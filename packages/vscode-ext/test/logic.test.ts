import { describe, it, expect, vi } from "vitest";
import { setProposal } from "@tether-md/kernel";
import {
  addCommentFromSelection,
  selectionToClean,
  buildDecorationModel,
  anchoredComments,
  cleanExportPath,
  minimalEdit,
  suggestionMarkdown,
  Debouncer,
} from "../src/logic.js";

const CLEAN = "We showed that the method improves recall.";
const add = (raw: string, s: number, e: number) =>
  addCommentFromSelection(raw, s, e, { body: "soften?", trust: "fact", kind: "comment", author: "human" });

describe("vscode-ext pure logic", () => {
  it("addCommentFromSelection maps a raw selection to a clean anchor and preserves clean", () => {
    const { raw, id } = add(CLEAN, 3, 9); // "showed"
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const model = buildDecorationModel(raw);
    expect(model.anchored).toHaveLength(1);
    // the anchored raw range hugs exactly the prose word, not the marker
    expect(raw.slice(model.anchored[0].start, model.anchored[0].end)).toBe("showed");
  });

  it("selectionToClean maps a raw offset past a marker back to clean space", () => {
    const { raw } = add(CLEAN, 3, 9);
    // In raw, "improves" sits after the inserted marker; its raw offset must map
    // back to its clean offset (kernel anchors in clean space).
    const rawIdx = raw.indexOf("improves");
    const { cleanStart } = selectionToClean(raw, rawIdx, rawIdx + 8);
    expect(cleanStart).toBe(CLEAN.indexOf("improves"));
  });

  it("buildDecorationModel dims the comment layer (markers + store)", () => {
    const { raw } = add(CLEAN, 3, 9);
    const model = buildDecorationModel(raw);
    // at least the inline marker and the store block
    expect(model.commentLayer.length).toBeGreaterThanOrEqual(2);
    // a comment-layer range covers a marker
    const coversMarker = model.commentLayer.some((r) => raw.slice(r.start, r.end).startsWith("<!--tether:c="));
    expect(coversMarker).toBe(true);
  });

  it("anchoredComments exposes body/trust/status at the anchored range", () => {
    const { raw } = add(CLEAN, 3, 9);
    const comments = anchoredComments(raw);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("soften?");
    expect(comments[0].status).toBe("open");
    expect(raw.slice(comments[0].range.start, comments[0].range.end)).toBe("showed");
  });

  it("anchoredComments surfaces a proposal (for suggestion-thread rendering)", () => {
    const { raw, id } = add(CLEAN, 3, 9);
    const out = setProposal(raw, id, "demonstrated");
    const comments = anchoredComments(out);
    expect(comments[0].proposal).toBe("demonstrated");
  });

  it("cleanExportPath derives a named sibling file (not an untitled buffer)", () => {
    expect(cleanExportPath("/a/b/essay.md")).toBe("/a/b/essay.clean.md");
    expect(cleanExportPath("/a/b/essay")).toBe("/a/b/essay.clean.md");
    expect(cleanExportPath("/a/b.dir/essay.markdown")).toBe("/a/b.dir/essay.clean.markdown");
  });

  it("rejects a selection that lies inside the comment layer (collapsed span)", () => {
    const { raw } = add(CLEAN, 3, 9);
    const storeIdx = raw.indexOf("<!--tether:store");
    expect(storeIdx).toBeGreaterThan(0);
    expect(() => add(raw, storeIdx + 5, storeIdx + 30)).toThrow(/comment layer|clean prose/);
  });

  it("a comment whose anchored prose was edited away is reported as orphaned (loud)", () => {
    const { raw } = add(CLEAN, 3, 9); // anchors "showed"
    // Mutate ONLY the prose occurrence (same length so offsets are stable); the store
    // copy of the quote is untouched, so it can no longer re-anchor.
    const broken = raw.replace("showed", "ZZZZZZ");
    const model = buildDecorationModel(broken);
    expect(model.anchored).toHaveLength(0);
    expect(model.orphaned).toHaveLength(1);
    expect(model.orphaned[0].quote).toBe("showed");
  });

  it("a fuzzily re-anchored comment lands in needsReview with banded confidence", () => {
    const TWO = "We showed that it works today. They showed nothing else at all.";
    const { raw } = addCommentFromSelection(TWO, 3, 9, { body: "x", trust: "fact", kind: "comment", author: "human" });
    // Kill the recorded context (prefix + suffix) around the FIRST "showed" while the second
    // exact occurrence keeps the match ambiguous — banded fuzzy score in [0.50, 0.75).
    // Each .replace hits the prose occurrence (the store copy is later in the file).
    const drifted = raw
      .replace("We ", "Qz ")
      .replace("that it works today", "xxxx xx xxxxx xxxxx")
      .replace("They", "TgeY");
    const model = buildDecorationModel(drifted);
    expect(model.anchored).toHaveLength(0);
    expect(model.orphaned).toHaveLength(0);
    expect(model.needsReview).toHaveLength(1);
    const nr = model.needsReview[0];
    expect(nr.confidence).toBeGreaterThanOrEqual(0.5);
    expect(nr.confidence).toBeLessThan(0.75);
    expect(drifted.slice(nr.range.start, nr.range.end)).toBe("showed");
    const [c] = anchoredComments(drifted);
    expect(c.status).toBe("needs-review");
  });

  it("anchoredComments reports current-vs-quote drift after a fuzzy re-anchor", () => {
    const { raw, id } = add(CLEAN, 3, 9);
    const withProposal = setProposal(raw, id, "demonstrated");
    // One same-length typo in the prose: re-anchors "open" (high confidence) but the span no
    // longer reads as quoted — exactly the case where kernel acceptProposal refuses.
    const drifted = withProposal.replace("showed", "sh0wed");
    const [c] = anchoredComments(drifted);
    expect(c.status).toBe("open");
    expect(c.quote).toBe("showed");
    expect(c.current).toBe("sh0wed");
    expect(suggestionMarkdown(c.current, c.quote, c.proposal!)).toContain("Accept will refuse");
  });
});

