// PICO-8 global functions — faithful port of z8lua's lpico8lib.c (max, min,
// mid, ceil, flr, trig, bit ops, tostr/tonum, chr/ord, split) plus the trig
// lookup tables (trigtables.h → trigtables.ts).

import type { LuaState } from "./state.ts";
import { Table, type NativeFn, type Value } from "./value.ts";
import * as fx from "./fix32.ts";
import { callSingle, tostringValue, typeErrorArg } from "./interp.ts";
import { checkAny, checkString, hasArg } from "./auxlib.ts";
import { sintable, atantable } from "./trigtables.ts";

function arg(_L: LuaState, args: Value[], i: number): number {
  // lua_tonumber semantics (lpico8lib passes every operand through it):
  // numbers convert, numeric strings parse, anything else (nil/missing/
  // boolean/table/…) yields 0 — no error.
  const v = args[i - 1];
  if (typeof v === "number") return v;
  if (typeof v === "string") return fx.strToNum(v) ?? 0;
  return 0;
}

const max: NativeFn = (L, args) =>
  [fx.max(arg(L, args, 1), arg(L, args, 2))];

const min: NativeFn = (L, args) =>
  [fx.min(arg(L, args, 1), arg(L, args, 2))];

const mid: NativeFn = (L, args) => {
  const x = arg(L, args, 1);
  const y = arg(L, args, 2);
  const z = arg(L, args, 3);
  // x > y ? y > z ? y : min(x, z) : x > z ? x : min(y, z)
  const r = x > y
    ? (y > z ? y : fx.min(x, z))
    : (x > z ? x : fx.min(y, z));
  return [r];
};

const ceil: NativeFn = (L, args) => [fx.ceil(arg(L, args, 1))];
const flr: NativeFn = (L, args) => [fx.floor(arg(L, args, 1))];

// sin_helper (lpico8lib.c:56) — exact table-driven PICO-8 sine.
function sinHelper(x: number): number {
  const xb = x | 0;
  const a = (((xb & 0x4000 ? ~x : x) | 0) & 0x3fff) + 2;
  const ret = ((a >> 2 << 4) + sintable[a >> 2]) | 0;
  return (xb & 0x8000) !== 0 ? ret : fx.neg(ret);
}

const cos: NativeFn = (L, args) =>
  [sinHelper(fx.sub(arg(L, args, 1), 0x4000))];

const sin: NativeFn = (L, args) => [sinHelper(arg(L, args, 1))];

const atan2: NativeFn = (L, args) => {
  const x = arg(L, args, 1);
  const y = arg(L, args, 2);
  let bits = 0x4000;
  if (x !== 0) {
    // (|y| << 16) / |x| in exact int64 — quotients can sit within 1 ulp of
    // an integer, so plain double division would diverge (lpico8lib.c:85)
    const ax = BigInt(Math.abs(x | 0));
    const ay = BigInt(Math.abs(y | 0));
    const q = Number((ay << 16n) / ax);
    if (q > 0x10000) {
      bits -= atantable[Number((0x100000000n / BigInt(q)) >> 5n)];
    } else {
      bits = atantable[Math.floor(q / 32)];
    }
  }
  if (x < 0) bits = (0x8000 - bits) | 0;
  if (y > 0) bits = -bits & 0xffff;
  // PICO-8 bug emulation: atan2(1, 0x8000)
  if (x !== 0 && (y | 0) === -2147483648) bits = -bits & 0xffff;
  return [bits | 0];
};

const sqrt: NativeFn = (L, args) => {
  // abacus algorithm (lpico8lib.c:99); magnitudes stay < 2^53 in doubles.
  // NOTE: the C for-increment (a >>= 2, root >>= 1) also runs after the LAST
  // body — one more root shift than a body-at-top arrangement.
  let x = (arg(L, args, 1) | 0) * 65536;
  let root = 0;
  if (x > 0) {
    let a = 2 ** 46;
    while (a !== 0) {
      if (x >= a + root) {
        x -= a + root;
        root += a * 2;
      }
      a = Math.floor(a / 4);
      root = Math.floor(root / 2);
    }
  }
  return [root | 0];
};

const abs: NativeFn = (L, args) => [fx.fixAbs(arg(L, args, 1))];

const sgn: NativeFn = (L, args) => {
  // lpico8lib.c:122 — bits >= 0 ? 1 : -1 (sgn(0) = 1, unlike fix32::sgn!)
  const x = arg(L, args, 1);
  return [(x | 0) >= 0 ? fx.fromInt(1) : fx.fromInt(-1)];
};

