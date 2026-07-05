// Wire-format types for the Tether projection kernel.
// Source of truth: docs/spec/wire-format-and-projection.md §2.4, §2.6, §5.

/** The two trust classes (architecture §1, §7). */
export type Trust = "fact" | "interpretation";

/** Comment kind. The gate dogfoods by writing findings as comments (D8). */
export type Kind = "comment" | "gate-finding";

export type Author = "human" | "agent" | "gate";

export type Status = "open" | "resolved" | "needs-review" | "orphaned";

/** W3C TextQuoteSelector — the source of truth for re-anchoring (§6). */
export interface QuoteSelector {
  exact: string;
  /** Up to 32 chars of context before `exact` (§2.4). */
  prefix: string;
  /** Up to 32 chars of context after `exact` (§2.4). */
  suffix: string;
}

/**
 * W3C TextPositionSelector — a locality *hint* only (§6).
 * Offsets are into P(raw) (the clean document), in UTF-16 code units (§4).
 */
export interface PositionSelector {
  start: number;
  end: number;
}

export interface Target {
  quote: QuoteSelector;
  position: PositionSelector;
}

/** kind-specific metadata for gate findings (§2.6). */
export interface FindingMeta {
  check: "fact-grounding" | "claim-strength";
  severity: "info" | "warn";
  /** 0..1; for claim-strength, the operating-point score. */
  confidence: number;
  /** true for claim-strength findings (labeled experimental in UI). */
  experimental: boolean;
  /** Background span, or "unmatched". */
  evidence: string;
  /** What the draft asserts. */
  observed?: string;
  /** What the Background supports. */
  supported?: string;
  /** Proposed downgrade (D10); inert until a human applies it. */
  suggestion?: string;
}

/** Fields common to every store record (§2.4). */
export interface RecordBase {
  /** ULID; matches the inline marker `c=<ID>`. */
  id: string;
  /** Record schema version. */
  v: 1;
  trust: Trust;
  author: Author;
  /** The comment / finding text (markdown). */
  body: string;
  status: Status;
  /** ISO-8601; stamped by the writing process. */
  created: string;
  target: Target;
  /**
   * A proposed replacement for the anchored span (suggestion mode). When present, the
   * comment is a pending suggestion the human can Accept (apply + clear) or Reject (clear).
   */
  proposal?: string;
}

/** A human/agent comment — carries no finding metadata. */
export interface CommentRecord extends RecordBase {
  kind: "comment";
  meta?: never;
}

/** A gate finding, dogfooded as a comment (D8); carries typed FindingMeta (§2.6). */
export interface FindingRecord extends RecordBase {
  kind: "gate-finding";
  meta: FindingMeta;
}

/**
 * One store record — one JSONL line (§2.4). Discriminated on `kind` so that
 * `rec.kind === "gate-finding"` narrows `rec.meta` to a fully-typed FindingMeta.
 */
export type Record = CommentRecord | FindingRecord;

/**
 * One retained run of text. The offsetMap is the ordered list of these;
 * the gaps between them are the stripped Tether regions (§5).
 */
export interface Segment {
  cleanStart: number;
  cleanEnd: number;
  rawStart: number;
  rawEnd: number;
}

/** The result of the projection P (§5). */
export interface Projection {
  clean: string;
  offsetMap: Segment[];
  store: Record[];
  /**
   * Raw-space ranges of the inline markers, in document order, paired with
   * their comment id. Used to derive the per-comment locality hint (§7).
   */
  markers: { id: string; rawStart: number; rawEnd: number }[];
}

/** Outcome of resolving one comment against P(raw).clean (§7). */
export interface Anchor {
  id: string;
  status: Extract<Status, "open" | "needs-review" | "orphaned">;
  /** Resolved span in clean space; null when orphaned. */
  range: PositionSelector | null;
  /** 0..1 confidence from the matchQuote-weighted score. */
  confidence: number;
}
