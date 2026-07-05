# Contributing to Tether MD

Thanks for your interest! This project is small and rigorously specified — most contributions go smoothly if you know three things up front.

## 1. The spec comes first

The wire format, projection `P`, and anchoring behavior are pinned in [`docs/spec/wire-format-and-projection.md`](docs/spec/wire-format-and-projection.md). Code follows the spec, not the other way around. If a change needs different behavior, propose the spec change in the PR (the spec and the code land together). Architecture decisions and their rationale live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## 2. The three invariants are non-negotiable

Every PR must keep these green (they run in CI from [`packages/kernel/test/invariants.test.ts`](packages/kernel/test/invariants.test.ts)):

1. **Re-anchor or orphan.** After any prose edit, every comment re-anchors with confidence ≥ 0.5 or is loudly orphaned — never silently mis-attached.
2. **Zero perturbation.** Adding or removing a comment never changes the clean document or any other comment's anchor.
3. **Export identity.** `tether export` is byte-for-byte the authored prose. Always.

## 3. Build & test

```sh
npm install        # workspace root (Node ≥ 20)
npm run build      # kernel → cli → vscode extension
npm test           # all packages (Vitest)
npm run typecheck
```

`npm test` needs `npm run build` to have run first; the CLI end-to-end tests drive the built binary.

Layout: `packages/kernel` (the projection kernel — pure, no IO), `packages/cli` (the `tether` binary; all IO lives in `cli.ts`, commands are pure transforms), `packages/vscode-ext` (`src/logic.ts` is pure and unit-tested; `src/extension.ts` is thin glue), `skills/` (the agent contract).

To run the VS Code extension from source: open `packages/vscode-ext` and press F5. To package it: `npm run package` in that folder (produces `tether-md.vsix`).

## Naming

- **Tether MD** is the product name, used in headings and prose. `tether-md` (code font) is the npm package, repo slug, and binary alias; `tether` (code font) is the CLI command only.
- Bare "Tether" appears only when quoting shipped UI strings ("Tether: Export Clean Document", "Add Tether Comment"). The kernel package is `@tether-md/kernel`, verbatim.
- Always "VS Code", never "VSCode".

## Pull requests

- Keep changes surgical; match the style around you.
- New behavior needs a test — bug fixes need a regression test that fails without the fix.
- If you touch anchoring, run the unicode suite twice: the offsets are UTF-16 code units and emoji/CJK documents are first-class citizens here.

## Reporting issues

A malformed-store hard-fail, a mis-anchor, or any case where `tether export` is not byte-identical to the authored prose is a **correctness bug** — please include the raw `.md` file (or a minimal reproduction) and the command you ran.
