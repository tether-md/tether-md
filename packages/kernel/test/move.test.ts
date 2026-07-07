import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  insertComment,
  buildRecord,
  acceptMove,
  setProposal,
  resolveDest,
  resolveAll,
  project,
  parseStore,
  serializeStore,
  cleanExport,
  StoreError,
  type CommentRecord,
  type Record,
} from "../src/index.js";

// A\n\nB\n\nC as named paragraphs, block boundaries at 0 / 13 / 26.
const DOC = "Alpha paragr.\n\nBravo paragr.\n\nCharlie parag.";
const A = { start: 0, end: 13 };
const B = { start: 15, end: 28 };
const C = { start: 30, end: 44 };

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

const moveOpts = (
  src: { start: number; end: number },
  dest: { start: number; end: number },
  side: "before" | "after",
  over: Partial<Parameters<typeof insertComment>[1]> = {},
) => ({
  cleanStart: src.start,
  cleanEnd: src.end,
  trust: "interpretation" as const,
  kind: "comment" as const,
  author: "human" as const,
  body: "Move this here.",
  now: 1_750_000_000_000,
  id: ID,
  dest: { cleanStart: dest.start, cleanEnd: dest.end, side },
  ...over,
});

describe("move record capture (buildRecord + insertComment)", () => {
  it("captures dest quote/position/side like a second target", () => {
    const rec = buildRecord(DOC, moveOpts(A, C, "after")) as CommentRecord;
    expect(rec.dest).toBeDefined();
    expect(rec.v).toBe(2); // §2.7: move records are v 2 so pre-move kernels refuse them loudly
    expect(rec.dest!.side).toBe("after");
    expect(rec.dest!.quote.exact).toBe("Charlie parag.");
    expect(rec.dest!.quote.prefix.endsWith("Bravo paragr.\n\n")).toBe(true);
    expect(rec.dest!.position).toEqual({ start: C.start, end: C.end });
    expect(rec.target.quote.exact).toBe("Alpha paragr.");
  });

  it("insertComment with dest leaves the clean document unchanged (Invariant 2)", () => {
    const { raw } = insertComment(DOC, moveOpts(A, C, "after"));
    expect(project(raw).clean).toBe(DOC);
  });

  it("rejects a zero-width dest span", () => {
    expect(() => buildRecord(DOC, moveOpts(B, { start: C.start, end: C.start }, "before"))).toThrow(/dest span/);
  });

  it("rejects a dest on a gate-finding", () => {
    expect(() =>
      buildRecord(
        DOC,
        moveOpts(B, A, "before", {
          kind: "gate-finding" as const,
          meta: {
            check: "fact-grounding" as const,
            severity: "info" as const,
            confidence: 1,
            experimental: false,
            evidence: "x",
          },
        }),
      ),
    ).toThrow(/gate-finding records cannot carry a move destination/);
  });

  it("rejects a no-op destination (adjacent block, across the blank line)", () => {
    // Inserting B before C is where B already is.
    expect(() => buildRecord(DOC, moveOpts(B, C, "before", { dest: { cleanStart: C.start, cleanEnd: C.end, side: "before" } }))).toThrow(
      /no-op/,
    );
    // Inserting B after A is also where B already is.
    expect(() => buildRecord(DOC, moveOpts(B, A, "after"))).toThrow(/no-op/);
    // And inside the source itself.
    expect(() => buildRecord(DOC, moveOpts(B, B, "before"))).toThrow(/no-op/);
  });
});

