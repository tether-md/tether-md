import { describe, it, expect } from "vitest";
import { decodeLine, encodeLine, encodeLineBase64, decodeLineBase64 } from "../src/index.js";

describe("hyphen-escape codec (§2.5)", () => {
  it("removes every hyphen so the HTML-comment grammar holds", () => {
    const out = encodeLine('{"created":"2026-06-24T12:00:00Z"}');
    expect(out).not.toContain("-");
    expect(out).not.toContain("--");
    expect(out.endsWith("-")).toBe(false);
    expect(out).toContain("2026\\D06\\D24");
  });

  it("round-trips arbitrary JSON containing -- and trailing backslashes", () => {
    const samples = [
      '{"a":"--double--","b":"trailing-"}',
      '{"path":"C:\\\\Users\\\\x"}',
      '{"escape":"literal \\\\D should survive"}',
      '{"dash":"-","empty":""}',
      '{"unicode":"café — 日本語 😀"}',
    ];
    for (const s of samples) {
      const enc = encodeLine(s);
      expect(enc).not.toContain("-");
      expect(decodeLine(enc)).toBe(s);
    }
  });

  it("decode is a single left-to-right pass: a real backslash before D is preserved", () => {
    // JSON string containing a backslash then literal D, e.g. value "\\D"
    const json = '{"x":"\\\\D"}'; // -> {"x":"\D"} as JS? Actually represents \\D in the string value
    const enc = encodeLine(json);
    expect(decodeLine(enc)).toBe(json);
  });

  it("base64url fallback round-trips", () => {
    const s = '{"created":"2026-06-24","x":"--"}';
    expect(decodeLineBase64(encodeLineBase64(s))).toBe(s);
    expect(encodeLineBase64(s)).not.toContain("-");
  });
});
