import { describe, it, expect } from "vitest";
import {
  runProject,
  runExport,
  runCommentList,
  runCommentAdd,
  runCommentResolve,
  runCommentRemove,
  runCommentSuggest,
  runCommentDiff,
  runEdit,
  runStatus,
  formatStatus,
  formatDiff,
  locateQuote,
} from "../src/commands.js";

const CLEAN = "We showed that the method improves recall.";

/** Comment on "the method improves" with a proposal attached (base for status/diff tests). */
function withProposal(): { raw: string; id: string } {
  const added = runCommentAdd(CLEAN, {
    start: CLEAN.indexOf("the method improves"),
    end: CLEAN.indexOf("the method improves") + "the method improves".length,
    body: "hedge",
    trust: "fact",
    kind: "comment",
    author: "human",
  });
  return { raw: runCommentSuggest(added.raw, added.id, "the method may improve"), id: added.id };
}

/**
 * Break the anchor into needs-review: 1 edit inside the quote, prefix+suffix destroyed.
 * Fuzzy score ≈ (50·18/19 + 0 + 0 + 2)/92 ≈ 0.54 — inside the [0.50, 0.75) band.
 */
function driftToNeedsReview(raw: string): string {
  return raw.replace("We showed that ", "Qx zvbnm kpwtr ").replace("improves", "improve").replace(" recall.", " zzkqw.");
}

