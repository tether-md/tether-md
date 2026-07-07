# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-07

### Added

- **Move comments (§2.7):** a comment can carry an optional `dest` — a request to move its anchored span to another point, expressed as a quote of non-empty adjacent prose plus a `before`/`after` side (a bare point could never re-anchor). Move records are written with **`v: 2`** so pre-move kernels refuse a document with a pending move loudly ("v must be 1") instead of tolerating a field their `setProposal` could half-apply; accepting or rejecting all moves returns the file to pure `v: 1`. `dest` + `proposal` on one record is a hard parse failure, and `setProposal` refuses on move records.
- Kernel `acceptMove(raw, id)`: human-gated apply — both anchors must resolve `open` with byte-exact quotes; deletes the span, re-inserts it at the destination (landing before any inline marker at that boundary), and normalizes the seams on both sides to the span's granularity (block / line / inline). Refuses loudly rather than corrupting: no-op destinations, spans whose hole contains another comment's marker (boundary-inclusive), ambiguous destination quotes (checked at creation and re-checked at accept — a markerless anchor must never guess between duplicate copies), CRLF seams (moves are LF-only in v1), and whitespace-only blank-line seams. New `resolveDest(clean, record)` resolves destinations with the standard confidence bands.
- VS Code: pick-up/place move marking (`⌘⌥M` / `Ctrl+Alt+M` → click a destination, or re-press for a QuickPick with live in-editor preview), paired ①/⇣① source/destination badges, move threads with **Accept Move** / **Reject** and drift warnings.
- CLI: `comment accept` applies moves too; `comment list` gains `moveTo` (destination quote, side, resolved anchor); `status` reports `moves pending`.

## [0.1.1] - 2026-07-06

### Added

- `tether init [dir] [--skill]`: one-command project setup for agents — writes `.mcp.json` (project-scoped MCP server), creates or appends the `AGENTS.md` contract note, and with `--skill` installs the Claude Code skill now bundled in the npm package. Idempotent; merges into existing files.
- The MCP server sends instructions at initialization telling connected agents never to edit tether-managed files with their own file tools; `tether_export`'s description points agents at it instead of the raw file.

### Fixed

- README claims scoped to what the implementation guarantees (comparison table, re-anchor and stale-accept wording, `--json` coverage).

## [0.1.0] - 2026-07-04

### Added

- Kernel: comment projection, W3C-selector re-anchoring, and byte-identical clean export — all three invariants proven in CI.
- `tether` CLI: `comment add/list/suggest/diff/accept/reject/resolve/remove`, `edit`, `export`, `status --check`.
- `tether mcp`: MCP server exposing the agent-safe surface.
- VS Code extension: native comment threads, diff-before-accept, clean export.
- Agent skill for comment-driven editing; 161 tests (including a fast-check property suite over the invariants) across the monorepo.
