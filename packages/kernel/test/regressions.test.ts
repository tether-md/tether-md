import { describe, it, expect } from "vitest";
import {
  insertComment,
  removeComment,
  setCommentStatus,
  setProposal,
  acceptProposal,
  replaceClean,
  project,
  resolveAll,
  serializeStore,
  StoreError,
  parseStore,
  type Record,
} from "../src/index.js";

// Regression guards for the kernel-spec audit findings.

const CLEAN = "We showed that the new method improves recall on the benchmark by a wide margin.";
const base = { trust: "fact" as const, kind: "comment" as const, author: "human" as const, body: "n", now: 1_750_000_000_000 };
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

const rec = (id: string): Record => ({
  id,
  v: 1,
  trust: "fact",
  kind: "comment",
  author: "human",
  body: "n",
  status: "open",
  created: "2026-06-24T12:00:00Z",
  target: { quote: { exact: "x", prefix: "", suffix: "" }, position: { start: 0, end: 1 } },
});

describe("byte-identity: trailing whitespace after the store never leaks into clean (#1/#13)", () => {
  it("a final newline an editor appends does not drift clean-export", () => {
    const raw = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 }).raw;
    for (const trailing of ["", "\n", "\n\n", "  ", "\t\n"]) {
      expect(project(raw + trailing).clean).toBe(CLEAN);
    }
  });
  it("parseStore extends rawEnd over tolerated trailing whitespace to EOF", () => {
    const raw = "prose\n" + serializeStore([rec(A)]) + "\n";
    expect(parseStore(raw)!.rawEnd).toBe(raw.length);
  });
});

describe("Invariant 2: anchor stability under removal and insert-before (#9)", () => {
  it("removing a comment leaves clean byte-identical and the other anchor stable", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const b = insertComment(a.raw, { ...base, id: B, cleanStart: 30, cleanEnd: 38 });
    const aBefore = resolveAll(b.raw).find((x) => x.id === A)!;
    const back = removeComment(b.raw, B);
    expect(project(back).clean).toBe(CLEAN);
    const aAfter = resolveAll(back).find((x) => x.id === A)!;
    expect(aAfter.range).toEqual(aBefore.range);
    expect(aAfter.status).toBe(aBefore.status);
  });

  it("inserting a comment BEFORE another does not move the later anchor", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 30, cleanEnd: 38 });
    const aBefore = resolveAll(a.raw).find((x) => x.id === A)!;
    const b = insertComment(a.raw, { ...base, id: B, cleanStart: 3, cleanEnd: 9 }); // earlier span
    expect(project(b.raw).clean).toBe(CLEAN);
    const aAfter = resolveAll(b.raw).find((x) => x.id === A)!;
    expect(aAfter.range).toEqual(aBefore.range);
  });
});

describe("Invariant 3: export byte-identity edge cases (#10)", () => {
  it("empty document: P is identity and a zero-width anchor is rejected", () => {
    expect(project("").clean).toBe("");
    // You cannot anchor a comment to nothing — an empty span is rejected, not silently
    // turned into an immediately-orphaned empty-quote comment.
    expect(() => insertComment("", { ...base, id: A, cleanStart: 0, cleanEnd: 0 })).toThrow(RangeError);
  });

  it("a collapsed (zero-width) span is rejected on a non-empty doc too", () => {
    expect(() => insertComment(CLEAN, { ...base, id: A, cleanStart: 5, cleanEnd: 5 })).toThrow(/non-empty/);
  });

  it("with and without a trailing newline both round-trip exactly", () => {
    for (const raw0 of ["We showed results.\n", "We showed results."]) {
      const a = insertComment(raw0, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
      expect(project(a.raw).clean).toBe(raw0);
      expect(removeComment(a.raw, A)).toBe(raw0);
    }
  });

  it("two comments on the same span both round-trip", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const b = insertComment(a.raw, { ...base, id: B, cleanStart: 3, cleanEnd: 9 });
    expect(project(b.raw).clean).toBe(CLEAN);
    expect(project(b.raw).store).toHaveLength(2);
  });
});

describe("P hard-fails at the projection boundary, not just at parseStore (#11)", () => {
  const block = serializeStore([rec(A)]);
  it("project() throws StoreError on a duplicate store block", () => {
    expect(() => project(block + "\n" + block)).toThrow(StoreError);
  });
  it("project() throws StoreError when the store is not last", () => {
    expect(() => project(block + "\ntrailing prose")).toThrow(StoreError);
  });
});

