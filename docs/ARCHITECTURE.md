# Tether — Architecture

**Status:** Living decision record (ADRs D1–D16) · **Updated:** 2026-07-04
**Scope:** This document is the durable architecture record for *Tether* (the core) and its first domain adapter (a separate, future project). It records the decisions and the rationale behind them. It is **specification, not code.**

> **Note for readers:** this is the internal decision record (ADRs D1–D16) that produced Tether MD, the anchored-comments layer this repo ships.
> Sections on the verification gate and the domain adapter describe planned future layers, not current features.
> For what exists today, see the README.

---

## 1. Purpose & thesis

**Tether** is a truth-bounded authoring platform: anchored inline markdown comments + a post-hoc verification gate + agent integration + a hard clean-export step.

The load-bearing idea, which shapes everything below:

> **The gate enforces truth, not the input file.** The *Background* file bounds what the model **sees**, never what it **emits**. The Background is only the reference standard the gate checks against. **The gate is the enforcement and the real engineering risk.**

Two consequences:

1. **Human-gated.** No send, no learned preference, no background edit, no submission past clean-export — without explicit human approval.
2. **Two trust-classes, never conflated.**
   - **Retrievable facts** — groundable, checked against the Background (Check 1).
   - **Interpretive claims** — fit rationale, the target-specific hook. *Not* groundable. Surfaced as model inference, flagged, **user-owned**.

## 2. The two products

| | Tether | Domain adapter (future) |
|---|---|---|
| **What** | Truth-bounded authoring core | Thin adapter for one high-stakes writing domain |
| **Build order** | First (foundation) | Second, on the stabilized core |
| **Generalization rule** | Generalize the core *only where it is obviously general*; refactor toward general when real pressure arrives, **not before** | Until a second domain exists, the adapter is Tether's **only consumer** |

**Repo topology (amended 2026-07-04, supersedes the original D9 submodule plan):** Tether MD is a **single standalone repo** (`tether-md`). The domain adapter will be a **separate repo** built on the published npm packages when its layer exists. Rationale in the D9 row below.

```
tether-md/                     (this repo)
├── packages/kernel/           TS — projection P, anchoring, store codec (@tether-md/kernel)
├── packages/cli/              TS — `tether` binary + MCP server (npm: tether-md)
├── packages/vscode-ext/       TS — editor extension (Layer 2)
├── skills/                    SKILL.md (Layer 3, agent integration)
├── examples/                  runnable fixtures + demo documents
└── docs/                      this file, milestone record, wire-format spec

domain-adapter/                (future, separate repo — Layer 4)
└── depends on tether-md + @tether-md/kernel from npm
```

## 3. Core principles

- **Truth-bounded, not input-bounded.** What the model reads ≠ what the gate permits. The gate is the contract.
- **Human is the author.** The user owns every sentence. The tool surfaces and proposes; the human decides and acts.
- **Honest about confidence.** Strong checks ship confident; weak checks ship labeled experimental and never block the strong ones.
- **Portability via clean-export.** In-file comments are fragile in non-extension editors; the net that makes this acceptable is that clean-export (the projection `P`) always yields pristine output.

## 4. Four-layer architecture

The four layers are **joined only by the file**. The editor and the agent **never talk to each other** — both only touch the `.md`. v1 builds **one** path end-to-end (VSCode + Claude Code), not a matrix.

```
        ┌───────────────────────────────────────────────┐
        │              the .md file                     │
        │   raw = clean_document + comment_layer        │
        └───────────────▲───────────────▲───────────────┘
                        │               │
          (reads/writes │               │ reads/writes)
                        │               │
   ┌────────────────────┴───┐     ┌─────┴────────────────────┐
   │ Layer 2: Editor        │     │ Layer 3: Agent           │
   │ VSCode extension       │     │ SKILL.md + `tether` CLI  │
   └────────────────────────┘     └──────────────────────────┘
                        │               │
                        └──────┬────────┘
                               │ both built on
                ┌──────────────▼────────────────┐
                │ Layer 1: Projection kernel    │
                │ P(raw)→clean + offset map,    │
                │ selectors, anchoring, store   │
                └──────────────▲────────────────┘
                               │ consumed by
                ┌──────────────┴────────────────┐
                │ Layer 4: Domain adapter       │
                │ skills/scripts + full gate    │
                └───────────────────────────────┘
```