const band: NativeFn = (L, args) => [
  fx.band(arg(L, args, 1), arg(L, args, 2)),
];
const bor: NativeFn = (L, args) => [
  fx.bor(arg(L, args, 1), arg(L, args, 2)),
];
const bxor: NativeFn = (L, args) => [
  fx.bxor(arg(L, args, 1), arg(L, args, 2)),
];
const bnot: NativeFn = (L, args) => [fx.bnot(arg(L, args, 1))];
const shl: NativeFn = (L, args) => [
  fx.shl(arg(L, args, 1), fx.toInt(arg(L, args, 2))),
];
const lshr: NativeFn = (L, args) => [
  fx.lshr(arg(L, args, 1), fx.toInt(arg(L, args, 2))),
];
const shr: NativeFn = (L, args) => [
  fx.shr(arg(L, args, 1), fx.toInt(arg(L, args, 2))),
];
const rotl: NativeFn = (L, args) => [
  fx.rotl(arg(L, args, 1), fx.toInt(arg(L, args, 2))),
];
const rotr: NativeFn = (L, args) => [
  fx.rotr(arg(L, args, 1), fx.toInt(arg(L, args, 2))),
];

const tostr: NativeFn = (L, args) => {
  // PICO-8 tostr(v [, flags]) — lpico8lib.c:171
  if (args.length < 1 || args[0] === undefined) return [""];
  let flags = 0;
  const f = args[1];
  if (typeof f === "boolean") flags = f ? 1 : 0;
  else if (typeof f === "number") flags = fx.toInt(f);

  const v = args[0];
  if (typeof v === "number") {
    if (flags) {
      const b = v | 0;
      if ((flags & 0x3) === 0x3) {
        const hi = ((b >>> 16) & 0xffff).toString(16).padStart(4, "0");
        const lo = (b & 0xffff).toString(16).padStart(4, "0");
        return [`0x${hi}${lo}`];
      }
      if ((flags & 0x2) === 0x2) {
        return [String(b)]; // "%d" of the bit pattern as int32
      }
      const hi = ((b >>> 16) & 0xffff).toString(16).padStart(4, "0");
      const lo = (b & 0xffff).toString(16).padStart(4, "0");
      return [`0x${hi}.${lo}`];
    }
    return [fx.numToString(v)];
  }
  if (typeof v === "string") return [v];
  if (typeof v === "boolean") return [v ? "true" : "false"];
  // table / function / thread
  if (v instanceof Table) {
    const tm = v.metatable?.get("__tostring") ?? null;
    if (tm !== null) return [callSingle(L, tm, [v])];
  }
  if (flags) return [tostringValue(L, v)];
  return [`[${nameOfType(v)}]`];
};

function nameOfType(v: Value): string {
  if (v instanceof Table) return "table";
  if (v === null) return "nil";
  if (typeof v === "function") return "function";
  const c = v as { proto?: unknown; frames?: unknown[] };
  if (c.proto !== undefined) return "function";
  if (Array.isArray(c.frames)) return "thread";
  return "userdata";
}

const tonum: NativeFn = (L, args) => {
  // PICO-8 tonum(v [, flags]) — lpico8lib.c:233
  const v = args[0];
  const flags = args.length >= 2 && (typeof args[1] === "number")
    ? fx.toInt(args[1])
    : 0;
  if (typeof v === "string") {
    if (flags & 0x1) {
      let hex = "";
      for (let i = 0; i < v.length && i < 8; i++) {
        const c = v[i];
        hex += isHexChar(c) ? c : "0";
      }
      const bits = parseInt(hex || "0", 16) | 0;
      return [fx.fromInt(flags & 0x2 ? bits >>> 16 : bits)];
    }
    if (flags & 0x2) {
      const n = Number(v); // strtol decimal, stops at first non-digit
      const bits = (Number.isFinite(n) ? Math.trunc(n) : 0) | 0;
      return [fx.fromInt(bits >>> 16)];
    }
    const n = fx.strToNum(v);
    if (n === null) return []; // PICO-8 returns nothing on failure
    return [n];
  }
  if (typeof v === "number") return [v];
  if (typeof v === "boolean") return [v ? fx.fromInt(1) : fx.fromInt(0)];
  return [];
};

function isHexChar(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") ||
    (c >= "A" && c <= "F");
}

const chr: NativeFn = (_L, args) => {
  // PICO-8 chr(...) — max 248 args, byte = (uint8_t)(int)floor(v)
  const n = Math.min(args.length, 248);
  let s = "";
  for (let i = 0; i < n; i++) {
    const v = args[i];
    const x = typeof v === "number" ? fx.toInt(v) : 0;
    s += String.fromCharCode(x & 0xff);
  }
  return [s];
};