describe("store validation (§2.7)", () => {
  const validRec = () => buildRecord(DOC, moveOpts(B, A, "before"));

  const storeWith = (mutate: (r: Record) => unknown): string => {
    const rec = JSON.parse(JSON.stringify(validRec()));
    mutate(rec);
    // serializeStore just encodes; feed the mutated object through it.
    return DOC + "\n" + serializeStore([rec as Record]);
  };

  it("round-trips a valid move record", () => {
    const raw = storeWith(() => undefined);
    const span = parseStore(raw)!;
    const rec = span.records[0] as CommentRecord;
    expect(rec.dest!.side).toBe("before");
    expect(rec.dest!.quote.exact).toBe("Alpha paragr.");
  });

  it("hard-fails dest + proposal on one record", () => {
    expect(() => parseStore(storeWith((r) => ((r as { proposal?: string }).proposal = "x")))).toThrow(StoreError);
  });

  it("hard-fails dest on a gate-finding", () => {
    expect(() =>
      parseStore(
        storeWith((r) => {
          (r as { kind: string }).kind = "gate-finding";
          (r as { meta?: object }).meta = { check: "fact-grounding", severity: "info", confidence: 1, experimental: false, evidence: "x" };
        }),
      ),
    ).toThrow(/only valid on kind "comment"/);
  });

  it("hard-fails an empty dest quote", () => {
    expect(() => parseStore(storeWith((r) => ((r as CommentRecord).dest!.quote.exact = "")))).toThrow(/non-empty/);
  });

  it("hard-fails a bad side", () => {
    expect(() => parseStore(storeWith((r) => (((r as CommentRecord).dest as unknown as { side: string }).side = "over")))).toThrow(
      /invalid dest.side/,
    );
  });

  it("hard-fails a missing dest.position", () => {
    expect(() => parseStore(storeWith((r) => delete (r as unknown as { dest: { position?: object } }).dest.position))).toThrow(
      /invalid dest.position/,
    );
  });

  it("hard-fails dest on a v 1 record and v 2 without dest (§2.7 versioning)", () => {
    expect(() => parseStore(storeWith((r) => ((r as { v: number }).v = 1)))).toThrow(/dest requires v 2/);
    expect(() => parseStore(storeWith((r) => delete (r as { dest?: object }).dest))).toThrow(/v 2 requires dest/);
  });

  it("plain comments stay v 1", () => {
    const rec = buildRecord(DOC, { ...moveOpts(B, A, "before"), dest: undefined });
    expect(rec.v).toBe(1);
  });
});

describe("setProposal guard", () => {
  it("refuses to attach a proposal to a move comment", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    expect(() => setProposal(raw, ID, "reworded")).toThrow(/is a move/);
  });
});

describe("resolveDest", () => {
  it("resolves the destination with confidence 1.0 on an unedited doc", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const proj = project(raw);
    const a = resolveDest(proj.clean, proj.store[0])!;
    expect(a.status).toBe("open");
    expect(a.confidence).toBe(1.0);
    expect(a.range).toEqual({ start: A.start, end: A.end });
  });

  it("returns null for a plain comment", () => {
    const { raw } = insertComment(DOC, { ...moveOpts(B, A, "before"), dest: undefined });
    const proj = project(raw);
    expect(resolveDest(proj.clean, proj.store[0])).toBeNull();
  });
});

describe("acceptMove — block seams", () => {
  it("moves a middle block forward (before a later block boundary is doc end)", () => {
    // Move B after C (side "after" on C = doc end).
    const { raw } = insertComment(DOC, moveOpts(B, C, "after"));
    const next = acceptMove(raw, ID);
    expect(next).toBe("Alpha paragr.\n\nCharlie parag.\n\nBravo paragr.");
  });

  it("moves a middle block backward (before the first block)", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const next = acceptMove(raw, ID);
    expect(next).toBe("Bravo paragr.\n\nAlpha paragr.\n\nCharlie parag.");
  });

  it("moves the FIRST block to the end", () => {
    const { raw } = insertComment(DOC, moveOpts(A, C, "after"));
    const next = acceptMove(raw, ID);
    expect(next).toBe("Bravo paragr.\n\nCharlie parag.\n\nAlpha paragr.");
  });

  it("moves the LAST block to the front", () => {
    const { raw } = insertComment(DOC, moveOpts(C, A, "before"));
    const next = acceptMove(raw, ID);
    expect(next).toBe("Charlie parag.\n\nAlpha paragr.\n\nBravo paragr.");
  });

  it("preserves a trailing newline when moving the last block", () => {
    const doc = DOC + "\n";
    const { raw } = insertComment(doc, moveOpts(C, A, "before"));
    const next = acceptMove(raw, ID);
    expect(next).toBe("Charlie parag.\n\nAlpha paragr.\n\nBravo paragr.\n");
  });

  it("preserves a trailing newline when moving a middle block to the end", () => {
    const doc = DOC + "\n";
    const { raw } = insertComment(doc, moveOpts(B, C, "after"));
    // side "after" quotes C, whose block ends before the trailing newline.
    const next = acceptMove(raw, ID);
    expect(next).toBe("Alpha paragr.\n\nCharlie parag.\n\nBravo paragr.\n");
  });

  it("removes the comment (marker + record) after the move", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const next = acceptMove(raw, ID);
    expect(next.includes("tether")).toBe(false);
    expect(project(next).store).toHaveLength(0);
  });

  it("leaves OTHER comments intact and re-anchorable", () => {
    const withMove = insertComment(DOC, moveOpts(B, A, "before"));
    const withBoth = insertComment(withMove.raw, {
      ...moveOpts(C, A, "before"),
      id: ID2,
      dest: undefined,
      body: "plain comment on Charlie",
    });
    const next = acceptMove(withBoth.raw, ID);
    expect(cleanExport(next)).toBe("Bravo paragr.\n\nAlpha paragr.\n\nCharlie parag.");
    const anchors = resolveAll(next);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe(ID2);
    expect(anchors[0].status).toBe("open");
    const proj = project(next);
    expect(proj.clean.slice(anchors[0].range!.start, anchors[0].range!.end)).toBe("Charlie parag.");
  });
});

