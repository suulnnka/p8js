// string library — port of lstrlib.c (Lua 5.2 + z8lua) including the pattern
// matcher and string.format. Byte semantics throughout: VM strings are JS
// strings of code units 0–255.

import type { LuaState } from "./state.ts";
import { Closure, Table, typeOf, type NativeFn, type Value } from "./value.ts";
import * as fx from "./fix32.ts";
import {
  argError, callFunction, luaLError, tostringValue, typeErrorArg,
} from "./interp.ts";
import {
  checkInt, checkNumber, checkString, hasArg, optInt, optString,
} from "./auxlib.ts";
import { dumpClosure } from "./dump.ts";

function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const MAXCAPTURES = 32;
const MAXCCALLS = 200;
const L_ESC = "%";
const SPECIALS = "^$*+?.([%-";

// C locale ctype over byte values (ASCII only — bytes ≥ 128 never match a class)
const isAlpha = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isSpaceB = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isXDigit = (c: number): boolean =>
  isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isCntrl = (c: number): boolean => c < 32 || c === 127;
const isGraph = (c: number): boolean => c >= 33 && c <= 126;
const isPunct = (c: number): boolean => isGraph(c) && !isAlpha(c) &&
  !isDigit(c);
const isLowerByte = (c: number): boolean => c >= 97 && c <= 122;
const toLowerB = (c: number): number => isLowerByte(c) ? c : (c >= 65 &&
  c <= 90 ? c + 32 : c);

// ---------------------------------------------------------------------------
// basic functions

function posrelat(pos: number, len: number): number {
  if (pos >= 0) return pos;
  if (-pos > len) return 0;
  return len + pos + 1;
}

const strLen: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  return [fx.fromInt(s.length)];
};

const strSub: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  let start = posrelat(checkInt(L, args, 2), s.length);
  const end = posrelat(optInt(L, args, 3, -1), s.length);
  if (start < 1) start = 1;
  const e = Math.min(end, s.length);
  if (start <= e) return [s.slice(start - 1, e)];
  return [""];
};

const strReverse: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  let out = "";
  for (let i = s.length - 1; i >= 0; i--) out += s[i];
  return [out];
};

const strLower: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(toLowerB(s.charCodeAt(i)));
  }
  return [out];
};

const strUpper: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += String.fromCharCode(c >= 97 && c <= 122 ? c - 32 : c);
  }
  return [out];
};

const strRep: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  const n = checkInt(L, args, 2);
  const sep = optString(L, args, 3, "") ?? "";
  if (n <= 0) return [""];
  let out = "";
  for (let i = 0; i < n; i++) {
    out += s;
    if (i < n - 1) out += sep;
  }
  return [out];
};

const strByte: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  let posi = posrelat(optInt(L, args, 2, 1), s.length);
  const pose = posrelat(optInt(L, args, 3, posi), s.length);
  if (posi < 1) posi = 1;
  const pe = Math.min(pose, s.length);
  if (posi > pe) return [];
  const out: Value[] = [];
  for (let i = posi; i <= pe; i++) out.push(fx.fromInt(s.charCodeAt(i - 1)));
  return out;
};

const strChar: NativeFn = (L, args) => {
  let out = "";
  for (let i = 1; i <= args.length; i++) {
    // luaL_checkint coerces numeric strings; non-convertible → argerror
    const c = checkInt(L, args, i);
    if (c < 0 || c > 255) argError(L, i, "value out of range");
    out += String.fromCharCode(c);
  }
  return [out];
};

const strDump: NativeFn = (L, args) => {
  const f = args[0];
  if (f === undefined || f === null) {
    typeErrorArg(L, args, 1, "function");
  }
  if (typeof f === "function") {
    // Native functions pass luaL_checktype(FUNCTION) but lua_dump fails on
    // them (lstrlib.c: lua_dump != 0 → error).
    luaLError(L, "unable to dump given function");
  }
  if (!(f instanceof Closure)) {
    typeErrorArg(L, args, 1, "function");
  }
  return [bytesToLatin1(dumpClosure(f))];
};

// ---------------------------------------------------------------------------
// pattern matching (MatchState port of lstrlib.c)

interface Cap {
  init: number;
  len: number;
}

interface MatchState {
  matchdepth: number;
  src: string;
  srcInit: number;
  srcEnd: number;
  p: string;
  pEnd: number;
  L: LuaState;
  level: number;
  capture: Cap[];
}

