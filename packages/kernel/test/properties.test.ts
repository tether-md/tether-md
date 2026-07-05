import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  insertComment,
  removeComment,
  setProposal,
  acceptProposal,
  project,
  resolveAll,
  encodeLine,
  decodeLine,
  encodeLineBase64,
  decodeLineBase64,
  type InsertOptions,
  type InsertResult,
} from "../src/index.js";

// Property-based tests for the spec §8 invariants (the spec explicitly promises these).
// fast-check reports seed+path on failure, so any counterexample is reproducible.
//
// HISTORY: this suite found three real kernel bugs (2026-07-04), all one root cause —
// the comment layer's visibility depends on the markdown parse of the prose, so a
// write that changes block structure (un-terminating a fence, a marker joining a
// closing-fence line, a removal re-pairing inline code) could push markers/store into
// a code region, where P preserves them and they LEAKED into the clean export. The
// kernel now refuses such writes (assertLayerInvisible in src/comment.ts), so the
// properties below run unrestricted; the minimized repros live in regressions.test.ts
// ("post-write guard").
//
// ---------------------------------------------------------------------------
// Generators — a small realistic-markdown arbitrary built from combinators.
// By construction the doc never contains Tether markup (export identity is only
// promised for tether-free documents); everything else is fair game: emoji/CJK/
// astral words, "--" runs, inline code, fenced blocks, NON-tether HTML comments,
// varying joiners and trailing whitespace.
// ---------------------------------------------------------------------------

const WORDS = [
  "the", "method", "improves", "recall", "wide", "margin", "naïve", "café",
  "日本語", "漢字テスト", "😀", "🎉🚀", "𝔘𝔫𝔦𝔠𝔬𝔡𝔢", "x-1", "co--op", "α",
] as const;

const word = fc.constantFrom(...WORDS);
const paragraph = fc.array(word, { minLength: 1, maxLength: 8 }).map((ws) => ws.join(" "));
const inlineCode = fc.tuple(word, word, word).map(([a, b, c]) => `${a} \`${b}\` ${c}`);
const fencedBlock = fc
  .tuple(fc.constantFrom("", "js", "text"), fc.array(word, { minLength: 1, maxLength: 3 }))
  .map(([lang, lines]) => "```" + lang + "\n" + lines.join("\n") + "\n```");
// A non-tether HTML comment is prose: P must keep it (no "--" inside, HTML grammar).
const htmlComment = fc
  .array(fc.constantFrom("note", "todo", "レビュー", "ok"), { minLength: 1, maxLength: 3 })
  .map((ws) => `<!-- ${ws.join(" ")} -->`);

function docFrom(pieces: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(
      paragraph, // prose first, so a code region never opens the file
      fc.array(pieces, { maxLength: 5 }),
      fc.constantFrom("\n", "\n\n"),
      fc.constantFrom("", "\n", "\n\n", "  ", "\t\n"),
    )
    .map(([first, rest, joiner, trailing]) => [first, ...rest].join(joiner) + trailing);
}

/** A tether-free markdown doc: paragraphs, inline code, fenced blocks, HTML comments. */
const docArb = docFrom(fc.oneof(paragraph, inlineCode, fencedBlock, htmlComment));
/** Two seeds -> a span over `s`. May be empty or split a surrogate — the kernel rejects those; discarded. */
function spanFrom(s: string, s1: number, s2: number): { start: number; end: number } {
  const i = s1 % (s.length + 1);
  const j = s2 % (s.length + 1);
  return { start: Math.min(i, j), end: Math.max(i, j) };
}

// The ONLY rejections insertComment may make (documented in comment.ts): empty span,
// surrogate split, the two code-region relocation refusals, and the post-write guard.
const DOCUMENTED_REJECTIONS = [
  /must select non-empty text/,
  /surrogate pair/,
  /very start of the document/,
  /following another code region/,
  /comment layer becomes\s+visible/,
];

