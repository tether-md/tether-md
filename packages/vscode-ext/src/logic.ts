// Pure editor logic — NO `vscode` import, so it is unit-testable with Vitest.
// The extension (extension.ts) is thin glue that maps these results onto the VSCode API.
//
// VSCode edits the RAW file (prose + comment layer). The kernel works in CLEAN space.
// Everything here translates between raw offsets (what the editor knows) and the kernel's
// clean-space anchoring.

import {
  project,
  resolveAll,
  resolveDest,
  rawToClean,
  cleanToRaw,
  insertComment,
  parseStore,
  codeRanges,
  type Author,
  type DestSide,
  type Kind,
  type Segment,
  type Trust,
} from "@tether-md/kernel";

export type { Author, DestSide } from "@tether-md/kernel";

/** A range in raw-document offsets (UTF-16 code units) — what the editor positions map to. */
export interface RawRange {
  start: number;
  end: number;
}

export interface OrphanInfo {
  id: string;
  quote: string;
  body: string;
}

export interface NeedsReviewInfo {
  id: string;
  range: RawRange;
  /** Fuzzy re-anchor confidence (0.50–0.75) — shown in the diagnostic. */
  confidence: number;
}

export interface DecorationModel {
  /** Re-anchored cleanly (open). */
  anchored: RawRange[];
  /** Re-anchored but flagged (0.50–0.75) — surface for review. */
  needsReview: NeedsReviewInfo[];
  /** Could not re-anchor (loud); no range — surfaced as diagnostics. */
  orphaned: OrphanInfo[];
  /** The comment layer (inline markers + store block) to dim. */
  commentLayer: RawRange[];
}

/** A move comment's resolved destination (§2.7), in raw space for decorating. */
export interface MoveInfo {
  side: DestSide;
  /** Destination anchor status: "open" | "needs-review" | "orphaned". */
  status: string;
  confidence: number;
  /** Resolved destination span (raw space); null when orphaned. */
  range: RawRange | null;
  /** Raw-space insertion point (side === "before" ? range.start : range.end); null when orphaned. */
  insertAt: number | null;
  /** The recorded destination quote. */
  quote: string;
  /** What the destination resolves to NOW ("" when orphaned). */
  current: string;
}

export interface AnchoredComment {
  id: string;
  range: RawRange;
  trust: Trust;
  kind: Kind;
  author: Author;
  status: string;
  confidence: number;
  body: string;
  /** The recorded quote the comment (and any proposal) was written against. */
  quote: string;
  /** What the anchor resolves to NOW — can drift from `quote` after edits. */
  current: string;
  /** A proposed replacement for the span (suggestion mode), if the agent has proposed one. */
  proposal?: string;
  /** Move destination info (§2.7), when the comment is a move. */
  move?: MoveInfo;
}

/** Raw offset of the char at a clean offset, preferring the segment that CONTAINS it
 *  (i.e. just after any marker that precedes it) — for a precise decoration START. */
function rawStartOf(offsetMap: Segment[], cleanOffset: number): number {
  for (const seg of offsetMap) {
    if (cleanOffset >= seg.cleanStart && cleanOffset < seg.cleanEnd) {
      return seg.rawStart + (cleanOffset - seg.cleanStart);
    }
  }
  return offsetMap.length ? offsetMap[offsetMap.length - 1].rawEnd : cleanOffset;
}

export function cleanRangeToRaw(offsetMap: Segment[], start: number, end: number): RawRange {
  // start: prefer the segment after a leading marker; end: cleanToRaw lands before a
  // trailing marker — together the decoration hugs exactly the anchored text.
  return { start: rawStartOf(offsetMap, start), end: cleanToRaw(offsetMap, end) };
}

/**
 * Derive the clean-export path from the source path, inserting a `.clean` marker before
 * the extension: `essay.md` -> `essay.clean.md`, `essay` -> `essay.clean.md`.
 * The marker lives in the FILENAME, never in the content (clean export stays pristine).
 */
export function cleanExportPath(originalPath: string): string {
  const slash = Math.max(originalPath.lastIndexOf("/"), originalPath.lastIndexOf("\\"));
  const dot = originalPath.lastIndexOf(".");
  if (dot > slash) return originalPath.slice(0, dot) + ".clean" + originalPath.slice(dot);
  return originalPath + ".clean.md";
}

