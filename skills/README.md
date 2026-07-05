# Tether skills (Layer 3 — agent integration)

SKILL.md skills that let an agent (Claude Code) participate in the Tether loop through the file-only `tether` CLI contract. The editor and the agent never talk to each other — both only touch the `.md`.

| Skill | Purpose |
|---|---|
| [`tether-edit`](tether-edit/SKILL.md) | Respond to the human's anchored comments in **suggestion mode**: read each as an instruction, PROPOSE a rewrite with `tether comment suggest`, and hand back — the human Accepts or Rejects each in the editor. The agent never applies, resolves, or exports. |

## Install

Copy (or symlink) a skill into a Claude Code skills directory so it's discoverable:

```sh
# project-scoped
mkdir -p .claude/skills && ln -s "$PWD/skills/tether-edit" .claude/skills/tether-edit
# or user-scoped: ~/.claude/skills/tether-edit
```

The skill invokes the `tether` CLI. If it isn't on your PATH, the skill falls back to `node <repo>/packages/cli/dist/cli.js`. To put it on PATH: `npm i -g tether-md` (or `npm link` inside `packages/cli` from a clone), or install the package globally.