const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;

function checkCapture(ms: MatchState, l: number): number {
  const idx = l - 49; // '1'
  if (idx < 0 || idx >= ms.level || ms.capture[idx].len === CAP_UNFINISHED) {
    luaLError(ms.L, `invalid capture index %${idx + 1}`);
  }
  return idx;
}

function captureToClose(ms: MatchState): number {
  for (let level = ms.level - 1; level >= 0; level--) {
    if (ms.capture[level].len === CAP_UNFINISHED) return level;
  }
  luaLError(ms.L, "invalid pattern capture");
}

function classEnd(ms: MatchState, p: number): number {
  const c = ms.p.charCodeAt(p);
  p++;
  if (c === L_ESC.charCodeAt(0)) {
    if (p === ms.pEnd) {
      luaLError(ms.L, "malformed pattern (ends with '%')");
    }
    return p + 1;
  }
  if (c === 91 /* [ */) {
    if (ms.p.charCodeAt(p) === 94 /* ^ */) p++;
    for (;;) {
      if (p === ms.pEnd) {
        luaLError(ms.L, "malformed pattern (missing ']')");
      }
      const ch = ms.p.charCodeAt(p);
      p++;
      if (ch === L_ESC.charCodeAt(0) && p < ms.pEnd) p++;
      if (ms.p.charCodeAt(p) === 93) break;
    }
    return p + 1;
  }
  return p;
}

function matchClass(c: number, cl: number): boolean {
  let res: boolean;
  switch (toLowerB(cl)) {
    case 97: res = isAlpha(c); break;
    case 99: res = isCntrl(c); break;
    case 100: res = isDigit(c); break;
    case 103: res = isGraph(c); break;
    case 108: res = isLowerByte(c); break;
    case 112: res = isPunct(c); break;
    case 115: res = isSpaceB(c); break;
    case 117: res = isUpper(c); break;
    case 119: res = isAlpha(c) || isDigit(c); break;
    case 120: res = isXDigit(c); break;
    case 122: res = c === 0; break;
    default: return cl === c;
  }
  return isLowerByte(cl) ? res : !res;
}

function matchBracketClass(
  ms: MatchState, c: number, p: number, ec: number,
): boolean {
  // p = index of '[', ec = index of ']' (C: while (++p < ec))
  let sig = true;
  if (ms.p.charCodeAt(p + 1) === 94 /* ^ */) {
    sig = false;
    p++;
  }
  for (;;) {
    p++;
    if (p >= ec) break;
    if (ms.p.charCodeAt(p) === L_ESC.charCodeAt(0)) {
      p++;
      if (matchClass(c, ms.p.charCodeAt(p))) return sig;
    } else if (ms.p.charCodeAt(p + 1) === 45 /* - */ && p + 2 < ec) {
      const lo = ms.p.charCodeAt(p);
      p += 2;
      if (lo <= c && c <= ms.p.charCodeAt(p)) return sig;
    } else if (ms.p.charCodeAt(p) === c) {
      return sig;
    }
  }
  return !sig;
}

function singlematch(
  ms: MatchState, s: number, p: number, ep: number,
): boolean {
  if (s >= ms.srcEnd) return false;
  const c = ms.src.charCodeAt(s);
  const pc = ms.p.charCodeAt(p);
  if (pc === 46 /* . */) return true;
  if (pc === L_ESC.charCodeAt(0)) return matchClass(c, ms.p.charCodeAt(p + 1));
  if (pc === 91) return matchBracketClass(ms, c, p, ep - 1);
  return pc === c;
}

function matchbalance(ms: MatchState, s: number, p: number): number {
  if (p >= ms.pEnd - 1) {
    luaLError(ms.L,
      "malformed pattern (missing arguments to '%b')");
  }
  if (ms.src.charCodeAt(s) !== ms.p.charCodeAt(p)) return -1;
  const b = ms.p.charCodeAt(p);
  const e = ms.p.charCodeAt(p + 1);
  let cont = 1;
  s++;
  while (s < ms.srcEnd) {
    const ch = ms.src.charCodeAt(s);
    if (ch === e) {
      if (--cont === 0) return s + 1;
    } else if (ch === b) {
      cont++;
    }
    s++;
  }
  return -1;
}

