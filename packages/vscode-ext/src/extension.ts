// Tether VSCode extension (Layer 2) — thin glue over ./logic.ts and the VSCode API.
// The editor only ever touches the .md; it never talks to the agent.
//
// UX is built on VSCode's native Comments API: inline comment threads with a gutter "+",
// per-thread Accept/Reject/Delete, plus a keybinding/right-click to comment a selection. No
// custom webview — the comment layer in the file is the source of truth, re-rendered as
// native threads on every change.

import * as vscode from "vscode";
import { basename } from "node:path";
import { acceptMove, acceptProposal, cleanExport, cleanToRaw, project, removeComment, StoreError, type Segment, type Trust } from "@tether-md/kernel";
import {
  addCommentFromSelection,
  addMoveComment,
  anchoredComments,
  buildDecorationModel,
  cleanBlocks,
  cleanExportPath,
  cleanRangeToRaw,
  destinationFromPoint,
  diagnoseDestinations,
  minimalEdit,
  moveMarkdown,
  moveTargets,
  selectionToClean,
  snapToBlocks,
  suggestionMarkdown,
  Debouncer,
  type Block,
  type MoveDestination,
  type MoveTarget,
  type RawRange,
} from "./logic.js";

let anchoredDeco: vscode.TextEditorDecorationType;
let needsReviewDeco: vscode.TextEditorDecorationType;
let commentLayerDeco: vscode.TextEditorDecorationType;
let moveSourceDeco: vscode.TextEditorDecorationType;
let moveGhostDeco: vscode.TextEditorDecorationType;
let moveBadgeDeco: vscode.TextEditorDecorationType;
let moveStatusItem: vscode.StatusBarItem;
let diagnostics: vscode.DiagnosticCollection;
let controller: vscode.CommentController;

// The armed pick-up/place state (at most one move being marked at a time). The document
// must not change between arming and placing — guarded by `version` at every use.
interface PendingMove {
  uri: string;
  version: number;
  /** Snapped source block(s), clean space. */
  src: Block;
  clean: string;
  blocks: Block[];
  offsetMap: Segment[];
  /** Source decoration span, raw space. */
  srcRaw: RawRange;
}
let pendingMove: PendingMove | null = null;
// The destination QuickPick, when open — disarming must close it, or it would preview
// stale offsets against a changed document and its Enter would silently do nothing.
let movePicker: vscode.QuickPick<vscode.QuickPickItem & { target: MoveTarget }> | undefined;

/** Every visible editor pane showing `uri` — decorations are per-editor-INSTANCE, so a
 *  split view needs them set/cleared on each pane, not just the first match. */
function editorsShowing(uri: string): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri);
}

// Tether threads we own, per document — so we can dispose + rebuild them on each change.
const threadsByDoc = new Map<string, vscode.CommentThread[]>();
const debounce = new Debouncer();

const isMarkdown = (doc: vscode.TextDocument) => doc.languageId === "markdown";

/** tetherMd.enable is resource-scoped — check against the document, not just the workspace. */
const enabledFor = (uri?: vscode.Uri) =>
  vscode.workspace.getConfiguration("tetherMd", uri ?? null).get<boolean>("enable", true);

