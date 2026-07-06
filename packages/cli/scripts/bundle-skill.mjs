// Bundle the canonical agent skill into the package so `tether init --skill` can install
// it on machines that only ever ran `npm i -g tether-md`. The source of truth stays at
// skills/tether-edit/SKILL.md in the repo root; this copy is generated on every build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkgDir, "..", "..", "skills", "tether-edit", "SKILL.md");
const dest = join(pkgDir, "skill", "SKILL.md");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
