// Phase 5 compat sweep: convert + headless-run every cart in the given
// directories for N frames and report pass/fail + per-frame cost.
//
// Usage: npx tsx scripts/run-carts.ts [frames=120] [dir...]
//   default dirs: ../carts (p8js sibling) and ../fake-08/test/carts

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertCart, type ConvertOptions } from "../tools/convert.ts";
import { Emulator } from "../src/core/host.ts";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BIOS = new Uint8Array(readFileSync(join(ROOT, "assets", "bios.bc")));

const opts: ConvertOptions = { input: "", output: null, source: false, label: false };

interface Row {
  cart: string;
  ok: boolean;
  frames: number;
  err: string;
  msPerFrame: number;
}

async function runCart(path: string, frames: number): Promise<Row> {
  const name = basename(path);
  const row: Row = { cart: name, ok: false, frames, err: "", msPerFrame: 0 };
  try {
    const { bytecode, cart } = await convertCart(path, opts);
    const emu = new Emulator({ biosBytes: BIOS, clockSeed: 1 });
    if (!emu.loadCart({ bytecode: new Uint8Array(bytecode), rom: cart.rom })) {
      row.err = emu.lastError ?? "loadCart failed";
      return row;
    }
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (!emu.tick()) {
        row.err = emu.lastError ?? `tick ${i} failed`;
        row.frames = i;
        row.msPerFrame = (performance.now() - t0) / Math.max(1, i);
        return row;
      }
      // wall-clock guard: a runaway cart must not hang the sweep (per-frame
      // instruction budgets cover intra-tick loops; this covers slow ones)
      if (performance.now() - t0 > 5000) {
        row.err = `wall-clock timeout after ${i} frames`;
        row.frames = i;
        row.msPerFrame = (performance.now() - t0) / Math.max(1, i);
        return row;
      }
    }
    row.ok = true;
    row.msPerFrame = (performance.now() - t0) / frames;
    return row;
  } catch (e) {
    row.err = (e as Error).message.split("\n")[0];
    return row;
  }
}

function listCarts(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".p8") || f.endsWith(".p8.png"))
    .filter((f) => !f.includes("syntax")) // known-fail dialect probe
    .map((f) => join(dir, f));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const frames = argv[0] && /^\d+$/.test(argv[0]) ? Number(argv[0]) : 120;
  const dirs = (argv[0] && /^\d+$/.test(argv[0]) ? argv.slice(1) : argv).map((d) =>
    resolve(d),
  );
  const useDirs = dirs.length > 0
    ? dirs
    : [join(ROOT, "..", "carts"), join(ROOT, "..", "fake-08", "test", "carts")];

  const carts = useDirs.flatMap(listCarts);
  if (carts.length === 0) {
    console.error("run-carts: no carts found in", useDirs.join(", "));
    process.exit(1);
  }

  const rows: Row[] = [];
  let idx = 0;
  for (const c of carts) {
    idx++;
    const t0 = performance.now();
    const row = await runCart(c, frames);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.error(`  [${idx}/${carts.length}] ${basename(c)} -> ${row.ok ? "ok" : "FAIL"} (${secs}s)`);
    rows.push(row);
  }

  const pass = rows.filter((r) => r.ok);
  const fail = rows.filter((r) => !r.ok);
  console.log(`run-carts: ${frames} frames each — pass ${pass.length}/${rows.length}`);
  if (pass.length > 0) {
    const avg = pass.reduce((s, r) => s + r.msPerFrame, 0) / pass.length;
    const worst = pass.reduce((a, b) => (a.msPerFrame > b.msPerFrame ? a : b));
    console.log(
      `  avg ${avg.toFixed(2)} ms/frame, worst ${worst.msPerFrame.toFixed(2)} (${worst.cart})`,
    );
  }
  for (const r of fail) {
    console.log(`  FAIL ${r.cart} @${r.frames}: ${r.err}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