1. **Projection kernel** (foundation). Anchoring and clean-export are *one thing*. The raw file is `clean_document + comment_layer`. One projection `P(raw) → clean` plus its offset map; **clean-export IS P.** Anchoring resolves W3C selectors against `P(raw)`, never raw bytes, computed deterministically from the human's selection (never the model). Orphan detection in projection-space. Built and unit-tested standalone, first. See [`docs/spec/wire-format-and-projection.md`](spec/wire-format-and-projection.md).
2. **Editor extension** — VSCode Extension API. v1 VSCode only. Cursor/Windsurf and a CLI `comment add` helper are fast-follows.
3. **Agent integration** — SKILL.md skills + a TypeScript `tether` CLI, headless via `claude -p` / Agent SDK; v1 Claude Code, agent-agnostic by design (the agnostic contract lives in the *kernel*, not the transport).
4. **Domain layer** — the adapter's skills/scripts + the full gate. Built last.

## 5. Resolved decisions (ADR summary)

| # | Decision | Choice | Why (one line) |
|---|---|---|---|
| D1 | Comment wire format | **HTML-comment marker + EOF sidecar store** | Only convention spec-stripped across CommonMark/GFM/pandoc **and** VSCode preview; sidesteps the HTML `--` footgun by keeping payload out of the inline marker. |
| D2 | Anchoring implementation | **String-native: port Hypothesis `matchQuote` + depend on `approx-string-match`; reimplement W3C TextQuote/TextPosition over strings** | `dom-anchor-*` libs are DOM-coupled; Tether anchors against the markdown *string* `P(raw)`. Hypothesis itself moved to string-native matching. |
| D3 | Orphan policy | **Add our own confidence floor** (`matchQuote` has none): ≥0.75 reattach · 0.5–0.75 reattach+`needs-review` · <0.5 orphan loudly | The library silently mis-anchors; for a truth tool that is the worst failure mode. |
| D4 | Agent integration v1 | **SKILL.md + one TS CLI now; defer MCP** | A single-agent v1 doesn't exercise agnosticism; CLI is the thin faithful expression of the file-only contract. MCP trigger = 2nd agent surface or streaming need; route = in-process `createSdkMcpServer`. |
| D5 | Claim-strength method | **Two physically separate pipelines.** Check 1: spaCy `trf` + GLiNER hybrid extraction → normalize → match. Check 2: lexicon recall-filter → NLI minimal-pair test → LLM-judge precision pass | Entailment is directional, which is exactly what a connotative upgrade violates; faithfulness metrics don't test hedging/intensifiers. |
| D6 | Check-2 acceptance bar | **Precision-first: ≥80% precision @ ≥40% recall, shown in v1** as non-blocking dismissible flags | A noisy check trains the author to ignore it; missed upgrades are recoverable, eroded trust isn't. Comparative-exaggeration tops ~56–61 F1 in the literature → operate at a high-precision point, not balanced F1. |
| D7 | Languages | **TypeScript** for kernel/CLI/editor/agent; **Python** for the claim-strength spike only | One language across Layers 1–3 (JS anchoring primitives); Python only where the ML/eval lives. |
| D8 | Gate output | **Dogfood — gate writes findings as Tether comments anchored to the offending spans** | Unifies the system; exercises the kernel hardest; findings are first-class, anchored, dismissible. |
| D9 | Repo topology | ~~Domain-adapter outer repo; Tether git submodule~~ **SUPERSEDED 2026-07-04 by D15a: single standalone `tether-md` repo** (packages/ + docs/ + skills/ + examples/); the domain adapter will be a *separate* repo consuming the published npm packages | Submodules are contributor friction, stars don't aggregate across repos, and the outer repo would have launched as an empty shell (the domain layer is unbuilt). D9 solved a working-layout question, not a product question. |
| D10 | Agent ↔ gate boundary | **Run gate + propose softenings** | Agent runs read-only checks *and* pre-writes suggested downgrades as flagged comments; never auto-applied. Human acts. |
| D11 | Sidecar JSON encoding | **Reversible hyphen-escape** (`\`→`\\`, `-`→`\D`), human-inspectable; base64 available as a config fallback | Must satisfy the HTML-comment grammar (no `--`, no trailing `-`) while staying debuggable by hand. (Impl note: the fallback is standard base64, not base64url — base64url's `-` would reintroduce the footgun.) |
| D12 | Comment-layer direction | **Bidirectional.** Human comments are *instructions to the agent* anchored to a span, not only agent→human findings. The comment is the localized, anchored instruction channel (replacing inline `[FIX]` marks and pasting into chat). | The loop is human-comments → agent-acts → review → repeat. |
| D13 | Agent-action surface | **Suggestion mode (propose / Accept / Reject).** The agent attaches a *proposed rewrite* to each comment; the human Accepts (applies it to the span **and clears the comment**) or Rejects (discards) — natively in the editor (Comments-API thread buttons). The agent never applies. Direct clean-space edit (`tether edit`) stays available for non-interactive use. | Realizes D10 ("propose, human applies") with a one-click review surface. Chosen after direct-edit left dangling markers + orphaned-but-resolved comments (no artifact survives Accept/Reject). Edits/proposals apply in clean space because raw markers interleave the prose. Gate findings (D8) flow through the same surface. |
| D14 | Public name | **`tether-md`** — npm `tether-md` (CLI) + `@tether-md/kernel`; extension `tether-md-vscode`, publisher `tether-md`, display name "Tether MD". The wire format is unchanged (`tether:` markers/store). | Bare "Tether" is unwinnable: npm `tether` is an active 8.5k★ library, the stablecoin owns search for the word (and files trademarks), and in-niche squatters exist. `tether-md` keeps every doc, verb, and wire byte at zero migration cost. *(Decided 2026-07-04.)* |
| D15 | Launch scope | **Core loop only** — kernel + CLI + editor + agent skill, polished best-in-class; the gate and the domain adapter ship later as their own separate launch. *(D15a: repo topology per amended D9.)* | Time-to-launch dominates: the "portable suggest-mode for markdown + any agent" slot is empty but actively contested; the gate isn't needed to win the category; two launches beat one diluted one. *(Decided 2026-07-04.)* |
| D16 | MCP surface | **Ship an MCP stdio server at launch** (`tether mcp`), exposing only the agent-safe verbs (list / status / diff / suggest / flag-back / export) — accept/reject/edit deliberately absent. | D4's deferral trigger ("a 2nd agent surface") has fired: "works with any agent" must be demonstrably true on day one, and the trust boundary (D13) is expressed at the tool surface itself. *(Decided 2026-07-04.)* |

Detail and grammar for D1–D3, D11 live in the wire-format spec.

## 6. Trust & decision boundary

Three distinct actions; the boundary defines who may do each:

| Action | Agent (Claude Code) | Human |
|---|---|---|
| Draft / edit prose | ✅ writes to file | ✅ |
| **Run the gate** (read-only analysis → findings) | ✅ runs it, surfaces findings as anchored comments | ✅ |
| **Propose** softenings/fixes | ✅ pre-writes suggested downgrades as *flagged, inert* comments | ✅ |
| **Apply** a fix / soften a claim | ❌ never auto-applies | ✅ approves & applies |
| Export clean / send / edit Background / learn preference | ❌ | ✅ only |

The gate's independence is preserved because it is deterministic extraction + NLI + a narrowly-pinned judge — not the drafting model free-associating about its own work.

## 7. Internal rules (hard)

1. **Non-fabrication** (gate-enforced): no upgrading credentials/results/roles/venues; a missing fact → **ask, never invent.**
2. **Two trust-classes:** facts grounded; interpretation flagged and user-owned.
3. **The user is the author** and owns every sentence.
4. **Disclosure, honest:** some settings require certifying that materials are un-AI-assisted; this tool **may be disallowed** there, with real consequences. Surface the policy and the risk; do not pretend "be genuinely you" resolves it. The user decides.
5. **Privacy = what leaves the device:** local file ownership is **not** local processing — the full verified record and every draft are sent to a third-party model API each run. (Local model is a future mitigation.)
6. **No spam; official channels only** (a domain-adapter rule — the tool itself sends nothing in v1).
7. **No overpromising:** nothing about outcomes the author cannot control.

## 8. Stack

- W3C selectors (string-native) + fuzzy re-anchoring via `approx-string-match` (port of Hypothesis `matchQuote`).
- Markdown parse/serialize via the **unified/remark** ecosystem (`remark-comment` models comments as droppable nodes with real offset positions) — `P` is built on node positions, not hand-rolled regex.
- VSCode Extension API.
- SKILL.md + headless `claude -p` / Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
- Retrieval APIs for the domain adapter — **deferred**, not in milestone 1.
- CSV / SheetJS for the domain adapter's tracker (a structured log of targets and document status) — **deferred** (milestone 2).
- No email send in v1. External target-metadata APIs deferred entirely.
- Tests: **Vitest** (TS), **pytest** (Python).

## 9. Build order — two concurrent tracks, then convergence

**Track A — Foundation (build-order: bottom-up):**
pin wire format → projection kernel standalone, fully unit-tested → editor extension + agent integration against it (Extension Development Host / `@vscode/test-electron`; MCP Inspector if/when MCP) → domain layer + full gate.

**Track B — Risk (in parallel, risk-order: hardest-first):**
claim-strength spike, hand-labeled Background+draft pairs, precision/recall on the *upgrades* — feeds the product **before** the four layers commit. A mediocre result reshapes the product before four layers exist.

> Build-order is foundation-up; risk-order is hardest-first; the two run **concurrently**.

## 10. Test axes

- **(a) Deterministic** — anchoring, format round-trip, orphan detection, clean-export, tracker schema. Kernel invariants:
  1. write comment → mutate prose → re-anchor **or loud orphan**;
  2. add/remove comment → **zero perturbation** of other anchors;
  3. export → **byte-identical** to the original clean document.
- **(b) Fabrication as a regression contract** — a red-team set where the Background omits a fact the draft wants (correct = ask/flag), plus the claim-strength check; run on **every model bump**, grown adversarially.
- **(c) Retrieval precision/recall** — right sources, misses, misattributions — evaluated **separately** from drafting. (Deferred past milestone 1.)

## 11. Tradeoffs (owned, not hidden)

- In-file comments buy portability at the cost of fragility in non-extension editors — **clean-export (P) is the net.**
- Voice learned from anxious, high-stakes edits trends over-formal — **authentic-sample cold-start** is the partial fix; honest that discrete rules catch tics, not holistic voice.
- External target metadata (funding-type signals) is often unretrievable — hence **cut, not caveated.**
- Disclosure policies may forbid the tool outright — **the user's decision.**
- Over-generalizing the core is a real cost — **the domain adapter stays the only consumer** until a second domain forces the interface.

## 12. Deferred (explicitly out of v1 / milestone 1)

Live target retrieval & fit-check (fixed fixture in M1); external funding/metadata signals (out entirely); master tracker (manual, structured — M2); cross-document consistency check (M2); suggested draft directions / divergent positioning; authenticity flagging (acknowledged mechanically dual-use); follow-up (no send in v1).

---

*Companion docs:* [`MILESTONE-1.md`](MILESTONE-1.md) · [`spec/wire-format-and-projection.md`](spec/wire-format-and-projection.md)
