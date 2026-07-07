import { describe, it, expect } from "vitest";
import { acceptMove, project } from "@tether-md/kernel";
import {
  addMoveComment,
  anchoredComments,
  cleanBlocks,
  destinationFromPoint,
  diagnoseDestinations,
  moveDestinations,
  moveMarkdown,
  moveTargets,
  snapToBlocks,
} from "../src/logic.js";

const DOC = "# Title\n\nFirst paragraph, short.\n\nSecond paragraph is a bit longer than the first one.\n\nThird paragraph closes.";
const blocks = () => cleanBlocks(DOC);

describe("cleanBlocks", () => {
  it("splits on blank lines", () => {
    const b = blocks();
    expect(b).toHaveLength(4);
    expect(DOC.slice(b[0].start, b[0].end)).toBe("# Title");
    expect(DOC.slice(b[3].start, b[3].end)).toBe("Third paragraph closes.");
  });

  it("keeps a fenced code block with internal blank lines atomic", () => {
    const doc = "Intro.\n\n```\nline\n\nmore\n```\n\nOutro.";
    const b = cleanBlocks(doc);
    expect(b).toHaveLength(3);
    expect(doc.slice(b[1].start, b[1].end)).toBe("```\nline\n\nmore\n```");
  });

  it("ignores a trailing newline", () => {
    const b = cleanBlocks("One.\n\nTwo.\n");
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual({ start: 6, end: 10 });
  });

  it("handles 3+ newline separators", () => {
    const b = cleanBlocks("One.\n\n\n\nTwo.");
    expect(b).toHaveLength(2);
    expect(b[1].start).toBe(8);
  });
});

describe("snapToBlocks", () => {
  it("snaps a mid-paragraph selection to the whole block", () => {
    const b = blocks();
    const s = snapToBlocks(b, b[1].start + 3, b[1].start + 8)!;
    expect(s).toEqual(b[1]);
  });

  it("snaps a caret (zero-width) to its containing block", () => {
    const b = blocks();
    const s = snapToBlocks(b, b[2].start + 5, b[2].start + 5)!;
    expect(s).toEqual(b[2]);
  });

  it("spans multiple blocks when the selection does", () => {
    const b = blocks();
    const s = snapToBlocks(b, b[1].end - 2, b[2].start + 2)!;
    expect(s).toEqual({ start: b[1].start, end: b[2].end });
  });

  it("caret at a block edge still resolves", () => {
    const b = blocks();
    expect(snapToBlocks(b, b[1].end, b[1].end)).toEqual(b[1]);
  });
});

describe("moveDestinations / destinationFromPoint", () => {
  it("excludes the source and its adjacent boundaries (no-ops)", () => {
    const b = blocks();
    const dests = moveDestinations(DOC, b, b[1]);
    // Valid: before Title (0), before Third, end of doc. Invalid: before First (self),
    // before Second (adjacent = no-op).
    const points = dests.map((d) => d.insertAt);
    expect(points).toContain(0);
    expect(points).toContain(b[3].start);
    expect(points).toContain(b[3].end);
    expect(points).not.toContain(b[1].start);
    expect(points).not.toContain(b[2].start);
  });

  it("snaps a click to the nearest valid boundary", () => {
    const b = blocks();
    // Click in the middle of the Third paragraph → nearest boundary around it.
    const d = destinationFromPoint(DOC, b, b[1], b[3].start + 3)!;
    expect(d.insertAt).toBe(b[3].start);
    expect(d.side).toBe("before");
  });

  it("returns null for a click on the source itself", () => {
    const b = blocks();
    expect(destinationFromPoint(DOC, b, b[1], b[1].start + 4)).toBeNull();
  });

  it("offers the document end with a side=after anchor quoting the last block", () => {
    const b = blocks();
    const d = destinationFromPoint(DOC, b, b[1], DOC.length)!;
    expect(d.side).toBe("after");
    expect(d.insertAt).toBe(b[3].end);
    expect(DOC.slice(d.destStart, d.destEnd)).toBe("Third paragraph closes.");
  });

  it("returns an empty list for a single-block document", () => {
    const doc = "Only one paragraph.";
    const b = cleanBlocks(doc);
    expect(moveDestinations(doc, b, b[0])).toEqual([]);
  });

  it("diagnoses WHY there are no destinations (adjacency vs ambiguity)", () => {
    // Two-block doc: both boundaries adjacent to the source, doc end ambiguous
    // (the tail sentence repeats verbatim inside the first block).
    const line = "I did everything alone and i am the best in the world.";
    const doc = `${line}\n${line}\n${line}\n\n${line}\n${line}`;
    const b = cleanBlocks(doc);
    const diag = diagnoseDestinations(doc, b, b[0]);
    expect(diag.destinations).toEqual([]);
    expect(diag.adjacent).toBeGreaterThan(0);
    expect(diag.ambiguous).toBeGreaterThan(0);

    // A distinct-paragraph doc diagnoses clean.
    const healthy = diagnoseDestinations(DOC, blocks(), blocks()[1]);
    expect(healthy.destinations.length).toBeGreaterThan(0);
    expect(healthy.ambiguous).toBe(0);
  });
});

