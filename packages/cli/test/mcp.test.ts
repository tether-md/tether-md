// MCP server: unit tests of the tool handlers, plus one in-memory client round-trip.
// The trust boundary under test: only the agent-safe tools exist — no accept/reject/
// resolve/remove/edit — and tether_comment always writes as author "agent".

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, tools } from "../src/mcp.js";
import { runCommentAdd, runCommentSuggest } from "../src/commands.js";

const CLEAN = "We showed that the method improves recall.\n";

function tmpDoc(contents: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "tether-mcp-")), "doc.md");
  writeFileSync(f, contents);
  return f;
}

/** A doc file with one commented span + proposal; returns the path and comment id. */
function docWithProposal(): { f: string; id: string } {
  const added = runCommentAdd(CLEAN, { start: 3, end: 9, body: "soften?", trust: "fact", kind: "comment", author: "human" });
  const f = tmpDoc(runCommentSuggest(added.raw, added.id, "demonstrated"));
  return { f, id: added.id };
}

describe("MCP tool handlers", () => {
  it("list mirrors the CLI list JSON", () => {
    const { f, id } = docWithProposal();
    const list = JSON.parse(tools.list({ file: f }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, quote: "showed", proposal: "demonstrated", author: "human" });
  });

  it("status mirrors the CLI status JSON", () => {
    const { f } = docWithProposal();
    const s = JSON.parse(tools.status({ file: f }));
    expect(s).toEqual({
      file: f,
      counts: { total: 1, open: 1, needsReview: 0, orphaned: 0, resolved: 0, byAuthor: { human: 1 } },
      proposals: 1,
      orphans: [],
      needsReview: [],
    });
  });

  it("diff mirrors the CLI diff JSON", () => {
    const { f, id } = docWithProposal();
    expect(JSON.parse(tools.diff({ file: f, id }))).toEqual({
      id,
      quote: "showed",
      current: "showed",
      proposal: "demonstrated",
      anchorStatus: "open",
    });
  });

  it("suggest writes a proposal to the file; export stays byte-identical", () => {
    const added = runCommentAdd(CLEAN, { start: 3, end: 9, body: "x", trust: "fact", kind: "comment", author: "human" });
    const f = tmpDoc(added.raw);
    JSON.parse(tools.suggest({ file: f, id: added.id, to: "demonstrated" }));
    expect(JSON.parse(tools.list({ file: f }))[0].proposal).toBe("demonstrated");
    expect(tools.export({ file: f })).toBe(CLEAN);
  });

  it("comment forces author 'agent' and defaults trust to 'interpretation'", () => {
    const f = tmpDoc(CLEAN);
    const res = JSON.parse(tools.comment({ file: f, quote: "improves", body: "no support in Background" }));
    expect(res.ok).toBe(true);
    const [c] = JSON.parse(tools.list({ file: f }));
    expect(c.id).toBe(res.id);
    expect(c.author).toBe("agent");
    expect(c.trust).toBe("interpretation");
    expect(readFileSync(f, "utf8")).toContain(`<!--tether:c=${res.id}-->`);
  });

  it("kernel errors surface with their message (unknown id, ambiguous quote)", () => {
    const { f } = docWithProposal();
    expect(() => tools.suggest({ file: f, id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", to: "x" })).toThrow(/not found/);
    const g = tmpDoc("a a a\n");
    expect(() => tools.comment({ file: g, quote: "a", body: "x" })).toThrow(/ambiguous/);
  });
});

describe("MCP server round-trip (in-memory transport)", () => {
  it("exposes exactly the agent-safe tools, and serves calls + tool errors", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // The contract is also SAID, not only shaped: server instructions reach every client.
    expect(client.getInstructions()).toContain("Never edit such a file with your own file tools");

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["tether_comment", "tether_diff", "tether_export", "tether_list", "tether_status", "tether_suggest"]);
    // The trust boundary: applying is the human's — none of these may ever appear.
    for (const forbidden of ["accept", "reject", "resolve", "remove", "edit"]) {
      expect(names.join(",")).not.toContain(forbidden);
    }

    const { f, id } = docWithProposal();
    const ok = (await client.callTool({ name: "tether_diff", arguments: { file: f, id } })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).proposal).toBe("demonstrated");

    const err = (await client.callTool({ name: "tether_diff", arguments: { file: f, id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toMatch(/not found/);

    await client.close();
    await server.close();
  });
});
