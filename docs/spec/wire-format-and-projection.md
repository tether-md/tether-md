# Spec: Wire format, projection P, anchoring

**Status:** v1 — pinned 2026-07-04 (⟨DECIDE⟩ points resolved as recommended; see the kernel README for documented deviations) · **Date:** 2026-06-24
**This is the gating spec.** It defines the comment wire format, which in turn defines `P`, the offset map, every selector, and all four layers. Pin this before anything else is built.

> **Reading note — embedded sub-decisions.** Three finer choices inside this spec are flagged **⟨DECIDE⟩**. Each is now resolved (as recommended); a short "Resolved" note at each block records what shipped.

---

## 1. The file model

A Tether `.md` file is, by definition:

```
raw  =  clean_document  +  comment_layer
```

- **`clean_document`** — the prose the author owns and will export/submit.
- **`comment_layer`** — everything Tether adds: inline identity **markers** and an end-of-file **store** block.

The projection `P(raw) → clean_document` strips the comment layer **completely and reversibly**. **Clean-export *is* `P`.** There is exactly one `P`; there is no second "export" path.

The comment layer is physically present in the file (single-file portability), but invisible in every renderer on the v1 path (VS Code preview, GitHub, pandoc) — see §3.

## 2. Grammar

### 2.1 Inline marker (identity + position hint)

Each comment places **one** inline caret marker at its anchor point:

```
<!--tether:c=<ID>-->
```

- `<ID>` — a **ULID** (Crockford base32, 26 chars, alphabet `0-9A-HJKMNP-TV-Z`). Contains no hyphen, so it can never form `--`.
- The marker carries **no payload and no selector** — only identity. (All structured data lives in the store, §2.3.)
- Placed immediately **before** the first character of the anchored span in `clean` space.

**⟨DECIDE 1⟩ Caret vs bracketing pair.** Recommended: **single caret** marker + the store's `TextQuoteSelector` defines the span *extent*. This minimizes inline noise (one short token) and matches Hypothesis's proven "position-hint + quote-is-truth" model. Alternative: a **bracketing pair** (`…:c=ID:s-->` / `…:c=ID:e-->`) makes spans editor-tracked and exact at the cost of 2× inline markers. I recommend single caret for v1; brackets remain a backward-compatible addition later. *Resolved: single caret marker, as recommended.*

### 2.2 Store block (sidecar)

All comment bodies and selectors live in **one** block at end-of-file:

```
<!--tether:store
{record}
{record}
tether:store-->
```

- Opening sentinel line: `<!--tether:store` followed by a newline.
- One **record per line** (JSON Lines), §2.4, after the hyphen-escape codec (§2.5).
- Closing sentinel line: `tether:store-->`.
- The block is the **last** thing in the file. `P` finds it with a single anchored scan; on a malformed or duplicate block, `P` **hard-fails** (never silently mis-parses).

### 2.3 Why marker + sidecar (not fully-inline)

- The HTML comment grammar **forbids `--`** inside comment text and a trailing `-`. Raw JSON routinely contains `--` → fully-inline JSON corrupts the file. Keeping the inline marker payload-free and pushing JSON into the store (where we control encoding) eliminates the single worst footgun.
- Prose stays readable in non-extension editors: inline noise is one opaque token, not a wall of selector+JSON.

### 2.4 Record schema (one JSONL line per comment)

```jsonc
{
  "id":     "01J9F3K8...",          // ULID; matches the inline marker c=<ID>
  "v":      1,                       // record schema version (2 = carries a move `dest`, §2.7)
  "trust":  "fact" | "interpretation",   // the two trust classes
  "kind":   "comment" | "gate-finding",  // dogfood: the gate writes findings as comments
  "author": "human" | "agent" | "gate",
  "body":   "markdown string",       // the comment / finding text
  "status": "open" | "resolved" | "needs-review" | "orphaned",
  "created":"2026-06-24T12:00:00Z",  // ISO-8601; stamped by the writing process
  "target": {
    "quote":    { "exact": "...", "prefix": "...", "suffix": "..." },  // W3C TextQuoteSelector
    "position": { "start": 1234, "end": 1251 }                         // W3C TextPositionSelector (hint)
  },
  "dest": { /* optional move destination, kind "comment" only, see §2.7 */ },
  "meta": { /* kind-specific, see §2.6 */ }
}
```

