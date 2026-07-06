// `tether mcp` — MCP stdio server exposing the AGENT-SAFE surface only.
//
// This is the trust boundary expressed at the tool surface: the agent reads (list, status,
// diff, export), proposes (suggest), and flags back (comment, author forced to "agent") —
// it can never apply. accept / reject / resolve / remove / edit are deliberately NOT
// exposed: those are the human's actions (in the editor, or an explicit CLI call under
// their hands). Do not add them here.
//
// IO (file read/write, transport) lives in this file; all document transforms come from
// commands.ts so MCP and CLI share one code path.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  locateQuote,
  runCommentAdd,
  runCommentDiff,
  runCommentList,
  runCommentSuggest,
  runExport,
  runStatus,
} from "./commands.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

// Handlers throw plain Errors (kernel messages included); McpServer converts any throw
// into a tool error ({isError: true}) carrying the message — no wrapping needed here.
function readRaw(path: string): string {
  return readFileSync(path, "utf8");
}

/** Atomic in-place write (temp + rename), same crash-safety contract as the CLI's. */
function writeRaw(path: string, content: string): void {
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

/** Tool handlers, exported for direct unit tests; the server wires these 1:1. */
export const tools = {
  list(args: { file: string }): string {
    return runCommentList(readRaw(args.file));
  },
  status(args: { file: string }): string {
    return JSON.stringify({ file: args.file, ...runStatus(readRaw(args.file)) });
  },
  diff(args: { file: string; id: string }): string {
    const d = runCommentDiff(readRaw(args.file), args.id);
    return JSON.stringify({ id: d.id, quote: d.quote, current: d.current, proposal: d.proposal, anchorStatus: d.anchorStatus });
  },
  suggest(args: { file: string; id: string; to: string }): string {
    writeRaw(args.file, runCommentSuggest(readRaw(args.file), args.id, args.to));
    return JSON.stringify({ ok: true, action: "suggest", id: args.id, file: args.file });
  },
  comment(args: { file: string; quote: string; body: string; trust?: "fact" | "interpretation" }): string {
    const raw = readRaw(args.file);
    const span = locateQuote(raw, args.quote);
    // author is FORCED to "agent" — an MCP client IS the agent side, whatever it claims;
    // trust defaults to "interpretation" (an agent's flag-backs are never groundable facts).
    const res = runCommentAdd(raw, { ...span, body: args.body, trust: args.trust ?? "interpretation", kind: "comment", author: "agent" });
    writeRaw(args.file, res.raw);
    return JSON.stringify({ ok: true, action: "comment", id: res.id, file: args.file });
  },
  export(args: { file: string }): string {
    return runExport(readRaw(args.file));
  },
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Server-level guidance every connected client receives at initialization. Agents with
 * their own file tools sit outside the tool surface, so the contract must be said, not
 * only shaped — this is the one channel that reaches every MCP client. */
export const SERVER_INSTRUCTIONS =
  "Tether-managed markdown files carry invisible <!--tether:...--> markers and a store block at EOF. " +
  "Never edit such a file with your own file tools: direct edits bypass the human's review and can corrupt markers. " +
  "Read the prose with tether_export (not the raw file), read the threads with tether_list, propose rewrites with " +
  "tether_suggest, and raise concerns with tether_comment. Accepting, rejecting, and editing belong to the human; " +
  "those tools are deliberately absent.";

/** Build the server (exported so tests can drive it over an in-memory transport). */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tether-md", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "tether_list",
    {
      description: "List every comment in a Tether markdown file, joined with its resolved anchor and any pending proposal (JSON).",
      inputSchema: { file: z.string().describe("Path to the Tether .md file") },
    },
    ({ file }) => text(tools.list({ file })),
  );

  server.registerTool(
    "tether_status",
    {
      description: "One-glance summary of a Tether file: comment counts by status and author, pending proposals, anchor health (JSON).",
      inputSchema: { file: z.string().describe("Path to the Tether .md file") },
    },
    ({ file }) => text(tools.status({ file })),
  );

  server.registerTool(
    "tether_diff",
    {
      description: "Preview one comment's proposal against the currently-anchored text (JSON: id, quote, current, proposal, anchorStatus).",
      inputSchema: { file: z.string().describe("Path to the Tether .md file"), id: z.string().describe("Comment id (ULID)") },
    },
    ({ file, id }) => text(tools.diff({ file, id })),
  );

  server.registerTool(
    "tether_suggest",
    {
      description:
        "Attach a proposed rewrite to a comment's anchored span (suggestion mode; writes the file). The prose is unchanged until the HUMAN accepts — there is no accept tool.",
      inputSchema: {
        file: z.string().describe("Path to the Tether .md file"),
        id: z.string().describe("Comment id (ULID)"),
        to: z.string().describe("Replacement text for the comment's anchored span"),
      },
    },
    ({ file, id, to }) => text(tools.suggest({ file, id, to })),
  );

  server.registerTool(
    "tether_comment",
    {
      description:
        "Flag something back to the human as a new anchored comment (writes the file). Author is always 'agent'; trust defaults to 'interpretation'.",
      inputSchema: {
        file: z.string().describe("Path to the Tether .md file"),
        quote: z.string().describe("Unique occurrence of document text to anchor to"),
        body: z.string().describe("Comment body (markdown)"),
        trust: z.enum(["fact", "interpretation"]).optional().describe("Default: interpretation"),
      },
    },
    ({ file, quote, body, trust }) => text(tools.comment({ file, quote, body, trust })),
  );

  server.registerTool(
    "tether_export",
    {
      description:
        "Print the clean document (comment layer stripped; byte-identical to the authored prose). Use this to read the prose instead of opening the raw file.",
      inputSchema: { file: z.string().describe("Path to the Tether .md file") },
    },
    ({ file }) => text(tools.export({ file })),
  );

  return server;
}

/** Entry point for `tether mcp` — serve over stdio until the client disconnects. */
export async function runMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
