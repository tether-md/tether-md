// Comment insert/remove — the write operations Layers 2/3 build on.
//
// These are the operations the kernel invariants test:
//   - Invariant 2 (zero-perturbation): P(insert(raw)).clean === P(raw).clean
//   - Invariant 3 (export identity):    round-trip leaves prose byte-identical
//
// A comment is an inline marker (in prose) + one store record (at EOF). Both are
// stripped by P, so adding/removing either never perturbs the clean document.

import { resolve, resolveDest } from "./anchor.js";
import { project, cleanToRaw, cleanToRawStart, markerHint, rawToClean } from "./projection.js";
import { serializeStore, parseStore, STORE_OPEN, STORE_CLOSE } from "./store.js";
import { encodeLine } from "./codec.js";
import { codeRanges } from "./projection.js";
import { ulid } from "./ulid.js";
import type { Anchor, Author, DestSide, FindingMeta, Kind, Record, Status, Trust } from "./types.js";

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
  /**
   * Move destination (§2.7, kind "comment" only): ask that the anchored span be moved
   * to before/after the NON-EMPTY clean-space span [cleanStart, cleanEnd) — the span
   * anchors the point, since a zero-width quote can never re-anchor.
   */
  dest?: { cleanStart: number; cleanEnd: number; side: DestSide };
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

/**
 * The span must be non-empty: a zero-width anchor captures an empty quote that can
 * never re-anchor (it orphans immediately). And offsets must land on character
 * boundaries, not inside an astral pair — else we would capture / write a lone
 * surrogate (§4: astral chars are two UTF-16 code units).
 */
function assertAnchorableSpan(clean: string, cleanStart: number, cleanEnd: number, what: string): void {
  if (cleanStart < 0 || cleanEnd > clean.length || cleanStart >= cleanEnd) {
    throw new RangeError(
      `invalid ${what} [${cleanStart}, ${cleanEnd}] for clean length ${clean.length} (must select non-empty text)`,
    );
  }
  if (splitsSurrogate(clean, cleanStart) || splitsSurrogate(clean, cleanEnd)) {
    throw new RangeError(`${what} [${cleanStart}, ${cleanEnd}] falls inside a UTF-16 surrogate pair`);
  }
}

/** Quote + position selectors for a clean-space span (§2.4 capture rules). */
function captureSelectors(clean: string, cleanStart: number, cleanEnd: number) {
  return {
    quote: {
      exact: clean.slice(cleanStart, cleanEnd),
      prefix: clean.slice(Math.max(0, cleanStart - CONTEXT), cleanStart),
      suffix: clean.slice(cleanEnd, cleanEnd + CONTEXT),
    },
    position: { start: cleanStart, end: cleanEnd },
  };
}