function maxExpand(
  ms: MatchState, s: number, p: number, ep: number,
): number {
  let i = 0;
  while (singlematch(ms, s + i, p, ep)) i++;
  for (;;) {
    const res = match(ms, s + i, ep + 1);
    if (res >= 0) return res;
    if (i === 0) return -1;
    i--;
  }
}

function minExpand(
  ms: MatchState, s: number, p: number, ep: number,
): number {
  for (;;) {
    const res = match(ms, s, ep + 1);
    if (res >= 0) return res;
    if (singlematch(ms, s, p, ep)) s++;
    else return -1;
  }
}

function startCapture(
  ms: MatchState, s: number, p: number, what: number,
): number {
  const level = ms.level;
  if (level >= MAXCAPTURES) luaLError(ms.L, "too many captures");
  ms.capture[level] = { init: s, len: what };
  ms.level = level + 1;
  const res = match(ms, s, p);
  if (res < 0) ms.level--;
  return res;
}

function endCapture(
  ms: MatchState, s: number, p: number,
): number {
  const l = captureToClose(ms);
  ms.capture[l].len = s - ms.capture[l].init;
  const res = match(ms, s, p);
  if (res < 0) ms.capture[l].len = CAP_UNFINISHED;
  return res;
}

function matchCapture(ms: MatchState, s: number, l: number): number {
  const idx = checkCapture(ms, l);
  const len = ms.capture[idx].len;
  if (ms.srcEnd - s >= len &&
    ms.src.startsWith(ms.src.slice(
      ms.capture[idx].init,
      ms.capture[idx].init + len,
    ), s)) {
    return s + len;
  }
  return -1;
}

type ClassStep = { cont: [number, number] } | { ret: number };

/** one "pattern item + optional suffix" step (lstrlib.c default case). */
function classItem(ms: MatchState, s: number, p: number): ClassStep {
  const ep = classEnd(ms, p);
  if (!singlematch(ms, s, p, ep)) {
    const suff = ms.p.charCodeAt(ep);
    if (suff === 42 || suff === 63 || suff === 45) {
      return { cont: [s, ep + 1] }; // *, ?, - accept empty
    }
    return { ret: -1 };
  }
  const suff = ms.p.charCodeAt(ep);
  switch (suff) {
    case 63: { // ? — one or zero, then match the REST recursively
      const r = match(ms, s + 1, ep + 1);
      if (r >= 0) return { ret: r };
      return { cont: [s, ep + 1] };
    }
    case 43: // + — one already matched, fall into *
      s++;
    // falls through
    case 42: // *
      return { ret: maxExpand(ms, s, p, ep) };
    case 45: // -
      return { ret: minExpand(ms, s, p, ep) };
    default:
      s++;
      return { cont: [s, ep] };
  }
}

/** recursive match — returns end index (>=0) or -1. */
export function match(ms: MatchState, s: number, p: number): number {
  if (ms.matchdepth-- === 0) luaLError(ms.L, "pattern too complex");
  const done = (r: number): number => {
    ms.matchdepth++;
    return r;
  };
  for (;;) {
    if (p === ms.pEnd) return done(s);
    const pc = ms.p.charCodeAt(p);
    if (pc === 40 /* ( */) {
      // C: s = start_capture(...); break; → return s — startCapture's inner
      // match consumes the REST of the pattern, so we must return its end.
      if (ms.p.charCodeAt(p + 1) === 41 /* ) */) {
        return done(startCapture(ms, s, p + 2, CAP_POSITION));
      }
      return done(startCapture(ms, s, p + 1, CAP_UNFINISHED));
    }
    if (pc === 41 /* ) */) {
      return done(endCapture(ms, s, p + 1));
    }
    if (pc === 36 /* $ */ && p + 1 === ms.pEnd) {
      return done(s === ms.srcEnd ? s : -1);
    }
    if (pc === L_ESC.charCodeAt(0)) {
      const next = p + 1 < ms.pEnd ? ms.p.charCodeAt(p + 1) : -1;
      if (next === 98 /* b */) {
        const r = matchbalance(ms, s, p + 2);
        if (r < 0) return done(-1);
        s = r;
        p += 4;
        continue;
      }
      if (next === 102 /* f */) {
        p += 2;
        if (p >= ms.pEnd || ms.p.charCodeAt(p) !== 91) {
          luaLError(ms.L, "missing '[' after '%f' in pattern");
        }
        const ep = classEnd(ms, p);
        const prev = s === ms.srcInit
          ? 0
          : ms.src.charCodeAt(s - 1);
        if (
          !matchBracketClass(ms, prev, p, ep - 1) &&
          matchBracketClass(ms, ms.src.charCodeAt(s), p, ep - 1)
        ) {
          p = ep;
          continue;
        }
        return done(-1);
      }
      if (next >= 48 && next <= 57) {
        const r = matchCapture(ms, s, next);
        if (r < 0) return done(-1);
        s = r;
        p += 2;
        continue;
      }
      // default escaped class (%a, %w, …) — falls into classItem at p (the ESC)
      const step = classItem(ms, s, p);
      if ("ret" in step) return done(step.ret);
      s = step.cont[0];
      p = step.cont[1];
      continue;
    }
    const step = classItem(ms, s, p);
    if ("ret" in step) return done(step.ret);
    s = step.cont[0];
    p = step.cont[1];
  }
}

