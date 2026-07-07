# Tether MD for VS Code

![Animated demo: a comment is anchored to a span in VS Code, an agent attaches a proposed rewrite, and the human reviews the diff and clicks Accept](https://raw.githubusercontent.com/tether-md/tether-md/main/docs/assets/hero.gif)

*The loop: anchor a comment to your prose, an agent proposes a rewrite, you review the diff and Accept or Reject.*

The editor path. It renders the comment layer, lets you create anchored comments from a selection, surfaces orphans loudly, and exports the clean document, all by reading and writing the one `.md`. It never talks to the agent; both touch only the file.

## What it does

Built on VS Code's native Comments API: inline comment threads, no custom UI.

| Feature | Behavior |
|---|---|
| Add a comment | Select prose and hover the gutter for the `+`, or press `⌘⌥C` (`Ctrl+Alt+C` on Windows/Linux) / right-click → *Add Tether Comment*. Type the body inline, then pick the trust class (fact or interpretation). A marker + store record is written into the file; the comment renders as an inline thread. VS Code shows one gutter `+` per logical line; for a second comment on the same soft-wrapped paragraph, select the text and use the keybinding. |
| Suggestion mode (Accept / Reject) | When an agent proposes a rewrite for a comment, its thread shows a diff preview (the currently-anchored text vs. the proposal) with **Accept** (applies it to the span and clears the comment, no leftover artifact) and **Reject** (discards the proposal + comment). If the span drifted since the proposal was made, the thread warns that Accept will refuse. The agent never applies; you decide. |
| Move a paragraph (pick up / place) | Put the caret in (or select) a paragraph and press `⌘⌥M` (`Ctrl+Alt+M`) or right-click → *Tether: Move Paragraph*. The paragraph is "picked up" (highlighted); **click** where it should go — the click snaps to the nearest paragraph boundary — or press `⌘⌥M` again for a **destination list with a live preview** in the editor. `Esc` cancels. This stores a move comment (source ① badge, destination ⇣① badge); nothing moves until you click **Accept Move** on its thread. If either end drifted since marking, the thread warns and Accept refuses. v1 limits: LF line endings only (the command says so on CRLF files), and blank lines containing only spaces are treated as paragraph-interior. |
| Delete | Plain comments (no proposal) have a **Delete** button. |
| Threads | Comments render as native threads at their anchored span, re-rendered from the store on every change; suggestions expand to show the diff. |
| **Tether: Export Clean Document** | Writes `<name>.clean.md` beside the file (clean-export = P; zero artifacts) and opens it. |
| Decorations | Anchored spans highlighted; the comment layer (markers + store) dimmed. |
| `needs-review` | A span re-anchored fuzzily (confidence 0.50–0.75) gets a dashed warning underline and a Problems-panel warning with the confidence. Re-confirm it before trusting a suggestion there. |
| Orphans | A comment that can't re-anchor (below the 0.50 confidence floor) is surfaced loudly in the Problems panel, with a quick fix to clear it. |
| Malformed file | A bad store block hard-fails the kernel; the extension shows it as an error diagnostic (never silently mis-renders). |
| Setting | `tetherMd.enable` (default `true`, resource-scoped); set `false` to make the extension inert for a folder. |

> **Tip:** VS Code's built-in text drag-and-drop moves text *immediately*, with no review step — the opposite of Tether's model (and an extension cannot intercept it). If you keep dragging by habit, consider disabling it for Markdown in your settings: `"[markdown]": { "editor.dragAndDrop": false }`. Tether never changes this setting for you.

## Architecture

Same split as the CLI: `src/logic.ts` is pure (no `vscode` import) and holds all the raw↔clean coordinate translation; `src/extension.ts` is thin glue over the VS Code API. The pure logic is unit-tested with Vitest; the glue is exercised manually in the Extension Development Host.

VS Code edits the raw file (prose + comment layer); the kernel anchors in clean space. `logic.ts` translates: a selection's raw offsets → clean offsets (`rawToClean`) to anchor, and resolved clean ranges → raw ranges for decorations (`rawStartOf` for the start so the highlight begins after a leading marker; `cleanToRaw` for the end so it stops before a trailing one).

## Develop & run

```sh
# from the repo root
npm install
npm run build      # bundles src/extension.ts -> dist/extension.js (esbuild, cjs, vscode external)
npm test           # pure-logic unit tests (Vitest)
```

**Install it (real-user flow):** `npm run package` → `tether-md.vsix`, then in VS Code: Extensions panel → `⋯` → *Install from VSIX…* → pick `tether-md.vsix`. The commands then live in any markdown file; no F5 needed.

**Run from source (dev):** open this folder in VS Code and press F5 (Extension Development Host); a `.vscode/launch.json` is provided here and at the repo root.

**The agent half of the loop:** the human comments here; an agent (Claude Code) reads them and edits the prose via the `tether` CLI. See [the tether-edit skill](https://github.com/tether-md/tether-md/blob/main/skills/tether-edit/SKILL.md).

> The kernel is ESM-only, so the extension is bundled to a single CJS file (esbuild) for the extension host. A full `@vscode/test-electron` integration harness is deferred (the host can't run headless in CI here); the pure logic carries the test coverage.
