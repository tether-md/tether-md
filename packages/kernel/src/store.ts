// EOF store block: serialize/parse (spec §2.2, §2.5).
//
//   <!--tether:store
//   {record}            (one JSONL line per comment, hyphen-escaped)
//   {record}
//   tether:store-->
//
// The block is the LAST thing in the file. P finds it with a single anchored scan;
// on a malformed or duplicate block it HARD-FAILS (never silently mis-parses, §2.2).

import { decodeLine, encodeLine } from "./codec.js";
import { isUlid } from "./ulid.js";
import type { Record } from "./types.js";

export const STORE_OPEN = "<!--tether:store";
export const STORE_CLOSE = "tether:store-->";

/** Thrown when the store block violates the grammar (§2.2 hard-fail). */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** A located store block within raw, in UTF-16 code units. */
export interface StoreSpan {
  /** Start of the stripped region: STORE_OPEN, or one preceding `\n` if present. */
  rawStart: number;
  /** End of the stripped region: just past `-->`, plus any tolerated trailing whitespace (== raw.length). */
  rawEnd: number;
  records: Record[];
}

/**
 * Find and parse the single store block. Returns null if there is none.
 * `protectedRanges` are raw-space ranges (e.g. code spans) inside which a
 * store-looking block must be ignored — it is user content, not Tether's.
 */
export function parseStore(
  raw: string,
  protectedRanges: { start: number; end: number }[] = [],
): StoreSpan | null {
  const opens: number[] = [];
  for (let i = raw.indexOf(STORE_OPEN); i !== -1; i = raw.indexOf(STORE_OPEN, i + 1)) {
    if (!inAnyRange(i, protectedRanges)) opens.push(i);
  }
  if (opens.length === 0) return null;
  if (opens.length > 1) {
    throw new StoreError(`duplicate store block: found ${opens.length} \`${STORE_OPEN}\` sentinels`);
  }

  const open = opens[0];
  const closeStart = raw.indexOf(STORE_CLOSE, open + STORE_OPEN.length);
  if (closeStart === -1) {
    throw new StoreError("unterminated store block: missing `tether:store-->`");
  }
  const closeEnd = closeStart + STORE_CLOSE.length;

  // Absorb exactly one immediately-preceding newline into the stripped region. This
  // is the separator comment-creation inserts; absorbing it keeps clean-export
  // byte-identical (Invariant 3) while leaving a readable line break in the raw file.
  const rawStart = open > 0 && raw[open - 1] === "\n" ? open - 1 : open;

  // The block must be the last thing in the file (only trailing whitespace allowed, §2.2).
  if (raw.slice(closeEnd).trim() !== "") {
    throw new StoreError("store block is not the last thing in the file");
  }
  // Absorb that tolerated trailing whitespace into the stripped region. Bytes after the
  // store are comment-layer territory (§2.2), never clean_document — leaving them retained
  // would leak a final newline (e.g. one an editor enforces) into P(raw).clean and break
  // export byte-identity (Invariant 3).
  const rawEnd = raw.length;

  // Opening sentinel occupies its own line; content begins after the newline.
  const afterOpen = open + STORE_OPEN.length;
  if (raw[afterOpen] !== "\n") {
    throw new StoreError("malformed store block: `<!--tether:store` must be followed by a newline");
  }
  const body = raw.slice(afterOpen + 1, closeStart);

  const records: Record[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    records.push(parseRecord(line));
  }

  // Record ids must be unique: every marker↔record join and every id-addressed operation
  // (suggest/accept/remove) assumes it. Two records with one id is a malformed store.
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) throw new StoreError(`duplicate record id: ${r.id}`);
    seen.add(r.id);
  }

  return { rawStart, rawEnd, records };
}

const TRUST = new Set(["fact", "interpretation"]);
const KIND = new Set(["comment", "gate-finding"]);
const AUTHOR = new Set(["human", "agent", "gate"]);
const STATUS = new Set(["open", "resolved", "needs-review", "orphaned"]);