describe("acceptMove — line and inline granularity", () => {
  it("moves a single line within a multi-line block with single-newline seams", () => {
    const doc = "Line one.\nLine two.\nLine three.";
    const { raw } = insertComment(doc, {
      ...moveOpts({ start: 10, end: 19 }, { start: 0, end: 9 }, "before"),
    });
    // "Line two." moved before "Line one."
    expect(acceptMove(raw, ID)).toBe("Line two.\nLine one.\nLine three.");
  });

  it("moves an inline span with a plain splice (no separators synthesized)", () => {
    const doc = "keep alpha bravo";
    // move "alpha " before "keep " → "alpha keep bravo"
    const { raw } = insertComment(doc, {
      ...moveOpts({ start: 5, end: 11 }, { start: 0, end: 5 }, "before"),
    });
    expect(acceptMove(raw, ID)).toBe("alpha keep bravo");
  });
});

describe("acceptMove — refusals", () => {
  it("throws for a comment with no dest", () => {
    const { raw } = insertComment(DOC, { ...moveOpts(B, A, "before"), dest: undefined });
    expect(() => acceptMove(raw, ID)).toThrow(/no move destination/);
  });

  it("throws when the source text drifted", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const edited = raw.replace("Bravo paragr.", "Bravo paragraph, edited.");
    expect(() => acceptMove(edited, ID)).toThrow(/re-mark|re-confirm/);
  });

  it("throws when the destination text drifted badly (orphaned dest)", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const edited = raw.replace("Alpha paragr.", "Entirely new opening text here.");
    expect(() => acceptMove(edited, ID)).toThrow(/destination/);
  });

  it("throws when another comment is anchored inside the moved block", () => {
    const withMove = insertComment(DOC, moveOpts(B, C, "after"));
    const withInner = insertComment(withMove.raw, {
      ...moveOpts({ start: B.start, end: B.start + 5 }, C, "before"),
      id: ID2,
      dest: undefined,
      body: "comment on Bravo's first word",
    });
    expect(() => acceptMove(withInner.raw, ID)).toThrow(/another comment/);
  });

  it("is atomic: a refused move leaves raw unusable-nowhere (unchanged)", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const edited = raw.replace("Bravo paragr.", "Bravo paragraph, edited.");
    try {
      acceptMove(edited, ID);
    } catch {
      // expected
    }
    // The document was not touched by the failed accept (pure function, but assert the
    // record + marker are still present and parseable).
    expect(project(edited).store).toHaveLength(1);
  });
});

describe("acceptMove — CRLF refusal (v1 is LF-only)", () => {
  it("buildRecord refuses a move whose seams border CRLF", () => {
    const doc = "Alpha one.\r\n\r\nBravo two.\r\n\r\nCharlie three.";
    const b = doc.indexOf("Bravo");
    expect(() =>
      buildRecord(doc, moveOpts({ start: b, end: b + 10 }, { start: 0, end: 10 }, "before")),
    ).toThrow(/CRLF/);
  });

  it("acceptMove refuses when the document turned CRLF after marking", () => {
    // Marked on an LF doc, then the newline style around the source changes.
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const crlf = raw.replace("Alpha paragr.\n\n", "Alpha paragr.\r\n\r\n");
    expect(() => acceptMove(crlf, ID)).toThrow(/CRLF|re-mark|orphaned|anchors cleanly/);
  });
});