export function activate(context: vscode.ExtensionContext): void {
  // tetherMd.enable=false at activation → contribute nothing (no controller, decorations,
  // or handlers). Re-enabling then needs a window reload; say so instead of staying silent.
  if (!enabledFor()) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("tetherMd.enable") && enabledFor()) {
          void vscode.window.showInformationMessage("Tether MD enabled — reload the window to activate it.");
        }
      }),
    );
    return;
  }

  anchoredDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  // needs-review gets its OWN look (not merged into anchored): a dashed warning underline +
  // warning background, all via theme tokens so it reads in any theme. textDecoration is raw
  // CSS — ThemeColor can't go there, but VSCode exposes tokens as --vscode-* variables.
  needsReviewDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("inputValidation.warningBackground"),
    textDecoration: "underline dashed var(--vscode-editorWarning-foreground)",
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  commentLayerDeco = vscode.window.createTextEditorDecorationType({
    opacity: "0.35",
    color: new vscode.ThemeColor("descriptionForeground"),
  });
  // The "picked up" excerpt while a move is being marked.
  moveSourceDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
    border: "1px dashed",
    borderColor: new vscode.ThemeColor("focusBorder"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  // Live destination preview while arrowing through the move QuickPick.
  moveGhostDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    after: {
      contentText: "  ⇠ move here",
      color: new vscode.ThemeColor("descriptionForeground"),
      fontStyle: "italic",
    },
  });
  // Paired source/destination badges (①, ⇣①) for stored move comments.
  moveBadgeDeco = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  moveStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  void vscode.commands.executeCommand("setContext", "tetherMd.movePending", false);
  diagnostics = vscode.languages.createDiagnosticCollection("tether-md");

  controller = vscode.comments.createCommentController("tether-md", "Tether MD");
  controller.commentingRangeProvider = {
    provideCommentingRanges: (doc) =>
      isMarkdown(doc) && enabledFor(doc.uri) ? [new vscode.Range(0, 0, doc.lineCount, 0)] : [],
  };

  // The agent half of the loop edits the .md on disk via the CLI. Watch for those external
  // writes so the comment threads rebuild without a manual reload (onDidChangeTextDocument
  // alone doesn't fire reliably for external reverts).
  const mdWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
  const onExternalWrite = (uri: vscode.Uri) => {
    const doc = docFor(uri);
    if (doc) scheduleRefresh(doc); // debounced — lets VSCode revert the buffer first
  };

  context.subscriptions.push(
    mdWatcher,
    mdWatcher.onDidChange(onExternalWrite),
    mdWatcher.onDidCreate(onExternalWrite),
    anchoredDeco,
    needsReviewDeco,
    commentLayerDeco,
    diagnostics,
    controller,
    moveSourceDeco,
    moveGhostDeco,
    moveBadgeDeco,
    moveStatusItem,
    vscode.commands.registerCommand("tetherMd.addComment", addCommentCommand),
    vscode.commands.registerCommand("tetherMd.exportClean", exportCleanCommand),
    vscode.commands.registerCommand("tetherMd.createComment", createCommentFromThread),
    vscode.commands.registerCommand("tetherMd.acceptSuggestion", acceptSuggestionCommand),
    vscode.commands.registerCommand("tetherMd.rejectSuggestion", rejectSuggestionCommand),
    vscode.commands.registerCommand("tetherMd.deleteThread", deleteThreadCommand),
    vscode.commands.registerCommand("tetherMd.clearOrphan", clearOrphanCommand),
    vscode.commands.registerCommand("tetherMd.moveSelection", moveSelectionCommand),
    vscode.commands.registerCommand("tetherMd.cancelMove", () => cancelMove()),
    vscode.commands.registerCommand("tetherMd.acceptMove", acceptMoveCommand),
    vscode.languages.registerCodeActionsProvider({ language: "markdown" }, orphanActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      // Switching documents abandons an armed move (its offsets belong to the old doc).
      if (pendingMove && (!e || e.document.uri.toString() !== pendingMove.uri)) cancelMove();
      if (e) refresh(e.document);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // The placement gesture: while armed, a mouse CLICK (empty selection) in the same
      // document places the move. Keyboard navigation stays free for looking around.
      if (!pendingMove || e.textEditor.document.uri.toString() !== pendingMove.uri) return;
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      const sel = e.selections[0];
      if (!sel || !sel.isEmpty) return;
      void placeMoveAtClick(e.textEditor, e.textEditor.document.offsetAt(sel.active));
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (pendingMove && e.document.uri.toString() === pendingMove.uri && e.contentChanges.length > 0) {
        cancelMove("Tether: document changed — move cancelled");
      }
      scheduleRefresh(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => disposeDoc(d)),
    // Per-resource flips of tetherMd.enable apply live: clear everything for a now-disabled
    // document (refresh() bails on it from here on), re-render a now-enabled one.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("tetherMd.enable")) return;
      for (const ed of vscode.window.visibleTextEditors) {
        if (!isMarkdown(ed.document)) continue;
        if (enabledFor(ed.document.uri)) refresh(ed.document);
        else clearDoc(ed.document);
      }
    }),
  );

  if (vscode.window.activeTextEditor) refresh(vscode.window.activeTextEditor.document);
}

