import { describe, it, expect } from "vitest";
import { insertComment, removeComment, project, resolveAll } from "../src/index.js";

const CLEAN = "We showed that the method improves recall on the benchmark.";
const opts = (over: Partial<Parameters<typeof insertComment>[1]> = {}) => ({
  cleanStart: 3,
  cleanEnd: 9, // "showed"
  trust: "fact" as const,
  kind: "comment" as const,
  author: "human" as const,
  body: "Background says 'suggested'.",
  now: 1_750_000_000_000,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ...over,
});

describe("comment write operations", () => {
  it("captures the right selector and leaves clean unchanged", () => {
    const { raw, record } = insertComment(CLEAN, opts());
    expect(record.target.quote.exact).toBe("showed");
    expect(record.target.quote.prefix).toBe("We ");
    expect(record.target.quote.suffix.startsWith(" that the method")).toBe(true);
    expect(record.target.position).toEqual({ start: 3, end: 9 });
    expect(project(raw).clean).toBe(CLEAN);
  });

  it("creates a store on first insert and appends on the second", () => {
    const a = insertComment(CLEAN, opts());
    const b = insertComment(a.raw, opts({ id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", cleanStart: 33, cleanEnd: 39 }));
    const proj = project(b.raw);
    expect(proj.store).toHaveLength(2);
    expect(proj.clean).toBe(CLEAN);
    // exactly one store block
    expect(b.raw.match(/<!--tether:store/g)).toHaveLength(1);
  });

  it("resolveAll re-anchors a freshly inserted comment to its own span", () => {
    const { raw } = insertComment(CLEAN, opts());
    const anchors = resolveAll(raw);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].status).toBe("open");
    expect(anchors[0].confidence).toBe(1.0);
    expect(anchors[0].range).toEqual({ start: 3, end: 9 });
  });

  it("removeComment strips the marker and its record, restoring the file", () => {
    const { raw } = insertComment(CLEAN, opts());
    const back = removeComment(raw, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(back).toBe(CLEAN);
  });

  it("removeComment of one of two leaves the other intact", () => {
    const a = insertComment(CLEAN, opts());
    const b = insertComment(a.raw, opts({ id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", cleanStart: 33, cleanEnd: 39 }));
    const back = removeComment(b.raw, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const proj = project(back);
    expect(proj.store.map((r) => r.id)).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
    expect(proj.clean).toBe(CLEAN);
  });
});
