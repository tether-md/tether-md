import { describe, it, expect } from "vitest";
import { insertComment, project, resolveAll } from "../src/index.js";

// §4: offsets are UTF-16 code units (astral chars count as 2, CJK as 1).
const CLEAN = "结果 😀 We showed 日本語 results on the 数据集 benchmark 🎯 end.";

describe("UTF-16 offset handling (§4)", () => {
  it("clean-export is byte-identical for an emoji/CJK document", () => {
    const start = CLEAN.indexOf("showed");
    const { raw } = insertComment(CLEAN, {
      trust: "fact",
      kind: "comment",
      author: "human",
      body: "claim-strength",
      now: 1_750_000_000_000,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      cleanStart: start,
      cleanEnd: start + 6,
    });
    expect(project(raw).clean).toBe(CLEAN);
  });

  it("the marker hint lands on the correct UTF-16 offset past astral chars", () => {
    const start = CLEAN.indexOf("results");
    const { raw } = insertComment(CLEAN, {
      trust: "fact",
      kind: "comment",
      author: "human",
      body: "note",
      now: 1_750_000_000_000,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      cleanStart: start,
      cleanEnd: start + 7,
    });
    const a = resolveAll(raw)[0];
    expect(a.status).toBe("open");
    expect(a.range).toEqual({ start, end: start + 7 });
    // sanity: the resolved slice is exactly the word, despite emoji/CJK before it
    expect(project(raw).clean.slice(a.range!.start, a.range!.end)).toBe("results");
  });
});
