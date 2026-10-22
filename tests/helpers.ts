// Shared helpers for VM tests: run a compiled chunk and capture print output.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkClosure, runChunk, tracebackString,
} from "../src/vm/interp.ts";
import { LuaState } from "../src/vm/state.ts";
import { undump } from "../src/vm/undump.ts";
import { LuaError } from "../src/vm/errors.ts";
import { openLibs } from "../src/vm/stdlib-base.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** assets/bios.bc bytes — EmulatorOptions.biosBytes for Node-side tests. */
export function readBios(): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, "assets", "bios.bc")));
}

export interface VmRun {
  /** everything written by print (latin1 code-unit text) */
  output: string;
  error: LuaError | null;
  /** uncaught-error message + traceback (z8lua msghandler shape) */
  errorText: string | null;
  state: LuaState;
}

/** Run a binary dump in a fresh state with openLibs; never throws. */
export function runVm(
  bytecode: Uint8Array,
  chunkname = "=diff",
  opts: { print?: (s: string) => void } = {},
): VmRun {
  let output = "";
  const L = new LuaState();
  openLibs(L, {
    print: (s) => {
      output += s;
      opts.print?.(s);
    },
  });
  let error: LuaError | null = null;
  let errorText: string | null = null;
  try {
    const proto = undump(bytecode, chunkname);
    const cl = chunkClosure(L, proto, L.globals);
    runChunk(L, cl);
  } catch (e) {
    if (e instanceof LuaError) {
      error = e;
      // z8lua's lua.c msghandler: msg + "\n" + luaL_traceback(L, L, msg, 1);
      // our top frame at throw time plays the msghandler's caller, so level 0
      // starts at the erroring frame — same lines as native level 1.
      const tb = tracebackString(L, null, 0);
      errorText = e.fullMessage() + "\n" + tb;
      // driver cleanup (frames were intentionally left for the traceback)
      L.frames.length = 0;
      L.closeUpvals(0);
      L.stack.length = 0;
      L.top = 0;
    } else {
      throw e;
    }
  }
  return { output, error, errorText, state: L };
}

/** Read a latin1 file (native z8lua stdout captured as raw bytes). */
export function readLatin1(p: string): string {
  const buf = readFileSync(p);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}