describe("acceptMove — accept-time drift guards", () => {
  it("refuses when the destination re-anchors only fuzzily (needs-review)", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    // Mutate the destination enough to force a fuzzy match but not orphaning.
    const edited = raw.replace("Alpha paragr.", "Alpma parngr.");
    expect(() => acceptMove(edited, ID)).toThrow(/destination no longer anchors cleanly|destination text has changed/);
  });

  it("refuses a move that BECAME a no-op through edits (adjacency at accept time)", () => {
    // Move C before B is valid at creation (C is after B). Delete B afterwards…
    const { raw } = insertComment(DOC, moveOpts(C, B, "before"));
    // …no wait: C before B is a REAL move. Instead delete the text between the
    // destination and the source so they become adjacent: remove Bravo entirely.
    const collapsed = raw.replace("Bravo paragr.\n\n", "");
    // Source C now sits right after the destination boundary — accept must refuse
    // (either as a no-op or via a drift guard), never silently rewrite.
    expect(() => acceptMove(collapsed, ID)).toThrow(/no-op|re-mark|anchors cleanly|has changed/);
  });
});

describe("destination ambiguity (markerless anchors must never guess between copies)", () => {
  const dup = "Opening line.\n\nRepeated paragraph text goes here.\n\nUnique middle A.\n\nRepeated paragraph text goes here.\n\nTail Z.";

  it("buildRecord refuses a dest quote that appears more than once", () => {
    const firstRepeat = dup.indexOf("Repeated");
    const tail = { start: dup.indexOf("Tail Z."), end: dup.length };
    expect(() => buildRecord(dup, moveOpts(tail, { start: firstRepeat, end: firstRepeat + 34 }, "before"))).toThrow(/ambiguous/);
  });

  it("acceptMove refuses when the dest text becomes duplicated AFTER marking", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    // An edit elsewhere duplicates the destination quote verbatim.
    const duplicated = raw.replace("Charlie parag.", "Charlie parag. Alpha paragr.");
    expect(() => acceptMove(duplicated, ID)).toThrow(/appears more than once/);
  });
});

describe("whitespace-only blank lines (CommonMark-blank, invisible in editors)", () => {
  it("buildRecord refuses a source whose seams border a whitespace-only line", () => {
    const doc = "Alpha.\n \nBravo.\n \nCharlie.";
    const b = doc.indexOf("Bravo.");
    expect(() => buildRecord(doc, moveOpts({ start: b, end: b + 6 }, { start: 0, end: 6 }, "before"))).toThrow(
      /whitespace-only blank line/,
    );
  });

  it("acceptMove refuses when a whitespace-only line appears near the seams after marking", () => {
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    // An edit turns the empty separator line before Bravo into a space-bearing one.
    const tainted = raw.replace("Alpha paragr.\n\n", "Alpha paragr.\n \n");
    expect(() => acceptMove(tainted, ID)).toThrow(/whitespace-only blank line|re-mark|anchors cleanly/);
  });
});

describe("foreign markers at the seam boundaries", () => {
  it("refuses when another comment's marker sits exactly at the hole start (span starts with the separator)", () => {
    // Comment 2 anchors "\n\nBravo paragr." — its marker lands at clean offset 13, which
    // is exactly delStart of a move of Bravo. Without the explicit check the move would
    // apply and strand that marker after Alpha.
    const withMove = insertComment(DOC, moveOpts(B, C, "after"));
    const withBoundary = insertComment(withMove.raw, {
      ...moveOpts({ start: 13, end: 28 }, C, "before"),
      id: ID2,
      dest: undefined,
      body: "comment anchoring the separator + Bravo",
    });
    expect(() => acceptMove(withBoundary.raw, ID)).toThrow(/another comment/);
  });

  it("inserts BEFORE a marker sitting at the destination point (marker stays with its text)", () => {
    // Comment 2 anchors "Charlie parag." — marker at clean 30. Moving Alpha before
    // Charlie inserts at that same point; the moved text must land BEFORE the marker,
    // never between the marker and its anchored span.
    const withMove = insertComment(DOC, moveOpts(A, C, "before"));
    const withDestComment = insertComment(withMove.raw, {
      ...moveOpts(C, A, "before"),
      id: ID2,
      dest: undefined,
      body: "comment on Charlie",
    });
    const next = acceptMove(withDestComment.raw, ID);
    expect(cleanExport(next)).toBe("Bravo paragr.\n\nAlpha paragr.\n\nCharlie parag.");
    // The surviving marker must still immediately precede its anchored text in raw.
    expect(next.includes(`<!--tether:c=${ID2}-->Charlie parag.`)).toBe(true);
    const anchors = resolveAll(next);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].status).toBe("open");
  });
});

