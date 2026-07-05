import { describe, it, expect } from "vitest";
import { insertComment, removeComment, project, resolve, resolveAll, markerHint } from "../src/index.js";

// Deterministic seeded PRNG so any failure is reproducible (no Math.random).
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Independent (non-kernel) similarity, to verify a reattachment without trusting
// resolve()'s own confidence — a circular check would never catch a silent mis-attach.
function levFit(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return 1;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[m][n] / Math.max(m, n, 1);
}

const CLEAN = "We showed that the new method improves recall on the benchmark by a wide margin.";
const baseOpts = {
  trust: "fact" as const,
  kind: "comment" as const,
  author: "human" as const,
  body: "note",
  now: 1_750_000_000_000,
};

describe("Kernel invariants (Test Axis a — the M1 acceptance contract)", () => {
  it("Invariant 2: adding a comment leaves clean byte-identical and other anchors stable", () => {
    const raw0 = CLEAN;
    const a = insertComment(raw0, { ...baseOpts, id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cleanStart: 3, cleanEnd: 9 });
    const anchorA1 = resolveAll(a.raw)[0];

    const b = insertComment(a.raw, {
      ...baseOpts,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      cleanStart: 30,
      cleanEnd: 38,
    });

    // clean unchanged by either insert
    expect(project(a.raw).clean).toBe(CLEAN);
    expect(project(b.raw).clean).toBe(CLEAN);

    // anchor A is unchanged by the addition of B
    const anchorA2 = resolveAll(b.raw).find((x) => x.id === "01ARZ3NDEKTSV4RRFFQ69G5FAV")!;
    expect(anchorA2.range).toEqual(anchorA1.range);
    expect(anchorA2.status).toBe(anchorA1.status);
  });

  it("Invariant 3: round-trip leaves the prose byte-identical (clean-export IS P)", () => {
    let raw = CLEAN;
    raw = insertComment(raw, { ...baseOpts, id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cleanStart: 3, cleanEnd: 9 }).raw;
    raw = insertComment(raw, { ...baseOpts, id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", cleanStart: 30, cleanEnd: 38 }).raw;
    expect(project(raw).clean).toBe(CLEAN);

    // removing every comment yields the original file exactly
    raw = removeComment(raw, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    raw = removeComment(raw, "01ARZ3NDEKTSV4RRFFQ69G5FB1");
    expect(raw).toBe(CLEAN);
  });

  it("Invariant 1: under random prose edits, every comment re-anchors (>=0.5) or orphans — never silently mis-attached", () => {
    const rng = lcg(42);
    const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    // 22..29 in CLEAN === " method" (leading space); quote.exact === " method".
    const { raw: anchored } = insertComment(CLEAN, { ...baseOpts, id: ID, cleanStart: 22, cleanEnd: 29 });
    const original = project(anchored);
    const quote = original.store[0].target.quote;
    expect(quote.exact).toBe(" method");

    let orphanCount = 0;
    let reattachCount = 0;
    for (let trial = 0; trial < 200; trial++) {
      // Apply a random prose edit to the CLEAN portion, keep the comment layer.
      const proj = project(anchored);
      const clean = proj.clean;
      const cut = Math.floor(rng() * clean.length);
      const len = Math.floor(rng() * 6);
      const mutated =
        rng() < 0.5
          ? clean.slice(0, cut) + clean.slice(cut + len) // delete
          : clean.slice(0, cut) + "XyZ".slice(0, len) + clean.slice(cut); // insert junk

      // Re-author: put the comment back onto the mutated prose by resolving the quote.
      const a = resolve(mutated, original.store[0], undefined);

      // The contract:
      if (a.status === "orphaned") {
        expect(a.range).toBeNull();
        orphanCount++;
      } else {
        reattachCount++;
        expect(a.confidence).toBeGreaterThanOrEqual(0.5);
        expect(a.range).not.toBeNull();
        expect(a.range!.start).toBeGreaterThanOrEqual(0);
        expect(a.range!.end).toBeLessThanOrEqual(mutated.length);
        // INDEPENDENT span-correctness check: a silently-reattached ("open") anchor must
        // point at text genuinely similar to the quote — not echo the kernel's confidence.
        if (a.status === "open") {
          const resolvedText = mutated.slice(a.range!.start, a.range!.end);
          expect(levFit(resolvedText, quote.exact)).toBeGreaterThanOrEqual(0.5);
        }
      }
    }
    // Non-vacuity: the 200 edits must actually exercise BOTH branches, else the test
    // could pass green while never stressing the re-anchor-or-orphan boundary.
    expect(orphanCount).toBeGreaterThan(0);
    expect(reattachCount).toBeGreaterThan(0);
  });
});
