// Pure editor logic — NO `vscode` import, so it is unit-testable with Vitest.
// The extension (extension.ts) is thin glue that maps these results onto the VSCode API.
//
// VSCode edits the RAW file (prose + comment layer). The kernel works in CLEAN space.
// Everything here translates between raw offsets (what the editor knows) and the kernel's
// clean-space anchoring.

import {
  project,
  resolveAll,
  rawToClean,
  cleanToRaw,
  insertComment,
  parseStore,
  codeRanges,
  type Author,
  type Kind,
  type Segment,
  type Trust,
} from "@tether-md/kernel";

export type { Author } from "@tether-md/kernel";

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

function cleanRangeToRaw(offsetMap: Segment[], start: number, end: number): RawRange {
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
    out.push({
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
    });
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
