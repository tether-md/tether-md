# tether-md — the `tether` CLI

The thin, stable, file-only contract surface over [`@tether-md/kernel`](https://github.com/tether-md/tether-md/tree/main/packages/kernel). The editor and the agent skill never talk to each other: both only touch the `.md`, and the agent touches it through this CLI.

## Commands

| Command | Effect |
|---|---|
| `tether export <file>` | Print the clean document. **Clean-export IS P.** |
| `tether project <file>` | Print the full projection (`clean`, `offsetMap`, `store`, `markers`) as JSON. |
| `tether status <file>` | One-glance summary: counts by status and author, pending proposals, anchor health. `--json` for the machine shape; `--check` exits `4` when any anchor is orphaned/needs-review (CI gate). |
| `tether edit <file> --quote "old" --to "new"` | Replace a unique prose span with new text (clean-space; preserves the comment layer). |
| `tether comment list <file>` | Print each store record joined with its resolved anchor + any proposal, as JSON. Filter with `--status s[,s]` (repeatable), `--author a`, `--kind k`. |
| `tether comment add <file> --quote "TEXT" --body "…" [...]` | Insert a comment anchored to the unique occurrence of `TEXT` (or `--start N --end M`). |
| `tether comment suggest <file> <id> --to "new"` | **Suggestion mode:** attach a proposed rewrite of the comment's span (prose unchanged until accepted). |
| `tether comment diff <file> <id>` | Preview a proposal: comment body, then `- currently-anchored text` / `+ proposal`. When the span has drifted from the recorded quote, this shows exactly what `accept` will refuse on. |
| `tether comment accept <file> <id>` | Apply a comment's proposal to its span, then remove the comment (no artifact). |
| `tether comment reject <file> <id>` | Discard a comment's proposal + the comment. |
| `tether comment resolve <file> <id>` | Mark a comment resolved (status only; keeps the marker). |
| `tether comment remove <file> <id>` | Delete a comment (marker + record). |
| `tether mcp` | Run the MCP stdio server (agent-safe tools only; see below). |
| `tether --help` / `--version` | Usage / version. |

All mutating commands are non-destructive by default: they print the new document; pass `--write` to edit in place.

`comment add` options: `--quote "text"` (anchor to the unique occurrence) or `--start N --end M` (explicit clean-space UTF-16 span); `--trust fact\|interpretation` (default `fact`), `--kind comment` (the only authorable kind; gate findings are emitted by the gate), `--author human\|agent\|gate` (default `human`), `--write`, `--json`.

> Prefer `--quote`: it's how an agent works (in text, not offsets). Explicit `--start`/`--end` offsets are clean-space UTF-16 code units and must land on character boundaries. `tether edit` is the safe way to change prose: editing the raw `.md` directly trips over the comment markers interleaved through it.

### `--json` envelopes (scripting)

`edit`, `suggest`, `accept`, `reject`, `resolve`, `remove` accept `--json`: with `--write`, success prints one line `{"ok":true,"action":…,"id":…,"file":…}` to stdout (the human stderr note is kept); without `--write`, `{"ok":true,"action":…,"id":…,"raw":…}` where `raw` is the would-be document. Whenever `--json` was passed, any error prints one line `{"ok":false,"error":{"code":<exit code>,"message":…}}` to stderr; exit codes unchanged.

## Exit codes (contract)

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error (bad/missing arguments) |
| `2` | store error — malformed store block (the kernel hard-failed) |
| `3` | IO error (file not found / unreadable / unwritable) |
| `4` | check failed (`status --check`: an anchor is orphaned or needs-review) |

These are stable so agents and CI can branch on them.

## MCP server

`tether mcp` serves the comment surface to any MCP-capable agent over stdio (server name `tether-md`). For Claude Code:

```sh
claude mcp add tether -- tether mcp
```

Generic `mcpServers` config:

```json
{
  "mcpServers": {
    "tether": { "command": "tether", "args": ["mcp"] }
  }
}
```

| Tool | Effect |
|---|---|
| `tether_list {file}` | Comment list JSON (same shape as `comment list`). |
| `tether_status {file}` | Status JSON (same shape as `status --json`). |
| `tether_diff {file, id}` | Proposal preview JSON (same shape as `comment diff --json`). |
| `tether_suggest {file, id, to}` | Attach a proposed rewrite (writes the file). |
| `tether_comment {file, quote, body, trust?}` | Flag something back: author is forced to `agent`, trust defaults to `interpretation`. |
| `tether_export {file}` | The clean document text. |

**The trust boundary, expressed at the tool surface:** `accept`, `reject`, `resolve`, `remove`, and `edit` are deliberately not exposed, and the server's instructions tell connected agents to stay on this surface. Over MCP the agent can read, propose, and flag back, but never apply. Accepting or rejecting a proposal stays a human action (in the editor, or an explicit CLI call under human hands). Note the scope: an agent that also carries its own file tools can still edit the raw file; pair the server with the [tether-edit skill](https://github.com/tether-md/tether-md/blob/main/skills/tether-edit/SKILL.md) or the `AGENTS.md` note from the [root README](https://github.com/tether-md/tether-md#hook-up-your-agent) so those tools honor the contract too.

## Deferred

- **`gate run`** — the verification gate is not yet wired. `comment add` deliberately rejects `--kind gate-finding`: those records require `meta` fields only the gate produces; the CLI authors plain comments. The gate will emit findings as anchored comments once built.

## Develop

```sh
# from the repo root
npm install
npm run build      # builds @tether-md/kernel then tether-md
npm test           # kernel + cli (cli e2e drives the built binary)
```