describe("suggestionMarkdown (diff-before-Accept)", () => {
  it("renders the header and a diff block of - current / + proposal", () => {
    const md = suggestionMarkdown("old text", "old text", "new text");
    expect(md).toContain("$(git-compare) **Suggested change**");
    expect(md).toContain("```diff\n- old text\n+ new text\n```");
    expect(md).not.toContain("Accept will refuse");
  });

  it("handles multi-line spans: one -/+ line per source line", () => {
    const md = suggestionMarkdown("a\nb", "a\nb", "c\nd\ne");
    expect(md).toContain("- a\n- b\n+ c\n+ d\n+ e");
  });

  it("warns when the anchored text has drifted from the recorded quote", () => {
    const md = suggestionMarkdown("current text", "quoted text", "proposal");
    expect(md).toContain("⚠ span changed since proposed — Accept will refuse; re-run the agent");
  });

  it("sizes the fence past any backtick run in the content", () => {
    const md = suggestionMarkdown("has ``` fence", "has ``` fence", "x");
    expect(md).toContain("````diff\n"); // 4 backticks > the 3 inside
    expect(md.trimEnd().endsWith("````")).toBe(true);
  });
});

describe("minimalEdit", () => {
  const apply = (old: string, e: { start: number; end: number; text: string }) =>
    old.slice(0, e.start) + e.text + old.slice(e.end);

  it("empty -> something inserts everything", () => {
    expect(minimalEdit("", "abc")).toEqual({ start: 0, end: 0, text: "abc" });
  });

  it("something -> empty deletes everything", () => {
    expect(minimalEdit("abc", "")).toEqual({ start: 0, end: 3, text: "" });
  });

  it("identical texts yield a zero-length no-op edit", () => {
    const e = minimalEdit("same", "same");
    expect(e.start).toBe(e.end);
    expect(e.text).toBe("");
  });

  it("trims common prefix and suffix to the changed middle", () => {
    const oldText = "We showed that";
    const newText = "We demonstrated that";
    const e = minimalEdit(oldText, newText);
    expect(e).toEqual({ start: 3, end: 7, text: "demonstrat" });
    expect(apply(oldText, e)).toBe(newText);
  });

  it("appending (the store-write case) touches only the tail", () => {
    const oldText = "prose body\n";
    const newText = "prose body\n<!--tether:store-->";
    const e = minimalEdit(oldText, newText);
    expect(e.start).toBe(oldText.length);
    expect(apply(oldText, e)).toBe(newText);
  });

  it("does not split a surrogate pair at the prefix boundary", () => {
    // 😀 and 😂 share the high surrogate \uD83D — a naive prefix trim would cut the pair.
    const e = minimalEdit("a\u{1F600}b", "a\u{1F602}b");
    expect(e).toEqual({ start: 1, end: 3, text: "\u{1F602}" });
    expect(apply("a\u{1F600}b", e)).toBe("a\u{1F602}b");
  });

  it("does not split a surrogate pair at the suffix boundary", () => {
    // U+1F600 and U+1FA00 share the LOW surrogate \uDE00 — a naive suffix trim would keep it.
    const e = minimalEdit("\u{1F600}", "\u{1FA00}");
    expect(e).toEqual({ start: 0, end: 2, text: "\u{1FA00}" });
    expect(apply("\u{1F600}", e)).toBe("\u{1FA00}");
  });
});

describe("Debouncer (ghost-thread guard)", () => {
  it("fires once after the delay, superseding earlier schedules for the same key", () => {
    vi.useFakeTimers();
    try {
      const d = new Debouncer();
      const calls: string[] = [];
      d.schedule("k", () => calls.push("a"), 200);
      d.schedule("k", () => calls.push("b"), 200);
      vi.advanceTimersByTime(199);
      expect(calls).toEqual([]);
      expect(d.pending("k")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(calls).toEqual(["b"]);
      expect(d.pending("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel drops a pending call (close between schedule and fire)", () => {
    vi.useFakeTimers();
    try {
      const d = new Debouncer();
      const calls: string[] = [];
      d.schedule("doc", () => calls.push("ghost"), 200);
      d.cancel("doc");
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual([]);
      expect(d.pending("doc")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys are independent; cancelAll clears every pending call", () => {
    vi.useFakeTimers();
    try {
      const d = new Debouncer();
      const calls: string[] = [];
      d.schedule("a", () => calls.push("a"), 100);
      d.schedule("b", () => calls.push("b"), 100);
      d.cancel("a");
      vi.advanceTimersByTime(100);
      expect(calls).toEqual(["b"]);
      d.schedule("c", () => calls.push("c"), 100);
      d.schedule("d", () => calls.push("d"), 100);
      d.cancelAll();
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual(["b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