/** removeComment, discarding a post-write-guard refusal (a safe outcome); other throws fail. */
function removeOrDiscard(raw: string, id: string): string {
  try {
    return removeComment(raw, id);
  } catch (err) {
    if (err instanceof RangeError && /comment layer becomes\s+visible/.test(err.message)) {
      fc.pre(false);
    }
    throw err;
  }
}

/** insertComment, discarding documented rejections; any OTHER throw fails the property. */
function insertOrDiscard(raw: string, opts: InsertOptions): InsertResult {
  try {
    return insertComment(raw, opts);
  } catch (err) {
    if (err instanceof RangeError && DOCUMENTED_REJECTIONS.some((re) => re.test(err.message))) {
      fc.pre(false); // legitimate, documented rejection — discard this case
    }
    throw err;
  }
}

/**
 * A random prose edit by string surgery INSIDE one retained (prose) segment of the
 * offset map — the store block and the marker bytes are never touched. `junk` must
 * not contain backtick/tilde/"<": an edit that opens a fence upstream re-parses the
 * comment layer as a code region and the store vanishes from the projection (the
 * FINDING 2 root cause); the rare edit that still manages it (e.g. fusing two
 * inline-code backticks) is discarded by the store-visibility precondition. (This is
 * the same re-parse surface the kernel's own post-write guard refuses on writes.)
 */
function proseEdit(raw: string, pick: number, at: number, del: number, junk: string): string {
  const segments = project(raw).offsetMap;
  fc.pre(segments.length > 0);
  const seg = segments[pick % segments.length];
  const start = seg.rawStart + (at % (seg.rawEnd - seg.rawStart + 1));
  const end = Math.min(seg.rawEnd, start + del);
  return raw.slice(0, start) + junk + raw.slice(end);
}

const junkArb = fc
  .array(fc.constantFrom("x", "Y", "z", " ", ".", ",", "-", "é", "日", "😀", "\n"), { maxLength: 12 })
  .map((cs) => cs.join(""));

