# Changelog

## 0.1.0

Initial release.

- Anchored comments on Markdown as native VS Code comment threads — gutter `+`, `⌘⌥C`, or right-click → *Add Tether Comment*. Comments live in the file (inline marker + EOF store) and survive edits.
- Suggestion review: when an agent attaches a proposal, the thread shows a **diff preview** (current anchored text vs. proposal) with **Accept** (applies + clears) and **Reject**. If the span drifted since the proposal was made, the thread warns that Accept will refuse.
- **needs-review** spans (fuzzy re-anchor, confidence 0.50–0.75) get their own dashed-underline decoration and a Problems-panel warning with the confidence — distinct from cleanly anchored spans.
- Orphans (can't re-anchor) surfaced loudly as diagnostics, with a *clear orphaned comment* quick fix.
- **Tether: Export Clean Document** writes `<name>.clean.md` (byte-identical prose, zero artifacts).
- Programmatic writes use minimal-range edits — cursor position and undo granularity survive.
- `tetherMd.enable` setting (resource-scoped) turns the extension off per folder.
