// Batch-convert every local reference cart as a smoke test.
// Usage: npx tsx scripts/convert-all.ts [outDir]

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { convertCart } from "../tools/convert.ts";
import type { ConvertOptions } from "../tools/convert.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(HERE);
const REF = dirname(PROJECT_ROOT);
const OUT = resolve(process.argv[2] ?? join(PROJECT_ROOT, ".out", "batch"));

// Fixtures that intentionally (or upstream-ly) fail compilation:
//  - zepto8/t/syntax.p8 uses constructs even zepto8's own pinned z8lua rejects
//    (e.g. `local a+=2`); the t/ harness does not load it as one chunk.
const KNOWN_FAIL = ["syntax.p8"];

const DIRS = [
  join(REF, "zepto8", "carts"),
  join(REF, "zepto8", "src"),
  join(REF, "zepto8", "t"),
  join(REF, "fake-08", "carts"),
  join(REF, "fake-08", "test", "carts"),
  join(REF, "jsgs", "src", "exampleCartridges"),
];

function collect(dir: string): string[] {
  if (!safe(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    const lower = name.toLowerCase();
    if (
      lower.endsWith(".p8") ||
      lower.endsWith(".p8.png") ||
      lower.endsWith(".png") // png carts only (filtered by magic at convert)
    ) {
      if (lower.includes("screenshots") || lower.includes("icon")) continue;
      out.push(full);
    }
  }
  return out;
}
function safe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = DIRS.flatMap(collect);
  let ok = 0;
  let skip = 0;
  const failures: [string, string][] = [];

  for (const file of files) {
    // only try PNG files that look like carts (checked inside convertCart too)
    const opts: ConvertOptions = {
      input: file,
      output: null,
      source: true,
      label: true,
    };
    try {
      const { p8c } = await convertCart(file, opts);
      // Name output from the path relative to REF: an absolute path keeps the
      // drive letter, and "C:__..." is parsed by Windows as an NTFS ADS.
      // Keep the source extension kind in the name so x.p8 and x.p8.png
      // (same stripped base) cannot overwrite each other.
      const rel = relative(REF, file);
      const suffix = /\.p8\.png$/i.test(rel)
        ? "__p8png"
        : /\.p8$/i.test(rel)
          ? ""
          : "__png";
      const base =
        rel.replace(/[\\/]/g, "__").replace(/\.(p8)?\.png$|\.p8$/i, "") +
        suffix;
      writeFileSync(join(OUT, base + ".p8c"), p8c);
      ok++;
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      // Non-cart PNGs (icons/screenshots) are expected to fail — count separately.
      if (/not a pico-8 cart png/.test(msg)) {
        skip++;
        continue;
      }
      if (KNOWN_FAIL.some((k) => file.endsWith(k))) {
        skip++;
        console.log(`  known-fail ${file}: ${msg}`);
        continue;
      }
      failures.push([file, msg]);
    }
  }

  console.log(`convert-all: ok=${ok} skipped-noncart-png=${skip} failed=${failures.length}`);
  for (const [f, m] of failures) console.log(`  FAIL ${f}: ${m}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
