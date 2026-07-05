// Minimal ULID generator (spec §2.1): 26 chars, Crockford base32, no hyphen.
// 48-bit millisecond timestamp (10 chars) + 80-bit randomness (16 chars).
//
// Lives in the kernel because comment creation assigns the id that the inline
// marker and the store record share. P itself never generates ids (P is pure).

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Matches a syntactically valid ULID (and the marker grammar's `<ID>`). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i] % 32];
  }
  return out;
}

/**
 * Generate a ULID. `now` is injectable for deterministic tests; defaults to the
 * wall clock. Randomness always comes from the CSPRNG.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}
