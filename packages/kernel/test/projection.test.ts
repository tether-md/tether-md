import { describe, it, expect } from "vitest";
import { project, cleanExport, rawToClean, cleanToRaw, type Segment } from "../src/index.js";

const ID0 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("projection P (§5)", () => {
  it("strips an inline marker from the clean document", () => {
    const raw = `We <!--tether:c=${ID0}-->showed results.`;
    const proj = project(raw);
    expect(proj.clean).toBe("We showed results.");
    expect(proj.markers).toHaveLength(1);
    expect(proj.markers[0].id).toBe(ID0);
  });

  it("preserves a tether-looking token inside inline code (code-guard, ⟨DECIDE 3⟩)", () => {
    const raw = "Use \`<!--tether:c=" + ID0 + "-->\` as the marker.";
    const proj = project(raw);
    expect(proj.clean).toBe(raw); // nothing stripped
    expect(proj.markers).toHaveLength(0);
  });

  it("preserves a tether-looking token inside a fenced code block", () => {
    const raw = ["```", `<!--tether:c=${ID0}-->`, "```", "", "Real prose."].join("\n");
    const proj = project(raw);
    expect(proj.clean).toContain(`<!--tether:c=${ID0}-->`);
    expect(proj.markers).toHaveLength(0);
  });

  it("preserves a non-tether HTML comment verbatim (⟨DECIDE 3⟩)", () => {
    const raw = `Text <!-- a normal comment --> more <!--tether:c=${ID0}-->here.`;
    const proj = project(raw);
    expect(proj.clean).toBe("Text <!-- a normal comment --> more here.");
  });

  it("cleanExport equals project().clean", () => {
    const raw = `A <!--tether:c=${ID0}-->B`;
    expect(cleanExport(raw)).toBe(project(raw).clean);
  });

  describe("offset-map bijection (§4)", () => {
    const raw = `We <!--tether:c=${ID0}-->showed results.`;
    const proj = project(raw);
    const map: Segment[] = proj.offsetMap;

    it("maps the marker boundary to the anchored span start in clean space", () => {
      const marker = proj.markers[0];
      // raw position just after the marker -> clean index of "showed"
      expect(rawToClean(map, marker.rawEnd)).toBe("We ".length);
      expect(proj.clean.startsWith("showed", "We ".length)).toBe(true);
    });

    it("rawToClean and cleanToRaw are inverse on retained text", () => {
      for (let clean = 0; clean <= proj.clean.length; clean++) {
        const raw2 = cleanToRaw(map, clean);
        expect(rawToClean(map, raw2)).toBe(clean);
      }
    });
  });
});
