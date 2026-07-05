# @tether-md/kernel — the projection kernel

The core of [Tether MD](https://github.com/tether-md/tether-md): anchored comments that live *inside* a Markdown file, survive edits, and strip away byte-identically.

A Tether `.md` is `clean_document + comment_layer` — the prose the author owns, plus invisible `<!--tether:c=<ULID>-->` markers and one JSONL store block at EOF. Anchoring and clean-export are **one thing**: there is exactly one projection

```
P(raw) -> { clean, offsetMap, store, markers }
```

`clean` is the export. There is no second export path — **clean-export IS P.**

Spec: [wire-format-and-projection.md](https://github.com/tether-md/tether-md/blob/main/docs/spec/wire-format-and-projection.md) · ADRs: [ARCHITECTURE.md](https://github.com/tether-md/tether-md/blob/main/docs/ARCHITECTURE.md)

## The three invariants (the contract everything else builds on)

Proven in [`test/invariants.test.ts`](https://github.com/tether-md/tether-md/blob/main/packages/kernel/test/invariants.test.ts), enforced in CI:

1. **Re-anchor or orphan.** Any prose edit → every comment re-anchors with confidence ≥ 0.50 or is marked `orphaned`. Never silently mis-attached.
2. **Zero perturbation.** Adding/removing a comment leaves `P(raw).clean` byte-identical and every other anchor unchanged.
3. **Export identity.** `P(raw).clean` is byte-for-byte the authored prose; the full round-trip is the identity on prose.

## Public API

### Projection & offsets

| Export | Purpose |
|---|---|
| `project(raw)` / `cleanExport(raw)` | The projection P (spec §5); `cleanExport` returns just `clean`. |
| `rawToClean` / `cleanToRaw` / `cleanToRawStart` / `markerHint` | The offset-map bijection (§4). All offsets are UTF-16 code units. |
| `codeRanges(raw)` | Raw-space `code`/`inlineCode` regions, where Tether-looking tokens are user content. |

### Anchoring

| Export | Purpose |
|---|---|
| `resolve` / `resolveQuote` | Re-anchor a record against `clean`: exact → context-disambiguated → fuzzy, with the spec's confidence bands (≥ 0.75 `open` · 0.50–0.75 `needs-review` · < 0.50 `orphaned`, §7). |
| `resolveAll(raw)` | Resolve every comment in a document (uses marker locality as the hint). |

### Comment operations

| Export | Purpose |
|---|---|
| `insertComment` / `buildRecord` | Anchor a new comment to a clean-space span (captures the W3C quote + position selectors). Markers never land inside code regions — they relocate to just before them. |
| `removeComment` | Delete a comment (marker + record); code-region literals are left alone. |
| `replaceClean(raw, start, end, text)` | Edit prose in **clean space**, preserving the comment layer — the agent's edit primitive (raw find/replace would trip over interleaved markers). |
| `setProposal(raw, id, text)` | **Suggestion mode:** attach a proposed rewrite of the comment's span. Prose is untouched until a human accepts. |
| `acceptProposal(raw, id)` | Apply the proposal to the span, then remove the comment — no artifact. Refuses unless the anchor is `open` **and** the anchored text still reads exactly as quoted (a stale proposal can never splice onto newer wording). |
| `setCommentStatus` | Mark `resolved` / reopen etc. (status only; keeps the marker). |

### Store & codec

| Export | Purpose |
|---|---|
| `parseStore` / `serializeStore` / `StoreError` / `STORE_OPEN` / `STORE_CLOSE` | The EOF store block (§2.2). Malformed, duplicate, misplaced, or duplicate-id stores **hard-fail loudly** — never a silent mis-parse. |
| `encodeLine` / `decodeLine` (+ `*Base64`) | The hyphen-escape codec (§2.5) keeping JSONL legal inside an HTML comment. |
| `ulid` / `isUlid` / `ULID_RE` | Marker identity (§2.1). |

All types are exported (`Record`, `Anchor`, `Projection`, `Segment`, `QuoteSelector`, …). ESM-only, no side effects, no IO — the kernel is a pure library.

## Develop

```sh
npm install        # from the repo root (npm workspace)
npm run typecheck
npm test           # vitest — includes the invariants suite and unicode (emoji/CJK) coverage
npm run build      # emit to dist/
```

## Resolved ⟨DECIDE⟩ points (built to the spec's recommendations)

- **⟨DECIDE 1⟩ — single caret marker** (`<!--tether:c=<ULID>-->`), span extent from the quote selector.
- **⟨DECIDE 2⟩ — readable hyphen-escape codec** (`\` → `\\`, `-` → `\D`); base64 fallback available.
- **⟨DECIDE 3⟩ — non-tether HTML comments preserved** verbatim; extended to tether-looking tokens inside code spans/blocks (they are user content).

## Documented deviations from the spec

These implementation choices depart from the spec as written. Each is defended in a code comment at the site.

1. **Fallback codec is standard base64, not base64url** ([`src/codec.ts`](https://github.com/tether-md/tether-md/blob/main/packages/kernel/src/codec.ts)). The base64url alphabet contains `-`, which would reintroduce the exact `--`/trailing-`-` footgun the codec exists to prevent.

2. **The store region absorbs its surrounding whitespace** ([`src/store.ts`](https://github.com/tether-md/tether-md/blob/main/packages/kernel/src/store.ts)). A retained separator would break byte-identity (Invariant 3): the kernel inserts exactly one `\n` on store creation and strips that newline plus tolerated trailing whitespace in P, preserving the prose's own trailing whitespace.

3. **P locates markers/store by exact-token string search, using remark only for code-region detection** ([`src/projection.ts`](https://github.com/tether-md/tether-md/blob/main/packages/kernel/src/projection.ts)). Keeps all offsets UTF-16 and sidesteps the CommonMark HTML-flow absorption rule; remark still classifies code so literal tether tokens there are preserved.

4. **Markers relocate out of code regions** ([`src/comment.ts`](https://github.com/tether-md/tether-md/blob/main/packages/kernel/src/comment.ts)). The spec places the marker immediately before the span's first character; for a span inside inline code or a fenced block that position would make the marker literal user content (breaking Invariant 2), so it is placed just before the enclosing region instead (end of the previous line for line-start fences). The marker is only a locality hint — the quote selector still defines the span. Two rare shapes are rejected loudly rather than risked: a code region at the very start of the document, and a fence immediately following another code region.

5. **Structure-changing writes are refused.** Markdown block structure is context-sensitive, so a write can re-parse the comment layer into visibility (an unbalanced code fence in an accepted proposal, a marker forced onto a closing-fence line, a removal that re-pairs inline code around another marker). Every mutating operation verifies `P(next).clean` against its intended result and throws instead of writing — found by the property suite, refused by design.

## Known limitations (v0.1)

- **LF-only store grammar.** A store block with CRLF newlines (e.g. round-tripped through `git autocrlf=true`) hard-fails with a `StoreError` — loud, never a silent mis-parse. The repo ships a `.gitattributes` forcing LF; CRLF tolerance on read is a tracked follow-up. Tether MD always *emits* canonical LF.
