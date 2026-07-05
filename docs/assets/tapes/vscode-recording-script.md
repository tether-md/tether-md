# Recording the VS Code hero GIF (manual — ~2 minutes)

The terminal GIFs regenerate from the `.tape` files; this one clip needs a human hand.
Target: `docs/assets/vscode.gif`, ≤ 30s, then add it to the README's "In VS Code" section.

## Setup (once)

1. `npm install && npm run build`, then `cd packages/vscode-ext && npm run package` → install `tether-md.vsix` (Extensions panel → ⋯ → *Install from VSIX…*).
2. Copy `examples/draft.md` somewhere fresh; open it in VS Code. Clean window: hide the sidebar (⌘B), zoom to a comfortable size (⌘+ twice), light or dark theme — pick one and stay.
3. Scrub the window of identity before hitting record: enable Do Not Disturb (notification banners can flash names or message contents mid-take), sign out of the VS Code Accounts badge / hide the Activity Bar (it shows the signed-in account avatar), and keep the crop tight — exclude the native title bar and menu bar (the title can expose the real filesystem path).
4. Recorder: [Kap](https://getkap.co) (free) → GIF, 1000–1200 px wide crop around the editor.

## The take

| Beat | Action | Seconds |
|---|---|---|
| 1 | Select the phrase `Databases survive until the next funding round.` → press **⌘⌥C** → type *"sharpen this — best line, but 'funding round' is a cliché"* → submit | 0–8 |
| 2 | In the integrated terminal (pre-opened, small): run `claude -p "address my tether comments in draft.md"` — or, to keep the take short, have the proposal pre-staged and just run `tether comment suggest … --write` from shell history (↑, Enter) | 8–14 |
| 3 | The thread updates: instruction + **diff block** (− current / + proposed) with **Accept · Reject** in the title bar. Hover it for a beat | 14–20 |
| 4 | Click **Accept** — the prose updates in place, thread and highlight vanish | 20–24 |
| 5 | Command palette → **Tether: Export Clean Document** — `draft.clean.md` opens: pure prose | 24–30 |

## Rules of the take

- One continuous take; no cuts. Slow, deliberate mouse movement.
- Don't show any other extensions' UI noise (disable Copilot ghost text for the take).
- The Accept click is the money shot — make sure the cursor visibly travels to it.
- Keep the GIF under ~4 MB: 12–15 fps is fine for editor content.
