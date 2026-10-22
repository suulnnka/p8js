#!/usr/bin/env -S npx tsx
// Phase 3.5 multi-cart merge — directory of .p8/.p8.png → single .p8c (P8C2).
// See TODO.md §转换期合卡 for the format and selection rules.
//
// Usage:
//   npx tsx tools/merge.ts <dir> [-o out.p8c] [--entry name.p8]
//
// - Every cart runs the existing parse → #include → p8luac pipeline
//   (convertCart), so per-cart behaviour is identical to single conversion.
// - Entry selection: --entry, else the cart carrying __label__, else the one
//   named *_0.*, else lexicographic first. (No static call-graph analysis —
//   filenames in POOM-style games are built at runtime; see TODO §2.)
// - Blocks: u32 raw_len | u32 comp_len | u8 method | data
//   method 0 = store, 1 = deflate-raw; falls back to store when inflation
//   does not shrink the block.

import { deflateRawSync } from "node:zlib";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { convertCart, type ConvertOptions } from "./convert.ts";

export const MAGIC_P8C2 = Buffer.from("P8C2", "latin1");
export const ROM_LEN = 0x4300;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

/** BLOCK: raw_len | comp_len | method | data (see TODO.md §格式). */
export function makeBlock(raw: Buffer): Buffer {
  if (raw.length === 0) {
    return Buffer.concat([u32(0), u32(0), Buffer.from([0])]);
  }
  const def = deflateRawSync(raw);
  const useDeflate = def.length < raw.length;
  const data = useDeflate ? def : raw;
  return Buffer.concat([
    u32(raw.length),
    u32(data.length),
    Buffer.from([useDeflate ? 1 : 0]),
    data,
  ]);
}

export interface MergeOptions {
  entry?: string;
}

export interface MergeResult {
  p8c: Buffer;
  entry: string;
  carts: string[];
}

/** Build a P8C2 from compiled carts. Entry cart first as bare blocks; every
 *  cart (incl. entry) appears in the sub list so `reload(fn)` can address
 *  the title cart as data (POOM stores actors in poom_0's resources). */
export function buildP8c2(
  entryName: string,
  carts: { name: string; rom: Buffer; bytecode: Buffer }[],
): Buffer {
  const header = Buffer.alloc(16);
  MAGIC_P8C2.copy(header, 0);
  header.writeUInt8(1, 4); // format field (magic is the real discriminator)
  header.writeUInt8(41, 5); // p8 version (POOM-era carts are 29..41)
  header.writeUInt32LE(0, 6); // minor
  header.writeUInt8(0, 10); // flags: v2 carries no source/label
  header.writeUInt8(0, 11);
  header.writeUInt32LE(ROM_LEN, 12);

  const entry = carts.find((c) => c.name === entryName);
  if (!entry) throw new Error(`merge: entry ${entryName} not in cart list`);

  const parts: Buffer[] = [header, makeBlock(entry.rom), makeBlock(entry.bytecode)];
  for (const c of carts) {
    const nameBuf = Buffer.from(c.name, "latin1");
    if (nameBuf.length > 0xffff) {
      throw new Error(`merge: name too long: ${c.name}`);
    }
    parts.push(u16(nameBuf.length), nameBuf, makeBlock(c.rom), makeBlock(c.bytecode));
  }
  return Buffer.concat(parts);
}

function pickEntry(names: string[], explicit?: string): string {
  if (explicit) {
    if (!names.includes(explicit)) {
      throw new Error(`merge: --entry ${explicit} not among ${names.join(", ")}`);
    }
    return explicit;
  }
  const withLabel = names.find((n) => n.includes("__label__"));
  if (withLabel) return withLabel;
  const zero = names.find((n) => /_0\.(p8|p8\.png)$/i.test(basename(n)));
  if (zero) return zero;
  return [...names].sort()[0];
}

export async function mergeCartDir(
  dir: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const abs = resolve(dir);
  if (!statSync(abs).isDirectory()) {
    throw new Error(`merge: not a directory: ${dir}`);
  }
  const names = readdirSync(abs)
    .filter((f) => f.endsWith(".p8") || f.endsWith(".p8.png"))
    .sort();
  if (names.length === 0) throw new Error(`merge: no carts in ${dir}`);

  const copts: ConvertOptions = {
    input: "", output: null, source: false, label: false,
  };
  const carts: { name: string; rom: Buffer; bytecode: Buffer }[] = [];
  for (const n of names) {
    const path = join(abs, n);
    const r = await convertCart(path, copts);
    // Data-only carts (no __lua__ section) store an empty code block
    // (TODO.md 验收 §5: poom_1~25 have no code at all). Compiling an empty
    // source yields a valid main chunk, but the merged format keeps it raw.
    const hasLua = r.cart.lua.trim().length > 0;
    carts.push({
      name: n,
      rom: Buffer.from(r.cart.rom),
      bytecode: hasLua ? Buffer.from(r.bytecode) : Buffer.alloc(0),
    });
  }

  const entry = pickEntry(names, opts.entry);
  return { p8c: buildP8c2(entry, carts), entry, carts: names.map((n) => n) };
}

function parseArgv(argv: string[]): { dir: string; out: string | null; entry?: string } {
  let dir = "";
  let out: string | null = null;
  let entry: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") out = argv[++i] ?? null;
    else if (a === "--entry") entry = argv[++i];
    else if (!dir) dir = a;
  }
  if (!dir) {
    console.error("usage: merge <dir> [-o out.p8c] [--entry name.p8]");
    process.exit(2);
  }
  return { dir, out, entry };
}

async function main(): Promise<void> {
  const { dir, out, entry } = parseArgv(process.argv.slice(2));
  const t0 = Date.now();
  const r = await mergeCartDir(dir, { entry });
  const outPath = out ?? join(dir, `${basename(dir)}.p8c`);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, r.p8c);
  console.log(
    `merge: ${r.carts.length} carts → ${outPath}\n` +
      `  entry: ${r.entry}  size ${r.p8c.length} B  (${Date.now() - t0} ms)`,
  );
}

const invokedDirectly = process.argv[1]?.endsWith("merge.ts") ||
  process.argv[1]?.endsWith("merge.mts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`merge: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}
