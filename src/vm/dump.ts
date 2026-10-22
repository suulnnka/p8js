// ldump.c port — serialize a Proto back to a z8lua/Lua 5.2 binary dump.
// Header matches the 64-bit WSL build: little-endian, int=4, size_t=8,
// instruction=4, number=4 (fix32), non-integral, standard tail.

import { Closure } from "./value.ts";
import type { Proto } from "./undump.ts";

const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61];
const LUAC_TAIL = [0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a];

const TNIL = 0;
const TBOOLEAN = 1;
const TNUMBER = 3;
const TSTRING = 4;

class Writer {
  private buf: number[] = [];

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }
  int(v: number): void {
    const x = v | 0;
    this.buf.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff,
      (x >>> 24) & 0xff);
  }
  sizeT(v: number): void {
    // 8-byte little endian (lengths always < 2^32)
    this.int(v & 0xffffffff);
    this.int(Math.floor(v / 0x100000000));
  }
  /** dump string: size_t len+1 incl. NUL; 0 for NULL. */
  str(s: string | null): void {
    if (s === null) {
      this.sizeT(0);
      return;
    }
    const len = s.length + 1;
    this.sizeT(len);
    for (let i = 0; i < s.length; i++) this.buf.push(s.charCodeAt(i) & 0xff);
    this.buf.push(0);
  }
  number(n: number): void {
    this.int(n | 0); // fix32 bit pattern
  }
  raw(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i] & 0xff);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

function dumpFunction(w: Writer, f: Proto): void {
  w.int(f.linedefined);
  w.int(f.lastlinedefined);
  w.byte(f.numparams);
  w.byte(f.is_vararg ? 1 : 0);
  w.byte(f.maxstacksize);

  // code
  w.int(f.code.length);
  for (let i = 0; i < f.code.length; i++) w.number(f.code[i]);

  // constants
  w.int(f.k.length);
  for (const k of f.k) {
    if (k === null) {
      w.byte(TNIL);
    } else if (typeof k === "boolean") {
      w.byte(TBOOLEAN);
      w.byte(k ? 1 : 0);
    } else if (typeof k === "number") {
      w.byte(TNUMBER);
      w.number(k);
    } else {
      w.byte(TSTRING);
      w.str(k);
    }
  }

  // protos
  w.int(f.p.length);
  for (const sub of f.p) dumpFunction(w, sub);

  // upvalues
  w.int(f.upvalues.length);
  for (const uv of f.upvalues) {
    w.byte(uv.instack ? 1 : 0);
    w.byte(uv.idx);
  }

  // debug
  w.str(f.source);
  w.int(f.lineinfo.length);
  for (let i = 0; i < f.lineinfo.length; i++) w.int(f.lineinfo[i]);
  w.int(f.locvars.length);
  for (const lv of f.locvars) {
    w.str(lv.varname);
    w.int(lv.startpc);
    w.int(lv.endpc);
  }
  w.int(f.upvalues.length);
  for (const uv of f.upvalues) w.str(uv.name);
}

/** string.dump — serialize a Lua closure's proto (z8lua lua_dump, strip=0). */
export function dumpClosure(cl: Closure): Uint8Array {
  const w = new Writer();
  w.raw(LUA_SIGNATURE);
  w.byte(0x52); // version
  w.byte(0); // format
  w.byte(1); // little endian
  w.byte(4); // sizeof(int)
  w.byte(8); // sizeof(size_t)
  w.byte(4); // sizeof(Instruction)
  w.byte(4); // sizeof(lua_Number) = fix32
  w.byte(0); // integral flag
  w.raw(LUAC_TAIL);
  dumpFunction(w, cl.proto);
  const out = w.finish();
  return out;
}