function lmemfind(
  s1: string, l1: number, s2: string, l2: number,
): number {
  if (l2 === 0) return 0;
  if (l2 > l1) return -1;
  l2--;
  const limit = l1 - l2;
  let init = 0;
  while (init <= limit) {
    const found = s1.indexOf(s2[0], init);
    if (found < 0 || found > limit) return -1;
    if (s1.startsWith(s2, found)) return found;
    init = found + 1;
  }
  return -1;
}

function pushOneCapture(
  ms: MatchState, i: number, s: number, e: number,
): Value[] {
  if (i >= ms.level) {
    if (i === 0) return [ms.src.slice(s, e)];
    luaLError(ms.L, "invalid capture index");
  }
  const l = ms.capture[i].len;
  if (l === CAP_UNFINISHED) luaLError(ms.L, "unfinished capture");
  if (l === CAP_POSITION) {
    return [fx.fromInt(ms.capture[i].init + 1)];
  }
  return [ms.src.slice(ms.capture[i].init, ms.capture[i].init + l)];
}

function pushCaptures(
  ms: MatchState, s: number, e: number,
): Value[] {
  const nlevels = ms.level === 0 && s >= 0 ? 1 : ms.level;
  const out: Value[] = [];
  for (let i = 0; i < nlevels; i++) {
    out.push(...pushOneCapture(ms, i, s, e));
  }
  return out;
}

function nospecials(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (SPECIALS.includes(p[i])) return false;
  }
  return true;
}

function strFindAux(L: LuaState, args: Value[], find: boolean): Value[] {
  const s = checkString(L, args, 1);
  const p = checkString(L, args, 2);
  let init = posrelat(optInt(L, args, 3, 1), s.length);
  if (init < 1) init = 1;
  else if (init > s.length + 1) return [null];
  // 4th arg truthy (only nil/false are falsy in Lua) forces a plain search
  const plainArg = args[3];
  const forcePlain = plainArg !== undefined && plainArg !== null &&
    plainArg !== false;
  if (find && (forcePlain || nospecials(p))) {
    const idx = lmemfind(s.slice(init - 1), s.length - init + 1, p, p.length);
    if (idx >= 0) {
      const start = init - 1 + idx;
      return [fx.fromInt(start + 1), fx.fromInt(start + p.length)];
    }
  } else {
    const ms: MatchState = {
      matchdepth: MAXCCALLS,
      src: s,
      srcInit: 0,
      srcEnd: s.length,
      p,
      pEnd: p.length,
      L,
      level: 0,
      capture: [],
    };
    let s1 = init - 1;
    const anchor = p.charCodeAt(0) === 94;
    let pp = p;
    if (anchor) pp = p.slice(1);
    for (;;) {
      ms.level = 0;
      ms.p = pp;
      ms.pEnd = pp.length;
      const res = match(ms, s1, 0);
      if (res >= 0) {
        if (find) {
          const out: Value[] = [
            fx.fromInt(s1 + 1),
            fx.fromInt(res),
          ];
          out.push(...pushCaptures(ms, -1, -1));
          return out;
        }
        return pushCaptures(ms, s1, res);
      }
      if (s1 >= ms.srcEnd || anchor) break;
      s1++;
    }
  }
  return [null];
}

const strFind: NativeFn = (L, args) => strFindAux(L, args, true);
const strMatch: NativeFn = (L, args) => strFindAux(L, args, false);

