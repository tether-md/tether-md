#!/usr/bin/env node
// The `tether` CLI — Layer 3, the file-only contract surface over the kernel.
//
// Exit codes (documented contract):
//   0  success
//   1  usage error (bad/missing arguments)
//   2  store error (malformed Tether file — the kernel hard-failed)
//   3  IO error (file not found / unreadable / unwritable)
//   4  check failed (`status --check`: an anchor is orphaned or needs-review)

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { project, StoreError, type Author, type Kind, type Status, type Trust } from "@tether-md/kernel";
import { runInit } from "./init.js";
import {
  formatDiff,
  formatStatus,
  locateQuote,
  runCommentAccept,
  runCommentAdd,
  runCommentDiff,
  runCommentList,
  runCommentReject,
  runCommentRemove,
  runCommentResolve,
  runCommentSuggest,
  runEdit,
  runExport,
  runProject,
  runStatus,
} from "./commands.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_STORE = 2;
const EXIT_IO = 3;
const EXIT_CHECK = 4;

const TRUSTS = new Set<Trust>(["fact", "interpretation"]);
const KINDS = new Set<Kind>(["comment", "gate-finding"]);
const AUTHORS = new Set<Author>(["human", "agent", "gate"]);
const STATUSES = new Set<Status>(["open", "resolved", "needs-review", "orphaned"]);

const HELP = `tether — anchored comments for Markdown that agents act on, but never apply

Usage:
  tether export <file>                 Print the clean document (clean-export = P).
  tether project <file>                Print the full projection as JSON.
  tether status <file>                 One-glance summary (counts, proposals, anchor health).
  tether edit <file> --quote T --to U  Replace prose span T with U (clean-space edit).
  tether comment list <file>           Print comments + resolved anchors as JSON.
  tether comment add <file> [opts]     Insert a comment (non-destructive by default).
  tether comment suggest <file> <id> --to U   Attach a proposed rewrite (suggestion mode).
  tether comment diff <file> <id>      Preview a proposal against the currently-anchored text.
  tether comment accept <file> <id>    Apply a comment's proposal, then remove the comment.
  tether comment reject <file> <id>    Discard a comment's proposal + the comment.
  tether comment resolve <file> <id>   Mark a comment resolved.
  tether comment remove <file> <id>    Delete a comment (marker + record).
  tether mcp                           Run the MCP stdio server (agent-safe tools only).
  tether init [dir] [--skill]          Set up a project for agents: .mcp.json + AGENTS.md note.
  tether --help | --version

status options:
  --json                               Print {file, counts, proposals, orphans, needsReview}.
  --check                              Exit 4 when any anchor is orphaned or needs-review (CI gate).

comment add options:
  --quote <text>                       Anchor to the unique occurrence of this text, OR
  --start <n> --end <n>                ...an explicit clean-space span (UTF-16).
  --body <text>                        Comment body (required).
  --trust fact|interpretation          Default: fact.
  --kind comment                       Default: comment. (gate-findings are emitted by the gate.)
  --author human|agent|gate            Default: human.
  --write                              Edit the file in place (default: print to stdout).
  --json                               (comment add) Print {"id": ...} instead of the document.

comment list options:
  --status <s>[,<s>]                   Filter by record status (repeatable or comma-separated).
  --author <a> / --kind <k>            Filter by author / kind.

init options:
  --skill                              Also install the Claude Code skill into .claude/skills.
  --json                               Print {ok:true, action:"init", results} on stdout.

edit / suggest / accept / reject / resolve / remove options:
  --write                              Edit the file in place (default: print to stdout).
  --json                               Success envelope {ok:true, action, id?, file|raw} on stdout;
                                       errors become {ok:false, error:{code, message}} on stderr.

Exit codes: 0 ok · 1 usage · 2 malformed Tether file · 3 IO error · 4 check failed`;

// Flipped in main() when --json is passed anywhere on the command line, so die() emits a
// machine-readable envelope and a scripted caller never parses human prose off stderr.
let jsonErrors = false;