- `target.position` offsets are in **`P(raw)` space** (the clean document), **UTF-16 code units** (§4).
- `quote.prefix` / `quote.suffix` capture **32 characters** of context each (matching Hypothesis), used to disambiguate and to re-anchor.

### 2.5 Hyphen-escape codec (the `--`-safety layer)

Store text must satisfy the HTML-comment grammar. **⟨DECIDE 2⟩** Recommended codec is reversible and human-inspectable:

**Encode** (per JSONL line, in order):
1. `s = JSON.stringify(record)`
2. `s = s.replaceAll("\\", "\\\\")`   // double every backslash
3. `s = s.replaceAll("-", "\\D")`     // every hyphen → backslash-D (no hyphen in the replacement)

After step 3 no `-` remains in the line → no `--`, no trailing `-`. Example: `"2026-06-24"` → `"2026\D06\D24"`.

**Decode** (single left-to-right pass, *not* sequential replace): on `\\`→`\`, on `\D`→`-`, consuming two chars each; any other char is literal. Then `JSON.parse`.

Fallback (config flag): **base64** the whole line (standard alphabet; base64url's `-` would reintroduce the footgun) — bulletproof, opaque. Chosen default is the readable codec because the owner values hand-inspectable raw files.

### 2.6 `meta` for gate findings (dogfood)

```jsonc
"meta": {
  "check":     "fact-grounding" | "claim-strength",
  "severity":  "info" | "warn",
  "confidence":0.0,                 // 0..1; for claim-strength, the operating-point score
  "experimental": true,            // true for claim-strength (labeled in UI)
  "evidence":  "Background span or 'unmatched'",
  "observed":  "Nature",           // what the draft asserts
  "supported": "preprint (bioRxiv)",// what the Background supports
  "suggestion":"soften 'demonstrated' → 'suggested'"  // proposed downgrade (D10); inert until human applies
}
```

### 2.7 `dest` for move comments

A comment may carry a **move destination**: a request that its anchored span be moved to
another point in the document. Like `proposal`, it is **inert until a human accepts it**.

```jsonc
"dest": {
  "quote":    { "exact": "...", "prefix": "...", "suffix": "..." },  // NON-EMPTY adjacent prose
  "position": { "start": 987, "end": 1010 },                          // hint, P(raw) space (§4)
  "side":     "before" | "after"                                      // insert at quote start | end
}
```

Rules:

- **The destination is a point, but a point cannot re-anchor** (an empty quote orphans
  immediately, §7). So the point is expressed as a quote of **non-empty** adjacent prose
  plus a `side`: the insertion point is the resolved span's start (`"before"`) or end
  (`"after"`). `dest.quote.exact` MUST be non-empty; parsers hard-fail otherwise.
- **The destination quote MUST be unique in the clean document** — it re-anchors by text
  alone (no marker as ground truth), and an ambiguous quote could silently re-attach to
  the wrong copy. Writers refuse to create an ambiguous destination (quote more context
  instead); `acceptMove` re-checks uniqueness at accept time and refuses if edits have
  since duplicated the text.
- `dest` is only valid on `kind: "comment"`; hard-fail on `gate-finding`.
- **`dest` + `proposal` on one record is a hard parse failure.** A kernel that understands
  only one of the two could half-apply the record (e.g. replace without moving). Writers
  MUST NOT create the combination; readers MUST reject it.
- The destination has **no inline marker**; it re-anchors purely by quote, with
  `dest.position.start` as the locality hint. It uses the same confidence bands as
  `target` (§7).
- **Versioning:** a record carrying `dest` MUST be written with `v: 2`, and `v: 2` MUST
  carry `dest` (each without the other is a hard parse failure). This is deliberate:
  pre-move kernels tolerate and round-trip unknown *fields*, so a `v: 1` move record
  would parse there as a plain comment — and the old `setProposal` (which knows no
  `dest` guard) could then attach a proposal to it, letting the old `acceptProposal`
  apply the rewrite while silently discarding the requested move. A version bump makes
  the old kernel's own `v must be 1` check refuse the whole store **loudly** instead
  ("hard-fail rather than mis-parse"). The cost is explicit: a pre-move kernel cannot
  read a document while it contains a pending move; accepting or rejecting all moves
  returns the file to pure `v: 1` records.

**Accepting a move** (`acceptMove`) applies only when BOTH anchors resolve as `open` with
byte-exact quote matches (same posture as accepting a proposal). It removes the comment,
deletes the source span, and re-inserts the text at the destination point, normalizing the
two seams to the span's granularity: the deletion hole collapses to one blank-line
separator for a block (none at a document edge; a single newline for a line-granular span;
plain splice for an inline span), and the insertion synthesizes separators **on both
sides** of the moved text — only what the destination point doesn't already have, so a
block boundary degenerates to a single trailing/leading separator while an arbitrary
mid-paragraph point gets both. Text inserted at a boundary where another comment's inline
marker sits lands **before** the marker (a marker must stay hugging its anchored text). A
destination inside or immediately adjacent to the source's extended hole is a no-op and
is rejected — at record creation and again at accept.

v1 refusals (loud, never silent corruption): a source span that contains — or whose
surrounding blank-line hole contains, boundary-inclusive at the hole start — another
comment's marker; seams or destinations bordering **CRLF** line endings (moves are
LF-only in v1); seams or destinations bordering **whitespace-only blank lines** (blank
per CommonMark but invisible in editors — normalize to empty lines first); an ambiguous
destination quote (above).

## 3. Renderer behavior (v1 path)

- HTML comments are passed through verbatim by CommonMark/GFM and **hidden** by the browser; the VS Code preview (markdown-it with raw HTML enabled — Microsoft "as-designed") hides them; pandoc default and GitHub hide them.
- **Known boundary:** a markdown pipeline with `html:false` (markdown-it default, Goldmark/Hugo default) **escapes** comments to visible text. This affects only the **raw** file in those pipelines; the **clean export** `P(raw)` has zero markers, so any consumer of clean output is unaffected. Documented, not blocking.

## 4. Offset convention

All offsets — `P(raw)` positions, the offset map, and `target.position` — are **UTF-16 code units**, matching `approx-string-match`. Chosen once, enforced project-wide. (Emoji/astral chars count as 2 units; CJK as 1.) Tests cover an emoji/CJK document.

## 5. The projection `P`

**Signature:** `P(raw: string) → { clean: string, offsetMap: Segment[], store: Record[] }`

**Algorithm:**
1. Parse `raw` with remark to an mdast tree (HTML comment nodes carry `position.start.offset` / `position.end.offset`).
2. Identify, in document order: (a) every inline `<!--tether:c=...-->` marker; (b) the EOF `tether:store … tether:store-->` block. Validate the store; hard-fail on malformed/duplicate.
3. Emit `clean` as `raw` with every identified Tether region deleted. **Non-tether HTML comments are preserved verbatim ⟨DECIDE 3⟩** (recommended: they are the user's content, not Tether's; alternative is strip-all-comments). *Resolved: non-tether comments are preserved verbatim, including in code regions, as recommended.*
4. Build `offsetMap`: an ordered list of retained runs

   ```ts
   type Segment = { cleanStart: number; cleanEnd: number; rawStart: number; rawEnd: number }
   ```

   Each retained text run is one segment; stripped Tether regions are the gaps between segments. The map is the bijection between `clean` offsets and `raw` offsets for all retained text.
5. Parse `store` lines via the §2.5 decoder → `Record[]`.

`P` is a **pure, deterministic function** — no model, no randomness, no clock dependence in the projection itself.

## 6. Selector model

W3C Web Annotation Data Model, resolved over the **string** `P(raw)`:

- **TextPositionSelector** — `{start, end}` integer offsets into `P(raw)`. Fast, exact, but brittle to edits. Stored as a **hint**.
- **TextQuoteSelector** — `{exact, prefix, suffix}` (32-char context). The **source of truth** for re-anchoring after edits: survives insertions/deletions elsewhere in the document.

Both are stored per comment; **quote takes precedence** for resolution, position is the tie-break/locality hint.

## 7. Anchoring & re-anchoring

Resolution runs against `P(raw)` (the projection — the markers themselves are *not* in `P(raw)`; the inline marker's position is mapped through the offset map to a `clean` offset that serves as the locality hint).

**Resolution order, per comment:**
1. **Marker locality + exact quote.** If the marker maps to a `clean` offset and `quote.exact` matches there → anchored, confidence `1.0`.
2. **Unique exact match.** `indexOf(quote.exact)` in `P(raw)`: if unique → reattach. If multiple, disambiguate by `prefix`/`suffix` then nearest to the position hint.
3. **Fuzzy match.** `approx-string-match(P(raw), quote.exact, maxErrors)` with `maxErrors = min(CAP, floor(exact.length / 2))`. Score candidates with `matchQuote` weights:

   | factor | weight |
   |---|---|
   | quote (`1 − errors/len`) | 50 |
   | prefix match | 20 |
   | suffix match | 20 |
   | position proximity (`1 − offset/len`) | 2 |

   Normalize to `0..1` (÷92).

**Confidence bands (D3 — the floor `matchQuote` lacks):**

| score | action | `status` |
|---|---|---|
| ≥ 0.75 | reattach silently | `open` |
| 0.50 – 0.75 | reattach **and** flag | `needs-review` |
| < 0.50 | do **not** guess | `orphaned` (loud) |

**Short-anchor guard:** for very short `exact` (e.g. < 8 chars), `maxErrors = quote.length/2` is too generous; require a minimum exact length or boost prefix/suffix weight to avoid false reattachment.

**Orphan UX hook:** the kernel emits a typed `orphaned` event; how loud it is in VS Code (inline decoration / Problems panel / quarantine list) is a Layer-2 decision, not a kernel one.

## 8. Invariants (testable properties)

These are the deterministic test contract (Test Axis (a)).

1. **Re-anchor-or-orphan.** For any prose edit, every comment either re-anchors with confidence ≥ 0.50 or is marked `orphaned`. **Never** silently mis-attached. *(Property test: random edits, assert no anchor maps to text whose quote-score < 0.50 while `status = open`.)*
2. **Zero-perturbation.** Adding or removing a comment leaves `P(raw)` **byte-identical** and every *other* comment's resolved anchor unchanged. *(Follows from P stripping all markers; tested directly: for any doc, `P(addComment(raw)).clean === P(raw).clean` and other anchors stable.)*
3. **Export identity.** For a `raw` with no prose edits since authoring, `P(raw).clean` equals the original clean document **byte-for-byte**. Round-trip: `clean → author adds comments → P → clean` is identity on the prose.

## 9. Worked round-trip example

**Author starts with `clean`:**
```
We showed that the method improves recall on the benchmark.
```

**Author anchors a comment to "showed" (a `gate-finding`, claim-strength). Raw becomes:**
```
We <!--tether:c=01J9F3K8QXVR3HZA03ZXVED9W0-->showed that the method improves recall on the benchmark.

