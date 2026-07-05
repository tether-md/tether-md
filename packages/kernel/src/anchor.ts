// Anchoring & re-anchoring (spec §7), with the confidence floor matchQuote lacks (D3).
//
// Resolution runs against P(raw).clean. Resolution order, per comment:
//   1. marker locality + exact quote  -> confidence 1.0
//   2. unique exact match             -> reattach; disambiguate duplicates by context
//   3. fuzzy match (approx-string-match) scored with matchQuote weights
//
// Confidence bands (D3, the floor the library lacks):
//   >= 0.75  reattach silently        status "open"
//   0.50-.75 reattach AND flag        status "needs-review"
//   < 0.50   do NOT guess             status "orphaned" (loud)

import search from "approx-string-match";
import type { Anchor, QuoteSelector, Record } from "./types.js";

const QUOTE_W = 50;
const PREFIX_W = 20;
const SUFFIX_W = 20;
const POS_W = 2;
const MAX_SCORE = QUOTE_W + PREFIX_W + SUFFIX_W + POS_W; // 92

const REATTACH = 0.75;
const FLOOR = 0.5;
const MAX_ERRORS_CAP = 256;
/** Below this length, half-the-quote error budget over-matches; tighten it (§7 short-anchor guard). */
const SHORT_ANCHOR = 8;

interface Match {
  start: number;
  end: number;
  errors: number;
}

/** Similarity of `text` to `str` in [0,1] via best fuzzy match (Hypothesis textMatchScore). */
function textMatchScore(text: string, str: string): number {
  if (str.length === 0 || text.length === 0) return 0.0;
  const matches = search(text, str, Math.floor(str.length / 2));
  return matches.length === 0 ? 0.0 : 1 - matches[0].errors / str.length;
}

function scoreMatch(clean: string, match: Match, quote: QuoteSelector, hint?: number): number {
  const quoteScore = quote.exact.length === 0 ? 0 : 1 - match.errors / quote.exact.length;
  const prefixScore = quote.prefix
    ? textMatchScore(clean.slice(Math.max(0, match.start - quote.prefix.length), match.start), quote.prefix)
    : 1.0;
  const suffixScore = quote.suffix
    ? textMatchScore(clean.slice(match.end, match.end + quote.suffix.length), quote.suffix)
    : 1.0;
  let posScore = 1.0;
  if (typeof hint === "number" && clean.length > 0) {
    posScore = Math.max(0, 1 - Math.abs(match.start - hint) / clean.length);
  }
  const raw = QUOTE_W * quoteScore + PREFIX_W * prefixScore + SUFFIX_W * suffixScore + POS_W * posScore;
  return raw / MAX_SCORE;
}

function maxErrorsFor(exact: string): number {
  if (exact.length < SHORT_ANCHOR) return Math.floor(exact.length / 4);
  return Math.min(MAX_ERRORS_CAP, Math.floor(exact.length / 2));
}

function allIndicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function band(
  id: string,
  score: number,
  range: { start: number; end: number } | null,
): Anchor {
  if (range === null || score < FLOOR) {
    return { id, status: "orphaned", range: null, confidence: Math.max(0, score) };
  }
  if (score >= REATTACH) return { id, status: "open", range, confidence: score };
  return { id, status: "needs-review", range, confidence: score };
}

/**
 * Resolve one comment against `clean`. `hint` is the marker's clean-space locality
 * (from markerHint); pass undefined when the marker is gone.
 */
export function resolveQuote(clean: string, quote: QuoteSelector, id: string, hint?: number): Anchor {
  const { exact } = quote;
  if (exact.length === 0) return { id, status: "orphaned", range: null, confidence: 0 };

  // 1. Marker locality + exact quote. Only short-circuit to full confidence when the
  //    context corroborates (high matchQuote score) OR the quote is unique — otherwise a
  //    stale hint that happens to land on an identical string would silently mis-attach.
  if (typeof hint === "number" && clean.startsWith(exact, hint)) {
    const range = { start: hint, end: hint + exact.length };
    const s = scoreMatch(clean, { ...range, errors: 0 }, quote, hint);
    if (s >= REATTACH || allIndicesOf(clean, exact).length === 1) {
      return { id, status: "open", range, confidence: 1.0 };
    }
    // else: ambiguous hint — fall through to steps 2/3 for disambiguation + banding.
  }

  // 2. Exact matches anywhere.
  const exacts = allIndicesOf(clean, exact);
  if (exacts.length === 1) {
    const start = exacts[0];
    return { id, status: "open", range: { start, end: start + exact.length }, confidence: 1.0 };
  }
  if (exacts.length > 1) {
    let best = { start: exacts[0], score: -1 };
    for (const start of exacts) {
      const score = scoreMatch(clean, { start, end: start + exact.length, errors: 0 }, quote, hint);
      if (score > best.score) best = { start, score };
    }
    return band(id, best.score, { start: best.start, end: best.start + exact.length });
  }

  // 3. Fuzzy.
  const matches = search(clean, exact, maxErrorsFor(exact)) as Match[];
  if (matches.length === 0) return { id, status: "orphaned", range: null, confidence: 0 };
  let best = { match: matches[0], score: -1 };
  for (const match of matches) {
    const score = scoreMatch(clean, match, quote, hint);
    if (score > best.score) best = { match, score };
  }
  return band(id, best.score, { start: best.match.start, end: best.match.end });
}

/** Resolve a full record. */
export function resolve(clean: string, record: Record, hint?: number): Anchor {
  return resolveQuote(clean, record.target.quote, record.id, hint);
}
