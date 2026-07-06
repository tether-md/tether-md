// `tether init` — one-shot project setup for agents. Writes the pieces that teach an
// agent the propose-never-apply contract, because an agent with its own file tools sits
// outside the MCP tool surface and follows the contract only once it has been told:
//   .mcp.json                        project-scoped MCP server (Claude Code discovers it)
//   AGENTS.md                        the contract note (read by Cursor and most agents)
//   .claude/skills/tether-edit/     (--skill) the bundled Claude Code skill
//
// Idempotent by design: every artifact is created if missing, merged or appended if
// present without our entry, and left untouched if already set up. Throws plain Errors;
// the CLI maps them to exit 3.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The MCP server entry `tether init` registers in .mcp.json. */
export const MCP_SERVER_ENTRY = { command: "tether", args: ["mcp"] };

/** Sentinel used to detect an AGENTS.md that already carries the note. */
const AGENTS_SENTINEL = "tether-md comments";

/** The contract note for agents that bring their own file tools. Mirrors the README. */
export const AGENTS_NOTE = `## tether-md documents

Markdown files here may contain tether-md comments: invisible <!--tether:...-->
markers plus a store block at EOF. Never edit these files directly; never touch
the markers or the store block. Read the threads with \`tether comment list\`,
propose rewrites with \`tether comment suggest <file> <id> --to "..." --write\`,
flag concerns with \`tether comment add <file> --quote "..." --body "..."
--author agent --write\`. Accept, reject, and export belong to the human.
`;

export interface InitResult {
  path: string;
  action: "wrote" | "updated" | "unchanged" | "kept";
  note?: string;
}

/** Atomic write (temp + rename), throwing variant of the CLI's writeRaw. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tether-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function initMcpJson(dir: string): InitResult {
  const path = join(dir, ".mcp.json");
  const fresh = { mcpServers: { tether: MCP_SERVER_ENTRY } };
  if (!existsSync(path)) {
    writeAtomic(path, JSON.stringify(fresh, null, 2) + "\n");
    return { path, action: "wrote" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix or remove it and rerun`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; fix or remove it and rerun`);
  }
  const config = parsed as { mcpServers?: Record<string, unknown> };
  if (config.mcpServers && typeof config.mcpServers === "object" && "tether" in config.mcpServers) {
    return { path, action: "unchanged" };
  }
  config.mcpServers = { ...config.mcpServers, tether: MCP_SERVER_ENTRY };
  writeAtomic(path, JSON.stringify(config, null, 2) + "\n");
  return { path, action: "updated" };
}

function initAgentsMd(dir: string): InitResult {
  const path = join(dir, "AGENTS.md");
  if (!existsSync(path)) {
    writeAtomic(path, `# Agent instructions\n\n${AGENTS_NOTE}`);
    return { path, action: "wrote" };
  }
  const current = readFileSync(path, "utf8");
  if (current.includes(AGENTS_SENTINEL)) {
    return { path, action: "unchanged" };
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeAtomic(path, current + sep + AGENTS_NOTE);
  return { path, action: "updated" };
}

/** The skill bundled into this package at build time (scripts/bundle-skill.mjs). */
export function bundledSkill(): string {
  const url = new URL("../skill/SKILL.md", import.meta.url);
  try {
    return readFileSync(url, "utf8");
  } catch {
    throw new Error("bundled skill not found (package built without skill/SKILL.md)");
  }
}

function initSkill(dir: string): InitResult {
  const skill = bundledSkill();
  const destDir = join(dir, ".claude", "skills", "tether-edit");
  const path = join(destDir, "SKILL.md");
  if (!existsSync(path)) {
    mkdirSync(destDir, { recursive: true });
    writeAtomic(path, skill);
    return { path, action: "wrote" };
  }
  if (readFileSync(path, "utf8") === skill) {
    return { path, action: "unchanged" };
  }
  return { path, action: "kept", note: "existing file differs from the bundled skill; left as-is" };
}

/** Run the full init against a project directory. */
export function runInit(dir: string, opts: { skill?: boolean } = {}): InitResult[] {
  const results = [initMcpJson(dir), initAgentsMd(dir)];
  if (opts.skill) results.push(initSkill(dir));
  return results;
}
