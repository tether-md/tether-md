// End-to-end: drive the BUILT binary the way an agent or user would. This proves the
// stable contract surface (args, stdout, exit codes), not just the command functions.

import { beforeAll, describe, it, expect } from "vitest";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const cli = join(pkgDir, "dist", "cli.js");
const CLEAN = "We showed that the method improves recall.\n";

beforeAll(() => {
  // The e2e exercises the compiled binary, so build the CLI first. The kernel must
  // already be built (its dist is what @tether-md/kernel resolves to at runtime).
  execSync("npm run build", { cwd: pkgDir, stdio: "ignore" });
}, 60_000);

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tether-e2e-"));
  const f = join(dir, "doc.md");
  writeFileSync(f, contents);
  return f;
}

describe("tether CLI (built binary)", () => {
  it("export prints the clean document unchanged", () => {
    const f = tmpFile(CLEAN);
    const out = execFileSync("node", [cli, "export", f], { encoding: "utf8" });
    expect(out).toBe(CLEAN);
  });

  it("comment add --write persists, and export still yields the original clean", () => {
    const f = tmpFile(CLEAN);
    const out = execFileSync("node", [cli, "comment", "add", f, "--start", "3", "--end", "9", "--body", "soften?", "--write", "--json"], { encoding: "utf8" });
    const { id } = JSON.parse(out);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The file now contains the comment layer...
    expect(readFileSync(f, "utf8")).toContain("<!--tether:c=");
    // ...but clean-export is byte-identical to the authored prose.
    expect(execFileSync("node", [cli, "export", f], { encoding: "utf8" })).toBe(CLEAN);
    // ...and the comment is listed.
    const list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list).toHaveLength(1);
    expect(list[0].quote).toBe("showed");
  });

  it("edit --quote --to rewrites prose even with interleaved comment markers", () => {
    const f = tmpFile(CLEAN);
    // two comments interleave markers through the sentence
    execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write"], { encoding: "utf8" });
    execFileSync("node", [cli, "comment", "add", f, "--quote", "improves", "--body", "y", "--write"], { encoding: "utf8" });
    // a raw find/replace of the whole clause would fail; tether edit works in clean space
    execFileSync("node", [cli, "edit", f, "--quote", "showed", "--to", "demonstrated", "--write"], { encoding: "utf8" });
    expect(execFileSync("node", [cli, "export", f], { encoding: "utf8" })).toBe(CLEAN.replace("showed", "demonstrated"));
    // the other comment survived
    const list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list.some((c: { quote: string }) => c.quote === "improves")).toBe(true);
  });

  it("suggest → accept applies the proposal and clears the comment (no artifact)", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "soften", "--write", "--json"], { encoding: "utf8" }),
    );
    execFileSync("node", [cli, "comment", "suggest", f, id, "--to", "demonstrated", "--write"], { encoding: "utf8" });
    let list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list[0].proposal).toBe("demonstrated");

    execFileSync("node", [cli, "comment", "accept", f, id, "--write"], { encoding: "utf8" });
    expect(execFileSync("node", [cli, "export", f], { encoding: "utf8" })).toBe(CLEAN.replace("showed", "demonstrated"));
    list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list).toHaveLength(0);
  });

  it("suggest → reject discards the proposal, prose unchanged", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write", "--json"], { encoding: "utf8" }),
    );
    execFileSync("node", [cli, "comment", "suggest", f, id, "--to", "demonstrated", "--write"], { encoding: "utf8" });
    execFileSync("node", [cli, "comment", "reject", f, id, "--write"], { encoding: "utf8" });
    expect(execFileSync("node", [cli, "export", f], { encoding: "utf8" })).toBe(CLEAN);
    expect(JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }))).toHaveLength(0);
  });

  it("accept on a comment with no proposal exits 1", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write", "--json"], { encoding: "utf8" }),
    );
    const r = spawnSync("node", [cli, "comment", "accept", f, id, "--write"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("edit on ambiguous quote exits 1", () => {
    const f = tmpFile("a a a\n");
    const r = spawnSync("node", [cli, "edit", f, "--quote", "a", "--to", "b"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("exits 1 on a usage error", () => {
    const r = spawnSync("node", [cli, "comment", "add", "/nope", "--body", "x"], { encoding: "utf8" });
    expect(r.status).toBe(1); // missing --start/--end
  });

  it("exits 1 on non-integer --start (no silent coercion of ''/hex/float)", () => {
    const f = tmpFile(CLEAN);
    for (const bad of ["", " ", "0x9", "1e2", "3.5"]) {
      const r = spawnSync("node", [cli, "comment", "add", f, "--start", bad, "--end", "9", "--body", "x"], { encoding: "utf8" });
      expect(r.status, `--start '${bad}'`).toBe(1);
    }
  });

  it("exits 1 on a zero-width span (start === end)", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "add", f, "--start", "5", "--end", "5", "--body", "x"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("add --quote anchors to the unique occurrence, then resolve and remove", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "soften?", "--write", "--json"], { encoding: "utf8" }),
    );
    let list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list[0].quote).toBe("showed");

    execFileSync("node", [cli, "comment", "resolve", f, id, "--write"], { encoding: "utf8" });
    list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list[0].status).toBe("resolved");

    execFileSync("node", [cli, "comment", "remove", f, id, "--write"], { encoding: "utf8" });
    list = JSON.parse(execFileSync("node", [cli, "comment", "list", f], { encoding: "utf8" }));
    expect(list).toHaveLength(0);
    expect(execFileSync("node", [cli, "export", f], { encoding: "utf8" })).toBe(CLEAN);
  });

  it("add --quote on ambiguous text exits 1", () => {
    const f = tmpFile("a a a\n");
    const r = spawnSync("node", [cli, "comment", "add", f, "--quote", "a", "--body", "x"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("resolve on an unknown id exits 1", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "resolve", f, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--write"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("remove on an unknown id exits 1 (no silent success)", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "remove", f, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--write"], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  it("comment add --kind gate-finding exits 1 with a clear message", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "add", f, "--quote", "showed", "--kind", "gate-finding", "--body", "x"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gate-finding/);
  });

  it("exits 3 when the file does not exist", () => {
    const r = spawnSync("node", [cli, "export", "/definitely/not/here.md"], { encoding: "utf8" });
    expect(r.status).toBe(3);
  });

  it("exits 2 on a malformed Tether file", () => {
    const f = tmpFile("prose\n<!--tether:store\n{}\ntether:store-->");
    const r = spawnSync("node", [cli, "export", f], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

/** A doc with one commented span + proposal; returns the file and comment id. */
function docWithProposal(): { f: string; id: string } {
  const f = tmpFile(CLEAN);
  const { id } = JSON.parse(
    execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "soften?", "--write", "--json"], { encoding: "utf8" }),
  );
  execFileSync("node", [cli, "comment", "suggest", f, id, "--to", "demonstrated", "--write"], { encoding: "utf8" });
  return { f, id };
}

/** Orphan the comment by rewriting the anchored prose directly (the marker survives). */
function orphanAnchor(f: string): void {
  writeFileSync(f, readFileSync(f, "utf8").replace("showed that the method improves recall.", "completely different words are here now."));
}

describe("tether status (built binary)", () => {
  it("prints a terse human summary", () => {
    const { f } = docWithProposal();
    const out = execFileSync("node", [cli, "status", f], { encoding: "utf8" });
    expect(out).toContain("1 comment (1 open, 0 needs-review, 0 orphaned, 0 resolved)");
    expect(out).toContain("proposals pending: 1");
    expect(out).toContain("anchor health: ok");
  });

  it("--json prints the stable object", () => {
    const { f, id } = docWithProposal();
    const j = JSON.parse(execFileSync("node", [cli, "status", f, "--json"], { encoding: "utf8" }));
    expect(j).toEqual({
      file: f,
      counts: { total: 1, open: 1, needsReview: 0, orphaned: 0, resolved: 0, byAuthor: { human: 1 } },
      proposals: 1,
      moves: 0,
      orphans: [],
      needsReview: [],
    });
    expect(id).toBeTruthy();
  });

  it("--check exits 0 while anchors are healthy, 4 once one orphans", () => {
    const { f, id } = docWithProposal();
    expect(spawnSync("node", [cli, "status", f, "--check"], { encoding: "utf8" }).status).toBe(0);

    orphanAnchor(f);
    const r = spawnSync("node", [cli, "status", f, "--check", "--json"], { encoding: "utf8" });
    expect(r.status).toBe(4);
    const j = JSON.parse(r.stdout);
    expect(j.orphans).toEqual([id]);
    expect(j.counts.orphaned).toBe(1);
  });
});

describe("tether comment diff (built binary)", () => {
  it("prints body header + minimal -/+ preview", () => {
    const { f, id } = docWithProposal();
    const out = execFileSync("node", [cli, "comment", "diff", f, id], { encoding: "utf8" });
    expect(out).toBe("soften?\n- showed\n+ demonstrated\n");
  });

  it("--json prints {id, quote, current, proposal, anchorStatus}", () => {
    const { f, id } = docWithProposal();
    const j = JSON.parse(execFileSync("node", [cli, "comment", "diff", f, id, "--json"], { encoding: "utf8" }));
    expect(j).toEqual({ id, quote: "showed", current: "showed", proposal: "demonstrated", anchorStatus: "open" });
  });

  it("exits 1 when the comment has no proposal", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write", "--json"], { encoding: "utf8" }),
    );
    const r = spawnSync("node", [cli, "comment", "diff", f, id], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no proposal/);
  });
});

describe("--json envelopes on mutating verbs (built binary)", () => {
  it("suggest --write --json prints {ok, action, id, file} and keeps the stderr note", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write", "--json"], { encoding: "utf8" }),
    );
    const r = spawnSync("node", [cli, "comment", "suggest", f, id, "--to", "demonstrated", "--write", "--json"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, action: "suggest", id, file: f });
    expect(r.stderr).toContain("suggested on");
  });

  it("edit --json without --write prints {ok, action, raw} and does not touch the file", () => {
    const f = tmpFile(CLEAN);
    const before = readFileSync(f, "utf8");
    const j = JSON.parse(execFileSync("node", [cli, "edit", f, "--quote", "showed", "--to", "demonstrated", "--json"], { encoding: "utf8" }));
    expect(j.ok).toBe(true);
    expect(j.action).toBe("edit");
    expect(j.raw).toBe(CLEAN.replace("showed", "demonstrated"));
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  it("resolve --write --json prints the envelope", () => {
    const f = tmpFile(CLEAN);
    const { id } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "x", "--write", "--json"], { encoding: "utf8" }),
    );
    const r = spawnSync("node", [cli, "comment", "resolve", f, id, "--write", "--json"], { encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, action: "resolve", id, file: f });
  });

  it("errors with --json become a one-line {ok:false, error:{code, message}} envelope on stderr", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "accept", f, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--write", "--json"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe(1);
    expect(err.error.message).toMatch(/not found/);
    expect(r.stdout).toBe("");
  });

  it("without --json the error output is the human line (unchanged contract)", () => {
    const f = tmpFile(CLEAN);
    const r = spawnSync("node", [cli, "comment", "accept", f, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--write"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^tether: comment .* not found\n$/);
  });
});

