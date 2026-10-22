// Loader for z8lua (Lua 5.2) binary dumps — port of native/build/z8lua/lundump.c
// plus ldump.c as the field-order spec. Numbers are raw fix32 bit patterns;
// strings are JS strings of code units 0–255 (trailing NUL stripped, embedded
// NULs preserved), nil constants are `null`.

import { NUM_OPCODES, getOp } from "./opcodes.ts";

export type LuaConst = null | boolean | number | string;

export interface UpvalDesc {
  instack: boolean;
  idx: number;
  name: string | null;
}

export interface LocVarInfo {
  varname: string | null;
  startpc: number;
  endpc: number;
}

export interface Proto {
  linedefined: number;
  lastlinedefined: number;
  numparams: number;
  is_vararg: boolean;
  maxstacksize: number;
  code: Int32Array;
  k: LuaConst[];
  p: Proto[];
  upvalues: UpvalDesc[];
  source: string | null;
  lineinfo: Int32Array;
  locvars: LocVarInfo[];
  /** OP_CLOSURE cache (lvm.c pushclosure/getcached): zero-upvalue closures
   *  created from this proto are reused across activations — Lua 5.2
   *  behaviour that differential tests observe as `f() == f()` being true. */
  cache?: unknown;
}

const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61]; // "\x1bLua"
const LUAC_TAIL = [0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a];
const LUAC_HEADERSIZE = 18;

const TNIL = 0;
const TBOOLEAN = 1;
const TNUMBER = 3;
const TSTRING = 4;

class LoadError extends Error {
  constructor(name: string, why: string) {
    super(`${name}: ${why} precompiled chunk`);
  }
}