export function deactivate(): void {
  debounce.cancelAll();
  for (const threads of threadsByDoc.values()) threads.forEach((t) => t.dispose());
  threadsByDoc.clear();
}

// ---- rendering -------------------------------------------------------------

function scheduleRefresh(doc: vscode.TextDocument): void {
  if (!isMarkdown(doc) || !enabledFor(doc.uri)) return;
  // The doc can close between schedule and fire (disposeDoc cancels, but a watcher event can
  // re-schedule after); firing then would resurrect its threads as ghosts. Guard the callback.
  debounce.schedule(
    doc.uri.toString(),
    () => {
      if (!doc.isClosed) refresh(doc);
    },
    200,
  );
}

function disposeDocThreads(key: string): void {
  (threadsByDoc.get(key) ?? []).forEach((t) => t.dispose());
  threadsByDoc.delete(key);
}

function disposeDoc(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();
  debounce.cancel(key); // a pending refresh outliving the doc would rebuild ghost threads
  disposeDocThreads(key);
  diagnostics.delete(doc.uri);
}

/** Drop everything we render for a doc (close, or tetherMd.enable flipped off). */
function clearDoc(doc: vscode.TextDocument): void {
  disposeDoc(doc);
  if (pendingMove && pendingMove.uri === doc.uri.toString()) cancelMove();
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  if (editor) {
    editor.setDecorations(anchoredDeco, []);
    editor.setDecorations(needsReviewDeco, []);
    editor.setDecorations(commentLayerDeco, []);
  }
  for (const e of editorsShowing(doc.uri.toString())) e.setDecorations(moveBadgeDeco, []);
}