const gmatch: NativeFn = (L, args) => {
  const s = checkString(L, args, 1);
  const p = checkString(L, args, 2);
  const state = { start: 0 };
  const aux: NativeFn = (L2) => {
    const ms: MatchState = {
      matchdepth: MAXCCALLS,
      src: s,
      srcInit: 0,
      srcEnd: s.length,
      p,
      pEnd: p.length,
      L: L2,
      level: 0,
      capture: [],
    };
    for (let src = state.start; src <= s.length; src++) {
      ms.level = 0;
      const e = match(ms, src, 0);
      if (e >= 0) {
        let newstart = e;
        if (e === src) newstart++;
        state.start = newstart;
        return pushCaptures(ms, src, e);
      }
    }
    return [];
  };
  return [aux];
};

function addS(
  ms: MatchState, s: number, e: number, news: string,
): string {
  let out = "";
  let i = 0;
  while (i < news.length) {
    const ch = news[i];
    if (ch !== L_ESC) {
      out += ch;
      i++;
      continue;
    }
    i++; // skip ESC
    const c = news[i];
    if (c === undefined) {
      luaLError(ms.L, "invalid use of '%' in replacement string");
    }
    if (!isDigit(c.charCodeAt(0))) {
      if (c !== L_ESC) {
        luaLError(ms.L, "invalid use of '%' in replacement string");
      }
      out += c;
      i++;
      continue;
    }
    if (c === "0") {
      out += ms.src.slice(s, e);
      i++;
      continue;
    }
    const cap = pushOneCapture(ms, c.charCodeAt(0) - 49, s, e);
    out += typeof cap[0] === "string"
      ? cap[0]
      : tostringValue(ms.L, cap[0]) as string;
    i++;
  }
  return out;
}

function addValue(
  ms: MatchState, s: number, e: number, tr: Value,
): string {
  const L = ms.L;
  if (typeof tr === "function" || tr instanceof Closure) {
    const caps = pushCaptures(ms, s, e);
    const r = callFunction(L, tr, caps);
    const v = r.length > 0 ? r[0] : null;
    if (v === null || v === false) return ms.src.slice(s, e);
    if (typeof v !== "string" && typeof v !== "number") {
      luaLError(L, `invalid replacement value (a ${typeOf(v)})`);
    }
    return typeof v === "string" ? v : fx.numToString(v);
  }
  if (tr instanceof Table) {
    const cap0 = pushOneCapture(ms, 0, s, e);
    const v = tr.get(cap0[0]);
    if (v === null) return ms.src.slice(s, e);
    if (typeof v !== "string" && typeof v !== "number") {
      luaLError(L, `invalid replacement value (a ${typeOf(v)})`);
    }
    return typeof v === "string" ? v : fx.numToString(v);
  }
  // number or string template (entry check restricted tr to these + fn/tbl)
  if (typeof tr === "string") return addS(ms, s, e, tr);
  return addS(ms, s, e, fx.numToString(tr as number));
}

const strGsub: NativeFn = (L, args) => {
  const src = checkString(L, args, 1);
  const p = checkString(L, args, 2);
  const tr = args[2];
  const maxS = optInt(L, args, 4, src.length + 1);
  const trType = typeOf(tr);
  if (
    trType !== "number" && trType !== "string" &&
    trType !== "function" && trType !== "table"
  ) {
    argError(L, 3, "string/function/table expected");
  }
  let anchor = false;
  let pp = p;
  if (pp.charCodeAt(0) === 94) {
    anchor = true;
    pp = pp.slice(1);
  }
  const ms: MatchState = {
    matchdepth: MAXCCALLS,
    src,
    srcInit: 0,
    srcEnd: src.length,
    p: pp,
    pEnd: pp.length,
    L,
    level: 0,
    capture: [],
  };
  let n = 0;
  let srcPos = 0;
  let out = "";
  while (n < maxS) {
    ms.level = 0;
    ms.p = pp;
    ms.pEnd = pp.length;
    const e = match(ms, srcPos, 0);
    if (e >= 0) {
      n++;
      out += addValue(ms, srcPos, e, tr);
    }
    if (e >= 0 && e > srcPos) srcPos = e;
    else if (srcPos < ms.srcEnd) out += src[srcPos++];
    else break;
    if (anchor) break;
  }
  out += src.slice(srcPos);
  return [out, fx.fromInt(n)];
};

// ---------------------------------------------------------------------------
// string.format

interface FmtSpec {
  flags: string;
  width: number; // 0 = none (max 2 digits ⇒ ≤99)
  prec: number | null; // null = none
}