/** Map a raw-space selection to the clean-space span the kernel anchors against. */
export function selectionToClean(
  raw: string,
  rawStart: number,
  rawEnd: number,
): { cleanStart: number; cleanEnd: number } {
  const { offsetMap } = project(raw);
  const a = rawToClean(offsetMap, rawStart);
  const b = rawToClean(offsetMap, rawEnd);
  return { cleanStart: Math.min(a, b), cleanEnd: Math.max(a, b) };
}

export interface AddOpts {
  body: string;
  trust: Trust;
  kind: Kind;
  author: Author;
}

/** Insert a comment anchored to a raw-space selection; returns the new raw + id. */
export function addCommentFromSelection(
  raw: string,
  rawStart: number,
  rawEnd: number,
  opts: AddOpts,
): { raw: string; id: string } {
  const { cleanStart, cleanEnd } = selectionToClean(raw, rawStart, rawEnd);
  // A selection lying entirely within the comment layer (markers / store block) collapses
  // to a zero-width clean span. Reject it with a clear message before the kernel does.
  if (cleanStart === cleanEnd) {
    throw new RangeError("selection contains no clean prose to anchor (it lies inside the comment layer)");
  }
  const res = insertComment(raw, {
    cleanStart,
    cleanEnd,
    body: opts.body,
    trust: opts.trust,
    kind: opts.kind,
    author: opts.author,
  });
  return { raw: res.raw, id: res.record.id };
}

/** Everything the editor needs to decorate the active document. */
export function buildDecorationModel(raw: string): DecorationModel {
  const proj = project(raw);
  const recById = new Map(proj.store.map((r) => [r.id, r]));
  const anchored: RawRange[] = [];
  const needsReview: NeedsReviewInfo[] = [];
  const orphaned: OrphanInfo[] = [];

  for (const a of resolveAll(raw)) {
    const rec = recById.get(a.id);
    if (a.status === "orphaned" || !a.range) {
      orphaned.push({ id: a.id, quote: rec?.target.quote.exact ?? "", body: rec?.body ?? "" });
      continue;
    }
    const range = cleanRangeToRaw(proj.offsetMap, a.range.start, a.range.end);
    if (a.status === "needs-review") needsReview.push({ id: a.id, range, confidence: a.confidence });
    else anchored.push(range);
  }

  const commentLayer: RawRange[] = proj.markers.map((m) => ({ start: m.rawStart, end: m.rawEnd }));
  const store = parseStore(raw, codeRanges(raw));
  if (store) commentLayer.push({ start: store.rawStart, end: store.rawEnd });

  return { anchored, needsReview, orphaned, commentLayer };
}

/** Anchored comments with bodies + raw ranges, for hovers. */
export function anchoredComments(raw: string): AnchoredComment[] {
  const proj = project(raw);
  const recById = new Map(proj.store.map((r) => [r.id, r]));
  const out: AnchoredComment[] = [];
  for (const a of resolveAll(raw)) {
    if (!a.range) continue;
    const rec = recById.get(a.id);
    if (!rec) continue;
    const entry: AnchoredComment = {
      id: a.id,
      range: cleanRangeToRaw(proj.offsetMap, a.range.start, a.range.end),
      trust: rec.trust,
      kind: rec.kind,
      author: rec.author,
      status: a.status,
      confidence: a.confidence,
      body: rec.body,
      quote: rec.target.quote.exact,
      current: proj.clean.slice(a.range.start, a.range.end),
      proposal: rec.proposal,
    };
    const d = resolveDest(proj.clean, rec);
    if (d && rec.kind === "comment" && rec.dest) {
      const insertCleanAt = d.range ? (rec.dest.side === "before" ? d.range.start : d.range.end) : null;
      entry.move = {
        side: rec.dest.side,
        status: d.status,
        confidence: d.confidence,
        range: d.range ? cleanRangeToRaw(proj.offsetMap, d.range.start, d.range.end) : null,
        insertAt: insertCleanAt === null ? null : cleanToRaw(proj.offsetMap, insertCleanAt),
        quote: rec.dest.quote.exact,
        current: d.range ? proj.clean.slice(d.range.start, d.range.end) : "",
      };
    }
    out.push(entry);
  }
  return out;
}

// ---- suggestion rendering ----------------------------------------------------