const ord: NativeFn = (_L, args) => {
  // fake-08 (libs/z8lua lpico8lib.c:286-298): none/nil or a value that does
  // not convert to string returns nil — PICO-8 docs: "When str is not a
  // string, ORD returns nil". Numbers coerce via tostring ("123" → '1','2','3').
  const first = args[0];
  let s: string;
  if (first === undefined || first === null) return [null];
  else if (typeof first === "string") s = first;
  else if (typeof first === "number") s = fx.numToString(first);
  else return [null]; // tables/functions: tolstring returns NULL → nil
  let count = 1;
  if (!hasArg(args, 3)) count = 1;
  else {
    if (typeof args[2] !== "number") return [];
    count = fx.toInt(args[2]);
  }
  let n = 0;
  if (hasArg(args, 2)) {
    if (typeof args[1] !== "number") return [];
    n = fx.toInt(args[1]) - 1;
  }
  if (n < 0 || n >= s.length || count < 1) return [];
  if (n + count > s.length) count = s.length - n;
  const out: Value[] = [];
  for (let i = 0; i < count; i++) out.push(fx.fromInt(s.charCodeAt(n + i)));
  return out;
};

const split: NativeFn = (L, args) => {
  if (args.length === 0) return []; // fake-08: numArgs==0 → no results
  if (args[0] === null) return [];
  const s = args[0] !== undefined ? args[0] : null;
  if (typeof s !== "string" && typeof s !== "number") {
    typeErrorArg(L, args, 1, "string");
  }
  const hay = typeof s === "string" ? s : fx.numToString(s);
  let size = 0;
  let needle = ",";
  if (typeof args[1] === "number") {
    size = fx.toInt(args[1]);
    if (size <= 0) size = 1;
  } else if (typeof args[1] === "string") {
    needle = args[1][0] ?? ",";
  }
  const convert = args[2] === undefined ||
    (args[2] !== null && args[2] !== false); // isnone || toboolean
  const t = new Table();
  const hlen = hay.length;
  let count = 0;
  if (size > 0) {
    let parser = 0;
    while (parser < hlen) {
      const next = Math.min(parser + size, hlen);
      pushChunk(t, hay, parser, next, convert, count);
      count++;
      parser = next;
    }
  } else {
    // needle mode — end = hlen + 1 so a trailing separator yields a final
    // empty chunk (observed: split("a,b,") has 3 elements)
    let parser = 0;
    const end = hlen + 1;
    while (parser < end) {
      let next = hay.indexOf(needle, parser);
      if (next < 0 || next >= end) next = hlen;
      pushChunk(t, hay, parser, next, convert, count);
      count++;
      parser = next + 1;
    }
  }
  return [t];
};

function pushChunk(
  t: Table, hay: string, from: number, to: number,
  convert: boolean, count: number,
): void {
  const piece = hay.slice(from, Math.max(from, to));
  if (convert) {
    const n = fx.strToNum(piece);
    if (n !== null) {
      t.set(fx.fromInt(count + 1), n);
      return;
    }
  }
  t.set(fx.fromInt(count + 1), piece);
}

/** pico8_inext (fake-08 libs/z8lua lpico8lib.c:364-378): integer-sequence
 *  `next` used as `for i,v in inext, t do`. Returns (i, t[i]) while the value
 *  is non-nil, else just nil so the for loop stops. */
const inext: NativeFn = (L, args) => {
  const t = args[0];
  if (!(t instanceof Table)) typeErrorArg(L, args, 1, "table");
  let i: number;
  if (args[1] === undefined || args[1] === null) i = 0;
  else i = cintOf(args[1]);
  i += 1;
  const v = t.get(fx.fromInt(i));
  if (v === null) return [null];
  return [fx.fromInt(i), v];
};

function cintOf(v: Value): number {
  if (typeof v === "number") return Math.trunc(fx.toDouble(v));
  if (typeof v === "string") return Math.trunc(fx.toDouble(fx.strToNum(v) ?? 0));
  return 0;
}

export function installPico8(L: LuaState): void {
  const entries: [string, NativeFn][] = [
    ["max", max], ["min", min], ["mid", mid],
    ["ceil", ceil], ["flr", flr],
    ["cos", cos], ["sin", sin], ["atan2", atan2], ["sqrt", sqrt],
    ["abs", abs], ["sgn", sgn],
    ["band", band], ["bor", bor], ["bxor", bxor], ["bnot", bnot],
    ["shl", shl], ["shr", shr], ["lshr", lshr],
    ["rotl", rotl], ["rotr", rotr],
    ["tostr", tostr], ["tonum", tonum],
    ["chr", chr], ["ord", ord], ["split", split],
    ["inext", inext],
  ];
  for (const [name, fn] of entries) L.globals.set(name, fn);
}