function die(code: number, msg: string): never {
  if (jsonErrors) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code, message: msg } }) + "\n");
  } else {
    process.stderr.write(`tether: ${msg}\n`);
  }
  process.exit(code);
}

function readRaw(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return die(EXIT_IO, `cannot read ${path}: ${(err as Error).message}`);
  }
}

/**
 * Atomic in-place write: sibling temp file + rename. A crash mid-write can never leave a
 * truncated document (a torn store block would otherwise hard-fail every later command).
 */
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
    die(EXIT_IO, `cannot write ${path}: ${(err as Error).message}`);
  }
}

/** Run a kernel-backed action, mapping a StoreError to the documented exit code. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StoreError) return die(EXIT_STORE, err.message);
    if (err instanceof RangeError) return die(EXIT_USAGE, err.message);
    throw err;
  }
}

function commentAdd(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        start: { type: "string" },
        end: { type: "string" },
        quote: { type: "string" },
        body: { type: "string" },
        trust: { type: "string" },
        kind: { type: "string" },
        author: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  if (!file) return die(EXIT_USAGE, "comment add: missing <file>");
  if (values.body === undefined) return die(EXIT_USAGE, "comment add: --body is required");

  const trust = (values.trust ?? "fact") as Trust;
  const kind = (values.kind ?? "comment") as Kind;
  const author = (values.author ?? "human") as Author;
  if (!TRUSTS.has(trust)) return die(EXIT_USAGE, `invalid --trust: ${trust}`);
  if (kind === "gate-finding") {
    return die(EXIT_USAGE, "comment add does not support --kind gate-finding (gate findings are emitted by the gate)");
  }
  if (!KINDS.has(kind)) return die(EXIT_USAGE, `invalid --kind: ${kind}`);
  if (!AUTHORS.has(author)) return die(EXIT_USAGE, `invalid --author: ${author}`);

  // Validate the span source BEFORE any IO, so a missing/bad arg is exit 1, not exit 3.
  const hasQuote = values.quote !== undefined;
  if (hasQuote && (values.start !== undefined || values.end !== undefined)) {
    return die(EXIT_USAGE, "comment add: use either --quote or --start/--end, not both");
  }
  if (!hasQuote && (values.start === undefined || values.end === undefined)) {
    return die(EXIT_USAGE, "comment add: provide --quote, or both --start and --end");
  }

  const raw = readRaw(file);

  let start: number;
  let end: number;
  if (hasQuote) {
    try {
      ({ start, end } = locateQuote(raw, values.quote!));
    } catch (err) {
      return die(EXIT_USAGE, (err as Error).message);
    }
  } else {
    // Strict integer parse: reject ""/whitespace/hex/exponential/float, which Number()
    // would silently coerce (e.g. Number("")===0) into a wrong-span anchor.
    const parseOffset = (s: string, name: string): number => {
      const t = s.trim();
      if (!/^-?\d+$/.test(t)) return die(EXIT_USAGE, `comment add: --${name} must be an integer`);
      return Number(t);
    };
    start = parseOffset(values.start!, "start");
    end = parseOffset(values.end!, "end");
  }

  const result = guard(() => runCommentAdd(raw, { start, end, body: values.body!, trust, kind, author }));

  if (values.write) {
    writeRaw(file, result.raw);
    process.stderr.write(`tether: added ${result.id}\n`);
    if (values.json) process.stdout.write(JSON.stringify({ id: result.id }) + "\n");
  } else if (values.json) {
    // Dry run: include the document the id belongs to, so a caller can persist exactly it.
    process.stdout.write(JSON.stringify({ id: result.id, raw: result.raw }) + "\n");
  } else {
    process.stdout.write(result.raw);
  }
}

/** Shared driver for `comment resolve|remove <file> <id> [--write]`. */
function commentMutate(verb: string, rest: string[], fn: (raw: string, id: string) => string): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { write: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  const id = positionals[1];
  if (!file) return die(EXIT_USAGE, `comment ${verb}: missing <file>`);
  if (!id) return die(EXIT_USAGE, `comment ${verb}: missing <id>`);

  const next = guard(() => fn(readRaw(file), id));
  if (values.write) {
    writeRaw(file, next);
    const past = verb.endsWith("e") ? `${verb}d` : `${verb}ed`; // resolved/removed/accepted/rejected
    process.stderr.write(`tether: ${past} ${id}\n`);
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, action: verb, id, file }) + "\n");
  } else if (values.json) {
    // Dry run: include the would-be document, so a caller can persist exactly it.
    process.stdout.write(JSON.stringify({ ok: true, action: verb, id, raw: next }) + "\n");
  } else {
    process.stdout.write(next);
  }
}

