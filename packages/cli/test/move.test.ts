import { describe, it, expect } from "vitest";
import { insertComment, setCommentStatus } from "@tether-md/kernel";
import { runCommentAccept, runCommentDiff, runCommentList, runStatus, formatStatus } from "../src/commands.js";

const DOC = "Alpha paragr.\n\nBravo paragr.\n\nCharlie parag.";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const withMove = () =>
  insertComment(DOC, {
    cleanStart: 15,
    cleanEnd: 28, // "Bravo paragr."
    trust: "interpretation",
    kind: "comment",
    author: "human",
    body: "Move this text here.",
    now: 1_750_000_000_000,
    id: ID,
    dest: { cleanStart: 0, cleanEnd: 13, side: "before" }, // before "Alpha paragr."
  }).raw;

describe("CLI move parity", () => {
  it("comment list surfaces moveTo with a resolved destination anchor", () => {
    const out = JSON.parse(runCommentList(withMove()));
    expect(out).toHaveLength(1);
    expect(out[0].moveTo.side).toBe("before");
    expect(out[0].moveTo.quote).toBe("Alpha paragr.");
    expect(out[0].moveTo.anchor.status).toBe("open");
  });

  it("comment accept routes a move to acceptMove", () => {
    const next = runCommentAccept(withMove(), ID);
    expect(next).toBe("Bravo paragr.\n\nAlpha paragr.\n\nCharlie parag.");
  });

  it("status counts pending moves and formatStatus surfaces them", () => {
    const report = runStatus(withMove());
    expect(report.moves).toBe(1);
    expect(formatStatus("doc.md", report)).toContain("moves pending: 1");
    // A doc without moves keeps the old rendering (no extra line).
    expect(formatStatus("doc.md", runStatus(DOC))).toBe("doc.md: no comments");
  });

  it("comment diff explains that a move has no proposal to diff", () => {
    expect(() => runCommentDiff(withMove(), ID)).toThrow(/is a move/);
  });

  it("a human-resolved move is no longer counted as pending", () => {
    const resolved = setCommentStatus(withMove(), ID, "resolved");
    const report = runStatus(resolved);
    expect(report.moves).toBe(0);
    expect(formatStatus("doc.md", report)).not.toContain("moves pending");
  });
});
