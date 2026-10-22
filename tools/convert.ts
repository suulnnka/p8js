#!/usr/bin/env -S npx tsx
// Convert a PICO-8 cart (.p8 / .p8.png) into the private .p8c format:
// resources ROM image + compiled z8lua bytecode (+ optional source/label).
//
//   npx tsx tools/convert.ts <cart.p8|cart.p8.png> [-o out.p8c]
//                            [--no-source] [--no-label] [--keep-source-file]

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseP8Text, ROM_CODE_START } from "./p8.ts";
import { parseP8Png } from "./pngcart.ts";
import { preprocessIncludes } from "./include.ts";
import type { ParsedCart } from "./p8.ts";

const MAGIC = Buffer.from("P8C1", "latin1");
const FORMAT_VERSION = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(HERE);
const P8LUAC_WINDOWS = join(PROJECT_ROOT, "native", "build", "p8luac");
const WSL_DISTRO = "Ubuntu-26.04";

function toWslPath(winPath: string): string {
  const p = resolve(winPath).replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return p;
}

export interface ConvertOptions {
  input: string;
  output: string | null;
  source: boolean;
  label: boolean;
}

function parseArgs(argv: string[]): ConvertOptions {
  const opts: ConvertOptions = {
    input: "",
    output: null,
    source: true,
    label: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--output") {
      opts.output = argv[++i];
    } else if (a === "--no-source") {
      opts.source = false;
    } else if (a === "--no-label") {
      opts.label = false;
    } else if (a === "-h" || a === "--help") {
      console.log(
        "usage: convert <cart.p8|cart.p8.png> [-o out.p8c] [--no-source] [--no-label]",
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    } else if (!opts.input) {
      opts.input = a;
    } else {
      console.error("multiple inputs given");
      process.exit(2);
    }
  }
  if (!opts.input) {
    console.error("usage: convert <cart.p8|cart.p8.png> [-o out.p8c]");
    process.exit(2);
  }
  return opts;
}

function defaultOutput(input: string): string {
  const lower = input.toLowerCase();
  if (lower.endsWith(".p8.png")) return input.slice(0, -".p8.png".length) + ".p8c";
  if (lower.endsWith(".png")) return input.slice(0, -extname(input).length) + ".p8c";
  if (lower.endsWith(".p8")) return input.slice(0, -".p8".length) + ".p8c";
  return input + ".p8c";
}

export function compileBytecode(source: string, chunkName: string): Buffer {
  // stdin mode with the chunk name as argv[2] (WSL does not reliably
  // forward custom environment variables). Windows has no native toolchain
  // and routes through WSL; Linux/CI runs the binary directly.
  const res = process.platform === "win32"
    ? spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", toWslPath(P8LUAC_WINDOWS), "-", chunkName], {
        input: Buffer.from(source, "latin1"),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      })
    : spawnSync(P8LUAC_WINDOWS, ["-", chunkName], {
        input: Buffer.from(source, "latin1"),
        maxBuffer: 64 * 1024 * 1024,
      });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = (res.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(err || `p8luac exited with status ${res.status}`);
  }
  if (!res.stdout || res.stdout.length === 0) {
    throw new Error("p8luac produced no bytecode");
  }
  return res.stdout;
}

function buildP8c(
  cart: ParsedCart,
  bytecode: Buffer,
  source: string,
  opts: ConvertOptions,
): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(16);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt8(cart.version & 0xff, 5);
  header.writeUInt32LE(cart.minor >>> 0, 6);
  let flags = 0;
  if (opts.source) flags |= 1;
  if (opts.label && cart.label) flags |= 2;
  header.writeUInt8(flags, 10);
  header.writeUInt8(0, 11);
  header.writeUInt32LE(ROM_CODE_START, 12);
  parts.push(header);
  parts.push(Buffer.from(cart.rom));
  parts.push(u32(bytecode.length));
  parts.push(bytecode);
  if (flags & 2) {
    parts.push(u32(cart.label!.length));
    parts.push(Buffer.from(cart.label!));
  } else {
    parts.push(u32(0));
  }
  if (flags & 1) {
    const srcBytes = Buffer.from(source, "latin1");
    parts.push(u32(srcBytes.length));
    parts.push(srcBytes);
  }
  return Buffer.concat(parts);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export interface ConvertResult {
  p8c: Buffer;
  cart: ParsedCart;
  source: string;
  bytecode: Buffer;
}

/** Load, preprocess and compile a cart file into .p8c bytes. */
export async function convertCart(
  input: string,
  opts: ConvertOptions,
): Promise<ConvertResult> {
  const raw = readFileSync(input);

  let cart: ParsedCart;
  if (raw.length >= 8 && raw[0] === 0x89 && raw[1] === 0x50) {
    cart = await parseP8Png(raw);
  } else {
    cart = parseP8Text(raw.toString("latin1"));
  }

  // Includes are expanded on the converted source, same order as zepto8
  // (parse converts utf8→pico8, preprocess runs on the converted text).
  // The bios frame-loop glue (assets/glue.lua, pico8 charset) is appended
  // BEFORE compiling so cart + glue share one chunk — this replaces fake-08's
  // runtime `load(cart_code..glue_code)` string concatenation, which cannot
  // work on bytecode (see PLAN §4.3 bios+glue / extract-bios.ts).
  const source = preprocessIncludes(cart.lua, input);
  const bytecode = compileBytecode(source + readGlue(), basename(input));
  const p8c = buildP8c(cart, bytecode, source, opts);
  return { p8c, cart, source, bytecode };
}

let glueCache: string | null = null;
function readGlue(): string {
  if (glueCache === null) {
    try {
      glueCache = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "glue.lua"),
        "latin1",
      );
    } catch {
      throw new Error(
        "convert: assets/glue.lua missing — run: npx tsx scripts/extract-bios.ts",
      );
    }
  }
  return glueCache;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const input = resolve(opts.input);

  let result: ConvertResult;
  try {
    result = await convertCart(input, opts);
  } catch (e) {
    console.error(`convert: ${(e as Error).message}`);
    process.exit(1);
  }

  const outPath = resolve(opts.output ?? defaultOutput(opts.input));
  writeFileSync(outPath, result.p8c);

  console.log(
    `convert: ${basename(input)} → ${outPath}\n` +
      `  version ${result.cart.version}  rom ${result.cart.rom.length}B  ` +
      `lua ${Buffer.byteLength(result.source, "latin1")}B  ` +
      `bytecode ${result.bytecode.length}B  label ${result.cart.label ? "yes" : "no"}  ` +
      `total ${result.p8c.length}B`,
  );
}

const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error(`convert: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}