/** `tether comment suggest <file> <id> --to "new text" [--write]`. */
function commentSuggest(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { to: { type: "string" }, write: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  const id = positionals[1];
  if (!file) return die(EXIT_USAGE, "comment suggest: missing <file>");
  if (!id) return die(EXIT_USAGE, "comment suggest: missing <id>");
  if (values.to === undefined) return die(EXIT_USAGE, "comment suggest: --to is required");

  const raw = readRaw(file);
  let hadPrior = false;
  try {
    hadPrior = project(raw).store.find((r) => r.id === id)?.proposal !== undefined;
  } catch {
    /* malformed store — the guard() below will report it as a StoreError (exit 2) */
  }
  const next = guard(() => runCommentSuggest(raw, id, values.to!));
  if (values.write) {
    writeRaw(file, next);
    process.stderr.write(`tether: ${hadPrior ? "replaced previous proposal on" : "suggested on"} ${id}\n`);
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, action: "suggest", id, file }) + "\n");
  } else if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, action: "suggest", id, raw: next }) + "\n");
  } else {
    process.stdout.write(next);
  }
}

/** `tether edit <file> --quote "old" --to "new" [--write]`. */
function editCommand(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        quote: { type: "string" },
        to: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  if (!file) return die(EXIT_USAGE, "edit: missing <file>");
  if (values.quote === undefined) return die(EXIT_USAGE, "edit: --quote is required");
  if (values.to === undefined) return die(EXIT_USAGE, "edit: --to is required");

  const raw = readRaw(file);
  let next: string;
  try {
    next = runEdit(raw, values.quote, values.to);
  } catch (err) {
    if (err instanceof StoreError) return die(EXIT_STORE, err.message);
    return die(EXIT_USAGE, (err as Error).message); // quote not found/ambiguous, or span overlaps the layer
  }
  if (values.write) {
    writeRaw(file, next);
    process.stderr.write("tether: edited\n");
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, action: "edit", file }) + "\n");
  } else if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, action: "edit", raw: next }) + "\n");
  } else {
    process.stdout.write(next);
  }
}