describe("moveTargets", () => {
  it("labels blocks by first line and includes End of document", () => {
    const b = blocks();
    const t = moveTargets(DOC, b, b[1]);
    expect(t.map((x) => x.label)).toEqual(["# Title", "Third paragraph closes.", "End of document"]);
  });

  it("caps long labels", () => {
    const long = "x".repeat(100) + "\n\nShort.";
    const b = cleanBlocks(long);
    const t = moveTargets(long, b, b[1]);
    expect(t[0].label.length).toBeLessThanOrEqual(61);
    expect(t[0].label.endsWith("…")).toBe(true);
  });
});

describe("destination robustness", () => {
  it("extends a duplicated 64-char block opening until the quote is unique", () => {
    const opener = "This opening sentence is repeated verbatim across two paragraphs in the file. ";
    const doc = `${opener}First tail.\n\n${opener}Second tail.\n\nSource para.`;
    const b = cleanBlocks(doc);
    const dests = moveDestinations(doc, b, b[2]);
    for (const d of dests) {
      const quote = doc.slice(d.destStart, d.destEnd);
      const second = doc.indexOf(quote, doc.indexOf(quote) + 1);
      expect(second).toBe(-1); // every offered quote is unique in the document
    }
    // Both duplicated blocks are still offered (their tails disambiguate them).
    expect(dests.filter((d) => d.side === "before")).toHaveLength(2);
  });

  it("drops a boundary whose whole block is duplicated verbatim", () => {
    const doc = "Source para.\n\nSame everything.\n\nSame everything.";
    const b = cleanBlocks(doc);
    const dests = moveDestinations(doc, b, b[0]);
    // Neither copy of "Same everything." can anchor a unique quote; only doc-end-ish
    // boundaries that CAN anchor uniquely survive. No offered quote may be ambiguous.
    for (const d of dests) {
      const quote = doc.slice(d.destStart, d.destEnd);
      expect(doc.indexOf(quote, doc.indexOf(quote) + 1)).toBe(-1);
    }
  });

  it("returns null instead of flinging when the click is nearest a no-op boundary", () => {
    const b = blocks();
    // Source is the second paragraph (b[1]); clicking at the very START of the next
    // block (b[2].start) is its no-op boundary's neighborhood — must NOT snap to some
    // distant boundary like the doc start.
    expect(destinationFromPoint(DOC, b, b[1], b[2].start + 1)).toBeNull();
  });
});

describe("moveMarkdown escaping", () => {
  it("renders the destination preview as an inert code span", () => {
    const doc = "Move me.\n\nDest with $(alert) icon and `ticks` here.";
    const b = cleanBlocks(doc);
    const dest = destinationFromPoint(doc, b, b[0], doc.length)!;
    const { raw } = addMoveComment(doc, b[0], dest, { body: "Move this text here.", trust: "interpretation", author: "human" });
    const md = moveMarkdown(anchoredComments(raw)[0]);
    // The preview line must be wrapped in a code span long enough that the content's
    // own backticks cannot terminate it, keeping $(...) and markdown inert.
    expect(md).toMatch(/``\s.*\$\(alert\).*\s``/);
  });
});

describe("addMoveComment → anchoredComments → acceptMove (full editor flow)", () => {
  it("round-trips: mark a move, render it, accept it", () => {
    const b = blocks();
    // Move "First paragraph, short." to the end of the document.
    const dest = destinationFromPoint(DOC, b, b[1], DOC.length)!;
    const { raw, id } = addMoveComment(DOC, b[1], dest, {
      body: "Move this text here.",
      trust: "interpretation",
      author: "human",
    });
    expect(project(raw).clean).toBe(DOC);

    const rendered = anchoredComments(raw);
    expect(rendered).toHaveLength(1);
    const c = rendered[0];
    expect(c.id).toBe(id);
    expect(c.move).toBeDefined();
    expect(c.move!.side).toBe("after");
    expect(c.move!.status).toBe("open");
    expect(c.move!.range).not.toBeNull();
    expect(c.move!.insertAt).not.toBeNull();
    expect(raw.slice(c.range.start, c.range.end)).toBe("First paragraph, short.");

    const applied = acceptMove(raw, id);
    expect(applied).toBe(
      "# Title\n\nSecond paragraph is a bit longer than the first one.\n\nThird paragraph closes.\n\nFirst paragraph, short.",
    );
  });

  it("reports drift in moveMarkdown when the destination changes", () => {
    const b = blocks();
    const dest = destinationFromPoint(DOC, b, b[1], 0)!;
    const { raw } = addMoveComment(DOC, b[1], dest, {
      body: "Move this text here.",
      trust: "interpretation",
      author: "human",
    });
    const fresh = anchoredComments(raw)[0];
    expect(moveMarkdown(fresh)).not.toContain("⚠");

    const edited = raw.replace("# Title", "# A very different heading now");
    const drifted = anchoredComments(edited)[0];
    expect(drifted.move).toBeDefined();
    expect(moveMarkdown(drifted)).toContain("⚠");
  });

  it("plain comments carry no move info", () => {
    const rendered = anchoredComments(DOC);
    expect(rendered).toEqual([]);
  });
});