describe("store schema validation hard-fails on non-conforming records (#4/#5)", () => {
  const wrap = (recordLine: string) => `<!--tether:store\n${recordLine}\ntether:store-->`;
  it("rejects an object missing required fields", () => {
    expect(() => project(wrap("{}"))).toThrow(StoreError);
  });
  it("rejects a non-ULID id", () => {
    expect(() => project(wrap('{"id":"not-a-ulid","v":1}'))).toThrow(/ULID/);
  });
  it("rejects an invalid enum value", () => {
    const r = { ...rec(A), trust: "bogus" as unknown as Record["trust"] };
    expect(() => project(wrap(JSON.stringify(r).replaceAll("-", "\\D")))).toThrow(/trust/);
  });
  it("rejects a gate-finding with no meta", () => {
    const r = { ...rec(A), kind: "gate-finding" as Record["kind"] };
    expect(() => project(wrap(JSON.stringify(r).replaceAll("-", "\\D")))).toThrow(/meta/);
  });
});

describe("store hard-fails on duplicate record ids", () => {
  it("two records sharing an id is a malformed store", () => {
    const block = serializeStore([rec(A), rec(A)]);
    expect(() => project("prose\n" + block)).toThrow(/duplicate record id/);
  });
});

describe("surrogate-pair guard: offsets must land on character boundaries (#14)", () => {
  it("rejects a cleanStart that splits an astral character", () => {
    const s = "a😀b"; // 😀 occupies UTF-16 indices 1..2
    expect(() => insertComment(s, { ...base, id: A, cleanStart: 2, cleanEnd: 3 })).toThrow(/surrogate/);
  });
  it("accepts offsets on the astral boundary", () => {
    const s = "a😀b";
    expect(() => insertComment(s, { ...base, id: A, cleanStart: 1, cleanEnd: 3 })).not.toThrow();
  });
});

describe("replaceClean (agent edits prose in clean space, markers preserved)", () => {
  // Two comments interleave markers through the sentence — a raw find/replace can't
  // match a clean span, but replaceClean edits one span and keeps the other comment.
  function twoComments() {
    let raw = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 }).raw; // "showed"
    const imp = CLEAN.indexOf("improves");
    raw = insertComment(raw, { ...base, id: B, cleanStart: imp, cleanEnd: imp + 8 }).raw; // "improves"
    return raw;
  }

  it("replaces one anchored span and leaves the other comment intact", () => {
    const raw = twoComments();
    const start = CLEAN.indexOf("showed");
    const next = replaceClean(raw, start, start + 6, "demonstrated");
    expect(project(next).clean).toBe(CLEAN.replace("showed", "demonstrated"));
    // the other comment (B, on "improves") still resolves
    const bAnchor = resolveAll(next).find((x) => x.id === B)!;
    expect(bAnchor.status).toBe("open");
    expect(project(next).clean.slice(bAnchor.range!.start, bAnchor.range!.end)).toBe("improves");
  });

  it("refuses to edit a span that overlaps another comment's marker", () => {
    const raw = twoComments();
    // span covering both "showed ... improves" contains B's marker
    const s = CLEAN.indexOf("showed");
    const e = CLEAN.indexOf("improves") + "improves".length;
    expect(() => replaceClean(raw, s, e, "x")).toThrow(/comment layer/);
  });

  it("a zero-width edit at a marker boundary inserts once and keeps one marker (#1)", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const out = replaceClean(a.raw, 3, 3, "X"); // offset 3 == the marker boundary
    expect(project(out).markers).toHaveLength(1);
    expect(project(out).clean).toBe(CLEAN.replace("showed", "Xshowed"));
  });

  it("rejects replacement text containing Tether markup (#2)", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const s = CLEAN.indexOf("showed");
    expect(() => replaceClean(a.raw, s, s + 6, `x<!--tether:c=${B}-->y`)).toThrow(/Tether markup/);
    expect(() => replaceClean(a.raw, s, s + 6, "x tether:store--> y")).toThrow(/Tether markup/);
  });

  it("rejects an edit span that splits a surrogate pair (#3)", () => {
    expect(() => replaceClean("a😀b", 2, 3, "x")).toThrow(/surrogate/);
  });
});

