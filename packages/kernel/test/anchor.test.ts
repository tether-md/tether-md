import { describe, it, expect } from "vitest";
import { resolveQuote } from "../src/index.js";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const q = (exact: string, prefix = "", suffix = "") => ({ exact, prefix, suffix });

describe("anchoring resolution order (§7) + confidence bands (D3)", () => {
  it("1. marker locality + exact quote -> open, confidence 1.0", () => {
    const clean = "aaa target bbb";
    const hint = clean.indexOf("target");
    const a = resolveQuote(clean, q("target", "aaa ", " bbb"), ID, hint);
    expect(a.status).toBe("open");
    expect(a.confidence).toBe(1.0);
    expect(a.range).toEqual({ start: hint, end: hint + 6 });
  });

  it("2. unique exact match -> open even with a stale hint", () => {
    const clean = "The method improves recall.";
    const a = resolveQuote(clean, q("improves", "method ", " recall"), ID, 999);
    expect(a.status).toBe("open");
    expect(a.confidence).toBe(1.0);
    expect(a.range).toEqual({ start: clean.indexOf("improves"), end: clean.indexOf("improves") + 8 });
  });

  it("2b. multiple exact matches -> disambiguated by prefix context", () => {
    const clean = "cat dog cat";
    const a = resolveQuote(clean, q("cat", "dog ", ""), ID);
    expect(a.range).toEqual({ start: 8, end: 11 }); // the 'cat' preceded by 'dog '
    expect(a.status).toBe("open");
  });

  it("3a. fuzzy reattach across a small edit -> open (>= 0.75)", () => {
    const clean = "The method improved recall on the held-out set.";
    const a = resolveQuote(clean, q("improves recall", "method ", " on the"), ID);
    expect(a.status).toBe("open");
    expect(a.confidence).toBeGreaterThanOrEqual(0.75);
    expect(a.range).not.toBeNull();
  });

  it("3b. fuzzy match with lost context -> needs-review (0.50-0.75)", () => {
    const clean = "zzzzz improvments qqqqq";
    const a = resolveQuote(clean, q("improvements", "NOPRE", "NOSUF"), ID);
    expect(a.status).toBe("needs-review");
    expect(a.confidence).toBeGreaterThanOrEqual(0.5);
    expect(a.confidence).toBeLessThan(0.75);
    expect(a.range).not.toBeNull();
  });

  it("3c. no plausible match -> orphaned (loud), range null", () => {
    const a = resolveQuote("totally unrelated content here", q("xyzzyplugh", "a", "b"), ID);
    expect(a.status).toBe("orphaned");
    expect(a.range).toBeNull();
  });

  it("short-anchor guard: a 2-char quote does not over-match a near neighbor", () => {
    const a = resolveQuote("xy ac zz", q("ab"), ID);
    expect(a.status).toBe("orphaned"); // must NOT reattach to 'ac'
  });
});
