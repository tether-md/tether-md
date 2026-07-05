// Comment insert/remove — the write operations Layers 2/3 build on.
//
// These are the operations the kernel invariants test:
//   - Invariant 2 (zero-perturbation): P(insert(raw)).clean === P(raw).clean
//   - Invariant 3 (export identity):    round-trip leaves prose byte-identical
//
// A comment is an inline marker (in prose) + one store record (at EOF). Both are
// stripped by P, so adding/removing either never perturbs the clean document.

import { resolve } from "./anchor.js";
import { project, cleanToRaw, cleanToRawStart, markerHint } from "./projection.js";
import { serializeStore, parseStore, STORE_OPEN, STORE_CLOSE } from "./store.js";
import { encodeLine } from "./codec.js";
import { codeRanges } from "./projection.js";
import { ulid } from "./ulid.js";
import type { Anchor, Author, FindingMeta, Kind, Record, Status, Trust } from "./types.js";

/** Context window captured on each side of the anchored span (§2.4). */
const CONTEXT = 32;

export interface InsertOptions {
  /** Anchored span in clean space, UTF-16 code units. */
  cleanStart: number;
  cleanEnd: number;
  trust: Trust;
  kind: Kind;
  author: Author;
  body: string;
  status?: Status;
  /** Required when kind is "gate-finding" (§2.6); ignored for comments. */
  meta?: FindingMeta;
  /** Injectable for deterministic tests; default Date.now(). */
  now?: number;
  /** Injectable id; default a fresh ULID. */
  id?: string;
}