describe("suggestion mode (propose → accept/reject)", () => {
  it("setProposal attaches a proposal without changing clean", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const out = setProposal(a.raw, A, "demonstrated");
    expect(project(out).clean).toBe(CLEAN);
    expect(project(out).store[0].proposal).toBe("demonstrated");
  });

  it("acceptProposal applies the proposal to the span and removes the comment (no artifact)", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 }); // "showed"
    const accepted = acceptProposal(setProposal(a.raw, A, "demonstrated"), A);
    expect(project(accepted).clean).toBe(CLEAN.replace("showed", "demonstrated"));
    expect(project(accepted).store).toHaveLength(0);
    expect(accepted).not.toContain("tether:c="); // marker gone too
  });

  it("acceptProposal throws when there is no proposal", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    expect(() => acceptProposal(a.raw, A)).toThrow(/no proposal/);
  });

  it("setProposal rejects Tether markup and empty proposals", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    expect(() => setProposal(a.raw, A, `x<!--tether:c=${B}-->y`)).toThrow(/Tether markup/);
    expect(() => setProposal(a.raw, A, "")).toThrow(/non-empty/);
  });

  it("acceptProposal refuses a needs-review (fuzzy) anchor instead of corrupting mid-word", () => {
    // anchor "experimental setup", then edit the prose so it re-resolves needs-review.
    const doc = "The methodology describes our experimental setup in detail and at length here.";
    const start = doc.indexOf("experimental setup");
    const a = insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + "experimental setup".length });
    const proposed = setProposal(a.raw, A, "test rig");
    // mutate the anchored phrase so the quote no longer matches exactly
    const broken = proposed.replace("experimental setup", "experimental apparatus configuration");
    const anchor = resolveAll(broken).find((x) => x.id === A)!;
    expect(anchor.status).toBe("needs-review");
    expect(() => acceptProposal(broken, A)).toThrow(/needs-review|re-confirm/);
  });
});

describe("stale-Accept guard: a HIGH-confidence fuzzy reattach must not apply a proposal", () => {
  // The needs-review guard alone is not enough: a fuzzy reattach can score >= 0.75 and read
  // "open" while pointing at DIFFERENT text than the proposal was written to replace —
  // accepting there clobbered the human's newer wording mid-word (reproduced pre-fix:
  // "A very careREPLACEMENT SENTENCE.").
  const doc = "The committee approved the budget. Further review follows next week.";
  const quote = "The committee approved the budget.";
  const proposed = () =>
    setProposal(
      insertComment(doc, { ...base, id: A, cleanStart: 0, cleanEnd: quote.length }).raw,
      A,
      "REPLACEMENT SENTENCE.",
    );

  it("refuses when the anchored text changed, even at open-status fuzzy confidence", () => {
    const edited = proposed().replace("The committee", "A very careful committee");
    const anchor = resolveAll(edited).find((x) => x.id === A)!;
    expect(anchor.status).toBe("open"); // the hole: fuzzy >= 0.75 still reads "open"
    expect(anchor.confidence).toBeLessThan(1);
    expect(() => acceptProposal(edited, A)).toThrow(/changed since the proposal/);
    // and the refusal must leave the document untouched (throw, not partial apply)
    expect(project(edited).clean).toContain("A very careful committee");
  });

  it("still accepts when the edit was elsewhere and the span reads exactly as quoted", () => {
    const edited = proposed().replace("next week", "in two weeks");
    const accepted = acceptProposal(edited, A);
    expect(project(accepted).clean).toBe("REPLACEMENT SENTENCE. Further review follows in two weeks.");
    expect(project(accepted).store).toHaveLength(0);
  });
});

