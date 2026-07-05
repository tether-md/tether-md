// Hyphen-escape codec — the `--`-safety layer (spec §2.5, D11).
//
// Store text must satisfy the HTML-comment grammar: no `--` inside, no trailing `-`.
// We guarantee this by removing every hyphen from each encoded line. The transform
// is reversible and human-inspectable; a base64url fallback exists for callers that
// prefer opaque-but-bulletproof (see `encodeLineBase64`).

/**
 * Encode one record line so it contains no `-` (hence no `--`, no trailing `-`).
 *
 * Order matters: double backslashes first, then map hyphens to `\D`. After this
 * no `-` remains, so the HTML-comment grammar is satisfied.
 */
export function encodeLine(json: string): string {
  return json.replaceAll("\\", "\\\\").replaceAll("-", "\\D");
}

/**
 * Decode one encoded line. Single left-to-right pass (NOT sequential replace, which
 * would corrupt a literal `\D` that followed a real backslash): `\\` → `\`, `\D` → `-`,
 * each consuming two chars; any other char is literal.
 */
export function decodeLine(encoded: string): string {
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch === "\\") {
      const next = encoded[i + 1];
      if (next === "\\") {
        out += "\\";
        i++;
      } else if (next === "D") {
        out += "-";
        i++;
      } else {
        // Lone backslash not part of a recognized escape — keep verbatim.
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// Fallback codec (config flag): bulletproof, opaque.
//
// NOTE: the spec (§2.5) says "base64url", but the base64url alphabet uses `-` and
// `_` — the `-` would reintroduce the exact `--`/trailing-`-` footgun this codec
// exists to prevent. STANDARD base64 (`A-Za-z0-9+/=`) contains no hyphen, so it is
// the grammar-safe fallback. (Deviation from spec wording; flagged for sign-off.)
export function encodeLineBase64(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

export function decodeLineBase64(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8");
}
