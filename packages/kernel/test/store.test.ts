import { describe, it, expect } from "vitest";
import { parseStore, serializeStore, StoreError, type Record } from "../src/index.js";

const rec = (id: string): Record => ({
  id,
  v: 1,
  trust: "fact",
  kind: "comment",
  author: "human",
  body: "note with -- dashes and a trailing dash-",
  status: "open",
  created: "2026-06-24T12:00:00Z",
  target: { quote: { exact: "x", prefix: "", suffix: "" }, position: { start: 0, end: 1 } },
});

describe("store block (§2.2)", () => {
  it("serialize then parse round-trips records", () => {
    const records = [rec("01ARZ3NDEKTSV4RRFFQ69G5FAV"), rec("01ARZ3NDEKTSV4RRFFQ69G5FB1")];
    const block = serializeStore(records);
    // The record lines (between the sentinels) must contain no `--`; the
    // `<!--`/`-->` sentinels are the comment delimiters themselves.
    for (const line of block.split("\n").slice(1, -1)) {
      expect(line).not.toContain("--");
    }
    const raw = "prose body\n" + block;
    const span = parseStore(raw);
    expect(span?.records).toEqual(records);
  });

  it("absorbs one preceding newline into the stripped region", () => {
    const block = serializeStore([rec("01ARZ3NDEKTSV4RRFFQ69G5FAV")]);
    const raw = "prose\n" + block; // one separator newline
    const span = parseStore(raw)!;
    // rawStart should point at the separator newline, not at '<'
    expect(raw[span.rawStart]).toBe("\n");
    expect(raw.slice(0, span.rawStart)).toBe("prose");
  });

  it("returns null when there is no store block", () => {
    expect(parseStore("just prose, no store")).toBeNull();
  });

  it("hard-fails on a duplicate store block", () => {
    const block = serializeStore([rec("01ARZ3NDEKTSV4RRFFQ69G5FAV")]);
    const raw = block + "\n" + block;
    expect(() => parseStore(raw)).toThrow(StoreError);
  });

  it("hard-fails when the store is not the last thing in the file", () => {
    const block = serializeStore([rec("01ARZ3NDEKTSV4RRFFQ69G5FAV")]);
    const raw = block + "\ntrailing prose";
    expect(() => parseStore(raw)).toThrow(/last thing/);
  });

  it("hard-fails on an unterminated store block", () => {
    const raw = "<!--tether:store\n{}\n"; // no closing sentinel
    expect(() => parseStore(raw)).toThrow(StoreError);
  });
});
