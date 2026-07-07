// Command implementations — pure string/object transforms over the kernel.
// All IO (file read/write, process exit) lives in cli.ts so these stay testable.

import {
  project,
  cleanExport,
  resolveAll,
  resolveDest,
  insertComment,
  removeComment,
  setCommentStatus,
  setProposal,
  acceptProposal,
  acceptMove,
  replaceClean,
  type Author,
  type Kind,
  type Trust,
} from "@tether-md/kernel";

/** `tether project <file>` — the full projection as JSON (for tooling/inspection). */
export function runProject(raw: string): string {
  return JSON.stringify(project(raw), null, 2);
}

/** `tether export <file>` — the clean document. Clean-export IS P. */
export function runExport(raw: string): string {
  return cleanExport(raw);
}

/** Filters for `comment list` — each matches the record's own field in the output. */
export interface ListFilters {
  /** Record statuses to keep (OR across the list). */
  status?: string[];
  author?: string;
  kind?: string;
}

/** `tether comment list <file>` — each store record joined with its resolved anchor. */
export function runCommentList(raw: string, filters?: ListFilters): string {
  const proj = project(raw);
  const anchors = new Map(resolveAll(raw).map((a) => [a.id, a]));
  let records = proj.store;
  if (filters?.status) records = records.filter((r) => filters.status!.includes(r.status));
  if (filters?.author) records = records.filter((r) => r.author === filters.author);
  if (filters?.kind) records = records.filter((r) => r.kind === filters.kind);
  const out = records.map((r) => ({
    id: r.id,
    trust: r.trust,
    kind: r.kind,
    author: r.author,
    status: r.status,
    quote: r.target.quote.exact,
    body: r.body,
    proposal: r.proposal,
    // §2.7 — a move comment: where the anchored span is asked to go.
    moveTo:
      r.kind === "comment" && r.dest
        ? { side: r.dest.side, quote: r.dest.quote.exact, anchor: resolveDest(proj.clean, r) }
        : undefined,
    anchor: anchors.get(r.id) ?? null,
  }));
  return JSON.stringify(out, null, 2);
}

export interface AddArgs {
  start: number;
  end: number;
  body: string;
  trust: Trust;
  kind: Kind;
  author: Author;
}

/** `tether comment add` — insert a comment; returns the new raw and the created id. */
export function runCommentAdd(raw: string, args: AddArgs): { raw: string; id: string } {
  const res = insertComment(raw, {
    cleanStart: args.start,
    cleanEnd: args.end,
    body: args.body,
    trust: args.trust,
    kind: args.kind,
    author: args.author,
  });
  return { raw: res.raw, id: res.record.id };
}

/**
 * Resolve a quote string to a clean-space span (for `--quote` anchoring — far friendlier
 * for agents than UTF-16 offsets). Requires a UNIQUE occurrence; ambiguity is an error so
 * a comment is never silently anchored to the wrong one.
 */
export function locateQuote(raw: string, quote: string): { start: number; end: number } {
  if (quote.length === 0) throw new Error("--quote must be non-empty");
  const { clean } = project(raw);
  const first = clean.indexOf(quote);
  if (first === -1) throw new Error(`quote not found in document: "${quote}"`);
  if (clean.indexOf(quote, first + 1) !== -1) {
    throw new Error(`quote is ambiguous (appears more than once): "${quote}" — add more context`);
  }
  return { start: first, end: first + quote.length };
}

/**
 * `tether edit <file> --quote "old" --to "new"` — replace a unique prose span with new
 * text in CLEAN space, preserving the comment layer. The agent's primary edit primitive:
 * editing the raw `.md` directly trips over markers interleaved in the prose.
 */
export function runEdit(raw: string, quote: string, to: string): string {
  const { start, end } = locateQuote(raw, quote);
  return replaceClean(raw, start, end, to);
}

/** `tether comment resolve <id>` — mark a comment resolved (e.g. after the agent acts). */
export function runCommentResolve(raw: string, id: string): string {
  return setCommentStatus(raw, id, "resolved");
}

/** `tether comment remove <id>` — delete a comment (marker + record). */
export function runCommentRemove(raw: string, id: string): string {
  if (!project(raw).store.some((r) => r.id === id)) {
    throw new RangeError(`comment ${id} not found`);
  }
  return removeComment(raw, id);
}

/** `tether comment suggest <id> --to "…"` — attach a proposed rewrite (suggestion mode). */
export function runCommentSuggest(raw: string, id: string, to: string): string {
  return setProposal(raw, id, to);
}

/** `tether comment accept <id>` — apply the proposal (or move, §2.7) and remove the comment. */
export function runCommentAccept(raw: string, id: string): string {
  const rec = project(raw).store.find((r) => r.id === id);
  if (rec && rec.kind === "comment" && rec.dest) return acceptMove(raw, id);
  return acceptProposal(raw, id);
}

/** `tether comment reject <id>` — discard the proposal + comment. */
export function runCommentReject(raw: string, id: string): string {
  return runCommentRemove(raw, id);
}