/** Re-render decorations, threads, and orphan/needs-review diagnostics for a document. */
function refresh(doc: vscode.TextDocument): void {
  if (!isMarkdown(doc) || doc.isClosed || !enabledFor(doc.uri)) return;
  const key = doc.uri.toString();
  // An immediate own-edit refresh supersedes any pending debounced one (avoids a double
  // rebuild that flickers threads and drops their expansion state).
  debounce.cancel(key);
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  const toRange = (r: RawRange) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));

  // Decorations + orphan/needs-review diagnostics from the projection.
  let orphaned: { id: string; quote: string; body: string }[] = [];
  let needsReview: { id: string; range: RawRange; confidence: number }[] = [];
  try {
    const model = buildDecorationModel(doc.getText());
    if (editor) {
      editor.setDecorations(anchoredDeco, model.anchored.map(toRange));
      editor.setDecorations(needsReviewDeco, model.needsReview.map((n) => toRange(n.range)));
      editor.setDecorations(commentLayerDeco, model.commentLayer.map(toRange));
    }
    orphaned = model.orphaned;
    needsReview = model.needsReview;
  } catch (err) {
    if (editor) {
      editor.setDecorations(anchoredDeco, []);
      editor.setDecorations(needsReviewDeco, []);
      editor.setDecorations(commentLayerDeco, []);
    }
    for (const e of editorsShowing(key)) e.setDecorations(moveBadgeDeco, []);
    const msg = err instanceof StoreError ? err.message : (err as Error).message;
    diagnostics.set(doc.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `Tether: ${msg}`, vscode.DiagnosticSeverity.Error)]);
    disposeDocThreads(key); // can't trust the comment layer; clear threads
    return;
  }

  diagnostics.set(doc.uri, [
    ...orphaned.map((o) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `Tether: orphaned comment [${o.id}] — could not re-anchor "${o.quote}". ${o.body}`.trim(),
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = "tether-md";
      d.code = o.id; // structural id for the "clear orphaned comment" quick fix
      return d;
    }),
    ...needsReview.map((n) => {
      const d = new vscode.Diagnostic(
        toRange(n.range),
        `Tether: comment [${n.id}] re-anchored fuzzily (confidence ${n.confidence.toFixed(2)}) — re-confirm the span`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = "tether-md";
      // no `code`: the clear-orphan quick fix keys off `code` and must not offer here
      return d;
    }),
  ]);

  // Rebuild native comment threads from the store (source of truth). A comment with a
  // `proposal` is a pending suggestion (Accept/Reject); one with a `dest` is a pending
  // move (Accept Move/Reject); otherwise a plain comment (Delete).
  disposeDocThreads(key);
  const threads: vscode.CommentThread[] = [];
  const moveBadges: vscode.DecorationOptions[] = [];
  let moveOrdinal = 0;
  for (const c of anchoredComments(doc.getText())) {
    const isSuggestion = c.proposal !== undefined;
    const isMove = c.move !== undefined;
    const comments: vscode.Comment[] = [
      { body: new vscode.MarkdownString(c.body), mode: vscode.CommentMode.Preview, author: { name: c.author }, label: c.trust },
    ];
    if (isSuggestion) {
      // Diff-before-Accept: show what will actually change (current anchored text, which can
      // have drifted from the recorded quote) — the instruction body above stays the WHY.
      comments.push({
        body: new vscode.MarkdownString(suggestionMarkdown(c.current, c.quote, c.proposal!), true),
        mode: vscode.CommentMode.Preview,
        author: { name: "tether · suggestion" },
      });
    }
    if (isMove) {
      // Where the text will land — with the same drift honesty as suggestions.
      comments.push({
        body: new vscode.MarkdownString(moveMarkdown(c), true),
        mode: vscode.CommentMode.Preview,
        author: { name: "tether · move" },
      });
      // Paired badges: ① on the excerpt, ⇣① at the destination line.
      moveOrdinal++;
      const glyph = MOVE_ORDINALS[moveOrdinal - 1] ?? `(${moveOrdinal})`;
      const badge = (at: number, text: string): vscode.DecorationOptions => {
        const pos = doc.positionAt(at);
        return {
          range: new vscode.Range(pos, pos),
          renderOptions: {
            before: { contentText: text, color: new vscode.ThemeColor("editorInfo.foreground"), fontWeight: "bold", margin: "0 0.25em 0 0" },
          },
        };
      };
      moveBadges.push(badge(c.range.start, glyph));
      if (c.move!.insertAt !== null) moveBadges.push(badge(c.move!.insertAt, `⇣${glyph}`));
    }
    // Anchor the thread to a SINGLE point at the span start, not the full span. A multi-line
    // range makes VSCode occupy every one of those gutter lines with the thread glyph, which
    // blocks the "+" affordance on the rest of the paragraph. The exact span is still shown by
    // the anchored highlight decoration; the thread just needs a home line.
    const startPos = doc.positionAt(c.range.start);
    const thread = controller.createCommentThread(doc.uri, new vscode.Range(startPos, startPos), comments);
    // Surface a fuzzy re-anchor in the label too (contextValue must keep its "<type>:<id>"
    // shape — the menu regexes and idFromThread parse it).
    const flag = c.status === "needs-review" ? " · needs review" : "";
    thread.label = (isMove ? "Tether move" : isSuggestion ? "Tether suggestion" : `Tether ${c.kind}`) + flag;
    thread.contextValue = `${isMove ? "move" : isSuggestion ? "suggestion" : "comment"}:${c.id}`;
    thread.canReply = false;
    thread.collapsibleState = isSuggestion || isMove
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
    // Deliberately NOT setting thread.state: that draws VSCode's native Resolve toggle, which
    // Tether doesn't handle (no event in the stable API) — a dead button. Resolve lives in the CLI.
    threads.push(thread);
  }
  for (const e of editorsShowing(key)) e.setDecorations(moveBadgeDeco, moveBadges);
  threadsByDoc.set(key, threads);
}

