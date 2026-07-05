---
name: tether-edit
description: Respond to a human's anchored Tether comments on a markdown draft by PROPOSING rewrites (suggestion mode) — the human then Accepts or Rejects each in the editor. Use when the user says "apply my Tether comments", "address my comments", "suggest fixes for my comments", or points you at a .md they've commented on with Tether.
---

# Tether MD suggestion loop

Tether MD anchors comments inside a Markdown file. The `.md` is `clean_document + comment_layer`: the prose the human owns, plus an invisible layer of anchored comments. The human comments to **direct** you; you **propose** rewrites; the human **Accepts or Rejects** each one in the editor (Accept applies it and clears the comment; Reject discards it). You never apply changes yourself.

**You only touch the `.md` through the `tether` CLI. You propose; the human decides.**

## The loop

1. **Read the document first** — proposals written blind to context read like patches, not prose:
   ```
   tether export <file>
   ```
   This prints the clean document (what the human sees and will ship). Never read or edit the raw `.md` for prose work — markers interleave the prose there, and a raw find/replace will corrupt the file.

2. **Read the comments** (instructions, anchored to exact spans):
   ```
   tether comment list <file>
   ```
   Each item has `id`, `author`, `quote` (the anchored phrase), `body` (the instruction), `status`, and `anchor`. Work the ones with `author: "human"`, `status: "open"`, and no existing proposal.

3. **Propose a rewrite for each**, addressed by `id` — your `--to` text replaces that comment's anchored `quote` if the human accepts:
   ```
   tether comment suggest <file> <id> --to "the rewritten version of the quoted phrase" --write
   ```
   Keep `--to` a self-contained replacement for **exactly the `quote`** (the anchored span). If satisfying the instruction needs changing more than the anchored phrase, don't force it into `--to` — flag it back instead (step 5).

   > A proposal can only be accepted while the comment still anchors cleanly (`anchor.status: "open"`). If the human has since edited that span (it shows `needs-review` or `orphaned`), Accept will refuse — re-read `comment list` and propose against the current text, or flag it back.

4. **Stop and hand back to the human.** Do **not** accept your own suggestions or edit the prose directly. Tell the human what you proposed; they review each suggestion in the editor (Accept / Reject) — or via `tether comment accept|reject <file> <id> --write`.

5. **If you can't ground an instruction** (a missing fact, an ambiguity, a claim with no support), don't guess — add your own comment, marked `interpretation` (your flag-backs are never groundable facts):
   ```
   tether comment add <file> --quote "the exact phrase" --author agent --trust interpretation --body "..." --write
   ```

6. **Verify, then report.** `tether comment list <file>` should show your proposals; `tether export <file>` (read-only) should still be the unchanged clean prose (proposals don't alter it until accepted). Report what you proposed and any flag-backs.

## Hard rules

- **Propose, never apply.** You write proposals (`suggest`) and flag-backs (`add`). The human owns Accept/Reject, export, and send. Don't run `accept`, `resolve`, or `export`-as-send on their behalf.
- **Non-fabrication.** Never upgrade credentials, results, roles, or venues. If an instruction needs a fact the document/Background doesn't support, flag it back — never invent it.
- **Facts in comment bodies are the human's.** If the comment itself supplies the fact or wording ("change the date — it was March 2024"), use it: it is the human's sentence. If neither the document nor the comment provides the needed fact, that is a flag-back, never a guess.
- **The human owns every sentence.** Your proposals serve their anchored instructions; you don't introduce new claims.
- **Don't auto-apply gate findings.** A `gate`-authored finding proposing a truth-downgrade is the human's to accept.

## CLI reference

| Command | Use |
|---|---|
| `tether comment list <file>` | Read all comments + anchors + any proposals (JSON). |
| `tether comment suggest <file> <id> --to "…" --write` | Propose a rewrite of a comment's anchored span (your main action). |
| `tether comment add <file> --quote "…" --author agent --trust interpretation --body "…" --write` | Flag something back (never a groundable fact). |
| `tether export <file>` | Print the pristine clean document (read-only check). |
| _human only:_ `tether comment accept\|reject <file> <id> --write` | Apply / discard a proposal. |

Exit codes: `0` ok · `1` usage · `2` malformed store block · `3` IO error · `4` check failed (`status --check`).

If `tether` is not on your PATH, invoke the built CLI directly: `node <repo>/packages/cli/dist/cli.js …`.