export interface StatusReport {
  counts: {
    total: number;
    open: number;
    needsReview: number;
    orphaned: number;
    resolved: number;
    byAuthor: Record<string, number>;
  };
  /** Comments carrying a proposal (each is Accept-able / Reject-able). */
  proposals: number;
  /** Comments carrying a move destination (§2.7; each is Accept-able / Reject-able). */
  moves: number;
  orphans: string[];
  needsReview: string[];
}

/**
 * `tether status <file>` — one-glance summary. A comment's EFFECTIVE status is "resolved"
 * when the human marked it so (done is done — anchor decay on a resolved comment is not a
 * failure); otherwise it is the LIVE anchor status (open/needs-review/orphaned). The
 * orphans/needsReview lists are exactly the comments whose proposals accept would refuse.
 */
export function runStatus(raw: string): StatusReport {
  const { store } = project(raw);
  const anchors = new Map(resolveAll(raw).map((a) => [a.id, a]));
  const counts = { total: store.length, open: 0, needsReview: 0, orphaned: 0, resolved: 0, byAuthor: {} as Record<string, number> };
  const orphans: string[] = [];
  const needsReview: string[] = [];
  let proposals = 0;
  let moves = 0;
  for (const r of store) {
    counts.byAuthor[r.author] = (counts.byAuthor[r.author] ?? 0) + 1;
    if (r.proposal !== undefined) proposals += 1;
    const effective = r.status === "resolved" ? "resolved" : anchors.get(r.id)!.status;
    // "moves pending" means actionable: a human-resolved move is done, not pending.
    if (r.kind === "comment" && r.dest !== undefined && effective !== "resolved") moves += 1;
    if (effective === "resolved") counts.resolved += 1;
    else if (effective === "open") counts.open += 1;
    else if (effective === "needs-review") {
      counts.needsReview += 1;
      needsReview.push(r.id);
    } else {
      counts.orphaned += 1;
      orphans.push(r.id);
    }
  }
  return { counts, proposals, moves, orphans, needsReview };
}

/** Human rendering of a StatusReport — a few terse lines, one glance. */
export function formatStatus(file: string, r: StatusReport): string {
  const c = r.counts;
  if (c.total === 0) return `${file}: no comments`;
  const lines = [
    `${file}: ${c.total} comment${c.total === 1 ? "" : "s"} (${c.open} open, ${c.needsReview} needs-review, ${c.orphaned} orphaned, ${c.resolved} resolved)`,
    `authors: ${Object.entries(c.byAuthor)
      .map(([a, n]) => `${a} ${n}`)
      .join(", ")}`,
    `proposals pending: ${r.proposals}`,
  ];
  if (r.moves > 0) lines.push(`moves pending: ${r.moves}`);
  const broken = [...r.orphans.map((id) => `${id} orphaned`), ...r.needsReview.map((id) => `${id} needs-review`)];
  lines.push(broken.length > 0 ? `anchor health: ${broken.join(", ")}` : "anchor health: ok");
  return lines.join("\n");
}

export interface DiffReport {
  id: string;
  /** The text the proposal was written against (the recorded quote selector). */
  quote: string;
  /** What the anchor resolves to NOW — null when orphaned. */
  current: string | null;
  proposal: string;
  anchorStatus: "open" | "needs-review" | "orphaned";
  /** Comment body — header of the human rendering (not part of the --json shape). */
  body: string;
}

/**
 * `tether comment diff <file> <id>` — preview a proposal before accepting. `current` is
 * what accept would actually replace; when it differs from `quote` (the span was edited
 * since the proposal was written), acceptProposal refuses — this diff surfaces that first.
 */
export function runCommentDiff(raw: string, id: string): DiffReport {
  const proj = project(raw);
  const rec = proj.store.find((r) => r.id === id);
  if (!rec) throw new RangeError(`comment ${id} not found`);
  if (rec.kind === "comment" && rec.dest) {
    throw new RangeError(`comment ${id} is a move (no proposal text to diff) — see \`comment list\` for its destination`);
  }
  if (rec.proposal === undefined) throw new RangeError(`comment ${id} has no proposal to preview`);
  const anchor = resolveAll(raw).find((a) => a.id === id)!;
  const current = anchor.range ? proj.clean.slice(anchor.range.start, anchor.range.end) : null;
  return { id, quote: rec.target.quote.exact, current, proposal: rec.proposal, anchorStatus: anchor.status, body: rec.body };
}

/** Human rendering of a DiffReport — body as header, then minimal unified-style -/+. */
export function formatDiff(d: DiffReport): string {
  const minus =
    d.current === null
      ? `- (orphaned — original quote: ${JSON.stringify(d.quote)})`
      : d.current
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n");
  const plus = d.proposal
    .split("\n")
    .map((l) => `+ ${l}`)
    .join("\n");
  return `${d.body}\n${minus}\n${plus}`;
}