export interface InsertResult {
  raw: string;
  record: Record;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** True if `off` falls between the two halves of a UTF-16 surrogate pair (§4). */
function splitsSurrogate(s: string, off: number): boolean {
  return off > 0 && off < s.length && isLowSurrogate(s.charCodeAt(off)) && isHighSurrogate(s.charCodeAt(off - 1));
}

/** Build the record for an insertion (exposed for testing the selector capture). */
export function buildRecord(clean: string, opts: InsertOptions): Record {
  const { cleanStart, cleanEnd } = opts;
  // The span must be non-empty: a zero-width anchor captures an empty quote that can
  // never re-anchor (it orphans immediately). Reject it here so no caller can create one.
  if (cleanStart < 0 || cleanEnd > clean.length || cleanStart >= cleanEnd) {
    throw new RangeError(
      `invalid span [${cleanStart}, ${cleanEnd}] for clean length ${clean.length} (must select non-empty text)`,
    );
  }
  // Offsets must land on character boundaries, not inside an astral pair — else we would
  // capture / write a lone surrogate (§4: astral chars are two UTF-16 code units).
  if (splitsSurrogate(clean, cleanStart) || splitsSurrogate(clean, cleanEnd)) {
    throw new RangeError(`span [${cleanStart}, ${cleanEnd}] falls inside a UTF-16 surrogate pair`);
  }
  const now = opts.now ?? Date.now();
  const base = {
    id: opts.id ?? ulid(now),
    v: 1 as const,
    trust: opts.trust,
    author: opts.author,
    body: opts.body,
    status: opts.status ?? "open",
    created: new Date(now).toISOString(),
    target: {
      quote: {
        exact: clean.slice(cleanStart, cleanEnd),
        prefix: clean.slice(Math.max(0, cleanStart - CONTEXT), cleanStart),
        suffix: clean.slice(cleanEnd, cleanEnd + CONTEXT),
      },
      position: { start: cleanStart, end: cleanEnd },
    },
  };
  if (opts.kind === "gate-finding") {
    if (!opts.meta) throw new RangeError("gate-finding records require meta (§2.6)");
    return { ...base, kind: "gate-finding", meta: opts.meta };
  }
  return { ...base, kind: "comment" };
}

/**
 * Post-write guard: a raw mutation is valid only if the comment layer stays invisible —
 * P(next).clean must be exactly the clean document the operation intends. Markdown block
 * structure is context-sensitive (a splice can un-terminate a fence; a marker landing on a
 * closing-fence line re-opens the block; removing a marker can re-pair inline code), and any
 * such shift would leak markers or the store into the export. Refuse loudly rather than
 * corrupt (Invariants 2/3). project() here also hard-fails if the store became unreadable.
 */
function assertLayerInvisible(next: string, expectedClean: string, op: string): void {
  if (project(next).clean !== expectedClean) {
    throw new RangeError(
      `${op} would change the document's markdown structure so the comment layer becomes ` +
        `visible (e.g. an unbalanced code fence or a marker joining a fence line); ` +
        `adjust the span or text`,
    );
  }
}

/** Insert a comment. Returns the new raw and the created record. */
export function insertComment(raw: string, opts: InsertOptions): InsertResult {
  const proj = project(raw);
  const record = buildRecord(proj.clean, opts);
  const marker = `<!--tether:c=${record.id}-->`;

  // 1. Insert the inline marker at the anchor point. Inside a code region the marker would
  //    be literal user content (⟨DECIDE 3⟩): P would preserve it, leaking it into the clean
  //    export and breaking Invariant 2. The marker is only a locality hint (the quote selector
  //    defines the span), so relocate it to just before the enclosing code region instead.
  const protectedRanges = codeRanges(raw);
  let rawInsert = cleanToRaw(proj.offsetMap, opts.cleanStart);
  // >= start: a marker at a fence's own line start would join the fence line and break it,
  // so an anchor beginning at the region's first character relocates too (no-op mid-line).
  const enclosing = protectedRanges.find((r) => rawInsert >= r.start && rawInsert < r.end);
  if (enclosing) {
    rawInsert = enclosing.start;
    if (rawInsert > 0 && raw[rawInsert - 1] === "\n") {
      // The region opens at a line start (fenced block): a marker joining the fence line
      // would break the fence. Put it at the end of the previous line instead.
      rawInsert -= 1;
    }
    if (rawInsert === 0) {
      throw new RangeError("cannot anchor inside a code region at the very start of the document");
    }
    if (protectedRanges.some((r) => rawInsert - 1 >= r.start && rawInsert - 1 < r.end)) {
      // The previous line itself ends in code (e.g. two adjacent fenced blocks): appending
      // the marker there would invalidate that closing fence. Refuse rather than corrupt.
      throw new RangeError("cannot anchor inside a code region immediately following another code region");
    }
  }
  let next = raw.slice(0, rawInsert) + marker + raw.slice(rawInsert);

  // 2. Add the record to the store (creating the block if absent).
  const encoded = encodeLine(JSON.stringify(record));
  if (proj.store.length > 0) {
    const closeAt = next.lastIndexOf(STORE_CLOSE);
    next = next.slice(0, closeAt) + encoded + "\n" + next.slice(closeAt);
  } else {
    next = next + "\n" + serializeStore([record]);
  }

  assertLayerInvisible(next, proj.clean, "insertComment");
  return { raw: next, record };
}

/** Remove a comment (marker + store record) by id. No-op if the id is absent. */
export function removeComment(raw: string, id: string): string {
  const before = project(raw).clean;
  const span = parseStore(raw, codeRanges(raw));
  let next = raw;

  // 1. Replace/drop the store block (using original indices; the marker is earlier).
  if (span) {
    const remaining = span.records.filter((r) => r.id !== id);
    const replacement = remaining.length > 0 ? "\n" + serializeStore(remaining) : "";
    next = next.slice(0, span.rawStart) + replacement + next.slice(span.rawEnd);
  }

  // 2. Remove the inline marker — skipping literal marker text inside code regions, which is
  //    user content (⟨DECIDE 3⟩), not the marker (project() applies the same guard).
  const marker = `<!--tether:c=${id}-->`;
  const protectedRanges = codeRanges(next);
  let at = next.indexOf(marker);
  while (at !== -1 && protectedRanges.some((r) => at >= r.start && at < r.end)) {
    at = next.indexOf(marker, at + 1);
  }
  if (at !== -1) next = next.slice(0, at) + next.slice(at + marker.length);

  assertLayerInvisible(next, before, "removeComment");
  return next;
}

/**
 * Replace a clean-space span with new prose, preserving the comment layer. This is how an
 * agent edits the document: it works in CLEAN space (what a reader sees), so interleaved
 * markers never get in the way (a raw find/replace would trip over them). The edited span
 * must not itself contain another comment's marker — edit one comment's span at a time.
 */
export function replaceClean(raw: string, cleanStart: number, cleanEnd: number, replacement: string): string {
  if (cleanStart < 0 || cleanEnd < cleanStart) {
    throw new RangeError(`invalid span [${cleanStart}, ${cleanEnd}]`);
  }
  const proj = project(raw);
  if (cleanEnd > proj.clean.length) {
    throw new RangeError(`span end ${cleanEnd} exceeds clean length ${proj.clean.length}`);
  }
  if (splitsSurrogate(proj.clean, cleanStart) || splitsSurrogate(proj.clean, cleanEnd)) {
    throw new RangeError(`span [${cleanStart}, ${cleanEnd}] falls inside a UTF-16 surrogate pair`);
  }
  // The replacement is spliced verbatim into the prose; reject Tether markup so it can
  // never inject a phantom marker (which P would silently strip) or a second store block.
  if (/<!--tether:/.test(replacement) || replacement.includes(STORE_CLOSE)) {
    throw new RangeError("replacement text may not contain Tether markup");
  }
  const rawStart = cleanToRawStart(proj.offsetMap, cleanStart);
  // A zero-width span maps to a single point (after any leading marker). Using cleanToRaw
  // for the end there would land BEFORE that marker and invert the bounds — which would
  // splice the marker into both halves and DUPLICATE it. Collapse to a single point.
  const rawEnd = cleanStart === cleanEnd ? rawStart : cleanToRaw(proj.offsetMap, cleanEnd);
  if (rawStart > rawEnd) {
    throw new RangeError(`internal: raw bounds inverted [${rawStart}, ${rawEnd}]`);
  }
  const region = raw.slice(rawStart, rawEnd);
  if (region.includes("<!--tether:c=") || region.includes(STORE_OPEN)) {
    throw new RangeError("edit span overlaps the comment layer; edit one comment's span at a time");
  }
  const next = raw.slice(0, rawStart) + replacement + raw.slice(rawEnd);
  assertLayerInvisible(next, proj.clean.slice(0, cleanStart) + replacement + proj.clean.slice(cleanEnd), "replaceClean");
  return next;
}

/** Set a comment's status (e.g. mark it "resolved" after an agent acts on it). */
export function setCommentStatus(raw: string, id: string, status: Status): string {
  const span = parseStore(raw, codeRanges(raw));
  if (!span || !span.records.some((r) => r.id === id)) {
    throw new RangeError(`comment ${id} not found`);
  }
  const updated = span.records.map((r) => (r.id === id ? ({ ...r, status } as Record) : r));
  return raw.slice(0, span.rawStart) + "\n" + serializeStore(updated) + raw.slice(span.rawEnd);
}

/**
 * Attach a proposed replacement for a comment's anchored span (suggestion mode). The human
 * later accepts (applies it) or rejects (discards). Rejects Tether markup in the proposal so
 * accepting it can never inject a marker.
 */
export function setProposal(raw: string, id: string, proposal: string): string {
  if (proposal.length === 0) {
    throw new RangeError("proposal must be non-empty (an empty proposal would silently delete the anchored span)");
  }
  if (/<!--tether:/.test(proposal) || proposal.includes(STORE_CLOSE)) {
    throw new RangeError("proposal text may not contain Tether markup");
  }
  const span = parseStore(raw, codeRanges(raw));
  if (!span || !span.records.some((r) => r.id === id)) {
    throw new RangeError(`comment ${id} not found`);
  }
  const updated = span.records.map((r) => (r.id === id ? ({ ...r, proposal } as Record) : r));
  return raw.slice(0, span.rawStart) + "\n" + serializeStore(updated) + raw.slice(span.rawEnd);
}

/**
 * Accept a comment's proposal: apply it to the anchored span (clean-space), then remove the
 * comment entirely (marker + record) so no artifact is left behind. Throws if the comment
 * has no proposal or can no longer be anchored.
 */
export function acceptProposal(raw: string, id: string): string {
  const proj = project(raw);
  const rec = proj.store.find((r) => r.id === id);
  if (!rec) throw new RangeError(`comment ${id} not found`);
  if (rec.proposal === undefined) throw new RangeError(`comment ${id} has no proposal to accept`);
  const anchor = resolveAll(raw).find((a) => a.id === id);
  if (!anchor || !anchor.range) {
    throw new RangeError(`comment ${id} is orphaned; cannot apply its proposal`);
  }
  // Only an "open" anchor (exact/unique match) is safe to apply silently. A "needs-review"
  // anchor is a low-confidence fuzzy reattachment whose span may be a partial/wrong substring
  // (spec §7) — applying a proposal there would splice mid-word and corrupt the prose, breaking
  // Invariant 1 ("never silently mis-attached"). Force a human re-confirm first.
  if (anchor.status !== "open") {
    throw new RangeError(
      `comment ${id} no longer anchors cleanly (${anchor.status}, confidence ${anchor.confidence.toFixed(2)}); re-confirm its span before accepting`,
    );
  }
  // Even an "open" anchor can be a high-confidence FUZZY reattachment (≥ 0.75) whose span
  // text no longer equals the quote the proposal was written to replace — applying there
  // clobbers the human's newer wording, possibly mid-word. Accept only while the span still
  // reads exactly as quoted; anything else needs a fresh proposal against the current text.
  const current = proj.clean.slice(anchor.range.start, anchor.range.end);
  if (current !== rec.target.quote.exact) {
    throw new RangeError(
      `comment ${id}'s anchored text has changed since the proposal was made ` +
        `(was ${JSON.stringify(rec.target.quote.exact)}, now ${JSON.stringify(current)}); ` +
        `re-propose against the current text before accepting`,
    );
  }
  const applied = replaceClean(raw, anchor.range.start, anchor.range.end, rec.proposal);
  return removeComment(applied, id);
}

/** Resolve every comment in `raw` against its own clean document. */
export function resolveAll(raw: string): Anchor[] {
  const proj = project(raw);
  const hintById = new Map<string, number>();
  for (const mk of proj.markers) {
    if (!hintById.has(mk.id)) hintById.set(mk.id, markerHint(proj.offsetMap, mk.rawEnd));
  }
  return proj.store.map((record) => resolve(proj.clean, record, hintById.get(record.id)));
}