/** Longest run of backticks in `s` — to size a fence the content cannot terminate. */
function maxBacktickRun(s: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = s[i] === "`" ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

/**
 * Markdown body for a suggestion thread: shows what Accept will actually CHANGE — the
 * currently-anchored text as `-` lines, the proposal as `+` lines. `current` is the resolved
 * span, which can drift from the recorded `quote`; when it has, the kernel's acceptProposal
 * WILL refuse (quote guard), so say so up front instead of surprising the user.
 * Rendered with MarkdownString(supportThemeIcons: true) — hence `$(git-compare)`.
 */
export function suggestionMarkdown(current: string, quote: string, proposal: string): string {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(current + proposal) + 1));
  const diff = [
    ...current.split("\n").map((l) => `- ${l}`),
    ...proposal.split("\n").map((l) => `+ ${l}`),
  ].join("\n");
  const parts = ["$(git-compare) **Suggested change**", `${fence}diff\n${diff}\n${fence}`];
  if (current !== quote) {
    parts.push("⚠ span changed since proposed — Accept will refuse; re-run the agent");
  }
  return parts.join("\n\n");
}

// ---- move marking (§2.7) -------------------------------------------------------
//
// v1 moves are BLOCK-granular: the source selection snaps outward to whole blank-line-
// separated block(s), and the destination snaps to a block boundary (or the document
// end). The kernel's acceptMove seam rule then keeps exactly one blank-line separator
// on each side of the moved text.

/** A top-level block of the CLEAN document (bare text; separators excluded). */
export interface Block {
  start: number;
  end: number;
}

/**
 * Split the clean document into blank-line-separated blocks, keeping code regions
 * atomic — a blank line inside a fenced block does not split it.
 */
export function cleanBlocks(clean: string): Block[] {
  const code = codeRanges(clean);
  const inCode = (i: number) => code.some((r) => i >= r.start && i < r.end);
  const blocks: Block[] = [];
  let cursor = 0;
  const n = clean.length;
  while (cursor < n) {
    while (cursor < n && clean[cursor] === "\n") cursor++;
    if (cursor >= n) break;
    let scanEnd = cursor;
    while (scanEnd < n) {
      const nl = clean.indexOf("\n\n", scanEnd);
      if (nl === -1) {
        scanEnd = n;
        break;
      }
      if (inCode(nl)) {
        scanEnd = nl + 1;
        continue;
      }
      scanEnd = nl;
      break;
    }
    let end = scanEnd;
    while (end > cursor && clean[end - 1] === "\n") end--; // trim the file's trailing newline
    blocks.push({ start: cursor, end });
    cursor = scanEnd;
  }
  return blocks;
}

/**
 * Snap a clean-space selection outward to whole block(s). A caret (zero-width) snaps to
 * the block containing it. Returns null when the selection touches no block text (it
 * lies wholly in blank lines).
 */
export function snapToBlocks(blocks: Block[], start: number, end: number): Block | null {
  const touched = blocks.filter((b) => b.end > start && b.start < end);
  if (touched.length > 0) {
    return { start: touched[0].start, end: touched[touched.length - 1].end };
  }
  const containing = blocks.find((b) => start >= b.start && start <= b.end);
  return containing ?? null;
}

export interface MoveDestination {
  /** Clean-space insertion point (a block start, or the end of the last block). */
  insertAt: number;
  /** The NON-EMPTY span whose quote anchors the destination (§2.7). */
  destStart: number;
  destEnd: number;
  side: DestSide;
}

/** ~64 chars anchors a destination robustly without quoting whole paragraphs. */
const DEST_QUOTE_MAX = 64;

/** Back off one code unit when `i` would split a UTF-16 surrogate pair. */
function safeCut(s: string, i: number): number {
  return i > 0 && i < s.length && isLowSurrogate(s.charCodeAt(i)) && isHighSurrogate(s.charCodeAt(i - 1)) ? i - 1 : i;
}

/** The source's no-op window: the block extended over its adjacent newline runs (the
 *  hole acceptMove collapses) — destinations inside it would move the text nowhere. */
function sourceHole(clean: string, src: Block): { start: number; end: number } {
  let start = src.start;
  while (start > 0 && clean[start - 1] === "\n") start--;
  let end = src.end;
  while (end < clean.length && clean[end] === "\n") end++;
  return { start, end };
}