describe("code regions: markers never land inside code (Invariant 2 for code spans)", () => {
  it("anchoring inside inline code relocates the marker before the code span", () => {
    const doc = "Use `foo bar` here.";
    const start = doc.indexOf("bar");
    const a = insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 3 });
    expect(project(a.raw).clean).toBe(doc); // pre-fix: the marker leaked into clean
    expect(a.raw.indexOf("<!--tether:c=")).toBeLessThan(a.raw.indexOf("`"));
    const anchor = resolveAll(a.raw).find((x) => x.id === A)!;
    expect(anchor.status).toBe("open");
    expect(project(a.raw).clean.slice(anchor.range!.start, anchor.range!.end)).toBe("bar");
    expect(removeComment(a.raw, A)).toBe(doc);
  });

  it("anchoring inside a fenced block puts the marker at the end of the previous line", () => {
    const doc = "Intro line.\n\n```js\nconst x = 1;\n```\n\nOutro.";
    const start = doc.indexOf("const x");
    const a = insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 7 });
    expect(project(a.raw).clean).toBe(doc);
    // the fence line itself must be untouched (a marker joining it would break the fence)
    expect(a.raw).toContain("\n```js\n");
    const anchor = resolveAll(a.raw).find((x) => x.id === A)!;
    expect(anchor.status).toBe("open");
    expect(removeComment(a.raw, A)).toBe(doc);
  });

  it("anchoring at a fenced block's own first character relocates too", () => {
    const doc = "Intro line.\n\n```js\nconst x = 1;\n```\n\nOutro.";
    const start = doc.indexOf("```js");
    const a = insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 5 });
    expect(project(a.raw).clean).toBe(doc);
    expect(a.raw).toContain("\n```js\n");
    expect(removeComment(a.raw, A)).toBe(doc);
  });

  it("refuses to anchor inside a code region at the very start of the document", () => {
    const doc = "```\ncode\n```\n\nprose after.";
    const start = doc.indexOf("code");
    expect(() => insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 4 })).toThrow(
      /very start/,
    );
  });

  it("refuses when relocation would append to a code-terminated line (adjacent fences)", () => {
    const doc = "```a\nx\n```\n```b\ny\n```\n";
    const start = doc.indexOf("y");
    expect(() => insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 1 })).toThrow(
      /following another code region/,
    );
  });

  it("removeComment removes the real marker, not a literal copy inside a code span", () => {
    const doc = "See `<!--tether:c=" + A + "-->` as the literal example. More prose here.";
    const start = doc.indexOf("More prose");
    const a = insertComment(doc, { ...base, id: A, cleanStart: start, cleanEnd: start + 10 });
    expect(project(a.raw).clean).toBe(doc);
    // pre-fix: indexOf found the code-span literal first, emptied the code span, and left
    // the real marker dangling.
    expect(removeComment(a.raw, A)).toBe(doc);
  });
});

describe("setCommentStatus (agent marks a comment handled)", () => {
  it("marks a comment resolved without perturbing clean", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    const out = setCommentStatus(a.raw, A, "resolved");
    expect(project(out).clean).toBe(CLEAN);
    expect(project(out).store[0].status).toBe("resolved");
  });
  it("throws on an unknown id", () => {
    const a = insertComment(CLEAN, { ...base, id: A, cleanStart: 3, cleanEnd: 9 });
    expect(() => setCommentStatus(a.raw, B, "resolved")).toThrow(/not found/);
  });
});

describe("post-write guard: mutations that would expose the comment layer refuse loudly", () => {
  // Found by the property suite (see properties.test.ts header). One root cause: a write
  // that changes markdown block structure can re-parse markers/store into a code region,
  // where P preserves them — the guard refuses instead of corrupting the export.

  it("insert: a span starting on a closing-fence line would un-terminate the fence", () => {
    const doc = "a\n```\nb\n```\nc";
    const nl = doc.lastIndexOf("\nc"); // the newline ending the closing-fence line
    expect(() => insertComment(doc, { ...base, id: A, cleanStart: nl, cleanEnd: nl + 1 })).toThrow(RangeError);
  });

  it("accept: a proposal carrying a bare fence opener would swallow the store", () => {
    for (const fence of ["\n```", "\n~~~"]) {
      const a = insertComment("a b", { ...base, id: A, cleanStart: 0, cleanEnd: 1 });
      const withProp = setProposal(a.raw, A, fence);
      expect(() => acceptProposal(withProp, A)).toThrow(/comment layer becomes\s+visible/);
      expect(project(withProp).clean).toBe("a b"); // refusal left the document intact
    }
  });

  it("accept: a plain proposal whose splice re-contextualizes the doc's own fences", () => {
    // Replacing "the\n" with "the" deletes the newline that made "```" a fence opener,
    // flipping the doc's closing fence into an unterminated opener.
    const doc = "the\n```\nthe\n```";
    const a = insertComment(doc, { ...base, id: A, cleanStart: 0, cleanEnd: 4 });
    const withProp = setProposal(a.raw, A, "the");
    expect(() => acceptProposal(withProp, A)).toThrow(/comment layer becomes\s+visible/);
  });

  it("remove: refuses an order that would strand a marker inside re-paired inline code", () => {
    // A's line-start marker hides `b`'s inline code from remark, so B's marker lands
    // between the backticks. Removing A first would re-form the code span around B's
    // marker (a permanent leak) — refused; removing B first, then A, round-trips.
    const doc = "a `b` c";
    const a = insertComment(doc, { ...base, id: A, cleanStart: 0, cleanEnd: 1 });
    const b = insertComment(a.raw, { ...base, id: B, cleanStart: 3, cleanEnd: 4 });
    expect(project(b.raw).clean).toBe(doc);
    expect(() => removeComment(b.raw, A)).toThrow(/comment layer becomes\s+visible/);
    expect(removeComment(removeComment(b.raw, B), A)).toBe(doc);
  });
});