describe("acceptMove — both-sided insertion seams (§2.7)", () => {
  it("an arbitrary mid-paragraph destination gets separators on BOTH sides", () => {
    const doc = "One two three.\n\nKeep.";
    const keep = { start: 16, end: 21 }; // "Keep."
    // Agent-style dest: quote "two" mid-paragraph, side "before".
    const { raw } = insertComment(doc, moveOpts(keep, { start: 4, end: 7 }, "before"));
    expect(acceptMove(raw, ID)).toBe("One \n\nKeep.\n\ntwo three.");
  });
});

describe("acceptMove — unicode", () => {
  it("moves a block containing astral characters intact", () => {
    const doc = "First 𝒜 paragraph.\n\nSecond 🦀 paragraph.\n\nThird paragraph.";
    const secondStart = doc.indexOf("Second");
    const secondEnd = doc.indexOf("Third") - 2;
    const firstStart = 0;
    const firstEnd = doc.indexOf("\n\n");
    const { raw } = insertComment(doc, {
      ...moveOpts({ start: secondStart, end: secondEnd }, { start: firstStart, end: firstEnd }, "before"),
    });
    expect(acceptMove(raw, ID)).toBe("Second 🦀 paragraph.\n\nFirst 𝒜 paragraph.\n\nThird paragraph.");
  });
});

describe("move properties (fast-check)", () => {
  // Independent model: a block-granular move is a LIST REORDER. The kernel implements it
  // as char-level splices with seam normalization; for pure "\n\n"-separated documents
  // the two must agree exactly — including the optional trailing newline.
  const arb = fc
    .record({
      k: fc.integer({ min: 2, max: 6 }),
      words: fc.array(fc.constantFrom("alpha", "bravo", "delta", "echo", "words", "prose"), { minLength: 1, maxLength: 4 }),
      trailing: fc.boolean(),
      sPick: fc.nat(),
      dPick: fc.nat(),
    })
    .map(({ k, words, trailing, sPick, dPick }) => {
      const blocks = Array.from({ length: k }, (_, i) => `Paragraph ${i} ${words.join(" ")}.`);
      const s = sPick % k;
      const validDests = Array.from({ length: k + 1 }, (_, d) => d).filter((d) => d !== s && d !== s + 1);
      const d = validDests[dPick % validDests.length];
      return { blocks, trailing, s, d };
    });

  it("mark + accept ≡ reordering the block list", () => {
    fc.assert(
      fc.property(arb, ({ blocks, trailing, s, d }) => {
        const doc = blocks.join("\n\n") + (trailing ? "\n" : "");
        // Char offsets of each block in the clean doc.
        const offsets: { start: number; end: number }[] = [];
        let at = 0;
        for (const b of blocks) {
          offsets.push({ start: at, end: at + b.length });
          at += b.length + 2;
        }
        const src = offsets[s];
        const dest =
          d < blocks.length
            ? { cleanStart: offsets[d].start, cleanEnd: offsets[d].end, side: "before" as const }
            : { cleanStart: offsets[blocks.length - 1].start, cleanEnd: offsets[blocks.length - 1].end, side: "after" as const };

        const { raw } = insertComment(doc, {
          cleanStart: src.start,
          cleanEnd: src.end,
          trust: "interpretation",
          kind: "comment",
          author: "human",
          body: "Move this text here.",
          now: 1_750_000_000_000,
          id: ID,
          dest,
        });
        expect(project(raw).clean).toBe(doc); // Invariant 2 holds with a dest present

        const reordered = blocks.slice();
        const [moved] = reordered.splice(s, 1);
        reordered.splice(d > s ? d - 1 : d, 0, moved);
        const expected = reordered.join("\n\n") + (trailing ? "\n" : "");
        expect(acceptMove(raw, ID)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe("wire-format compatibility", () => {
  it("a move record survives this kernel's spread-based rewrites (v 2 + dest intact)", () => {
    // setCommentStatus-style read-modify-write must keep the move fully specified.
    const { raw } = insertComment(DOC, moveOpts(B, A, "before"));
    const span = parseStore(raw)!;
    const rewritten = span.records.map((r) => ({ ...r, status: "resolved" }) as Record);
    const roundTripped = raw.slice(0, span.rawStart) + "\n" + serializeStore(rewritten) + raw.slice(span.rawEnd);
    const rec = parseStore(roundTripped)!.records[0] as CommentRecord;
    expect(rec.v).toBe(2);
    expect(rec.dest!.quote.exact).toBe("Alpha paragr.");
    expect(rec.status).toBe("resolved");
  });
});