/** Build the record for an insertion (exposed for testing the selector capture). */
export function buildRecord(clean: string, opts: InsertOptions): Record {
  const { cleanStart, cleanEnd } = opts;
  assertAnchorableSpan(clean, cleanStart, cleanEnd, "span");
  const now = opts.now ?? Date.now();
  const base = {
    id: opts.id ?? ulid(now),
    // v 2 marks a move record (§2.7) so pre-move kernels refuse it loudly instead of
    // tolerating a dest they cannot honor.
    v: (opts.dest ? 2 : 1) as 1 | 2,
    trust: opts.trust,
    author: opts.author,
    body: opts.body,
    status: opts.status ?? "open",
    created: new Date(now).toISOString(),
    target: captureSelectors(clean, cleanStart, cleanEnd),
  };
  if (opts.kind === "gate-finding") {
    if (opts.dest) throw new RangeError("gate-finding records cannot carry a move destination (§2.7)");
    if (!opts.meta) throw new RangeError("gate-finding records require meta (§2.6)");
    return { ...base, kind: "gate-finding", meta: opts.meta };
  }
  if (!opts.dest) return { ...base, kind: "comment" };

  assertAnchorableSpan(clean, opts.dest.cleanStart, opts.dest.cleanEnd, "dest span");
  // The insertion point the record asks for: anywhere inside the span's seam-extended
  // hole (span + the newline runs acceptMove collapses, see moveSeams) the move is a
  // no-op — reject at creation so a dead move can never be stored.
  const point = opts.dest.side === "before" ? opts.dest.cleanStart : opts.dest.cleanEnd;
  const hole = moveSeams(clean, cleanStart, cleanEnd);
  if (point >= hole.delStart && point <= hole.delEnd) {
    throw new RangeError(
      `move destination (insert at ${point}) lies inside or immediately adjacent to the moved span ` +
        `[${cleanStart}, ${cleanEnd}] — the move would be a no-op`,
    );
  }
  assertCleanSeamPoint(clean, point);
  const destSel = captureSelectors(clean, opts.dest.cleanStart, opts.dest.cleanEnd);
  // The destination re-anchors by quote alone (no marker as ground truth): an ambiguous
  // quote could later re-anchor to the WRONG copy with full confidence and the move would
  // apply there silently. Refuse at creation — same posture as the CLI's locateQuote.
  if (countOccurrences(clean, destSel.quote.exact) > 1) {
    throw new RangeError("destination quote is ambiguous (appears more than once); quote more context");
  }
  return { ...base, kind: "comment", dest: { ...destSel, side: opts.dest.side } };
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
  const rec = span?.records.find((r) => r.id === id);
  if (!span || !rec) {
    throw new RangeError(`comment ${id} not found`);
  }
  // §2.7: dest + proposal on one record is a wire-format violation (half-apply hazard);
  // refuse here too so no new-kernel code path can ever create the combination.
  if (rec.kind === "comment" && rec.dest) {
    throw new RangeError(`comment ${id} is a move; it cannot also carry a proposal (accept the move or remove it)`);
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

/**
 * Seam geometry for moving the span [cleanStart, cleanEnd): the deletion hole extended
 * over the adjacent newline runs, and the separator that reflects the span's granularity
 * (0 newlines = inline splice, 1 = line, ≥2 = block with one blank line).
 *
 * Clean "\n" seams only (v1): the walks and the synthesized separators assume LF line
 * endings and true empty blank lines. On a CRLF document — or one whose "blank" lines
 * contain spaces/tabs (blank per CommonMark, invisible in editors) — they would merge
 * paragraphs and double separators. Refuse loudly instead of corrupting silently.
 */
function moveSeams(clean: string, cleanStart: number, cleanEnd: number) {
  let delStart = cleanStart;
  while (delStart > 0 && clean[delStart - 1] === "\n") delStart--;
  let delEnd = cleanEnd;
  while (delEnd < clean.length && clean[delEnd] === "\n") delEnd++;
  if (clean.slice(Math.max(0, delStart - 2), Math.min(clean.length, delEnd + 2)).includes("\r")) {
    throw new RangeError("the moved text borders CRLF line endings; moves support LF documents only (v1)");
  }
  if (/(^|\n)[ \t]+$/.test(clean.slice(0, delStart)) || /^[ \t]+(\n|$)/.test(clean.slice(delEnd))) {
    throw new RangeError(
      "the moved text borders a whitespace-only blank line; normalize it to an empty line first (v1 moves need clean seams)",
    );
  }
  const beforeGap = cleanStart - delStart;
  const afterGap = delEnd - cleanEnd;
  const sep = "\n".repeat(Math.min(2, Math.max(beforeGap, afterGap)));
  return { delStart, delEnd, beforeGap, afterGap, sep };
}

/** Occurrences of `needle` in `clean` (bounded early: we only care about 0, 1, many). */
function countOccurrences(clean: string, needle: string): number {
  let n = 0;
  for (let i = clean.indexOf(needle); i !== -1 && n < 2; i = clean.indexOf(needle, i + 1)) n++;
  return n;
}

/** The insertion seam has the same clean-"\n"-seams constraint as the deletion seams (v1). */
function assertCleanSeamPoint(clean: string, point: number): void {
  let s = point;
  while (s > 0 && clean[s - 1] === "\n") s--;
  let e = point;
  while (e < clean.length && clean[e] === "\n") e++;
  if (clean.slice(Math.max(0, s - 2), Math.min(clean.length, e + 2)).includes("\r")) {
    throw new RangeError("the move destination borders CRLF line endings; moves support LF documents only (v1)");
  }
  if (/(^|\n)[ \t]+$/.test(clean.slice(0, s)) || /^[ \t]+(\n|$)/.test(clean.slice(e))) {
    throw new RangeError(
      "the move destination borders a whitespace-only blank line; normalize it to an empty line first (v1 moves need clean seams)",
    );
  }
}

/**
 * Insert prose at a clean-space POINT, landing BEFORE any inline marker sitting at that
 * boundary — a marker is the locality hint for the text it precedes, so inserted text
 * must never wedge between a marker and its anchored span. Same protections as
 * replaceClean (no Tether markup in the text; the comment layer stays invisible).
 */
function insertCleanAt(raw: string, cleanPoint: number, text: string): string {
  const proj = project(raw);
  if (cleanPoint < 0 || cleanPoint > proj.clean.length) {
    throw new RangeError(`invalid insertion point ${cleanPoint} for clean length ${proj.clean.length}`);
  }
  if (splitsSurrogate(proj.clean, cleanPoint)) {
    throw new RangeError(`insertion point ${cleanPoint} falls inside a UTF-16 surrogate pair`);
  }
  if (/<!--tether:/.test(text) || text.includes(STORE_CLOSE)) {
    throw new RangeError("inserted text may not contain Tether markup");
  }
  const rawPoint = cleanToRaw(proj.offsetMap, cleanPoint);
  const next = raw.slice(0, rawPoint) + text + raw.slice(rawPoint);
  assertLayerInvisible(next, proj.clean.slice(0, cleanPoint) + text + proj.clean.slice(cleanPoint), "acceptMove");
  return next;
}

/**
 * Accept a move comment (§2.7): delete its anchored span, re-insert that text at the
 * recorded destination, then remove the comment (marker + record). The two seams are
 * normalized to the span's granularity — a moved block keeps exactly one blank-line
 * separator on each side (none at a document edge); a moved line keeps one newline; an
 * inline span splices plainly. Applies only while BOTH anchors re-resolve as "open" with
 * byte-exact quotes (same posture as acceptProposal: never apply against drifted text).
 */
export function acceptMove(raw: string, id: string): string {
  const proj = project(raw);
  const rec = proj.store.find((r) => r.id === id);
  if (!rec) throw new RangeError(`comment ${id} not found`);
  if (rec.kind !== "comment" || !rec.dest) throw new RangeError(`comment ${id} has no move destination to accept`);
  const anchor = resolveAll(raw).find((a) => a.id === id);
  if (!anchor || !anchor.range) {
    throw new RangeError(`comment ${id} is orphaned; cannot apply its move`);
  }
  // Same two guards as acceptProposal, for the same reasons: a needs-review anchor may be
  // a partial/wrong substring, and even an "open" fuzzy reattachment can cover text that
  // no longer reads as quoted — moving either would corrupt prose the human just edited.
  if (anchor.status !== "open") {
    throw new RangeError(
      `comment ${id} no longer anchors cleanly (${anchor.status}, confidence ${anchor.confidence.toFixed(2)}); re-confirm its span before accepting`,
    );
  }
  const clean = proj.clean;
  const moved = clean.slice(anchor.range.start, anchor.range.end);
  if (moved !== rec.target.quote.exact) {
    throw new RangeError(
      `comment ${id}'s anchored text has changed since the move was marked ` +
        `(was ${JSON.stringify(rec.target.quote.exact)}, now ${JSON.stringify(moved)}); ` +
        `re-mark the move against the current text before accepting`,
    );
  }
  // The destination must hold to the SAME standard — it has no marker, so it re-anchors
  // purely by quote; anything below byte-exact would drop the text somewhere surprising.
  const destAnchor = resolveDest(clean, rec)!;
  if (!destAnchor.range || destAnchor.status !== "open") {
    throw new RangeError(
      `comment ${id}'s move destination no longer anchors cleanly ` +
        `(${destAnchor.status}, confidence ${destAnchor.confidence.toFixed(2)}); re-mark the destination`,
    );
  }
  const destCurrent = clean.slice(destAnchor.range.start, destAnchor.range.end);
  if (destCurrent !== rec.dest.quote.exact) {
    throw new RangeError(
      `comment ${id}'s destination text has changed since the move was marked ` +
        `(was ${JSON.stringify(rec.dest.quote.exact)}, now ${JSON.stringify(destCurrent)}); re-mark the destination`,
    );
  }
  // Ambiguity re-checked NOW, not just at creation: edits can duplicate the quoted text
  // later, and a markerless anchor cannot tell copies apart — it would apply at whichever
  // copy scores best, silently. Refuse instead.
  if (countOccurrences(clean, rec.dest.quote.exact) > 1) {
    throw new RangeError(
      `comment ${id}'s destination text now appears more than once in the document; re-mark the destination`,
    );
  }

  const { delStart, delEnd, afterGap, sep } = moveSeams(clean, anchor.range.start, anchor.range.end);
  const point = rec.dest.side === "before" ? destAnchor.range.start : destAnchor.range.end;
  if (point >= delStart && point <= delEnd) {
    throw new RangeError(
      `comment ${id}'s destination falls inside or immediately adjacent to the moved text (the move would be a no-op)`,
    );
  }
  assertCleanSeamPoint(clean, point);
  // v1 refuses to move text other comments anchor to (their markers would strand).
  // replaceClean catches markers strictly inside the hole; a marker exactly AT delStart —
  // anchoring a span that begins with the separator — would escape via replaceClean's
  // leading-marker exclusion, so check the half-open hole [delStart, delEnd) explicitly.
  // A marker at delEnd anchors the FOLLOWING block and is unaffected by the move.
  for (const mk of proj.markers) {
    if (mk.id === id) continue;
    const at = rawToClean(proj.offsetMap, mk.rawStart);
    if (at >= delStart && at < delEnd) {
      throw new RangeError(
        `comment ${id}'s moved text (or its surrounding blank lines) contains another comment's anchor; ` +
          `resolve or move that comment first`,
      );
    }
  }
  // What fills the hole: an interior hole keeps one granularity-matched separator; a hole
  // at the document's start keeps nothing; at the document's end, just the file's trailing
  // newline if it had one.
  const holeFill = delStart === 0 ? "" : delEnd === clean.length ? (afterGap > 0 ? "\n" : "") : sep;
  // The moved text must end up separated from its new neighbours ON BOTH SIDES at its own
  // granularity (§2.7) — synthesize only what the destination point doesn't already have.
  // At a block boundary this degenerates to the classic one-sided pad; at an arbitrary
  // agent-chosen point (e.g. mid-paragraph) both sides get separators.
  const gN = sep.length;
  const beforeP = clean.slice(0, point);
  const afterP = clean.slice(point);
  const leftRun = (beforeP.match(/\n*$/) as RegExpMatchArray)[0].length;
  const rightRun = (afterP.match(/^\n*/) as RegExpMatchArray)[0].length;
  const leftPad = beforeP.length === leftRun ? 0 : Math.max(0, gN - leftRun); // doc start needs nothing
  const rightPad = afterP.length === rightRun ? 0 : Math.max(0, gN - rightRun); // doc end keeps its own tail
  const insertText = "\n".repeat(leftPad) + moved + "\n".repeat(rightPad);

  // Remove marker + record FIRST: removeComment leaves the clean document untouched
  // (Invariant 2), so every clean-space offset above stays valid — and the hole edit no
  // longer contains this comment's own marker. Both edits are clean-space, applied
  // later-in-document first, so the earlier offsets survive unchanged. Any OTHER comment
  // anchored within the moved region makes replaceClean throw (v1 refuses to carry
  // markers along); rewrap that error with an actionable message.
  let next = removeComment(raw, id);
  try {
    if (point >= delEnd) {
      next = insertCleanAt(next, point, insertText);
      next = replaceClean(next, delStart, delEnd, holeFill);
    } else {
      next = replaceClean(next, delStart, delEnd, holeFill);
      next = insertCleanAt(next, point, insertText);
    }
  } catch (err) {
    if (err instanceof RangeError && /overlaps the comment layer/.test((err as Error).message)) {
      throw new RangeError(
        `comment ${id}'s moved text (or its surrounding blank lines) contains another comment's anchor; ` +
          `resolve or move that comment first`,
      );
    }
    throw err;
  }
  return next;
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