/** `tether init [dir] [--skill] [--json]` — set up a project so agents get the contract. */
function initCommand(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { skill: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const dir = positionals[0] ?? ".";

  let results;
  try {
    results = runInit(dir, { skill: values.skill });
  } catch (err) {
    return die(EXIT_IO, `init: ${(err as Error).message}`);
  }
  for (const r of results) {
    process.stderr.write(`tether: ${r.action} ${r.path}${r.note ? ` (${r.note})` : ""}\n`);
  }
  if (values.json) process.stdout.write(JSON.stringify({ ok: true, action: "init", results }) + "\n");
}

/** `tether status <file> [--json] [--check]`. */
function statusCommand(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { json: { type: "boolean", default: false }, check: { type: "boolean", default: false } },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  if (!file) return die(EXIT_USAGE, "status: missing <file>");

  const report = guard(() => runStatus(readRaw(file)));
  if (values.json) {
    process.stdout.write(JSON.stringify({ file, ...report }) + "\n");
  } else {
    process.stdout.write(formatStatus(file, report) + "\n");
  }
  // --check: CI gate. Fail on exactly the anchors accept would refuse (orphaned/needs-review).
  if (values.check && (report.orphans.length > 0 || report.needsReview.length > 0)) {
    process.exit(EXIT_CHECK);
  }
}

/** `tether comment diff <file> <id> [--json]`. */
function commentDiff(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  const id = positionals[1];
  if (!file) return die(EXIT_USAGE, "comment diff: missing <file>");
  if (!id) return die(EXIT_USAGE, "comment diff: missing <id>");

  const d = guard(() => runCommentDiff(readRaw(file), id));
  if (values.json) {
    process.stdout.write(
      JSON.stringify({ id: d.id, quote: d.quote, current: d.current, proposal: d.proposal, anchorStatus: d.anchorStatus }) + "\n",
    );
  } else {
    process.stdout.write(formatDiff(d) + "\n");
  }
}

/** `tether comment list <file> [--status s[,s]]... [--author a] [--kind k]`. */
function commentList(rest: string[]): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { status: { type: "string", multiple: true }, author: { type: "string" }, kind: { type: "string" } },
    });
  } catch (err) {
    return die(EXIT_USAGE, (err as Error).message);
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  if (!file) return die(EXIT_USAGE, "comment list: missing <file>");

  // --status is repeatable AND comma-separable; validate every value so a typo'd filter
  // fails loudly (exit 1) instead of silently matching nothing.
  let status: string[] | undefined;
  if (values.status) {
    status = values.status.flatMap((s) => s.split(",")).map((s) => s.trim());
    for (const s of status) if (!STATUSES.has(s as Status)) return die(EXIT_USAGE, `invalid --status: ${s}`);
  }
  if (values.author !== undefined && !AUTHORS.has(values.author as Author)) {
    return die(EXIT_USAGE, `invalid --author: ${values.author}`);
  }
  if (values.kind !== undefined && !KINDS.has(values.kind as Kind)) {
    return die(EXIT_USAGE, `invalid --kind: ${values.kind}`);
  }

  process.stdout.write(guard(() => runCommentList(readRaw(file), { status, author: values.author, kind: values.kind })) + "\n");
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP + "\n");
    process.exit(EXIT_OK);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    process.exit(EXIT_OK);
  }
  jsonErrors = argv.includes("--json");

  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "export": {
      const file = rest[0];
      if (!file) return die(EXIT_USAGE, "export: missing <file>");
      process.stdout.write(guard(() => runExport(readRaw(file))));
      return;
    }
    case "project": {
      const file = rest[0];
      if (!file) return die(EXIT_USAGE, "project: missing <file>");
      process.stdout.write(guard(() => runProject(readRaw(file))) + "\n");
      return;
    }
    case "status":
      return statusCommand(rest);
    case "init":
      return initCommand(rest);
    case "edit":
      return editCommand(rest);
    case "comment": {
      const sub = rest[0];
      if (sub === "list") return commentList(rest.slice(1));
      if (sub === "add") return commentAdd(rest.slice(1));
      if (sub === "suggest") return commentSuggest(rest.slice(1));
      if (sub === "diff") return commentDiff(rest.slice(1));
      if (sub === "accept") return commentMutate("accept", rest.slice(1), runCommentAccept);
      if (sub === "reject") return commentMutate("reject", rest.slice(1), runCommentReject);
      if (sub === "resolve") return commentMutate("resolve", rest.slice(1), runCommentResolve);
      if (sub === "remove") return commentMutate("remove", rest.slice(1), runCommentRemove);
      return die(EXIT_USAGE, `comment: unknown subcommand '${sub ?? ""}' (expected list|add|suggest|diff|accept|reject|resolve|remove)`);
    }
    case "mcp": {
      // Lazy import: the MCP SDK drags a heavy dependency tree; plain CLI calls must not pay
      // its startup cost. The server holds the process open on the stdio transport.
      import("./mcp.js")
        .then((m) => m.runMcpServer())
        .catch((err: Error) => die(EXIT_IO, `mcp: ${err.message}`));
      return;
    }
    default:
      return die(EXIT_USAGE, `unknown command '${cmd}' (see --help)`);
  }
}

main(process.argv.slice(2));