function scanformat(L: LuaState, s: string, start: number): {
  spec: FmtSpec; next: number;
} {
  let i = start;
  let flags = "";
  while (i < s.length && "-+ #0".includes(s[i])) {
    flags += s[i];
    i++;
  }
  if (flags.length >= 5) {
    luaLError(L, "invalid format (repeated flags)");
  }
  let width = 0;
  if (i < s.length && isDigit(s.charCodeAt(i))) {
    width = s.charCodeAt(i) - 48;
    i++;
    if (i < s.length && isDigit(s.charCodeAt(i))) {
      width = width * 10 + (s.charCodeAt(i) - 48);
      i++;
    }
  }
  let prec: number | null = null;
  if (s[i] === ".") {
    i++;
    prec = 0;
    if (i < s.length && isDigit(s.charCodeAt(i))) {
      prec = s.charCodeAt(i) - 48;
      i++;
      if (i < s.length && isDigit(s.charCodeAt(i))) {
        prec = prec * 10 + (s.charCodeAt(i) - 48);
        i++;
      }
    }
  }
  if (i < s.length && isDigit(s.charCodeAt(i))) {
    luaLError(L, "invalid format (width or precision too long)");
  }
  return { spec: { flags, width, prec }, next: i };
}

/** pad a numeric/string body per printf flags (sign already in body). */
function padOut(body: string, spec: FmtSpec, numeric: boolean): string {
  const len = body.length;
  if (spec.width <= len) return body;
  const pad = spec.width - len;
  if (spec.flags.includes("-")) {
    return body + " ".repeat(pad);
  }
  if (numeric && spec.flags.includes("0") && !spec.flags.includes("-")) {
    // zero-pad after any sign
    const m = /^([+-])/.exec(body);
    if (m) return m[1] + "0".repeat(pad) + body.slice(1);
    return "0".repeat(pad) + body;
  }
  return " ".repeat(pad) + body;
}

/** exact-tie-aware fixed-point formatting (printf %f, half-even on ties). */
function formatFixed(x: number, prec: number): string {
  const neg = x < 0;
  const ax = Math.abs(x);
  if (prec <= 0) {
    // %.0f — exact-tie half-even, sign preserved (glibc prints "-0")
    const n = Math.floor(ax);
    const frac = ax - n;
    let r: number;
    if (frac === 0.5) r = n % 2 === 0 ? n : n + 1;
    else r = frac > 0.5 ? n + 1 : n;
    return (neg ? "-" : "") + String(r);
  }
  const scale = 10 ** prec;
  const v = ax * scale; // exact for fix32 doubles when prec ≤ 9
  const n = Math.floor(v);
  const frac = v - n;
  let r: number;
  if (frac === 0.5) r = n % 2 === 0 ? n : n + 1;
  else r = Math.round(v);
  const ip = Math.floor(r / scale);
  const fp = String(r % scale).padStart(prec, "0");
  return (neg ? "-" : "") + ip + "." + fp;
}

