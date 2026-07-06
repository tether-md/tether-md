<div align="center">

# Tether MD

You comment. The agent proposes. You decide.

[![CI](https://github.com/tether-md/tether-md/actions/workflows/ci.yml/badge.svg)](https://github.com/tether-md/tether-md/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tether-md)](https://www.npmjs.com/package/tether-md)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img src="docs/assets/hero.gif" alt="The Tether MD loop: comment on a phrase, the agent proposes a diff, Accept applies it, export is byte-identical" width="820">

<i>Comment across the draft, as fact or interpretation. The agent works through every comment in one pass; you accept or reject each change. Export stays byte-identical.</i>

</div>

---

Most AI writing surfaces either rewrite your document under you (chat canvases, "apply" buttons) or lock review into a platform (Google Docs, Word, Notion). Markdown in git has no standard suggest mode: a way to leave a comment on a phrase, have an AI act on it, and approve or reject each change yourself.

Tether MD is that layer: anchored comments for Markdown that AI agents act on, but never apply. It is a file format rather than a platform.

- **Comments live in the file.** One invisible HTML-comment marker per comment, plus a machine-readable block at the end. No database, no sidecar, no service; the raw file renders clean on GitHub, in VS Code preview, and through pandoc.
- **Anchors survive editing.** Quote selectors with fuzzy re-anchoring follow the text through edits, flag uncertain matches as needs-review, or orphan with an error.
- **Agents propose; humans apply.** Your comments are anchored instructions. An agent attaches proposals; Accept applies one and clears the comment, Reject discards it.
- **Clean export is tested in CI.** One projection function strips the comment layer; the result is byte-for-byte your prose.

## Quickstart

```sh
npm i -g tether-md
```

```sh
printf 'A draft with some exact phrase in it.\n' > draft.md
tether comment add draft.md --quote "some exact phrase" --body "tighten this" --write
tether status draft.md                       # comments, proposals, anchor health
tether comment suggest draft.md <id> --to "a tighter version" --write   # the agent's move (or yours)
tether comment diff draft.md <id>            # preview:  - current / + proposed
tether comment accept draft.md <id> --write  # apply it and clear the comment
tether export draft.md                       # the authored prose, byte-identical
```

Every mutating command prints its result by default, only edits in place with `--write` (atomically), and takes `--json`; `comment list` and error envelopes are JSON already. Exit codes are stable:

| code | meaning |
|---|---|
| 0 | ok |
| 1 | usage error |
| 2 | malformed store block |
| 3 | IO error |
| 4 | check failed (`status --check`) |

Try it on a real document in 30 seconds: [`examples/`](examples/) ships a worked walkthrough, including the one-line proof of the export guarantee (`tether export reviewed.md | diff - draft.md` prints nothing: byte-identical).

## Hook up your agent

Any MCP-capable agent (Claude Code, Cursor, Codex CLI, and others):

```sh
claude mcp add tether -- tether mcp
```

The MCP server exposes `tether_list`, `tether_status`, `tether_diff`, `tether_suggest`, `tether_comment` (flag-backs), and `tether_export`. It deliberately omits accept, reject, and edit: the trust boundary is enforced at the tool surface, not by prompt etiquette.

For Claude Code there is also a full skill, [`skills/tether-edit/SKILL.md`](skills/tether-edit/SKILL.md). It teaches the contract end to end: read the document, read the comments, propose per instruction, flag back anything that can't be grounded, hand control back. The agent never applies, resolves, or exports.

The working loop becomes: comment on phrases, tell the agent to "address my comments", then review each suggestion in your editor and accept or reject it.

## In VS Code

Install the extension: download `tether-md.vsix` from [Releases](https://github.com/tether-md/tether-md/releases), then in VS Code open the Extensions panel and pick Install from VSIX from its `⋯` menu. Or build it from a clone (`npm install && npm run build && npm run package -w tether-md-vscode`). Then:

- select prose, press <kbd>⌘⌥C</kbd> (<kbd>Ctrl+Alt+C</kbd> on Windows/Linux), type your comment; it renders as a native inline thread
- agent proposals appear in the thread as a diff (current vs. proposed) with Accept and Reject buttons
- fuzzy re-anchors get a dashed warning underline and a diagnostic; orphans land in the Problems panel with a one-click fix
- "Tether: Export Clean Document" writes `<name>.clean.md` beside the file
- VS Code shows one gutter `+` per logical line, so for a second comment on the same soft-wrapped paragraph, select the text and use the keybinding

The editor and the agent never talk to each other. Both only touch the file, so you can watch proposals arrive in your open editor.

## What the file actually looks like

```markdown
The pattern is always the same. The app starts as a text editor and becomes a
database. <!--tether:c=01KWQ2QFDFTHXWAF7RJS1ZNSSX-->Databases survive until the
next funding round.

<!--tether:store
{"id":"01KWQ2QFDFTHXWAF7RJS1ZNSSX","v":1,"trust":"fact","author":"human","body":"sharpen this",...}
tether:store-->
```

One caret marker per comment (a ULID, which can never form the `--` sequence HTML comments forbid), and all data in one JSONL store block at the end of the file, escaped to stay grammar-legal. Renderers hide HTML comments, so the raw file previews clean on GitHub, in VS Code preview, and through pandoc. The grammar, the projection algorithm, the selector model, and the re-anchoring confidence bands are specified in [`docs/spec/wire-format-and-projection.md`](docs/spec/wire-format-and-projection.md). The spec is the product; the TypeScript here is the reference implementation.

## What happens when you edit the text

A comment points at a phrase, and you keep editing the document. Each time the file is read, every comment is re-matched to the current text and gets a confidence score between 0 and 1. The score decides one of three outcomes:

| outcome | when | what you see |
|---|---|---|
| anchored | the phrase still matches (score ≥ 0.75) | the comment follows its text |
| `needs-review` | the phrase changed enough to blur the match (0.50–0.75) | a dashed warning underline and a diagnostic; Accept refuses until you re-confirm |
| orphaned | the phrase is effectively gone (below 0.50) | a loud error; `tether status --check` exits 4, so CI can catch it |

A weak match downgrades to `needs-review` or orphans loudly; it does not silently attach to the wrong words.

<div align="center">
<img src="docs/assets/anchors.gif" alt="A comment follows its text through edits, gets flagged when its phrase is reworded, and orphans loudly when the phrase is deleted" width="800">
</div>

Matching tries the exact phrase first, disambiguates duplicates by their surrounding context, and only then falls back to fuzzy matching, which is where the score comes from (details in the [spec](docs/spec/wire-format-and-projection.md)). One extra safeguard on top: accepting a proposal requires the anchored text to still read exactly as it did when the proposal was made, so a stale suggestion can never splice onto changed wording.

## The three invariants

Everything above reduces to three properties, tested on every commit:

1. **Re-anchor or orphan.** After any edit, every comment re-anchors above the confidence floor or orphans loudly. Weak matches are never silent.
2. **Zero perturbation.** Adding or removing a comment never changes the exported prose or any other comment's anchor.
3. **Export identity.** `tether export` is byte-for-byte the authored prose.

## How it compares

| | comments in the file | survive edits | AI propose, human accept | works with any agent | clean export guarantee |
|---|---|---|---|---|---|
| Tether MD | yes | fuzzy, loud orphans | native threads / CLI | CLI + MCP + skill | byte-identical, in CI |
| Google Docs / Word / Notion | no (platform DB) | yes | their AI only | no | export differs from source |
| GitHub PR suggestions | no (PR thread) | no (stale on rebase) | in the PR UI | PR-bound bots | n/a (reviews a diff, not the doc) |
| CriticMarkup | yes (visible syntax) | inline, no drift detection | no native flow | format only | processor-dependent |
| Cursor / chat canvases | no (session diff) | — | until the session ends | no | — |
| Roughdraft | yes (CriticMarkup) | inline, no drift detection | in its local web UI | yes (CLI) | not spec'd or CI-tested |

The bet: suggest mode should be a property of the document, not of an app. That is also why the wire format is specified independently of this implementation; ports are welcome.

Why not CriticMarkup? Its syntax is visible noise in any CriticMarkup-unaware renderer (GitHub included), and its comments bind only by adjacency: nothing detects when the prose they were about is rewritten. Tether's markers hide in rendered views and re-anchor by quoted text. Why not PR review? Suggestions there attach to diff lines in a forge's database, need a remote and a pull request, and go stale on rebase; here the document itself carries the review, offline, in any repo state.

## Monorepo

| Package | What |
|---|---|
| [`tether-md`](packages/cli) | The `tether` CLI and MCP server (`tether mcp`): the stable, file-only contract surface. |
| [`@tether-md/kernel`](packages/kernel) | The pure projection kernel: `P(raw) → clean`, offset maps, anchoring, store codec. No IO. |
| [`tether-md-vscode`](packages/vscode-ext) | The VS Code extension (native Comments API). |
| [`skills/`](skills) | The agent contract (Claude Code skill). |
| [`docs/`](docs) | The wire-format spec, architecture decision records, milestone history. |

```sh
git clone https://github.com/tether-md/tether-md && cd tether-md
npm install && npm run build && npm test
```

## Limitations (v0.1)

- Editor UI is VS Code-only today. The kernel is editor-agnostic; Obsidian and nvim ports are the most-wanted contributions.
- Store blocks are LF-only by grammar. CRLF hard-fails loudly rather than mis-parsing; the repo's `.gitattributes` protects checkouts, and tolerant reads are tracked.
- One store block per file; concurrent writers race at the file level. Treat the raw file like source code (git merges the store poorly).
- A comment anchored inside a code region relocates its marker to just before that region. Two pathological shapes are rejected with clear errors.

## Roadmap

- Verification gate (the origin of this project): fact-grounding and claim-strength checks whose findings arrive as anchored comments.
- CriticMarkup import/export, conformance test vectors for ports, an Obsidian plugin, a browser build of the kernel.

## Contributing

The spec comes first, the three invariants are non-negotiable, and correctness bugs get priority over everything else. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