/** Occurrences of `needle` in `clean`, early-bounded (only 0 / 1 / many matter). */
function countOccurrences(clean: string, needle: string): number {
  let n = 0;
  for (let i = clean.indexOf(needle); i !== -1 && n < 2; i = clean.indexOf(needle, i + 1)) n++;
  return n;
}

/** Why a document offers the destinations it does — for honest empty-state messages. */
export interface DestinationDiagnosis {
  destinations: MoveDestination[];
  /** Boundaries excluded because moving there is a no-op (adjacent to the source). */
  adjacent: number;
  /** Boundaries dropped because no unique anchoring quote exists (text repeats verbatim). */
  ambiguous: number;
}

/**
 * All valid destinations for moving `src`: every block start ("insert before") plus the
 * document end ("insert after" the last block), excluding boundaries inside or adjacent
 * to the source (those moves are no-ops the kernel rejects). Destination quotes anchor
 * by text alone, so each is EXTENDED past the ~64-char default until it is unique in the
 * document; a boundary whose whole block is duplicated verbatim is dropped (the kernel
 * refuses ambiguous destinations rather than guess between copies).
 */
export function diagnoseDestinations(clean: string, blocks: Block[], src: Block): DestinationDiagnosis {
  const hole = sourceHole(clean, src);
  const out: MoveDestination[] = [];
  let adjacent = 0;
  let ambiguous = 0;
  for (const b of blocks) {
    if (b.start >= hole.start && b.start <= hole.end) {
      adjacent++;
      continue;
    }
    let destEnd = safeCut(clean, Math.min(b.end, b.start + DEST_QUOTE_MAX));
    while (countOccurrences(clean, clean.slice(b.start, destEnd)) > 1 && destEnd < b.end) {
      destEnd = safeCut(clean, Math.min(b.end, destEnd + DEST_QUOTE_MAX));
    }
    if (countOccurrences(clean, clean.slice(b.start, destEnd)) > 1) {
      ambiguous++;
      continue;
    }
    out.push({ insertAt: b.start, destStart: b.start, destEnd, side: "before" });
  }
  const last = blocks[blocks.length - 1];
  if (last) {
    if (last.end >= hole.start && last.end <= hole.end) {
      adjacent++;
    } else {
      let destStart = safeCut(clean, Math.max(last.start, last.end - DEST_QUOTE_MAX));
      while (countOccurrences(clean, clean.slice(destStart, last.end)) > 1 && destStart > last.start) {
        destStart = safeCut(clean, Math.max(last.start, destStart - DEST_QUOTE_MAX));
      }
      if (countOccurrences(clean, clean.slice(destStart, last.end)) <= 1) {
        out.push({ insertAt: last.end, destStart, destEnd: last.end, side: "after" });
      } else {
        ambiguous++;
      }
    }
  }
  return { destinations: out, adjacent, ambiguous };
}

export function moveDestinations(clean: string, blocks: Block[], src: Block): MoveDestination[] {
  return diagnoseDestinations(clean, blocks, src).destinations;
}

/**
 * Snap a clean-space click to the nearest valid destination boundary. Returns null when
 * the click lands on the source itself, or when the NEAREST boundary is one of the
 * source's own no-op boundaries — placing at some farther "valid" boundary would fling
 * the paragraph somewhere the user never aimed at. Stay armed and hint instead.
 */
