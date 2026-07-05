// The projection P (spec §5) and the offset-map bijection (§4).
//
//   P(raw) -> { clean, offsetMap, store, markers }
//
// Clean-export IS P. There is exactly one P; no second export path.
//
// Design note (offset units, §4): all offsets are UTF-16 code units. We locate the
// exact Tether tokens (markers, store sentinels) by string search on `raw`, which is
// inherently UTF-16 — never by remark's offsets. remark is consulted only to find
// CODE regions, inside which a Tether-looking token is user content and must be
// preserved (⟨DECIDE 3⟩ extends to code, where literal examples may live). This
// sidesteps both the HTML-flow-absorption footgun and any offset-unit ambiguity.

import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { parseStore } from "./store.js";
import type { Projection, Record, Segment } from "./types.js";

/** `<!--tether:c=<ULID>-->` — identity-only inline marker (§2.1). */
const MARKER_RE = /<!--tether:c=([0-9A-HJKMNP-TV-Z]{26})-->/g;

interface Range {
  start: number;
  end: number;
}

/**
 * Raw-space ranges of `code` and `inlineCode` nodes — protected regions where a
 * Tether-looking token is literal user content, not Tether markup.
 */
export function codeRanges(raw: string): Range[] {
  const tree = unified().use(remarkParse).parse(raw);
  const ranges: Range[] = [];
  visit(tree, (node: { type: string; position?: { start: { offset?: number }; end: { offset?: number } } }) => {
    if (node.type !== "code" && node.type !== "inlineCode") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === "number" && typeof end === "number") ranges.push({ start, end });
  });
  return ranges;
}

function inAnyRange(offset: number, ranges: Range[]): boolean {
  return ranges.some((r) => offset >= r.start && offset < r.end);
}

/**
 * The projection P. Pure and deterministic: no model, no randomness, no clock.
 * Hard-fails (throws StoreError) on a malformed or duplicate store block.
 */
export function project(raw: string): Projection {
  const protectedRanges = codeRanges(raw);

  // 1. Inline markers (outside code).
  const markers: { id: string; rawStart: number; rawEnd: number }[] = [];
  for (const m of raw.matchAll(MARKER_RE)) {
    const rawStart = m.index;
    if (inAnyRange(rawStart, protectedRanges)) continue;
    markers.push({ id: m[1], rawStart, rawEnd: rawStart + m[0].length });
  }

  // 2. The EOF store block (outside code).
  const store = parseStore(raw, protectedRanges);

  // 3. All stripped regions, in raw order.
  const stripped: Range[] = markers.map((mk) => ({ start: mk.rawStart, end: mk.rawEnd }));
  if (store) stripped.push({ start: store.rawStart, end: store.rawEnd });
  stripped.sort((a, b) => a.start - b.start);

  // 4. Emit clean + offsetMap from the retained runs (the gaps between stripped regions).
  const offsetMap: Segment[] = [];
  let clean = "";
  let cursor = 0;
  for (const region of stripped) {
    if (region.start > cursor) {
      const cleanStart = clean.length;
      const text = raw.slice(cursor, region.start);
      clean += text;
      offsetMap.push({
        cleanStart,
        cleanEnd: clean.length,
        rawStart: cursor,
        rawEnd: region.start,
      });
    }
    cursor = region.end;
  }
  if (cursor < raw.length) {
    const cleanStart = clean.length;
    clean += raw.slice(cursor);
    offsetMap.push({ cleanStart, cleanEnd: clean.length, rawStart: cursor, rawEnd: raw.length });
  }

  return { clean, offsetMap, store: store ? store.records : [], markers };
}

/** Convenience: just the clean document. Clean-export IS P. */
export function cleanExport(raw: string): string {
  return project(raw).clean;
}

/**
 * Map a raw-space offset to clean space. Offsets inside a stripped region collapse
 * to the boundary where the region was removed (stripping removes zero clean text,
 * so adjacent retained segments are contiguous in clean space).
 */
export function rawToClean(offsetMap: Segment[], rawOffset: number): number {
  if (offsetMap.length === 0) return 0;
  if (rawOffset <= offsetMap[0].rawStart) return offsetMap[0].cleanStart;
  for (const seg of offsetMap) {
    if (rawOffset >= seg.rawStart && rawOffset <= seg.rawEnd) {
      return seg.cleanStart + (rawOffset - seg.rawStart);
    }
    if (rawOffset < seg.rawStart) {
      // In a gap before this segment — collapse to its clean start.
      return seg.cleanStart;
    }
  }
  return offsetMap[offsetMap.length - 1].cleanEnd;
}

/**
 * Map a clean-space offset to raw space. At a boundary shared by two retained
 * segments (a stripped region sits between them), resolves to the earliest segment's
 * raw position — i.e. just before any existing marker at that point.
 */
export function cleanToRaw(offsetMap: Segment[], cleanOffset: number): number {
  if (offsetMap.length === 0) return cleanOffset;
  for (const seg of offsetMap) {
    if (cleanOffset <= seg.cleanEnd) {
      return seg.rawStart + (cleanOffset - seg.cleanStart);
    }
  }
  return offsetMap[offsetMap.length - 1].rawEnd;
}

/**
 * Raw offset of the char at a clean offset, preferring the segment that CONTAINS it
 * (i.e. just *after* any marker that precedes it). Use for the START of an edit/decoration,
 * where `cleanToRaw` (which lands before a marker) would wrongly include the marker.
 */
export function cleanToRawStart(offsetMap: Segment[], cleanOffset: number): number {
  for (const seg of offsetMap) {
    if (cleanOffset >= seg.cleanStart && cleanOffset < seg.cleanEnd) {
      return seg.rawStart + (cleanOffset - seg.cleanStart);
    }
  }
  return offsetMap.length ? offsetMap[offsetMap.length - 1].rawEnd : cleanOffset;
}

/** The clean-space locality hint for a marker: where its anchored span begins (§7). */
export function markerHint(offsetMap: Segment[], markerRawEnd: number): number {
  return rawToClean(offsetMap, markerRawEnd);
}

export type { Record };