<!--tether:store
{"id":"01J9F3K8QXVR3HZA03ZXVED9W0","v":1,"trust":"fact","kind":"gate\Dfinding","author":"gate","body":"Background says 'suggested', not 'showed'.","status":"open","created":"2026\D06\D24T12:00:00Z","target":{"quote":{"exact":"showed","prefix":"We ","suffix":" that the metho"},"position":{"start":3,"end":9}},"meta":{"check":"claim\Dstrength","severity":"warn","confidence":0.71,"experimental":true,"observed":"showed","supported":"suggested","suggestion":"soften 'showed' → 'suggested'"}}
tether:store-->
```
*(Note the hyphen-escape: `gate-finding`→`gate\Dfinding`, `claim-strength`→`claim\Dstrength`, the date's hyphens → `\D`.)*

**`P(raw).clean` →** byte-identical to the original:
```
We showed that the method improves recall on the benchmark.
```

**Adding a *second* comment** elsewhere inserts another marker + store line — `P(raw).clean` is unchanged, and comment `01J9F3K8QXVR3HZA03ZXVED9W0` still resolves to the same span (Invariant 2).

---

*Companion docs:* [`../ARCHITECTURE.md`](../ARCHITECTURE.md) · [`../MILESTONE-1.md`](../MILESTONE-1.md)