describe("comment list filters (built binary)", () => {
  function docWithTwo(): { f: string; humanId: string } {
    const f = tmpFile(CLEAN);
    const { id: humanId } = JSON.parse(
      execFileSync("node", [cli, "comment", "add", f, "--quote", "showed", "--body", "one", "--write", "--json"], { encoding: "utf8" }),
    );
    execFileSync(
      "node",
      [cli, "comment", "add", f, "--quote", "improves", "--body", "two", "--author", "agent", "--trust", "interpretation", "--write"],
      { encoding: "utf8" },
    );
    execFileSync("node", [cli, "comment", "resolve", f, humanId, "--write"], { encoding: "utf8" });
    return { f, humanId };
  }

  it("--status, --author, and comma-separated values filter the list", () => {
    const { f } = docWithTwo();
    const open = JSON.parse(execFileSync("node", [cli, "comment", "list", f, "--status", "open"], { encoding: "utf8" }));
    expect(open).toHaveLength(1);
    expect(open[0].author).toBe("agent");

    const both = JSON.parse(execFileSync("node", [cli, "comment", "list", f, "--status", "open,resolved"], { encoding: "utf8" }));
    expect(both).toHaveLength(2);

    const human = JSON.parse(execFileSync("node", [cli, "comment", "list", f, "--author", "human"], { encoding: "utf8" }));
    expect(human).toHaveLength(1);
    expect(human[0].body).toBe("one");

    const none = JSON.parse(execFileSync("node", [cli, "comment", "list", f, "--author", "human", "--status", "open"], { encoding: "utf8" }));
    expect(none).toHaveLength(0);
  });

  it("a typo'd --status exits 1 instead of matching nothing", () => {
    const { f } = docWithTwo();
    const r = spawnSync("node", [cli, "comment", "list", f, "--status", "opne"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid --status/);
  });
});

describe("tether init (built binary)", () => {
  it("sets up a fresh project and is idempotent, with a --json envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-e2e-init-"));
    const first = execFileSync("node", [cli, "init", dir, "--skill", "--json"], { encoding: "utf8" });
    const envelope = JSON.parse(first);
    expect(envelope.ok).toBe(true);
    expect(envelope.results.map((r: { action: string }) => r.action)).toEqual(["wrote", "wrote", "wrote"]);

    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.tether).toEqual({ command: "tether", args: ["mcp"] });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("tether-md comments");
    expect(readFileSync(join(dir, ".claude", "skills", "tether-edit", "SKILL.md"), "utf8")).toContain("tether");

    const again = JSON.parse(execFileSync("node", [cli, "init", dir, "--skill", "--json"], { encoding: "utf8" }));
    expect(again.results.map((r: { action: string }) => r.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("invalid .mcp.json exits 3 with a pointed message", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-e2e-init-"));
    writeFileSync(join(dir, ".mcp.json"), "{nope");
    const r = spawnSync("node", [cli, "init", dir], { encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/not valid JSON/);
  });
});