function stripFracZeros(s: string): string {
  if (!s.includes(".")) return s;
  let out = s;
  while (out.endsWith("0")) out = out.slice(0, -1);
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

function formatExp(x: number, prec: number, upper: boolean): string {
  // correct rounding on the exact binary value comes from toExponential;
  // exact-tie cases for %e are not differential-tested (documented gap).
  const s = Math.abs(x).toExponential(prec);
  const dot = s.indexOf("e");
  const mant = s.slice(0, dot);
  const expNum = parseInt(s.slice(dot + 1), 10);
  const sign = expNum < 0 ? "-" : "+";
  const aexp = Math.abs(expNum).toString().padStart(2, "0");
  return `${x < 0 ? "-" : ""}${mant}${upper ? "E" : "e"}${sign}${aexp}`;
}

function formatG(x: number, spec: FmtSpec, upper: boolean): string {
  const prec = spec.prec ?? 6; // significant digits (C default 6)
  if (x === 0) return stripFracZeros(formatFixed(0, Math.min(prec, 9)));
  const ax = Math.abs(x);
  const exp10 = Math.floor(Math.log10(ax));
  let body: string;
  if (exp10 < -4 || exp10 >= prec) {
    const s = formatExp(x, prec - 1, false);
    // strip trailing zeros in the mantissa + dot (C %g, no # flag)
    const dot = s.indexOf("e");
    let mant = s.slice(0, dot);
    const exp = s.slice(dot);
    if (mant.includes(".")) {
      while (mant.endsWith("0")) mant = mant.slice(0, -1);
      if (mant.endsWith(".")) mant = mant.slice(0, -1);
    }
    body = mant + exp;
  } else {
    // f-style: precision counts SIGNIFICANT digits ⇒ decimals = prec-(e+1)
    const decimals = Math.max(0, prec - (exp10 + 1));
    body = stripFracZeros(formatFixed(x, Math.min(decimals, 9)));
  }
  return upper ? body.toUpperCase() : body;
}

function isDigitCharCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

const strFormat: NativeFn = (L, args) => {
  const fmt = checkString(L, args, 1);
  const top = args.length;
  let arg = 1;
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== L_ESC) {
      out += ch;
      i++;
      continue;
    }
    i++;
    if (fmt[i] === L_ESC) {
      out += L_ESC;
      i++;
      continue;
    }
    arg++;
    if (arg > top) argError(L, arg, "no value");
    const scanned = scanformat(L, fmt, i);
    const spec = scanned.spec;
    i = scanned.next;
    const conv = fmt[i];
    i++;
    switch (conv) {
      case "c": {
        const v = checkInt(L, args, arg);
        out += padOut(String.fromCharCode(v & 0xff), spec, false);
        break;
      }
      case "d": case "i": {
        const n = checkNumber(L, args, arg);
        const ni = fx.toInt(n); // floor — matches (long)fix32
        out += padOut(String(ni), spec, true);
        break;
      }
      case "o": case "u": case "x": case "X": {
        const n = checkNumber(L, args, arg);
        const ni = fx.toInt(n);
        // (unsigned long)fix32: negative → 2^64 + ni (matches C's 64-bit
        // unsigned conversion for %lx/%lo/%lu)
        let uv: bigint;
        if (ni >= 0) uv = BigInt(ni >>> 0);
        else uv = BigInt(ni) + (1n << 64n);
        const base = conv === "o" ? 8 : conv === "u" ? 10 : 16;
        let s = uv.toString(base);
        if (conv === "X") s = s.toUpperCase();
        out += padOut(s, spec, true);
        break;
      }
      case "e": case "E": {
        const n = fx.toDouble(checkNumber(L, args, arg));
        out += padOut(
          formatExp(n, spec.prec ?? 6, conv === "E"),
          spec, true,
        );
        break;
      }
      case "f": {
        const n = fx.toDouble(checkNumber(L, args, arg));
        out += padOut(
          formatFixed(n, Math.min(spec.prec ?? 6, 9)),
          spec, true,
        );
        break;
      }
      case "g": case "G": {
        const n = fx.toDouble(checkNumber(L, args, arg));
        out += padOut(formatG(n, spec, conv === "G"), spec, true);
        break;
      }
      case "q": {
        out += addQuoted(checkString(L, args, arg));
        break;
      }
      case "s": {
        const v = args[arg - 1];
        const s = typeof v === "string" ? v : tostringValue(L, v) as string;
        if (spec.prec === null && s.length >= 100) {
          // no precision and long string → add raw (width ignored, per C)
          out += s;
        } else {
          let body = s;
          if (spec.prec !== null) body = body.slice(0, spec.prec);
          out += padOut(body, spec, false);
        }
        break;
      }
      default:
        luaLError(
          L,
          `invalid option '%${conv ?? ""}' to 'format'`,
        );
    }
  }
  return [out];
};

function addQuoted(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === '"' || c === "\\" || c === "\n") {
      out += "\\" + c;
    } else if (isCntrl(code)) {
      const nextCode = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (nextCode >= 0 && isDigitCharCode(nextCode)) {
        out += "\\" + String(code).padStart(3, "0");
      } else {
        out += "\\" + String(code);
      }
    } else {
      out += c;
    }
  }
  return out + '"';
}

// ---------------------------------------------------------------------------
// registration

export function makeStringLib(): [string, NativeFn][] {
  return [
    ["byte", strByte],
    ["char", strChar],
    ["dump", strDump],
    ["find", strFind],
    ["format", strFormat],
    ["gmatch", gmatch],
    ["gsub", strGsub],
    ["len", strLen],
    ["lower", strLower],
    ["match", strMatch],
    ["rep", strRep],
    ["reverse", strReverse],
    ["sub", strSub],
    ["upper", strUpper],
  ];
}
