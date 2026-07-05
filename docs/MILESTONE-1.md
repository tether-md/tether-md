# Milestone 1 — one document, one target, one review, one export

**Status:** Historical planning record (2026-06-24). The core loop (A1–A5, plus the MCP surface) shipped as **Tether MD v0.1**; A6/A7/Track B (Background builder, gate, claim-strength) are deferred to the separate domain-adapter repo per D15.
**Companion:** [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`spec/wire-format-and-projection.md`](spec/wire-format-and-projection.md)

---

## 1. Goal

Exercise **both** truth-guarantees and the **export gate** in one end-to-end run:

> **In:** Background → one grounded, target-specific draft (gate running, *both* checks) → one verified review cycle → clean export.

This is the smallest thing that proves the core thesis: the gate enforces truth on what is emitted, the human stays in the loop, and clean-export yields pristine output.

## 2. Scope

**In scope**
- Background builder: structured intake of the **verified record** — the user's actual roles, methods, results, and credentials, with the exact status of each claim.
- One per-target draft in the user's voice, grounded, with a target-specific **hook** (interpretive → flagged, user-owned).
- Voice cold-start from a few authentic prior writing samples + lightweight in-session preferences. **Not** graduated rules learned from anxious high-stakes edits.
- The verification gate, **both checks**, with Check 2 labeled experimental and non-blocking.
- The projection kernel: anchoring, orphan detection, clean-export (`P`).
- The VSCode editor path (Layer 2) and the Claude Code agent path (Layer 3) — **one** path each, against the kernel.
- Gate findings surfaced **as Tether comments** (dogfood, D8); agent may **propose softenings** as flagged inert comments (D10).

**Out of scope (deferred)**
- Live target retrieval / fit-check — **use a fixed fixture.** (Live retrieval is its own test axis and must not gate the core loop.)
- All funding APIs.
- Master tracker (a structured log of targets and document status; manual) — M2.
- Cross-document consistency check — M2 (needs multiple documents).
- Voice beyond a couple of in-context samples.
- Authenticity flagging.
- Follow-up / any email send.

## 3. The run (end-to-end flow)

```
1. Background intake      → structured verified-record file (the reference standard)
2. Load fixed fixture     → target {name, area, recent work} as a fixture (no live retrieval)
3. Draft                  → one target-specific draft in the user's voice
                            · facts grounded in Background
                            · hook flagged as interpretive (trust=interpretation)
4. Run gate (both checks) → Check 1 fact-grounding (confident)
                            · Check 2 claim-strength (experimental, non-blocking)
                            · findings written as anchored Tether comments
                            · agent may add suggested softenings (inert)
5. Review cycle           → human reviews findings, edits prose, resolves/dismisses
                            · kernel re-anchors surviving comments or orphans loudly
6. Clean export (P)       → pristine clean_document, byte-identical to authored prose
```

## 4. Components to build (mapped to layers & tracks)

**Track A — Foundation (bottom-up):**
- **A1. Wire format** — pinned per the spec. *(blocks everything)*
- **A2. Projection kernel** (`packages/kernel`, TS) — `P`, offset map, store codec, selectors, anchoring + re-anchoring, orphan detection. **Built and unit-tested standalone first.**
- **A3. `tether` CLI** (`packages/cli`, TS) — stable contract surface over the kernel: `project`, `comment list/add`, `gate run`, `export`. JSON in/out, documented exit codes.
- **A4. VSCode extension** (`packages/vscode-ext`, TS) — render markers as inline UI, create comments from a selection, show gate findings, surface orphans. Tested via Extension Development Host / `@vscode/test-electron`.
- **A5. Agent integration** (`skills/`) — SKILL.md skills calling the CLI; headless-capable via `claude -p`. `Bash(tether *)` pre-approved; the destructive verbs reserved for explicit invocation.
- **A6. Background builder** — structured intake → verified-record file.
- **A7. The gate** — Check 1 (strong) wired into the kernel's comment layer; Check 2 (experimental) integrated from the Track B spike, **physically separate** so it can never block Check 1.

**Track B — Risk (hardest-first, concurrent):**
- **B1. Claim-strength spike** (`spikes/claim-strength`, Python) — lexicon recall-filter → NLI minimal-pair test → LLM-judge precision pass.
- **B2. Eval harness** — hand-labeled Background+draft pairs; measure precision/recall on the **upgrades**; report against the bar.

**Convergence:** A7 consumes B1's method once B2 clears (or near-clears) the bar; a mediocre B-result reshapes the product before the four layers commit.

## 5. Acceptance criteria

**Functional**
- A real Background → a grounded, voice-plausible draft → gate findings as anchored comments → human review → clean export, in one run.
- Check 1 catches a planted discrete-fact upgrade (e.g. "Nature" over a preprint).
- Check 2 flags a planted connotative upgrade (e.g. "demonstrated" where Background supports "suggested"), labeled experimental, non-blocking.
- A missing fact triggers **ask, never invent** (Rule 1).
- The hook is present and flagged `trust=interpretation`.

**Deterministic kernel invariants (Test Axis a)** — *all must pass:*
1. write comment → mutate prose → **re-anchor or loud orphan** (Invariant 1).
2. add/remove comment → **zero perturbation** of other anchors (Invariant 2).
3. export → **byte-identical** to the original clean document (Invariant 3).

**Fabrication regression contract (Test Axis b)**
- A red-team set where the Background omits a fact the draft "wants": correct behavior = ask/flag, never fabricate. Wired to run on every model bump; grows adversarially.

**Claim-strength bar (D6)**
- On the frozen, versioned eval set: **≥80% precision @ ≥40% recall** on upgrades, precision as the hard floor. Reported as an operating point on a tunable threshold — not a model-quality claim.

## 6. Sequencing & dependencies

```
A1 ─▶ A2 ─▶ A3 ─┬─▶ A4 (editor)
                └─▶ A5 (agent)
A6 ────────────────▶ A7 (gate) ◀── B1 ◀── B2   (Track B runs concurrently from day 0)
A2,A3,A6,A7 ───────▶ end-to-end run
```

- **A1 blocks all.** Pin the wire format first (the wire-format spec).
- A2 is built and **fully unit-tested standalone** before A4/A5 touch it.
- Track B starts **immediately and in parallel** — it is risk-order, not build-order, and must feed the product before A7 commits.

## 7. Definition of done

- The §3 run completes for one real Background + one fixture target.
- All three kernel invariants pass in CI (Vitest).
- The fabrication regression set passes; the claim-strength eval reports against the bar (pytest).
- Clean export is byte-identical; the exported file contains **zero** Tether artifacts.
- Both editor and agent paths can each independently drive the run via the file.

## 8. What this milestone deliberately does **not** prove

- That live retrieval works (fixture only).
- That voice modeling is holistic (a couple of samples only).
- That cross-document consistency holds (single document).
- That external metadata signals are reliable (out entirely).
- Anything about final outcomes (Rule 7).

These are named so "milestone 1 done" is not mistaken for "product done."
