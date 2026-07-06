// `tether init` — the one-shot project setup. Under test: each artifact is created when
// missing, merged/appended when present without our entry, left alone when already set
// up, and the whole command is idempotent. The bundled skill must match the repo's
// canonical SKILL.md (the build copies it in; drift here means the bundling broke).

import { beforeAll, describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_NOTE, MCP_SERVER_ENTRY, runInit } from "../src/init.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

beforeAll(() => {
  // The skill is bundled by the build; make sure it exists for the --skill tests.
  execSync("node scripts/bundle-skill.mjs", { cwd: pkgDir, stdio: "ignore" });
});

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "tether-init-"));
}

describe("tether init", () => {
  it("fresh directory: writes .mcp.json and AGENTS.md", () => {
    const dir = tmpProject();
    const results = runInit(dir);
    expect(results.map((r) => r.action)).toEqual(["wrote", "wrote"]);

    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp).toEqual({ mcpServers: { tether: MCP_SERVER_ENTRY } });

    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain(AGENTS_NOTE);
  });

  it("existing .mcp.json: merges the tether entry, preserving other servers", () => {
    const dir = tmpProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const [mcp] = runInit(dir);
    expect(mcp.action).toBe("updated");
    const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.tether).toEqual(MCP_SERVER_ENTRY);
  });

  it("existing .mcp.json without mcpServers key: gains one, other keys preserved", () => {
    const dir = tmpProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ unrelated: true }));
    const [mcp] = runInit(dir);
    expect(mcp.action).toBe("updated");
    const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(parsed.unrelated).toBe(true);
    expect(parsed.mcpServers.tether).toEqual(MCP_SERVER_ENTRY);
  });

  it("invalid .mcp.json: throws with the path, touches nothing", () => {
    const dir = tmpProject();
    writeFileSync(join(dir, ".mcp.json"), "{not json");
    expect(() => runInit(dir)).toThrow(/\.mcp\.json is not valid JSON/);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{not json");
  });

  it("existing AGENTS.md without the note: appends, original content preserved", () => {
    const dir = tmpProject();
    writeFileSync(join(dir, "AGENTS.md"), "# Mine\n\nKeep this.\n");
    const [, agents] = runInit(dir);
    expect(agents.action).toBe("updated");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content.startsWith("# Mine\n\nKeep this.\n")).toBe(true);
    expect(content).toContain(AGENTS_NOTE);
  });

  it("is idempotent: second run reports unchanged and changes no bytes", () => {
    const dir = tmpProject();
    runInit(dir, { skill: true });
    const before = ["/.mcp.json", "/AGENTS.md", "/.claude/skills/tether-edit/SKILL.md"].map((p) => readFileSync(dir + p, "utf8"));
    const results = runInit(dir, { skill: true });
    expect(results.map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
    const after = ["/.mcp.json", "/AGENTS.md", "/.claude/skills/tether-edit/SKILL.md"].map((p) => readFileSync(dir + p, "utf8"));
    expect(after).toEqual(before);
  });

  it("--skill installs the bundled skill, byte-identical to the repo's canonical copy", () => {
    const dir = tmpProject();
    const results = runInit(dir, { skill: true });
    expect(results).toHaveLength(3);
    expect(results[2].action).toBe("wrote");
    const installed = readFileSync(join(dir, ".claude", "skills", "tether-edit", "SKILL.md"), "utf8");
    const canonical = readFileSync(join(pkgDir, "..", "..", "skills", "tether-edit", "SKILL.md"), "utf8");
    expect(installed).toBe(canonical);
  });

  it("--skill keeps a user-modified skill file untouched", () => {
    const dir = tmpProject();
    const dest = join(dir, ".claude", "skills", "tether-edit");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "customized\n");
    const results = runInit(dir, { skill: true });
    expect(results[2].action).toBe("kept");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("customized\n");
  });
});