class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly le: boolean,
    readonly sizeTBytes: number,
    readonly name: string,
  ) {}

  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new LoadError(this.name, "truncated");
  }

  byte(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  int(): number {
    // DumpInt/LoadInt: 4-byte signed; negative is corruption.
    this.need(4);
    const v = this.le
      ? this.buf[this.pos] | (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)
      : (this.buf[this.pos] << 24) | (this.buf[this.pos + 1] << 16) |
        (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3];
    this.pos += 4;
    if (v < 0) throw new LoadError(this.name, "corrupted");
    return v;
  }

  /** size_t: 4 or 8 bytes depending on the dump header. */
  sizeT(): number {
    if (this.sizeTBytes === 4) return this.int();
    this.need(8);
    let lo: number, hi: number;
    if (this.le) {
      lo = this.int();
      hi =
        this.buf[this.pos] | (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24);
    } else {
      hi =
        (this.buf[this.pos] << 24) | (this.buf[this.pos + 1] << 16) |
        (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3];
      lo = this.int(); // advances pos by 4 — hi read first, then lo
    }
    this.pos += 4;
    if (hi !== 0) throw new LoadError(this.name, "corrupted"); // lengths beyond 2^32
    return lo >>> 0;
  }

  number(): number {
    // lua_Number = fix32 = 4 raw bytes (integral flag asserted 0 at header).
    this.need(4);
    const p = this.pos;
    const v = this.le
      ? this.buf[p] | (this.buf[p + 1] << 8) |
        (this.buf[p + 2] << 16) | (this.buf[p + 3] << 24)
      : (this.buf[p] << 24) | (this.buf[p + 1] << 16) |
        (this.buf[p + 2] << 8) | this.buf[p + 3];
    this.pos += 4;
    return v | 0;
  }

  /** String: size_t length including trailing NUL; 0 ⇒ null (Lua NULL). */
  str(): string | null {
    const size = this.sizeT();
    if (size === 0) return null;
    this.need(size);
    const bytes = this.buf.subarray(this.pos, this.pos + size - 1); // drop NUL
    this.pos += size;
    // Code units 0–255 only — no UTF-8 decoding (VM byte-string semantics).
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  code(): Int32Array {
    const n = this.int();
    this.need(n * 4);
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.number(); // same 4-byte LE/BE read
    return out;
  }

  ints(n: number): Int32Array {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int();
    return out;
  }
}

function loadFunction(r: Reader): Proto {
  const linedefined = r.int();
  const lastlinedefined = r.int();
  const numparams = r.byte();
  const is_vararg = r.byte();
  const maxstacksize = r.byte();

  const code = r.code();

  const kn = r.int();
  const k: LuaConst[] = new Array(kn);
  for (let i = 0; i < kn; i++) {
    const t = r.byte();
    switch (t) {
      case TNIL: k[i] = null; break;
      case TBOOLEAN: k[i] = r.byte() !== 0; break;
      case TNUMBER: k[i] = r.number(); break;
      case TSTRING: k[i] = r.str(); break;
      default: throw new LoadError(r.name, "corrupted");
    }
  }
  const pn = r.int();
  const protos: Proto[] = new Array(pn);
  for (let i = 0; i < pn; i++) protos[i] = loadFunction(r);

  const unp = r.int();
  const upvalues: UpvalDesc[] = new Array(unp);
  for (let i = 0; i < unp; i++) {
    upvalues[i] = { instack: r.byte() !== 0, idx: r.byte(), name: null };
  }

  const source = r.str();
  const lineinfo = r.ints(r.int());
  const lvn = r.int();
  const locvars: LocVarInfo[] = new Array(lvn);
  for (let i = 0; i < lvn; i++) {
    locvars[i] = { varname: r.str(), startpc: r.int(), endpc: r.int() };
  }
  const uvn = r.int(); // upvalue names (0 when debug info stripped)
  if (uvn > unp) throw new LoadError(r.name, "corrupted");
  for (let i = 0; i < uvn; i++) upvalues[i].name = r.str();

  for (let i = 0; i < code.length; i++) {
    if (getOp(code[i]) >= NUM_OPCODES) throw new LoadError(r.name, "corrupted");
  }

  return {
    linedefined,
    lastlinedefined,
    numparams,
    is_vararg: is_vararg !== 0,
    maxstacksize,
    code,
    k,
    p: protos,
    upvalues,
    source,
    lineinfo,
    locvars,
  };
}

/**
 * Load a binary chunk; returns its main Proto (the outer closure has no
 * captured upvalues in practice for luac output — undump only shrinks/keeps
 * the closure, the proto is what the VM needs).
 *
 * NOTE: error messages always use the fixed name "binary string" — z8lua's
 * luaU_undump hardcodes `S.name="binary string"` (lundump.c:213) regardless
 * of the chunkname passed by lua_load.
 */
export function undump(data: Uint8Array, _name = "binary string"): Proto {
  const name = "binary string"; // lundump.c:213 — always, regardless of caller
  if (data.length < LUAC_HEADERSIZE) throw new LoadError(name, "truncated");

  for (let i = 0; i < 4; i++) {
    if (data[i] !== LUA_SIGNATURE[i]) throw new LoadError(name, "not a");
  }
  if (data[4] !== 0x52) throw new LoadError(name, "version mismatch in");
  if (data[5] !== 0) throw new LoadError(name, "version mismatch in");
  const sizeT = data[8];
  // lundump.c LoadHeader: bytes 0..11 mismatch ⇒ "incompatible"; tail only
  // (0..11 fine but the 6 tail bytes differ) ⇒ "corrupted". Big-endian dumps
  // (data[6] !== 1) are rejected as incompatible — nothing here produces them.
  if (
    data[6] !== 1 || data[7] !== 4 || (sizeT !== 4 && sizeT !== 8) ||
    data[9] !== 4 || data[10] !== 4 || data[11] !== 0
  ) {
    throw new LoadError(name, "incompatible");
  }
  for (let i = 0; i < 6; i++) {
    if (data[12 + i] !== LUAC_TAIL[i]) throw new LoadError(name, "corrupted");
  }

  const r = new Reader(data, true, sizeT, name);
  r.pos = LUAC_HEADERSIZE;
  return loadFunction(r);
}