export function destinationFromPoint(clean: string, blocks: Block[], src: Block, point: number): MoveDestination | null {
  const hole = sourceHole(clean, src);
  if (point >= hole.start && point <= hole.end) return null;
  let best: MoveDestination | null = null;
  let bestDist = Infinity;
  for (const c of moveDestinations(clean, blocks, src)) {
    const d = Math.abs(point - c.insertAt);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  const noopDist = Math.min(Math.abs(point - hole.start), Math.abs(point - hole.end));
  if (best === null || noopDist < bestDist) return null;
  return best;
}

export interface MoveTarget extends MoveDestination {
  /** One-line preview of the destination for pickers. */
  label: string;
}

/** First line of a block, trimmed and capped for a picker label. */
function blockLabel(clean: string, b: Block): string {
  const nl = clean.indexOf("\n", b.start);
  const end = nl === -1 || nl > b.end ? b.end : nl;
  const line = clean.slice(b.start, end).trim();
  return line.length > 60 ? line.slice(0, safeCut(line, 59)).trimEnd() + "…" : line;
}

/** Valid destinations labeled for a QuickPick, in document order. */
export function moveTargets(clean: string, blocks: Block[], src: Block): MoveTarget[] {
  return moveDestinations(clean, blocks, src).map((d) => {
    if (d.side === "after") return { ...d, label: "End of document" };
    const block = blocks.find((b) => b.start === d.insertAt)!;
    return { ...d, label: blockLabel(clean, block) };
  });
}

/** Insert a move comment for a snapped source block + destination (clean space). */
export function addMoveComment(
  raw: string,
  src: Block,
  dest: MoveDestination,
  opts: { body: string; trust: Trust; author: Author },
): { raw: string; id: string } {
  const res = insertComment(raw, {
    cleanStart: src.start,
    cleanEnd: src.end,
    body: opts.body,
    trust: opts.trust,
    kind: "comment",
    author: opts.author,
    dest: { cleanStart: dest.destStart, cleanEnd: dest.destEnd, side: dest.side },
  });
  return { raw: res.raw, id: res.record.id };
}

/**
 * Markdown body for a move thread: where the anchored text will land, with the same
 * drift honesty as suggestionMarkdown — when either anchor has drifted, acceptMove WILL
 * refuse, so say so up front instead of surprising the user.
 */
export function moveMarkdown(c: AnchoredComment): string {
  const m = c.move!;
  const destQuote = m.range === null ? m.quote : m.current;
  // The preview is raw document text rendered into a trusted, theme-icon-enabled
  // MarkdownString — wrap it in a code span it cannot terminate (same defense as
  // suggestionMarkdown's fenced diff) so `$(...)`, markdown, or backticks stay inert.
  const firstLine = destQuote.split("\n")[0];
  const tick = "`".repeat(maxBacktickRun(firstLine) + 1);
  const preview = `${tick} ${firstLine}${destQuote.includes("\n") ? "…" : ""} ${tick}`;
  const where =
    m.range === null
      ? "destination could not be found (orphaned)"
      : `will be moved ${m.side === "before" ? "to before" : "to after"}: ${preview}`;
  const parts = [`$(arrow-right) **Move** — this text ${where}`];
  if (c.current !== c.quote) {
    parts.push("⚠ the moved text changed since the move was marked — Accept will refuse; re-mark the move");
  } else if (m.range === null || m.status !== "open" || m.current !== m.quote) {
    parts.push("⚠ the destination changed since the move was marked — Accept will refuse; re-mark the move");
  }
  return parts.join("\n\n");
}

// ---- minimal edits -----------------------------------------------------------

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Smallest single-range edit turning `oldText` into `newText`: trim the common prefix and
 * suffix by UTF-16 code unit, then widen so neither boundary splits a surrogate pair.
 * Whole-document replaces trash cursor position and undo granularity; this keeps
 * programmatic writes surgical. Identical inputs yield a zero-length edit (start === end,
 * text === "") the caller can skip.
 */
export function minimalEdit(oldText: string, newText: string): { start: number; end: number; text: string } {
  let start = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (start < maxPrefix && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  // Prefix ended right after a (shared) high surrogate: the differing low halves would make
  // the edit split the pair. Back off to replace the whole character.
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  // Common suffix starts on a (shared) low surrogate: widen past it so the pair stays whole.
  if (oldEnd < oldText.length && isLowSurrogate(oldText.charCodeAt(oldEnd))) {
    oldEnd++;
    newEnd++;
  }
  return { start, end: oldEnd, text: newText.slice(start, newEnd) };
}

// ---- debounce ----------------------------------------------------------------

/**
 * Keyed trailing-edge debounce with per-key cancel. Exists (rather than a bare Map of
 * timeouts) for the ghost-thread guard: a refresh pending for a document that closes between
 * schedule and fire must be cancellable on close, and cancellable wholesale on deactivate.
 * No vscode types, so it is unit-testable.
 */
export class Debouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Schedule `fn` after `ms`, superseding any pending call for `key`. */
  schedule(key: string, fn: () => void, ms: number): void {
    this.cancel(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
  }

  /** Drop the pending call for `key` (no-op when none). */
  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** True when a call is pending for `key`. */
  pending(key: string): boolean {
    return this.timers.has(key);
  }
}