/** Circled ordinals pairing a move's source badge with its destination badge. */
const MOVE_ORDINALS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

// ---- edits -----------------------------------------------------------------

async function applyRaw(doc: vscode.TextDocument, next: string): Promise<boolean> {
  // Minimal-range replace, never the whole document — a full replace trashes the cursor
  // position, folding, and undo granularity of the human's own edit stream.
  const e = minimalEdit(doc.getText(), next);
  if (e.start === e.end && e.text === "") return true; // no-op
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  return vscode.workspace.applyEdit(edit);
}

function docFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

/** The gutter "+" submit: anchor a comment to the thread's range. */
async function createCommentFromThread(reply: vscode.CommentReply): Promise<void> {
  const doc = docFor(reply.thread.uri);
  if (!doc || !enabledFor(doc.uri)) return;
  const trust = await vscode.window.showQuickPick(["fact", "interpretation"], {
    placeHolder: "Trust class (fact = groundable; interpretation = your own claim)",
  });
  if (trust === undefined) return; // cancelled — leave the draft so it can be retried
  let range = reply.thread.range;
  if (range.isEmpty) range = doc.lineAt(range.start.line).range; // clicked a line, no selection
  try {
    const { raw: next } = addCommentFromSelection(
      doc.getText(),
      doc.offsetAt(range.start),
      doc.offsetAt(range.end),
      { body: reply.text, trust: trust as Trust, kind: "comment", author: "human" },
    );
    if (await applyRaw(doc, next)) {
      reply.thread.dispose(); // drop the draft only after the write lands; refresh renders the stored thread
      refresh(doc);
    } else {
      vscode.window.showErrorMessage("Tether: edit could not be applied — comment not added.");
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

/** Extract the comment id from a thread's `contextValue` ("suggestion:<id>" / "comment:<id>"). */
function idFromThread(thread: vscode.CommentThread): string | undefined {
  const cv = thread.contextValue;
  const i = cv ? cv.indexOf(":") : -1;
  return i === -1 ? undefined : cv!.slice(i + 1);
}

async function acceptSuggestionCommand(thread: vscode.CommentThread): Promise<void> {
  const doc = docFor(thread.uri);
  const id = idFromThread(thread);
  if (!doc || !id || !enabledFor(doc.uri)) return;
  try {
    if (await applyRaw(doc, acceptProposal(doc.getText(), id))) refresh(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

async function rejectSuggestionCommand(thread: vscode.CommentThread): Promise<void> {
  const doc = docFor(thread.uri);
  const id = idFromThread(thread);
  if (!doc || !id || !enabledFor(doc.uri)) return;
  try {
    if (await applyRaw(doc, removeComment(doc.getText(), id))) refresh(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

async function deleteThreadCommand(thread: vscode.CommentThread): Promise<void> {
  const doc = docFor(thread.uri);
  const id = idFromThread(thread);
  if (!doc || !id || !enabledFor(doc.uri)) return;
  try {
    if (await applyRaw(doc, removeComment(doc.getText(), id))) refresh(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

/** Quick-fix on an orphan diagnostic: remove the un-anchorable comment (it has no thread). */
const orphanActions: vscode.CodeActionProvider = {
  provideCodeActions(_doc, _range, context) {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      if (d.source !== "tether-md" || typeof d.code !== "string") continue;
      const action = new vscode.CodeAction("Tether: clear orphaned comment", vscode.CodeActionKind.QuickFix);
      action.diagnostics = [d];
      action.command = { command: "tetherMd.clearOrphan", title: "Clear orphaned comment", arguments: [_doc.uri, d.code] };
      actions.push(action);
    }
    return actions;
  },
};

async function clearOrphanCommand(uri: vscode.Uri, id: string): Promise<void> {
  const doc = docFor(uri);
  if (!doc || !enabledFor(uri)) return;
  try {
    if (await applyRaw(doc, removeComment(doc.getText(), id))) refresh(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

async function addCommentCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdown(editor.document)) {
    vscode.window.showWarningMessage("Tether: open a markdown file first.");
    return;
  }
  if (!enabledFor(editor.document.uri)) {
    vscode.window.showWarningMessage("Tether: disabled here (tetherMd.enable is false).");
    return;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage("Tether: select the text to comment on.");
    return;
  }
  const doc = editor.document;
  const version = doc.version;
  const raw = doc.getText();
  const selStart = doc.offsetAt(editor.selection.start);
  const selEnd = doc.offsetAt(editor.selection.end);

  const body = await vscode.window.showInputBox({ prompt: "Tether comment body" });
  if (body === undefined) return;
  const trust = await vscode.window.showQuickPick(["fact", "interpretation"], {
    placeHolder: "Trust class (fact = groundable; interpretation = your own claim)",
  });
  if (trust === undefined) return;
  if (doc.version !== version) {
    vscode.window.showErrorMessage("Tether: document changed during input — comment not added.");
    return;
  }

  try {
    const { raw: next, id } = addCommentFromSelection(raw, selStart, selEnd, {
      body,
      trust: trust as Trust,
      kind: "comment",
      author: "human",
    });
    if (await applyRaw(doc, next)) {
      refresh(doc);
      vscode.window.showInformationMessage(`Tether: added comment ${id}`);
    } else {
      vscode.window.showErrorMessage("Tether: edit could not be applied.");
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

// ---- move marking (pick-up / place) ------------------------------------------
//
// Select (or just place the caret in) a paragraph → Cmd+Alt+M arms the move and
// highlights the excerpt → the next mouse CLICK places it (snapped to the nearest
// paragraph boundary) → a move comment is stored; nothing is applied until the human
// clicks Accept Move on the thread. Cmd+Alt+M again while armed opens a destination
// QuickPick with a live ghost preview. Esc cancels.

/** Arm a move for the current selection/caret, or open the picker when already armed. */
async function moveSelectionCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdown(editor.document)) {
    vscode.window.showWarningMessage("Tether: open a markdown file first.");
    return;
  }
  if (!enabledFor(editor.document.uri)) {
    vscode.window.showWarningMessage("Tether: disabled here (tetherMd.enable is false).");
    return;
  }
  const doc = editor.document;
  if (doc.eol === vscode.EndOfLine.CRLF) {
    // The kernel's seam normalization is LF-only (v1) and would refuse at accept anyway;
    // say so up front with the remedy instead of a puzzling "no destination" later.
    vscode.window.showWarningMessage(
      "Tether: moving paragraphs needs LF line endings (v1) — switch this file via the CRLF selector in the status bar.",
    );
    return;
  }
  if (pendingMove && pendingMove.uri === doc.uri.toString()) {
    openMovePicker(editor); // second Cmd+Alt+M = the destination picker
    return;
  }
  cancelMove(); // a stale armed move on another doc

  const raw = doc.getText();
  let clean: string;
  let offsetMap: Segment[];
  try {
    const proj = project(raw);
    clean = proj.clean;
    offsetMap = proj.offsetMap;
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
    return;
  }
  const blocks = cleanBlocks(clean);
  const sel = selectionToClean(raw, doc.offsetAt(editor.selection.start), doc.offsetAt(editor.selection.end));
  const src = snapToBlocks(blocks, sel.cleanStart, sel.cleanEnd);
  if (!src) {
    vscode.window.showWarningMessage("Tether: place the cursor in (or select) the paragraph to move.");
    return;
  }
  const diag = diagnoseDestinations(clean, blocks, src);
  if (diag.destinations.length === 0) {
    // Say WHY, not just "no destination" — the three causes need different remedies.
    // (Paragraphs are blank-line separated; single-newline lines are one paragraph.)
    const msg =
      blocks.length < 2
        ? "Tether: this document is a single paragraph (paragraphs are separated by blank lines) — there is nowhere to move it."
        : diag.ambiguous > 0
          ? "Tether: no usable destination — the text at every possible target repeats verbatim elsewhere, so a move there could not be re-anchored unambiguously. Make the target paragraph distinct, or move a different paragraph."
          : "Tether: no usable destination — the only other paragraph boundaries sit right next to this paragraph, so moving there would change nothing.";
    vscode.window.showWarningMessage(msg);
    return;
  }
  const srcRaw = cleanRangeToRaw(offsetMap, src.start, src.end);
  pendingMove = { uri: doc.uri.toString(), version: doc.version, src, clean, blocks, offsetMap, srcRaw };
  const srcRange = new vscode.Range(doc.positionAt(srcRaw.start), doc.positionAt(srcRaw.end));
  for (const e of editorsShowing(pendingMove.uri)) e.setDecorations(moveSourceDeco, [srcRange]);
  void vscode.commands.executeCommand("setContext", "tetherMd.movePending", true);
  moveStatusItem.text = "$(arrow-right) Tether: click where the paragraph should go · re-press for a list · Esc cancels";
  moveStatusItem.show();
}

/** Disarm the pick-up/place mode and clear its transient UI (all panes + open picker). */
function cancelMove(note?: string): void {
  if (!pendingMove) return;
  const uri = pendingMove.uri;
  pendingMove = null;
  movePicker?.hide(); // its onDidHide disposes it
  for (const e of editorsShowing(uri)) {
    e.setDecorations(moveSourceDeco, []);
    e.setDecorations(moveGhostDeco, []);
  }
  void vscode.commands.executeCommand("setContext", "tetherMd.movePending", false);
  moveStatusItem.hide();
  if (note) vscode.window.setStatusBarMessage(note, 4000);
}

/** A mouse click while armed: snap it to the nearest paragraph boundary and place. */
async function placeMoveAtClick(editor: vscode.TextEditor, rawOffset: number): Promise<void> {
  const pm = pendingMove;
  if (!pm) return;
  const doc = editor.document;
  if (doc.version !== pm.version) {
    cancelMove("Tether: document changed — move cancelled");
    return;
  }
  const point = selectionToClean(doc.getText(), rawOffset, rawOffset).cleanStart;
  const dest = destinationFromPoint(pm.clean, pm.blocks, pm.src, point);
  if (!dest) {
    // Clicked the excerpt itself or right next to it (a no-op boundary) — stay armed.
    vscode.window.setStatusBarMessage(
      "Tether: that spot is where the paragraph already is — click a farther boundary (Esc cancels)",
      3000,
    );
    return;
  }
  await createMove(editor, dest);
}

/** Store the move comment for an armed source + chosen destination. */
async function createMove(editor: vscode.TextEditor, dest: MoveDestination): Promise<void> {
  const pm = pendingMove;
  if (!pm) return;
  const doc = editor.document;
  if (doc.version !== pm.version) {
    cancelMove("Tether: document changed — move cancelled");
    return;
  }
  try {
    const { raw: next, id } = addMoveComment(doc.getText(), pm.src, dest, {
      body: "Move this text here.",
      trust: "interpretation",
      author: "human",
    });
    cancelMove();
    if (await applyRaw(doc, next)) {
      refresh(doc);
      vscode.window.setStatusBarMessage(`Tether: move marked (${id}) — Accept Move on its thread applies it`, 5000);
    } else {
      vscode.window.showErrorMessage("Tether: edit could not be applied — move not marked.");
    }
  } catch (err) {
    cancelMove();
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

/** The optional upgrade: a destination QuickPick with a live ghost preview. */
function openMovePicker(editor: vscode.TextEditor): void {
  const pm = pendingMove;
  if (!pm) return;
  const targets = moveTargets(pm.clean, pm.blocks, pm.src);
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { target: MoveTarget }>();
  movePicker = qp;
  qp.title = "Tether: move paragraph to…";
  qp.placeholder = "Destination is previewed in the editor — Enter to place, Esc to keep clicking";
  qp.items = targets.map((t) => ({
    label: t.side === "after" ? "$(arrow-down) End of document" : `$(symbol-text) ${t.label}`,
    description: t.side === "after" ? "" : "insert before this paragraph",
    target: t,
  }));
  qp.onDidChangeActive((active) => {
    // Disarmed (e.g. the document changed) while the picker was open: previews would be
    // stale offsets against a different document — cancelMove hides us; do nothing here.
    const t = active[0]?.target;
    if (!t || !pendingMove) return;
    const pos = editor.document.positionAt(cleanToRaw(pm.offsetMap, t.insertAt));
    const range = new vscode.Range(pos, pos);
    for (const e of editorsShowing(pm.uri)) e.setDecorations(moveGhostDeco, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
  qp.onDidAccept(() => {
    const t = qp.activeItems[0]?.target;
    const stillArmed = pendingMove !== null;
    qp.hide();
    if (t && stillArmed) void createMove(editor, t);
    else if (!stillArmed) vscode.window.setStatusBarMessage("Tether: move no longer armed — re-press to start over", 4000);
  });
  qp.onDidHide(() => {
    // Esc from the picker returns to click-to-place (still armed); a successful accept
    // has already disarmed via createMove → cancelMove.
    for (const e of editorsShowing(pm.uri)) e.setDecorations(moveGhostDeco, []);
    if (movePicker === qp) movePicker = undefined;
    qp.dispose();
  });
  qp.show();
}

async function acceptMoveCommand(thread: vscode.CommentThread): Promise<void> {
  const doc = docFor(thread.uri);
  const id = idFromThread(thread);
  if (!doc || !id || !enabledFor(doc.uri)) return;
  try {
    if (await applyRaw(doc, acceptMove(doc.getText(), id))) refresh(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

async function exportCleanCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isMarkdown(editor.document)) {
    vscode.window.showWarningMessage("Tether: open a markdown file first.");
    return;
  }
  if (!enabledFor(editor.document.uri)) {
    vscode.window.showWarningMessage("Tether: disabled here (tetherMd.enable is false).");
    return;
  }
  const doc = editor.document;
  let clean: string;
  try {
    clean = cleanExport(doc.getText());
  } catch (err) {
    const msg = err instanceof StoreError ? err.message : (err as Error).message;
    vscode.window.showErrorMessage(`Tether export failed: ${msg}`);
    return;
  }
  if (doc.isUntitled || doc.uri.scheme !== "file") {
    const out = await vscode.workspace.openTextDocument({ language: "markdown", content: clean });
    await vscode.window.showTextDocument(out, vscode.ViewColumn.Beside);
    return;
  }
  const target = vscode.Uri.file(cleanExportPath(doc.uri.fsPath));
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(clean, "utf8"));
  } catch (err) {
    vscode.window.showErrorMessage(`Tether: could not write ${basename(target.fsPath)}: ${(err as Error).message}`);
    return;
  }
  const opened = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(opened, vscode.ViewColumn.Beside);
  vscode.window.showInformationMessage(`Tether: exported clean → ${basename(target.fsPath)}`);
}