describe("CLI command functions", () => {
  it("export returns the clean document", () => {
    const added = runCommentAdd(CLEAN, {
      start: 3,
      end: 9,
      body: "check this",
      trust: "fact",
      kind: "comment",
      author: "human",
    });
    expect(runExport(added.raw)).toBe(CLEAN);
  });

  it("project returns parseable JSON with clean + store + markers", () => {
    const added = runCommentAdd(CLEAN, {
      start: 3,
      end: 9,
      body: "b",
      trust: "fact",
      kind: "comment",
      author: "human",
    });
    const proj = JSON.parse(runProject(added.raw));
    expect(proj.clean).toBe(CLEAN);
    expect(proj.store).toHaveLength(1);
    expect(proj.markers).toHaveLength(1);
  });

  it("comment list joins each record with its resolved anchor", () => {
    const added = runCommentAdd(CLEAN, {
      start: 3,
      end: 9,
      body: "Background says 'suggested'",
      trust: "interpretation",
      kind: "comment",
      author: "agent",
    });
    const list = JSON.parse(runCommentList(added.raw));
    expect(list).toHaveLength(1);
    expect(list[0].quote).toBe("showed");
    expect(list[0].trust).toBe("interpretation");
    expect(list[0].author).toBe("agent");
    expect(list[0].anchor.status).toBe("open");
    expect(list[0].anchor.range).toEqual({ start: 3, end: 9 });
  });

  it("locateQuote finds a unique span and rejects missing/ambiguous", () => {
    expect(locateQuote(CLEAN, "showed")).toEqual({ start: 3, end: 9 });
    expect(() => locateQuote(CLEAN, "zzz")).toThrow(/not found/);
    expect(() => locateQuote("a a a", "a")).toThrow(/ambiguous/);
  });

  it("resolve marks a comment resolved; remove restores the clean file", () => {
    const added = runCommentAdd(CLEAN, {
      start: 3,
      end: 9,
      body: "b",
      trust: "fact",
      kind: "comment",
      author: "human",
    });
    const resolved = runCommentResolve(added.raw, added.id);
    expect(JSON.parse(runCommentList(resolved))[0].status).toBe("resolved");

    const removed = runCommentRemove(added.raw, added.id);
    expect(runExport(removed)).toBe(CLEAN);
    expect(JSON.parse(runCommentList(removed))).toHaveLength(0);
  });

  it("comment add round-trips: add then export is byte-identical", () => {
    const added = runCommentAdd(CLEAN, {
      start: 0,
      end: 2,
      body: "subject",
      trust: "fact",
      kind: "comment",
      author: "human",
    });
    expect(added.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(runExport(added.raw)).toBe(CLEAN);
  });
});

describe("status", () => {
  it("counts by status/author, proposals, healthy anchors", () => {
    const { raw } = withProposal();
    const two = runCommentAdd(raw, { start: 0, end: 2, body: "subject", trust: "fact", kind: "comment", author: "agent" });
    const r = runStatus(two.raw);
    expect(r.counts).toEqual({ total: 2, open: 2, needsReview: 0, orphaned: 0, resolved: 0, byAuthor: { human: 1, agent: 1 } });
    expect(r.proposals).toBe(1);
    expect(r.orphans).toEqual([]);
    expect(r.needsReview).toEqual([]);
  });

  it("an orphaned anchor is counted and listed by id", () => {
    const { raw, id } = withProposal();
    // Rewrite the prose out from under the anchor (marker survives; the quote is gone).
    const broken = raw.replace("the method improves recall.", "completely different words are here now.");
    const r = runStatus(broken);
    expect(r.counts.orphaned).toBe(1);
    expect(r.orphans).toEqual([id]);
  });

  it("a needs-review anchor is counted and listed by id", () => {
    const { raw, id } = withProposal();
    const r = runStatus(driftToNeedsReview(raw));
    expect(r.counts.needsReview).toBe(1);
    expect(r.needsReview).toEqual([id]);
    expect(r.counts.open).toBe(0);
  });

  it("resolved wins over anchor decay (done is done — not a check failure)", () => {
    const { raw, id } = withProposal();
    const broken = runCommentResolve(raw, id).replace("the method improves recall.", "completely different words are here now.");
    const r = runStatus(broken);
    expect(r.counts.resolved).toBe(1);
    expect(r.counts.orphaned).toBe(0);
    expect(r.orphans).toEqual([]);
  });

  it("formatStatus renders terse lines, and a no-comments one-liner", () => {
    const { raw, id } = withProposal();
    const broken = raw.replace("the method improves recall.", "completely different words are here now.");
    const text = formatStatus("doc.md", runStatus(broken));
    expect(text).toContain("doc.md: 1 comment (0 open, 0 needs-review, 1 orphaned, 0 resolved)");
    expect(text).toContain("authors: human 1");
    expect(text).toContain("proposals pending: 1");
    expect(text).toContain(`anchor health: ${id} orphaned`);
    expect(formatStatus("doc.md", runStatus(CLEAN))).toBe("doc.md: no comments");
  });
});

describe("comment diff", () => {
  it("returns quote/current/proposal/anchorStatus for a clean anchor", () => {
    const { raw, id } = withProposal();
    const d = runCommentDiff(raw, id);
    expect(d).toMatchObject({
      id,
      quote: "the method improves",
      current: "the method improves",
      proposal: "the method may improve",
      anchorStatus: "open",
      body: "hedge",
    });
  });

  it("current reflects drifted text — exactly what acceptProposal refuses on", () => {
    const { raw, id } = withProposal();
    // Clean-space edit INSIDE the anchored span: the anchor re-attaches (open) but the
    // span no longer reads as quoted, so accept would refuse. diff must surface that.
    const drifted = runEdit(raw, "improves", "improved");
    const d = runCommentDiff(drifted, id);
    expect(d.anchorStatus).toBe("open");
    expect(d.quote).toBe("the method improves");
    expect(d.current).toBe("the method improved");
  });

  it("orphaned anchor yields current: null", () => {
    const { raw, id } = withProposal();
    const broken = raw.replace("the method improves recall.", "completely different words are here now.");
    const d = runCommentDiff(broken, id);
    expect(d.anchorStatus).toBe("orphaned");
    expect(d.current).toBeNull();
  });

  it("throws when the comment has no proposal, or does not exist", () => {
    const added = runCommentAdd(CLEAN, { start: 3, end: 9, body: "b", trust: "fact", kind: "comment", author: "human" });
    expect(() => runCommentDiff(added.raw, added.id)).toThrow(/no proposal/);
    expect(() => runCommentDiff(added.raw, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(/not found/);
  });

  it("formatDiff renders body header + -/+ lines; orphaned shows the original quote", () => {
    const { raw, id } = withProposal();
    expect(formatDiff(runCommentDiff(raw, id))).toBe("hedge\n- the method improves\n+ the method may improve");
    const broken = raw.replace("the method improves recall.", "completely different words are here now.");
    expect(formatDiff(runCommentDiff(broken, id))).toContain('- (orphaned — original quote: "the method improves")');
  });
});

describe("comment list filters", () => {
  function twoComments(): string {
    const a = runCommentAdd(CLEAN, { start: 0, end: 2, body: "one", trust: "fact", kind: "comment", author: "human" });
    const b = runCommentAdd(a.raw, { start: 3, end: 9, body: "two", trust: "interpretation", kind: "comment", author: "agent" });
    return runCommentResolve(b.raw, a.id);
  }

  it("filters by status, author, kind — and combinations", () => {
    const raw = twoComments();
    expect(JSON.parse(runCommentList(raw))).toHaveLength(2);
    expect(JSON.parse(runCommentList(raw, { status: ["open"] }))[0].body).toBe("two");
    expect(JSON.parse(runCommentList(raw, { status: ["open", "resolved"] }))).toHaveLength(2);
    expect(JSON.parse(runCommentList(raw, { author: "human" }))[0].body).toBe("one");
    expect(JSON.parse(runCommentList(raw, { kind: "comment" }))).toHaveLength(2);
    expect(JSON.parse(runCommentList(raw, { kind: "gate-finding" }))).toHaveLength(0);
    expect(JSON.parse(runCommentList(raw, { status: ["open"], author: "human" }))).toHaveLength(0);
  });
});
