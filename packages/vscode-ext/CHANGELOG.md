# Changelog

## 0.2.0

- **Move a paragraph (pick up / place):** `⌘⌥M` / `Ctrl+Alt+M` (or right-click → *Tether: Move Paragraph*) picks up the paragraph under the caret/selection; the next click places it at the nearest paragraph boundary, or press the keybinding again for a destination QuickPick with a live in-editor preview. Stores a move comment (paired ①/⇣① badges); the text moves only when you click **Accept Move** on its thread. `Esc` cancels; any document edit disarms. Moves ride the same re-anchoring as comments — if the excerpt or destination drifts, the thread warns and Accept refuses.

## 0.1.1

No extension changes; version lockstep with `tether-md` 0.1.1 (which adds `tether init` and MCP server instructions).

## 0.1.0

Initial release.

- Anchored comments on Markdown as native VS Code comment threads — gutter `+`, `⌘⌥C`, or right-click → *Add Tether Comment*. Comments live in the file (inline marker + EOF store) and survive edits.
- Suggestion review: when an agent attaches a proposal, the thread shows a **diff preview** (current anchored text vs. proposal) with **Accept** (applies + clears) and **Reject**. If the span drifted since the proposal was made, the thread warns that Accept will refuse.
- **needs-review** spans (fuzzy re-anchor, confidence 0.50–0.75) get their own dashed-underline decoration and a Problems-panel warning with the confidence — distinct from cleanly anchored spans.
- Orphans (can't re-anchor) surfaced loudly as diagnostics, with a *clear orphaned comment* quick fix.
- **Tether: Export Clean Document** writes `<name>.clean.md` (byte-identical prose, zero artifacts).
- Programmatic writes use minimal-range edits — cursor position and undo granularity survive.
- `tetherMd.enable` setting (resource-scoped) turns the extension off per folder.