function isObj(x: unknown): x is { [k: string]: unknown } {
  return typeof x === "object" && x !== null;
}

/**
 * Decode + JSON.parse + validate one record line against the §2.4 schema. Hard-fails
 * (StoreError) on any violation — a JSON-valid but non-conforming record must never be
 * silently accepted (§2.2: never silently mis-parse a malformed store).
 */
function parseRecord(line: string): Record {
  let value: unknown;
  try {
    value = JSON.parse(decodeLine(line));
  } catch (err) {
    throw new StoreError(`malformed store record (invalid JSON): ${(err as Error).message}`);
  }
  const bad = (why: string): never => {
    throw new StoreError(`malformed store record (${why}): ${line}`);
  };
  if (!isObj(value)) return bad("not an object");
  if (typeof value.id !== "string" || !isUlid(value.id)) return bad("id is not a ULID");
  if (value.v !== 1 && value.v !== 2) return bad("v must be 1 or 2");
  if (typeof value.trust !== "string" || !TRUST.has(value.trust)) return bad("invalid trust");
  if (typeof value.kind !== "string" || !KIND.has(value.kind)) return bad("invalid kind");
  if (typeof value.author !== "string" || !AUTHOR.has(value.author)) return bad("invalid author");
  if (typeof value.status !== "string" || !STATUS.has(value.status)) return bad("invalid status");
  if (typeof value.body !== "string") return bad("body must be a string");
  if (typeof value.created !== "string") return bad("created must be a string");
  if (!isObj(value.target)) return bad("missing target");
  const q = value.target.quote;
  const p = value.target.position;
  if (!isObj(q) || typeof q.exact !== "string" || typeof q.prefix !== "string" || typeof q.suffix !== "string") {
    return bad("invalid target.quote");
  }
  if (!isObj(p) || !Number.isFinite(p.start) || !Number.isFinite(p.end)) {
    return bad("invalid target.position");
  }
  if (value.proposal !== undefined && typeof value.proposal !== "string") return bad("proposal must be a string");
  if (value.kind === "gate-finding" && !isObj(value.meta)) return bad("gate-finding requires meta");
  // §2.7 — v 2 is exactly "carries a move destination"; each without the other is malformed.
  if (value.v === 2 && value.dest === undefined) return bad("v 2 requires dest (§2.7)");
  if (value.dest !== undefined && value.v !== 2) return bad("dest requires v 2 (§2.7)");
  if (value.dest !== undefined) {
    // §2.7 — a move destination. Validated as strictly as `target`; a half-understood
    // move must never be silently accepted. In particular `dest` + `proposal` on one
    // record is rejected outright: a kernel that knows only `proposal` could apply the
    // replacement without the move (a half-apply).
    if (value.kind !== "comment") return bad('dest is only valid on kind "comment"');
    if (value.proposal !== undefined) return bad("a record cannot carry both dest and proposal");
    if (!isObj(value.dest)) return bad("invalid dest");
    const dq = value.dest.quote;
    const dp = value.dest.position;
    if (
      !isObj(dq) ||
      typeof dq.exact !== "string" ||
      dq.exact.length === 0 ||
      typeof dq.prefix !== "string" ||
      typeof dq.suffix !== "string"
    ) {
      return bad("invalid dest.quote (exact must be a non-empty string)");
    }
    if (!isObj(dp) || !Number.isFinite(dp.start) || !Number.isFinite(dp.end)) return bad("invalid dest.position");
    if (value.dest.side !== "before" && value.dest.side !== "after") {
      return bad('invalid dest.side (must be "before" or "after")');
    }
  }
  return value as unknown as Record;
}

/** Serialize records into a store block string (no surrounding newlines). */
export function serializeStore(records: Record[]): string {
  const lines = records.map((r) => encodeLine(JSON.stringify(r)));
  return `${STORE_OPEN}\n${lines.join("\n")}\n${STORE_CLOSE}`;
}

function inAnyRange(offset: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((r) => offset >= r.start && offset < r.end);
}
