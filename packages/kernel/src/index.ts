// @tether-md/kernel — Layer 1: the projection kernel.
// Anchoring and clean-export are one thing; both are P(raw).

export type {
  Anchor,
  Author,
  CommentRecord,
  FindingMeta,
  FindingRecord,
  Kind,
  PositionSelector,
  Projection,
  QuoteSelector,
  Record,
  RecordBase,
  Segment,
  Status,
  Target,
  Trust,
} from "./types.js";

// Projection P, clean-export, and the offset-map bijection.
export {
  project,
  cleanExport,
  rawToClean,
  cleanToRaw,
  cleanToRawStart,
  markerHint,
  codeRanges,
} from "./projection.js";

// Anchoring & re-anchoring (confidence bands per D3).
export { resolve, resolveQuote } from "./anchor.js";

// Comment write operations + bulk resolution.
export {
  buildRecord,
  insertComment,
  removeComment,
  setCommentStatus,
  setProposal,
  acceptProposal,
  replaceClean,
  resolveAll,
  type InsertOptions,
  type InsertResult,
} from "./comment.js";

// Store block + codec (exposed for the CLI and for hand-inspection tooling).
export { parseStore, serializeStore, StoreError, STORE_OPEN, STORE_CLOSE } from "./store.js";
export type { StoreSpan } from "./store.js";
export { encodeLine, decodeLine, encodeLineBase64, decodeLineBase64 } from "./codec.js";
export { ulid, isUlid, ULID_RE } from "./ulid.js";