/** Deterministic Fisher-Yates (LCG-driven, same recipe as invariants.test.ts). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const base = { trust: "fact", kind: "comment", author: "human", body: "n", now: 1_750_000_000_000 } as const;
const IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  "01ARZ3NDEKTSV4RRFFQ69G5FA5",
] as const;
const A = IDS[0];
const B = IDS[1];

describe("Property: export identity (Invariant 3) — P(insertComment(clean)).clean === clean", () => {
  it("holds for any tether-free doc and any accepted span", () => {
    fc.assert(
      fc.property(docArb, fc.nat(), fc.nat(), (doc, s1, s2) => {
        // Base case first: P is identity on a tether-free document.
        expect(project(doc).clean).toBe(doc);
        const { start, end } = spanFrom(doc, s1, s2);
        const { raw } = insertOrDiscard(doc, { ...base, id: A, cleanStart: start, cleanEnd: end });
        expect(project(raw).clean).toBe(doc);
      }),
      { numRuns: 200 },
    );
  }, 20_000);
});

describe("Property: zero perturbation (Invariant 2)", () => {
  it("inserting B leaves clean and A's anchor unchanged; removing B restores the exact raw bytes", () => {
    fc.assert(
      fc.property(
        docArb,
        fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()),
        fc.boolean(), // which of the two disjoint spans gets comment A
        (doc, seeds, firstIsA) => {
          // Two disjoint spans from four sorted cut points.
          const cuts = seeds.map((s) => s % (doc.length + 1)).sort((x, y) => x - y);
          const spans = [
            { start: cuts[0], end: cuts[1] },
            { start: cuts[2], end: cuts[3] },
          ];
          const [spanA, spanB] = firstIsA ? spans : [spans[1], spans[0]];
          const a = insertOrDiscard(doc, { ...base, id: A, cleanStart: spanA.start, cleanEnd: spanA.end });
          const before = resolveAll(a.raw).find((x) => x.id === A)!;
          const b = insertOrDiscard(a.raw, { ...base, id: B, cleanStart: spanB.start, cleanEnd: spanB.end });
          expect(project(b.raw).clean).toBe(doc); // clean untouched by either insert
          const after = resolveAll(b.raw).find((x) => x.id === A)!;
          expect(after.range).toEqual(before.range); // A's resolved anchor is unmoved by B…
          expect(after.status).toBe(before.status);
          expect(removeOrDiscard(b.raw, B)).toBe(a.raw); // …and removing B is byte-exact undo
        },
      ),
      { numRuns: 200 },
    );
  }, 20_000);

});

describe("Property: insert/remove round-trip is byte-identity", () => {
  it("N comments in (N in 1..5), N comments out in any order — byte-identical original", () => {
    fc.assert(
      fc.property(
        docArb,
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 5 }),
        fc.nat(), // removal-order seed
        (doc, seedPairs, orderSeed) => {
          let raw = doc;
          seedPairs.forEach(([s1, s2], k) => {
            // clean is invariant under inserts, so spans stay valid against `doc` itself.
            const { start, end } = spanFrom(doc, s1, s2);
            raw = insertOrDiscard(raw, { ...base, id: IDS[k], cleanStart: start, cleanEnd: end }).raw;
          });
          // The guard may refuse an ORDER (removing one marker would expose another,
          // e.g. by re-pairing inline code) — a workable order must always exist:
          // rotate refusals to the back and require completion.
          const queue = shuffled(seedPairs.map((_, k) => IDS[k]), orderSeed);
          let stuck = 0;
          while (queue.length > 0) {
            const id = queue.shift()!;
            try {
              raw = removeComment(raw, id);
              stuck = 0;
            } catch (err) {
              if (!(err instanceof RangeError)) throw err;
              queue.push(id);
              if (++stuck > queue.length) throw new Error(`no removal order completes: ${(err as Error).message}`);
            }
          }
          expect(raw).toBe(doc);
        },
      ),
      { numRuns: 200 },
    );
  }, 20_000);

});

describe("Property: hyphen-escape codec (§2.5) and base64 fallback", () => {
  const anyString = fc.string({ unit: "binary", maxLength: 200 });

  it("decodeLine ∘ encodeLine is identity; output satisfies the HTML-comment grammar", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const enc = encodeLine(s);
        expect(enc).not.toContain("-"); // no hyphen at all ⇒ no "--" and no trailing "-"
        expect(enc).not.toContain("--");
        expect(enc.endsWith("-")).toBe(false);
        expect(decodeLine(enc)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it("base64 pair round-trips and is grammar-safe (standard base64: no hyphen)", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const enc = encodeLineBase64(s);
        expect(enc).not.toContain("-");
        expect(enc).not.toContain("--");
        expect(decodeLineBase64(enc)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });
});

describe("Property: re-anchor-or-orphan (Invariant 1)", () => {
  it("after a random prose edit: confidence is banded, and a unique verbatim quote MUST resolve open at 1.0", () => {
    fc.assert(
      fc.property(
        docArb,
        fc.nat(),
        fc.nat(), // span seeds
        fc.nat(),
        fc.nat(),
        fc.nat({ max: 12 }),
        junkArb, // edit: segment pick, position, delete-length, insertion
        (doc, s1, s2, pick, at, del, junk) => {
          const { start, end } = spanFrom(doc, s1, s2);
          const { raw, record } = insertOrDiscard(doc, { ...base, id: A, cleanStart: start, cleanEnd: end });
          const edited = proseEdit(raw, pick, at, del, junk);
          const proj = project(edited);
          fc.pre(proj.store.length === 1); // the edit must leave the comment layer parseable
          const anchor = resolveAll(edited)[0];
          // Confidence bands (D3): "open" is never a low-confidence guess, "needs-review"
          // lives exactly in [0.5, 0.75), and an orphan carries no range.
          if (anchor.status === "open") expect(anchor.confidence).toBeGreaterThanOrEqual(0.75);
          if (anchor.status === "needs-review") {
            expect(anchor.confidence).toBeGreaterThanOrEqual(0.5);
            expect(anchor.confidence).toBeLessThan(0.75);
          }
          if (anchor.status === "orphaned") expect(anchor.range).toBeNull();
          if (anchor.range) {
            expect(anchor.range.start).toBeGreaterThanOrEqual(0);
            expect(anchor.range.end).toBeLessThanOrEqual(proj.clean.length);
          }
          // If the quote still occurs verbatim exactly once, it MUST silently re-anchor there.
          const exact = record.target.quote.exact;
          const hits = indicesOf(proj.clean, exact);
          if (hits.length === 1) {
            expect(anchor.status).toBe("open");
            expect(anchor.confidence).toBe(1);
            expect(anchor.range).toEqual({ start: hits[0], end: hits[0] + exact.length });
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 30_000);
});

describe("Property: accept safety — acceptProposal throws, or applies EXACTLY quote→proposal", () => {
  const proposalArb = fc.array(word, { minLength: 1, maxLength: 4 }).map((ws) => ws.join(" "));

  it("random edit then accept: either a RangeError refusal, or a surgical replacement at the anchor", () => {
    fc.assert(
      fc.property(
        docArb,
        fc.nat(),
        fc.nat(),
        proposalArb,
        fc.nat(),
        fc.nat(),
        fc.nat({ max: 12 }),
        junkArb,
        (doc, s1, s2, proposal, pick, at, del, junk) => {
          const { start, end } = spanFrom(doc, s1, s2);
          const ins = insertOrDiscard(doc, { ...base, id: A, cleanStart: start, cleanEnd: end });
          const edited = proseEdit(setProposal(ins.raw, A, proposal), pick, at, del, junk);
          // The edit must leave the comment layer intact: store parseable AND the
          // marker still a marker (not re-parsed into prose/code by the edit).
          const after = project(edited);
          fc.pre(after.store.length === 1 && after.markers.length === 1);
          const pre = project(edited).clean;
          let accepted: string;
          try {
            accepted = acceptProposal(edited, A);
          } catch (err) {
            expect(err).toBeInstanceOf(RangeError); // refusing is always a safe outcome
            return;
          }
          const anchor = resolveAll(edited).find((x) => x.id === A)!;
          expect(anchor.range).not.toBeNull();
          const { start: rs, end: re } = anchor.range!;
          // Accept may only fire onto text that still reads exactly as quoted…
          expect(pre.slice(rs, re)).toBe(ins.record.target.quote.exact);
          // …and the result is that quote swapped for the proposal — nothing else changes.
          expect(project(accepted).clean).toBe(pre.slice(0, rs) + proposal + pre.slice(re));
          // No record survives the accept.
          expect(project(accepted).store).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  }, 30_000);

  // Fence-bearing docs AND proposals that may carry a bare fence opener: the guard
  // must refuse any accept whose splice would re-contextualize fences (deterministic
  // repros in regressions.test.ts), and every accept that goes through is surgical.
  it("…for fence-bearing docs and proposals too (refusal is the safe outcome)", () => {
    const anyProposal = fc.oneof(
      fc.array(word, { minLength: 1, maxLength: 4 }).map((ws) => ws.join(" ")),
      fc.tuple(word, fc.constantFrom("\n```", "\n~~~")).map(([w, f]) => w + f),
    );
    fc.assert(
      fc.property(docArb, fc.nat(), fc.nat(), anyProposal, (doc, s1, s2, proposal) => {
        const { start, end } = spanFrom(doc, s1, s2);
        const ins = insertOrDiscard(doc, { ...base, id: A, cleanStart: start, cleanEnd: end });
        const withProp = setProposal(ins.raw, A, proposal);
        let accepted: string;
        try {
          accepted = acceptProposal(withProp, A);
        } catch {
          return; // refusal is safe
        }
        const anchor = resolveAll(withProp).find((x) => x.id === A)!;
        const { start: rs, end: re } = anchor.range!;
        expect(project(accepted).clean).toBe(doc.slice(0, rs) + proposal + doc.slice(re));
        expect(accepted).not.toContain("tether:");
      }),
      { numRuns: 100 },
    );
  }, 20_000);
});
