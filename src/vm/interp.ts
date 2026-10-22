// z8lua (Lua 5.2.4 + fix32/PEEK extensions) interpreter 閳?port of lvm.c/ldo.c
// /ldebug.c semantics onto the explicit Frame stack in state.ts.
//
// Design notes (PLAN 鎼?.3c):
//  - One iterative execute() loop over L.frames; Lua閳墶ua calls push frames
//    (no JS recursion). JS recursion only at native boundaries: natives that
//    call Lua go through callValue/callFunction 閳?nested execute(barrier).
//  - frame.pc is synced on every instruction fetch BEFORE any call-out, so a
//    YieldSignal/BudgetSignal unwinding the JS stack leaves every frame
//    resumable; resumeState() repairs abandoned native frames (documented
//    gap: yield across natives 閳?PLAN 鎼?).
//  - Numbers are int32 fix32 bit patterns (value.ts); strings are byte
//    strings (code units 0閳?55).

import {
  OP_MOVE, OP_LOADK, OP_LOADKX, OP_LOADBOOL, OP_LOADNIL, OP_GETUPVAL,
  OP_GETTABUP, OP_GETTABLE, OP_SETTABUP, OP_SETUPVAL, OP_SETTABLE,
  OP_NEWTABLE, OP_SELF, OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_POW,
  OP_IDIV, OP_BAND, OP_BOR, OP_BXOR, OP_SHL, OP_SHR, OP_LSHR, OP_ROTL,
  OP_ROTR, OP_UNM, OP_BNOT, OP_NOT, OP_PEEK, OP_PEEK2, OP_PEEK4, OP_LEN,
  OP_CONCAT, OP_JMP, OP_EQ, OP_LT, OP_LE, OP_TEST, OP_TESTSET, OP_CALL,
  OP_TAILCALL, OP_RETURN, OP_FORLOOP, OP_FORPREP, OP_TFORCALL, OP_TFORLOOP,
  OP_SETLIST, OP_CLOSURE, OP_VARARG, OP_EXTRAARG, getA, getBx,
  getSJx, getAx, isK, indexK,
} from "./opcodes.ts";
import { LuaError, YieldSignal, BudgetSignal } from "./errors.ts";
import {
  MULTRET, type Frame, LuaState, makeClosure,
} from "./state.ts";
import type { Proto } from "./undump.ts";
import { undump } from "./undump.ts";
import {
  Closure, Table, UpVal, typeOf, isFalse, isCallable, type Value,
  type NativeFn,
} from "./value.ts";
import * as fx from "./fix32.ts";

const MAXTAGLOOP = 100;
const LFIELDS_PER_FLUSH = 50;
const ENV = "_ENV";
/** A/B switch for the fake-08 sandbox fallback (diagnostics only). */
export const sandboxFallbackSwitch = { disable: false };

// testAMode 閳?lopcodes.c luaP_opmodes bit 6 ("instruction sets A").
const TEST_A = new Set<number>([
  OP_MOVE, OP_LOADK, OP_LOADKX, OP_LOADBOOL, OP_LOADNIL, OP_GETUPVAL,
  OP_GETTABUP, OP_GETTABLE, OP_NEWTABLE, OP_SELF,
  OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_POW, OP_IDIV,
  OP_BAND, OP_BOR, OP_BXOR, OP_SHL, OP_SHR, OP_LSHR, OP_ROTL, OP_ROTR,
  OP_UNM, OP_BNOT, OP_NOT, OP_PEEK, OP_PEEK2, OP_PEEK4, OP_LEN, OP_CONCAT,
  OP_TESTSET, OP_CALL, OP_TAILCALL, OP_FORLOOP, OP_FORPREP, OP_TFORLOOP,
  OP_CLOSURE, OP_VARARG,
]);

// ---------------------------------------------------------------------------
// chunk ids, lines, positions (lobject.c luaO_chunkid / ldebug.c addinfo)

const LUA_IDSIZE = 60;

/** luaO_chunkid 閳?short source display name (60 bytes incl. NUL in C). */
export function chunkId(source: string): string {
  const l = source.length;
  if (source.startsWith("=")) {
    const s = source.slice(1);
    return s.length <= LUA_IDSIZE ? s : "..." + s.slice(l + 1 - LUA_IDSIZE);
  }
  if (source.startsWith("@")) {
    const s = source.slice(1);
    if (s.length <= LUA_IDSIZE) return s;
    const keep = LUA_IDSIZE - 4; // "..." + tail
    return "..." + s.slice(s.length - keep);
  }
  const nl = source.indexOf("\n");
  const prefix = '[string "';
  const suffix = '"]';
  const budget = LUA_IDSIZE - (prefix.length + suffix.length + 3); // + "..."
  if (l < budget && nl < 0) return prefix + source + suffix;
  let head = nl >= 0 ? source.slice(0, nl) : source;
  if (head.length > budget) head = head.slice(0, budget);
  return prefix + head + "..." + suffix;
}

/** currentline(ci) 閳?lineinfo of the frame's current instruction, or -1/0. */
function frameLine(frame: Frame): number {
  if (!frame.cl) return -1;
  const li = frame.cl.proto.lineinfo;
  const idx = frame.pc - 1;
  if (idx < 0 || idx >= li.length) return 0;
  return li[idx];
}

/** luaL_where 閳?"short_src:line: " for frame at `level`, else "". */
export function where(L: LuaState, level: number): string {
  const idx = L.frames.length - 1 - level;
  if (idx < 0) return "";
  const frame = L.frames[idx];
  const line = frameLine(frame);
  if (frame.cl && line > 0) {
    const src = frame.cl.proto.source;
    return `${chunkId(src ?? "?")}:${line}: `;
  }
  return "";
}

/** luaG_addinfo 閳?position prefix only when the top frame is Lua code. */
function addInfo(L: LuaState, msg: string): string {
  return where(L, 0) + msg;
}

/** runtime error from an executing instruction (luaG_runerror). */
export function runtimeError(L: LuaState, msg: string): never {
  const full = addInfo(L, msg);
  throw new LuaError(full, true, null, full);
}

/** luaL_error 閳?where(level=1) prefix + throw (used by natives). */
export function luaLError(L: LuaState, msg: string): never {
  const full = where(L, 1) + msg;
  throw new LuaError(full, true, null, full);
}

// ---------------------------------------------------------------------------
// symbolic execution for error names (ldebug.c getobjname/findsetreg/kname)

function getLocalName(p: Proto, localNumber: number, pc: number): string | null {
  for (const lv of p.locvars) {
    if (lv.startpc > pc) break;
    if (pc < lv.endpc) {
      localNumber--;
      if (localNumber === 0) return lv.varname;
    }
  }
  return null;
}

function upvalName(p: Proto, uv: number): string {
  const d = p.upvalues[uv];
  return d && d.name !== null ? d.name : "?";
}

function findsetreg(p: Proto, lastpc: number, reg: number): number {
  let setreg = -1;
  let jmptarget = 0;
  const filterpc = (pc: number): number => (pc < jmptarget ? -1 : pc);
  for (let pc = 0; pc < lastpc; pc++) {
    const i = p.code[pc];
    const op = i & 0x3f;
    const a = (i >>> 6) & 0xff;
    switch (op) {
      case OP_LOADNIL: {
        const b = (i >>> 23) & 0x1ff;
        if (a <= reg && reg <= a + b) setreg = filterpc(pc);
        break;
      }
      case OP_TFORCALL:
        if (reg >= a + 2) setreg = filterpc(pc);
        break;
      case OP_CALL:
      case OP_TAILCALL:
        if (reg >= a) setreg = filterpc(pc);
        break;
      case OP_JMP: {
        const dest = pc + 1 + getSJx(i);
        if (pc < dest && dest <= lastpc && dest > jmptarget) jmptarget = dest;
        break;
      }
      case OP_TEST:
        if (reg === a) setreg = filterpc(pc);
        break;
      default:
        if (TEST_A.has(op) && reg === a) setreg = filterpc(pc);
        break;
    }
  }
  return setreg;
}

function kname(p: Proto, pc: number, c: number, out: { name: string }): void {
  if (isK(c)) {
    const kv = p.k[indexK(c)];
    if (typeof kv === "string") {
      out.name = kv;
      return;
    }
  } else {
    const what = getobjname(p, pc, c, out);
    if (what && what === "c") return;
  }
  out.name = "?";
}

function getobjname(
  p: Proto, lastpc: number, reg: number, out: { name: string },
): string | null {
  let name = getLocalName(p, reg + 1, lastpc);
  if (name !== null) {
    out.name = name;
    return "local";
  }
  const pc = findsetreg(p, lastpc, reg);
  if (pc !== -1) {
    const i = p.code[pc];
    const op = i & 0x3f;
    const a = (i >>> 6) & 0xff;
    switch (op) {
      case OP_MOVE: {
        const b = (i >>> 23) & 0x1ff;
        if (b < a) return getobjname(p, pc, b, out);
        break;
      }
      case OP_GETTABUP:
      case OP_GETTABLE: {
        const k = (i >>> 14) & 0x1ff;
        const t = (i >>> 23) & 0x1ff;
        const vn = op === OP_GETTABLE
          ? getLocalName(p, t + 1, pc)
          : upvalName(p, t);
        kname(p, pc, k, out);
        return vn === ENV ? "global" : "field";
      }
      case OP_GETUPVAL:
        out.name = upvalName(p, (i >>> 23) & 0x1ff);
        return "upvalue";
      case OP_LOADK:
      case OP_LOADKX: {
        const b = op === OP_LOADK
          ? getBx(i)
          : getAx(p.code[pc + 1]);
        const kv = p.k[b];
        if (typeof kv === "string") {
          out.name = kv;
          return "constant";
        }
        break;
      }
      case OP_SELF: {
        const k = (i >>> 14) & 0x1ff;
        kname(p, pc, k, out);
        return "method";
      }
      default:
        break;
    }
  }
  return null;
}

/** getfuncname(caller) 閳?how `caller` called its callee (ldebug.c). */
function getfuncname(
  caller: Frame, out: { name: string },
): { kind: string } | null {
  if (!caller.cl) return null;
  const p = caller.cl.proto;
  const pc = caller.pc - 1;
  if (pc < 0 || pc >= p.code.length) return null;
  const i = p.code[pc];
  const op = i & 0x3f;
  const a = (i >>> 6) & 0xff;
  switch (op) {
    case OP_CALL:
    case OP_TAILCALL: {
      const kind = getobjname(p, pc, a, out);
      return kind === null ? null : { kind };
    }
    case OP_TFORCALL:
      out.name = "for iterator";
      return { kind: "for iterator" };
    case OP_SELF:
    case OP_GETTABUP:
    case OP_GETTABLE:
    case OP_SETTABUP:
    case OP_SETTABLE:
    case OP_EQ:
    case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_MOD:
    case OP_POW: case OP_IDIV: case OP_BAND: case OP_BOR: case OP_BXOR:
    case OP_SHL: case OP_SHR: case OP_LSHR: case OP_ROTL: case OP_ROTR:
    case OP_UNM: case OP_BNOT: case OP_LEN:
    case OP_LT: case OP_LE: case OP_CONCAT: {
      // metamethod name 閳?first/second operand; ldebug maps op閳姲m name.
      out.name = tmNameForOp(op) ?? "?";
      return { kind: "metamethod" };
    }
    default:
      return null;
  }
}

function tmNameForOp(op: number): string | null {
  // NOTE: z8lua's luaT_eventname has upstream typos 閳?these ARE the field
  // names the native VM looks up (ltm.c:33-41): _idiv / __and / __or /
  // __xor / rotr / __not. Our names must match byte-for-byte or metamethod
  // dispatch (and the resulting error messages) diverge from golden output.
  switch (op) {
    case OP_SELF: case OP_GETTABUP: case OP_GETTABLE: return "__index";
    case OP_SETTABUP: case OP_SETTABLE: return "__newindex";
    case OP_EQ: return "__eq";
    case OP_ADD: return "__add";
    case OP_SUB: return "__sub";
    case OP_MUL: return "__mul";
    case OP_DIV: return "__div";
    case OP_MOD: return "__mod";
    case OP_POW: return "__pow";
    case OP_IDIV: return "_idiv"; // z8lua typo: single leading underscore
    case OP_BAND: return "__and"; // z8lua typo: missing "b"
    case OP_BOR: return "__or"; // z8lua typo: missing "b"
    case OP_BXOR: return "__xor"; // z8lua typo: missing "b"
    case OP_SHL: return "__shl";
    case OP_SHR: return "__shr";
    case OP_LSHR: return "__lshr";
    case OP_ROTL: return "__rotl";
    case OP_ROTR: return "rotr"; // z8lua typo: missing underscores
    case OP_UNM: return "__unm";
    case OP_BNOT: return "__not"; // z8lua typo: "__bnot" would not match
    case OP_PEEK: return "__peek";
    case OP_PEEK2: return "__peek2";
    case OP_PEEK4: return "__peek4";
    case OP_LEN: return "__len";
    case OP_LT: return "__lt";
    case OP_LE: return "__le";
    case OP_CONCAT: return "__concat";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// luaG_typeerror family

const typeNames: Record<string, string> = {
  nil: "nil", boolean: "boolean", number: "number", string: "string",
  table: "table", function: "function", thread: "thread",
  userdata: "userdata",
};

function objTypeName(v: Value): string {
  return typeNames[typeOf(v)] ?? "userdata";
}

/** luaG_typeerror 閳?with symbolic name when the value sits in a register. */
export function typeError(L: LuaState, v: Value, op: string): never {
  const t = objTypeName(v);
  const ci = L.frames[L.frames.length - 1];
  let kind: string | null = null;
  let name = "";
  if (ci && ci.cl) {
    // z8lua uses pointer identity: the operand must be a register slot of
    // this frame (K constants and temporaries outside the window get no name).
    const reg = stackSlotOf(L, ci, v);
    if (reg >= 0) {
      const slot = ci.base + reg;
      for (let i = 0; i < ci.cl.upvals.length; i++) {
        if (ci.cl.upvals[i].slot === slot) {
          kind = "upvalue";
          name = upvalName(ci.cl.proto, i);
          break;
        }
      }
      if (kind === null) {
        const out = { name: "" };
        const r = getobjname(ci.cl.proto, ci.pc - 1, reg, out);
        if (r !== null) {
          kind = r;
          name = out.name;
        }
      }
    }
  }
  if (kind !== null) {
    runtimeError(L, `attempt to ${op} ${kind} '${name}' (a ${t} value)`);
  }
  runtimeError(L, `attempt to ${op} a ${t} value`);
}

function stackSlotOf(L: LuaState, frame: Frame, v: Value): number {
  const max = frame.cl?.proto.maxstacksize ?? 0;
  for (let i = frame.base; i < frame.base + max; i++) {
    if (L.stack[i] === v) return i - frame.base;
  }
  return -1;
}

function concatError(L: LuaState, p1: Value, p2: Value): never {
  const bad = (typeof p1 === "string" || typeof p1 === "number") ? p2 : p1;
  typeError(L, bad, "concatenate");
}

function arithError(L: LuaState, p1: Value, p2: Value): never {
  const bad = isNumberish(p1) ? p2 : p1;
  typeError(L, bad, "perform arithmetic on");
}

function orderError(L: LuaState, p1: Value, p2: Value): never {
  const t1 = objTypeName(p1);
  const t2 = objTypeName(p2);
  if (t1 === t2) runtimeError(L, `attempt to compare two ${t1} values`);
  runtimeError(L, `attempt to compare ${t1} with ${t2}`);
}

// luaL_argerror / typeerror 閳?bad argument #n to 'name' (msg)
export function argError(L: LuaState, narg: number, extramsg: string): never {
  const top = L.frames[L.frames.length - 1];
  if (!top) luaLError(L, `bad argument #${narg} (${extramsg})`);
  let name: string | null = null;
  let kind = "";
  const caller = L.frames[L.frames.length - 2];
  if (caller && caller.cl && !top.tail) {
    const r = getfuncname(caller, { name: "" });
    if (r) {
      const out = { name: "" };
      getfuncname(caller, out);
      name = out.name;
      kind = r.kind;
    }
  }
  if (kind === "method") {
    narg--;
    if (narg === 0) {
      luaLError(L, `calling '${name}' on bad self (${extramsg})`);
    }
  }
  if (name === null) {
    const fn = top.cl ? null : L.stack[top.func];
    name = (fn !== null && fn !== undefined &&
      findFieldName(L.globals, fn, 2)) || "?";
  }
  luaLError(L, `bad argument #${narg} to '${name}' (${extramsg})`);
}

export function typeErrorArg(
  L: LuaState, args: Value[], narg: number, tname: string,
): never {
  const v = args[narg - 1];
  const got = narg - 1 >= args.length || v === undefined
    ? "no value"
    : objTypeName(v);
  argError(L, narg, `${tname} expected, got ${got}`);
}

/** findField 閳?lauxlib.c pushglobalfuncname's recursive name search.
 *  Two-pass (direct fields first, then nested) to mirror the patched native
 *  findfield 閳?upstream's single-pass hash order is seed-dependent. */
function findFieldName(t: Table, target: Value, level: number): string | null {
  if (level === 0) return null;
  // pass 1: direct
  for (const [k, v] of t.map) {
    if (typeof k !== "string") continue;
    if (rawEqual(v, target)) return k;
  }
  // pass 2: nested (depth-limited)
  if (level > 1) {
    for (const [k, v] of t.map) {
      if (typeof k !== "string") continue;
      if (v instanceof Table) {
        const sub = findFieldName(v, target, level - 1);
        if (sub !== null) return k + "." + sub;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// raw equality / number coercion / display strings

export function rawEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  return false;
}

function isNumberish(v: Value): boolean {
  if (typeof v === "number") return true;
  return typeof v === "string" && fx.strToNum(v) !== null;
}

/** luaV_tonumber 閳?number as-is, string via luaO_str2d. */
export function toNumber(v: Value): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = fx.strToNum(v);
    return n === null ? undefined : n;
  }
  return undefined;
}

/** luaV_tostring for display: number 閳?"%.4f"-strip; else undefined. */
function numberToDisplay(v: Value): string | undefined {
  if (typeof v === "number") return fx.numToString(v);
  if (typeof v === "string") return v;
  return undefined;
}

// per-run handle counter for the "table: 0x閳? / "function: 0x閳? default 閳?// real addresses are nondeterministic anyway (never differential-tested).
let handleCounter = 0x1000;

/** luaL_tolstring 閳?the VALUE base `tostring` returns (may be non-string). */
export function tostringValue(L: LuaState, v: Value): Value {
  const tm = tmByObj(L, v, "__tostring");
  if (tm !== null) {
    const r = callSingle(L, tm, [v]);
    if (typeof r === "string") return r;
    if (typeof r === "number") return fx.numToString(r);
    return r; // weird TM result passes through (as luaL_tolstring would)
  }
  if (typeof v === "string") return v;
  if (typeof v === "number") return fx.numToString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null) return "nil";
  const t = typeOf(v); // table | function | thread
  handleCounter = (handleCounter + 0x10) & 0xfffffff0;
  return `${t}: 0x${handleCounter.toString(16)}`;
}

// ---------------------------------------------------------------------------
// metamethods (ltm.c + lvm.c helpers)

function tmFromTable(v: Value, event: string): Value | null {
  if (v instanceof Table && v.metatable !== null) {
    const tm = v.metatable.get(event);
    return tm === null ? null : tm;
  }
  return null;
}

/** luaT_gettmbyobj 閳?table metatable, else the shared string metatable. */
function tmByObj(L: LuaState, v: Value, event: string): Value | null {
  if (typeof v === "string") {
    const st = L.registry.get("STRING_META");
    if (st instanceof Table) {
      const tm = st.get(event);
      if (tm !== null) return tm;
    }
    return null;
  }
  return tmFromTable(v, event);
}

/**
 * Bookkeeping for one native-driven call 閳?captured so the caller decides
 * WHEN to unwind: pcall unwinds immediately (no handler), xpcall unwinds only
 * AFTER its handler ran (z8lua invokes the handler before luaD_pcall restores
 * the stack, so a traceback inside the handler sees the failing frames).
 */
export interface CallSite {
  entryFrames: number;
  stackIdx: number;
  prevTop: number;
}

export function beginCall(L: LuaState): CallSite {
  return {
    entryFrames: L.frames.length,
    stackIdx: L.stack.length,
    prevTop: L.top,
  };
}

/** normal completion: gather MULTRET results and restore stack/top. */
export function finishCall(L: LuaState, site: CallSite): Value[] {
  const results = L.stack.slice(site.stackIdx, L.top);
  L.stack.length = site.stackIdx;
  L.top = site.prevTop;
  return results;
}

/** discard everything the call put on the frame/stack (error path). */
export function abortCall(L: LuaState, site: CallSite): void {
  while (L.frames.length > site.entryFrames) L.frames.pop();
  L.closeUpvals(site.stackIdx);
  L.stack.length = site.stackIdx;
  L.top = site.prevTop;
}

/**
 * Run fn(args) 閳?on LuaError the frames/stack are LEFT AS-IS (rethrown) so a
 * caller can run a handler/traceback before abortCall(); YieldSignal and
 * BudgetSignal also pass through untouched (state must stay resumable).
 */
export function invokeNoCleanup(
  L: LuaState, site: CallSite, fn: Value, args: Value[],
): Value[] {
  L.stack.push(fn, ...args);
  L.top = site.stackIdx + 1 + args.length;
  const done = precall(L, site.stackIdx, MULTRET);
  if (done) return finishCall(L, site);
  execute(L, site.entryFrames);
  return finishCall(L, site);
}

/** callFunction 閳?call `fn` with `args`; LuaError unwinds before rethrow. */
export function callFunction(L: LuaState, fn: Value, args: Value[]): Value[] {
  const site = beginCall(L);
  try {
    return invokeNoCleanup(L, site, fn, args);
  } catch (e) {
    if (e instanceof LuaError) abortCall(L, site);
    throw e; // YieldSignal / BudgetSignal keep state intact
  }
}

/** Single-result convenience (callTM / metamethods). */
export function callSingle(L: LuaState, fn: Value, args: Value[]): Value {
  const res = callFunction(L, fn, args);
  return res.length > 0 ? res[0] : null;
}

/** call_binTM (lvm.c) 閳?try first operand's TM, then second's. */
function callBinTM(
  L: LuaState, p1: Value, p2: Value, event: string,
): { ok: true; value: Value } | { ok: false } {
  let tm = tmByObj(L, p1, event);
  if (tm === null) tm = tmByObj(L, p2, event);
  if (tm === null) return { ok: false };
  return { ok: true, value: callSingle(L, tm, [p1, p2]) };
}

// ---------------------------------------------------------------------------
// arithmetic (luaO_arith / fix32 ops; TM when operands aren't numbers)

function arithNum(L: LuaState, op: number, a: number, b: number): number {
  switch (op) {
    case OP_ADD: return fx.add(a, b);
    case OP_SUB: return fx.sub(a, b);
    case OP_MUL: return fx.mul(a, b);
    case OP_DIV: return fx.div(a, b);
    case OP_MOD: return fx.mod(a, b);
    case OP_POW: return fx.pow(a, b);
    case OP_IDIV: return fx.idiv(a, b);
    case OP_BAND: return fx.band(a, b);
    case OP_BOR: return fx.bor(a, b);
    case OP_BXOR: return fx.bxor(a, b);
    // shift counts are fix32 VALUES (z8lua: `int((b))` in luai_numshl etc.) —
    // converting via toInt; passing the raw bit pattern would hit the
    // `y >= 32 → 0` guard and silently zero the shift (caught by POOM's
    // unpack_variant: `(h&0x7f)<<8|mpeek()` returned just the low byte).
    case OP_SHL: return fx.shl(a, fx.toInt(b));
    case OP_SHR: return fx.shr(a, fx.toInt(b));
    case OP_LSHR: return fx.lshr(a, fx.toInt(b));
    case OP_ROTL: return fx.rotl(a, fx.toInt(b));
    case OP_ROTR: return fx.rotr(a, fx.toInt(b));
    case OP_UNM: return fx.neg(a);
    case OP_BNOT: return fx.bnot(a);
    case OP_PEEK: case OP_PEEK2: case OP_PEEK4: {
      const count = op === OP_PEEK ? 1 : op === OP_PEEK2 ? 2 : 4;
      return peekOp(L, a, count);
    }
    default: throw new Error(`arith op ${op}`);
  }
}

function peekOp(L: LuaState, a: number, count: 1 | 2 | 4): number {
  const p = L.pico8memory;
  let address = fx.toInt(a) & 0x7fff;
  const at = (i: number): number => (p !== null && i < 0x8000 ? p[i] : 0);
  let ret = 0;
  switch (count) {
    case 4:
      ret |= at(address + 1) << 8;
      ret |= at(address);
      address += 2;
      // falls through
    case 2:
      ret |= at(address + 1) << 24;
      // falls through
    case 1:
      ret |= at(address) << 16;
      break;
  }
  return ret | 0;
}

function tmEventFor(op: number): string {
  return tmNameForOp(op) ?? "__add";
}

/** luaV_arith 閳?full path with coercion and metamethods. Returns a Value. */
function arithValue(L: LuaState, op: number, rb: Value, rc: Value): Value {
  if (typeof rb === "number" && typeof rc === "number") {
    return arithNum(L, op, rb, rc);
  }
  const nb = toNumber(rb);
  const nc = toNumber(rc);
  if (nb !== undefined && nc !== undefined) {
    return arithNum(L, op, nb, nc);
  }
  const tm = callBinTM(L, rb, rc, tmEventFor(op));
  if (!tm.ok) arithError(L, rb, rc);
  return tm.value;
}

// ---------------------------------------------------------------------------
// comparisons (lvm.c luaV_lessthan/lessequal/equalobj)

function callOrderTM(
  L: LuaState, p1: Value, p2: Value, event: string,
): boolean | null {
  const r = callBinTM(L, p1, p2, event);
  if (!r.ok) return null;
  return !isFalse(r.value);
}

export function ltValues(L: LuaState, l: Value, r: Value): boolean {
  if (typeof l === "number" && typeof r === "number") return l < r;
  if (typeof l === "string" && typeof r === "string") {
    return byteCompare(l, r) < 0;
  }
  const res = callOrderTM(L, l, r, "__lt");
  if (res === null) orderError(L, l, r);
  return res;
}

export function leValues(L: LuaState, l: Value, r: Value): boolean {
  if (typeof l === "number" && typeof r === "number") return l <= r;
  if (typeof l === "string" && typeof r === "string") {
    return byteCompare(l, r) <= 0;
  }
  const res = callOrderTM(L, l, r, "__le");
  if (res !== null) return res;
  const res2 = callOrderTM(L, r, l, "__lt");
  if (res2 === null) orderError(L, l, r);
  return !res2;
}

/** l_strcmp 閳?byte-wise (strcoll in C locale == memcmp for ASCII/bytes). */
function byteCompare(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const n = Math.min(la, lb);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return la === lb ? 0 : la < lb ? -1 : 1;
}

function getEqualTM(
  L: LuaState, mt1: Table | null, mt2: Table | null,
): Value | null {
  const tm1 = mt1 !== null ? mt1.get("__eq") : null;
  if (tm1 === null) return null;
  if (mt1 === mt2) return tm1;
  const tm2 = mt2 !== null ? mt2.get("__eq") : null;
  if (tm2 === null) return null;
  return rawEqual(tm1, tm2) ? tm1 : null;
}

/** luaV_equalobj (non-raw). */
export function equalValues(L: LuaState, t1: Value, t2: Value): boolean {
  if (t1 === null || t2 === null) return t1 === t2;
  if (typeof t1 === "number" && typeof t2 === "number") return t1 === t2;
  if (typeof t1 === "boolean" && typeof t2 === "boolean") return t1 === t2;
  if (typeof t1 === "string" && typeof t2 === "string") return t1 === t2;
  if (t1 instanceof Table && t2 instanceof Table) {
    if (t1 === t2) return true;
    const tm = getEqualTM(L, t1.metatable, t2.metatable);
    if (tm === null) return false;
    return !isFalse(callSingle(L, tm, [t1, t2]));
  }
  // functions/threads/userdata: identity
  return t1 === t2;
}

// ---------------------------------------------------------------------------
// gettable / settable (lvm.c + PICO-8 string index special case)

function strIndexChar(s: string, key: Value): string | null {
  // PICO-8: t[pos] on strings (z8lua lvm.c:112-122). Non-number keys and
  // out-of-range positions yield nil (C reads UB garbage; observed nil).
  if (typeof key !== "number") return null;
  const k = fx.toInt(key);
  const idx = k > 0 ? k - 1 : s.length + k;
  if (idx < 0 || idx >= s.length) return null;
  return s[idx];
}

/** luaV_gettable 閳?result written to caller (value returned). */
export function gettable(L: LuaState, t: Value, key: Value): Value {
  if (typeof t === "string") return strIndexChar(t, key);
  for (let loop = 0; loop < MAXTAGLOOP; loop++) {
    if (t instanceof Table) {
      const res = t.get(key);
      if (res !== null) return res;
      const tm = tmFromTable(t, "__index");
      if (tm === null) return null;
      if (typeof tm === "function" || tm instanceof Closure) {
        return callSingle(L, tm, [t, key]);
      }
      t = tm;
      continue;
    }
    const tm = tmByObj(L, t, "__index");
    if (tm === null) typeError(L, t, "index");
    if (typeof tm === "function" || tm instanceof Closure) {
      return callSingle(L, tm, [t, key]);
    }
    t = tm;
  }
  runtimeError(L, "loop in gettable");
}

/**
 * fake-08 sandbox fallback (their libs/z8lua/lvm.c OP_GETTABUP/GETTABLE
 * patch): when a string-keyed lookup misses and the result is nil, resolve
 * the key in `registry["__PICO8_SANDBOX"]` 閳?the bios publishes the cart
 * sandbox there (p8GlobalLuaFunctions.h:580). This keeps API globals like
 * `circfill` reachable after a cart overrides `_ENV` (nested_env_test /
 * Ex-Terra draw_gbullets_old). Returns null when no fallback applies 閳? * registry is empty outside a running cart, so tests/differential see no-op.
 */
function sandboxFallback(L: LuaState, key: Value): Value {
  if (typeof key !== "string") return null;
  const sb = L.registry.get("__PICO8_SANDBOX");
  if (sb instanceof Table) {
    const v = sb.get(key);
    if (v !== null) return v;
  }
  return null;
}

/** luaV_settable. */
export function settable(L: LuaState, t: Value, key: Value, val: Value): void {
  for (let loop = 0; loop < MAXTAGLOOP; loop++) {
    if (t instanceof Table) {
      const oldval = t.get(key);
      if (oldval !== null || t.has(key)) {
        // entry exists (possibly nil-valued? has() true means key present) 閳?        // assign raw; but Lua semantics: existing non-nil 閳?set directly.
        t.set(key, val);
        return;
      }
      if (key === null && tmFromTable(t, "__newindex") === null) {
        runtimeError(L, "table index is nil");
      }
      const tm = tmFromTable(t, "__newindex");
      if (tm === null) {
        t.set(key, val);
        return;
      }
      if (typeof tm === "function" || tm instanceof Closure) {
        callFunction(L, tm, [t, key, val]);
        return;
      }
      t = tm;
      continue;
    }
    const tm = tmByObj(L, t, "__newindex");
    if (tm === null) typeError(L, t, "index");
    if (typeof tm === "function" || tm instanceof Closure) {
      callFunction(L, tm, [t, key, val]);
      return;
    }
    t = tm;
  }
  runtimeError(L, "loop in settable");
}

// ---------------------------------------------------------------------------
// luaV_objlen / luaV_concat

/** luaV_objlen 閳?returns a fix32 bit pattern (Lua number). */
export function objlen(L: LuaState, v: Value): number {
  if (v instanceof Table) {
    const tm = tmFromTable(v, "__len");
    if (tm !== null) {
      const r = callSingle(L, tm, [v]);
      return typeof r === "number" ? r : fx.fromDouble(Number(r));
    }
    return fx.fromInt(v.length());
  }
  if (typeof v === "string") return fx.fromInt(v.length);
  const tm = tmByObj(L, v, "__len");
  if (tm === null) typeError(L, v, "get length of");
  const r = callSingle(L, tm, [v]);
  return typeof r === "number" ? r : fx.fromDouble(Number(r));
}

/** coerce stack[idx] to string in place (luaV_tostring); false if not possible */
function tostringInPlace(L: LuaState, idx: number): boolean {
  const v = L.stack[idx];
  const s = numberToDisplay(v);
  if (s === undefined) return false;
  L.stack[idx] = s;
  return true;
}

/** luaV_concat over stack[0 .. L.top) tail; result lands at L.top-1. */
function concatValues(L: LuaState, total: number): void {
  do {
    const top = L.top;
    const bV = L.stack[top - 2];
    const cV = L.stack[top - 1];
    if (
      !(typeof bV === "string" || typeof bV === "number") ||
      !tostringInPlace(L, top - 1)
    ) {
      const tm = callBinTM(L, bV, cV, "__concat");
      if (!tm.ok) concatError(L, bV, cV);
      L.stack[top - 2] = tm.value;
      // n = 2
    } else {
      const s2 = L.stack[top - 1] as string;
      if (s2.length === 0) {
        tostringInPlace(L, top - 2);
        // n = 2 閳?result is first operand (coerced)
      } else if (
        typeof L.stack[top - 2] === "string" &&
        (L.stack[top - 2] as string).length === 0
      ) {
        L.stack[top - 2] = s2;
        // n = 2 閳?result is second operand
      } else {
        // collect as many stringable operands as possible (leftwards)
        let i = 1;
        while (i < total && tostringInPlace(L, top - i - 1)) i++;
        // n = i 閳?build the buffer from top-i .. top-1
        let buf = "";
        for (let j = i; j >= 1; j--) {
          const v = L.stack[top - j];
          buf += typeof v === "number" ? fx.numToString(v) : String(v);
        }
        L.stack[top - i] = buf;
        total -= i - 1;
        L.top -= i - 1;
        continue;
      }
    }
    total -= 1; // n = 2 閳?total -= 1
    L.top -= 1;
  } while (total > 1);
}

// ---------------------------------------------------------------------------
// pre-call / post-call (ldo.c)

function adjustVarargs(L: LuaState, p: Proto, funcIdx: number): number {
  const nfix = p.numparams;
  const base = L.top; // first register after the varargs region
  for (let i = 0; i < nfix; i++) {
    L.stack[base + i] = L.stack[funcIdx + 1 + i];
    L.stack[funcIdx + 1 + i] = null;
  }
  return base;
}

/**
 * luaD_precall 閳?returns true when a native completed inline (results at
 * funcIdx); false when a Lua frame was pushed and execute() must run it.
 */
export function precall(L: LuaState, funcIdx: number, nresults: number): boolean {
  for (;;) {
    const fn = L.stack[funcIdx];
    if (fn instanceof Closure) {
      const p = fn.proto;
      const nargs = L.top - funcIdx - 1;
      let n = nargs;
      while (n < p.numparams) {
        L.stack[L.top] = null;
        L.top++;
        n++;
      }
      let base: number;
      if (!p.is_vararg) {
        base = funcIdx + 1;
      } else {
        base = adjustVarargs(L, p, funcIdx);
      }
      const frame: Frame = {
        cl: fn, native: undefined, func: funcIdx, base, pc: 0,
        top: base + p.maxstacksize, nresults,
      };
      L.frames.push(frame);
      L.top = frame.top;
      return false;
    }
    if (typeof fn === "function" || fn instanceof Table) {
      // native function, or value with __call
      if (fn instanceof Table) {
        const tm = tmByObj(L, fn, "__call");
        if (tm !== null && (typeof tm === "function" || tm instanceof Closure)) {
          // open a hole: shift everything up one and put tm at funcIdx
          L.stack.length = L.stack.length + 1;
          for (let i = L.top; i > funcIdx; i--) L.stack[i] = L.stack[i - 1];
          L.stack[funcIdx] = tm;
          L.top++;
          continue;
        }
        typeError(L, fn, "call");
      }
      const native = fn as NativeFn;
      const frame: Frame = {
        cl: null, native, func: funcIdx, base: funcIdx + 1, pc: 0,
        top: L.top, nresults,
      };
      L.frames.push(frame);
      const args = L.stack.slice(funcIdx + 1, L.top);
      const res = native(L, args);
      // normal return: pop the native frame and place results
      L.frames.pop();
      poscallResults(L, funcIdx, nresults, res);
      return true;
    }
    // not a function 閳?try __call (already handled Table above)
    const tm = tmByObj(L, fn, "__call");
    if (tm !== null && (typeof tm === "function" || tm instanceof Closure)) {
      for (let i = L.top; i > funcIdx; i--) L.stack[i] = L.stack[i - 1];
      L.stack[funcIdx] = tm;
      L.top++;
      continue;
    }
    typeError(L, fn, "call");
  }
}

/** place native results at `target` honoring `wanted` (luaD_poscall core). */
function poscallResults(
  L: LuaState, target: number, wanted: number, res: Value[],
): void {
  if (wanted === MULTRET) {
    for (let i = 0; i < res.length; i++) L.stack[target + i] = res[i];
    L.top = target + res.length;
    return;
  }
  const take = Math.min(wanted, res.length);
  for (let i = 0; i < take; i++) L.stack[target + i] = res[i];
  for (let i = take; i < wanted; i++) L.stack[target + i] = null;
  L.top = target + wanted;
}

/** luaD_poscall for a returning Lua frame. Returns wanted (MULTRET=-1). */
function poscallLua(
  L: LuaState, frame: Frame, firstResult: number,
): number {
  L.closeUpvals(frame.base);
  L.frames.pop();
  if (frame.bridge) {
    // deliver to the real call site across abandoned native frames
    const { dst, wanted, nextTop, wrap } = frame.bridge;
    const gathered: Value[] = [];
    for (let i = firstResult; i < L.top; i++) gathered.push(L.stack[i]);
    poscallResults(L, dst, wanted, wrap ? [true, ...gathered] : gathered);
    L.top = wanted >= 0 ? nextTop : L.top;
    return wanted;
  }
  const target = frame.func;
  const wanted = frame.nresults;
  // gather from firstResult..L.top into target with wanted rules
  if (wanted === MULTRET) {
    let n = 0;
    let src = firstResult;
    while (src < L.top) {
      L.stack[target + n] = L.stack[src];
      n++;
      src++;
    }
    L.top = target + n;
  } else {
    let n = 0;
    let src = firstResult;
    while (n < wanted && src < L.top) {
      L.stack[target + n] = L.stack[src];
      n++;
      src++;
    }
    while (n < wanted) {
      L.stack[target + n] = null;
      n++;
    }
    L.top = target + wanted;
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// the interpreter loop

/** execute 閳?run frames until L.frames.length <= barrier. */
export function execute(L: LuaState, barrier: number): void {
  while (L.frames.length > barrier) {
    const frame = L.frames[L.frames.length - 1];
    if (frame.native !== undefined && frame.native !== null) {
      if (frame.abandoned) {
        L.frames.pop();
        continue;
      }
      throw new Error("p8js: native frame resumed unexpectedly");
    }
    runFrame(L, frame, barrier);
  }
}

function runFrame(L: LuaState, frame: Frame, barrier: number): void {
  const cl = frame.cl!;
  const p = cl.proto;
  const code = p.code;
  const k = p.k;
  let base = frame.base;
  let pc = frame.pc;
  const done = (): void => {
    frame.pc = pc;
  };

  for (;;) {
    if (L.budget !== 0) {
      if (--L.budget <= 0) {
        frame.pc = pc;
        throw new BudgetSignal(L.budget);
      }
    }
    const i = code[pc++];
    frame.pc = pc; // keep synced before any call-out
    const op = i & 0x3f;
    const A = (i >>> 6) & 0xff;
    const ra = base + A;
    switch (op) {
      case OP_MOVE:
        L.stack[ra] = L.stack[base + ((i >>> 23) & 0x1ff)];
        break;
      case OP_LOADK:
        L.stack[ra] = k[getBx(i)];
        break;
      case OP_LOADKX:
        L.stack[ra] = k[getAx(code[pc++])];
        frame.pc = pc;
        break;
      case OP_LOADBOOL:
        L.stack[ra] = ((i >>> 23) & 0x1ff) !== 0;
        if (((i >>> 14) & 0x1ff) !== 0) {
          pc++;
          frame.pc = pc;
        }
        break;
      case OP_LOADNIL: {
        const b = (i >>> 23) & 0x1ff;
        for (let j = 0; j <= b; j++) L.stack[ra + j] = null;
        break;
      }
      case OP_GETUPVAL:
        L.stack[ra] = cl.upvals[(i >>> 23) & 0x1ff].get();
        break;
      case OP_GETTABUP: {
        const t = cl.upvals[(i >>> 23) & 0x1ff].get();
        const key = isK((i >>> 14) & 0x1ff)
          ? k[indexK((i >>> 14) & 0x1ff)]
          : L.stack[base + ((i >>> 14) & 0x1ff)];
        let v = gettable(L, t, key);
        // fake-08 compat: nil global lookups fall back to the cart sandbox in
        // the registry 閳?this is what makes `_ENV = bullet` + `circfill(...)`
        // still resolve (their lvm.c OP_GETTABUP patch; Ex-Terra's
        // draw_gbullets_old, see KNOWN-GAPS).
        if (v === null && !sandboxFallbackSwitch.disable) {
          const fb = sandboxFallback(L, key);
          if (fb !== null) v = fb;
        }
        L.stack[ra] = v;
        break;
      }
      case OP_GETTABLE: {
        const t = L.stack[base + ((i >>> 23) & 0x1ff)];
        const c = (i >>> 14) & 0x1ff;
        const key = isK(c) ? k[indexK(c)] : L.stack[base + c];
        // NOTE: fake-08 also patches OP_GETTABLE for overridden-`_ENV` for-loop
        // lookups, but applying it to plain table field reads poisons nil-
        // probes like pigments' `if e.pcol then` (sandbox holds a same-named
        // global) and can loop forever. Only the GETTABUP path (globals via
        // the _ENV upvalue) is enabled 鈥?that is what nested_env_test needs.
        L.stack[ra] = gettable(L, t, key);
        break;
      }
      case OP_SETTABUP: {
        const t = cl.upvals[A].get();
        const b = (i >>> 23) & 0x1ff;
        const key = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const val = isK(c) ? k[indexK(c)] : L.stack[base + c];
        settable(L, t, key, val);
        break;
      }
      case OP_SETUPVAL:
        cl.upvals[(i >>> 23) & 0x1ff].set(L.stack[ra]);
        break;
      case OP_SETTABLE: {
        const b = (i >>> 23) & 0x1ff;
        const key = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const val = isK(c) ? k[indexK(c)] : L.stack[base + c];
        settable(L, L.stack[ra], key, val);
        break;
      }
      case OP_NEWTABLE: {
        const t = new Table();
        // B is a floating-point byte hint of the array size (luaO_fb2int)
        const b = (i >>> 23) & 0x1ff;
        const e = (b >> 3) & 0x1f;
        t.arraySize = e === 0 ? b : ((b & 7) + 8) << (e - 1);
        L.stack[ra] = t;
        break;
      }
      case OP_SELF: {
        const rb = L.stack[base + ((i >>> 23) & 0x1ff)];
        L.stack[ra + 1] = rb;
        const c = (i >>> 14) & 0x1ff;
        const key = isK(c) ? k[indexK(c)] : L.stack[base + c];
        L.stack[ra] = gettable(L, rb, key);
        break;
      }
      case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_MOD:
      case OP_POW: case OP_IDIV: case OP_BAND: case OP_BOR: case OP_BXOR:
      case OP_SHL: case OP_SHR: case OP_LSHR: case OP_ROTL: case OP_ROTR: {
        const b = (i >>> 23) & 0x1ff;
        const rb = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const rc = isK(c) ? k[indexK(c)] : L.stack[base + c];
        L.stack[ra] = arithValue(L, op, rb, rc);
        break;
      }
      case OP_UNM: case OP_BNOT: case OP_PEEK: case OP_PEEK2: case OP_PEEK4: {
        const rb = L.stack[base + ((i >>> 23) & 0x1ff)];
        L.stack[ra] = arithValue(L, op, rb, rb);
        break;
      }
      case OP_NOT:
        L.stack[ra] = isFalse(L.stack[base + ((i >>> 23) & 0x1ff)]);
        break;
      case OP_LEN:
        L.stack[ra] = objlen(L, L.stack[base + ((i >>> 23) & 0x1ff)]);
        break;
      case OP_CONCAT: {
        const b = (i >>> 23) & 0x1ff;
        const c = (i >>> 14) & 0x1ff;
        L.top = base + c + 1;
        concatValues(L, c - b + 1);
        L.stack[ra] = L.stack[base + b];
        L.top = frame.top;
        break;
      }
      case OP_JMP: {
        if (A > 0) L.closeUpvals(base + A - 1);
        pc += getSJx(i);
        frame.pc = pc;
        break;
      }
      case OP_EQ: {
        const b = (i >>> 23) & 0x1ff;
        const rb = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const rc = isK(c) ? k[indexK(c)] : L.stack[base + c];
        const eq = equalValues(L, rb, rc);
        if (eq !== (A !== 0)) pc++;
        else {
          const j = code[pc];
          pc += 1 + getSJx(j);
          const ja = getA(j);
          if (ja > 0) L.closeUpvals(base + ja - 1);
        }
        frame.pc = pc;
        break;
      }
      case OP_LT: {
        const b = (i >>> 23) & 0x1ff;
        const rb = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const rc = isK(c) ? k[indexK(c)] : L.stack[base + c];
        const lt = ltValues(L, rb, rc);
        if (lt !== (A !== 0)) pc++;
        else {
          const j = code[pc];
          pc += 1 + getSJx(j);
          const ja = getA(j);
          if (ja > 0) L.closeUpvals(base + ja - 1);
        }
        frame.pc = pc;
        break;
      }
      case OP_LE: {
        const b = (i >>> 23) & 0x1ff;
        const rb = isK(b) ? k[indexK(b)] : L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const rc = isK(c) ? k[indexK(c)] : L.stack[base + c];
        const le = leValues(L, rb, rc);
        if (le !== (A !== 0)) pc++;
        else {
          const j = code[pc];
          pc += 1 + getSJx(j);
          const ja = getA(j);
          if (ja > 0) L.closeUpvals(base + ja - 1);
        }
        frame.pc = pc;
        break;
      }
      case OP_TEST: {
        const c = (i >>> 14) & 0x1ff;
        const cond = c !== 0 ? isFalse(L.stack[ra]) : !isFalse(L.stack[ra]);
        if (cond) pc++;
        else {
          const j = code[pc];
          pc += 1 + getSJx(j);
          const ja = getA(j);
          if (ja > 0) L.closeUpvals(base + ja - 1);
        }
        frame.pc = pc;
        break;
      }
      case OP_TESTSET: {
        const b = (i >>> 23) & 0x1ff;
        const rb = L.stack[base + b];
        const c = (i >>> 14) & 0x1ff;
        const cond = c !== 0 ? isFalse(rb) : !isFalse(rb);
        if (cond) pc++;
        else {
          L.stack[ra] = rb;
          const j = code[pc];
          pc += 1 + getSJx(j);
          const ja = getA(j);
          if (ja > 0) L.closeUpvals(base + ja - 1);
        }
        frame.pc = pc;
        break;
      }
      case OP_CALL: {
        const b = (i >>> 23) & 0x1ff;
        const nresults = ((i >>> 14) & 0x1ff) - 1;
        if (b !== 0) L.top = ra + b;
        const doneCall = precall(L, ra, nresults);
        if (doneCall) {
          if (nresults >= 0) L.top = frame.top;
          break; // continue this frame
        }
        done();
        return; // Lua callee pushed 閳?outer loop takes over
      }
      case OP_TAILCALL: {
        const b = (i >>> 23) & 0x1ff;
        if (b !== 0) L.top = ra + b;
        const doneCall = precall(L, ra, MULTRET);
        if (doneCall) {
          // native tail call: results at ra; the trailing RETURN gathers them
          break;
        }
        // Lua callee: replace the current frame in place (ldo.c TAILCALL)
        const nci = L.frames.pop()!;
        const oci = frame;
        const nfunc = nci.func;
        const ofunc = oci.func;
        const lim = nci.base + nci.cl!.proto.numparams;
        L.closeUpvals(oci.base);
        for (let aux = 0; nfunc + aux < lim; aux++) {
          L.stack[ofunc + aux] = L.stack[nfunc + aux];
        }
        oci.base = ofunc + (nci.base - nfunc);
        oci.top = ofunc + (L.top - nfunc);
        oci.pc = 0;
        oci.cl = nci.cl;
        oci.tail = true;
        L.top = oci.base + oci.cl!.proto.maxstacksize;
        // NOTE: do NOT call done() here 閳?it would clobber oci.pc = 0 with
        // the stale local pc (TAILCALL+1) and resume at the trailing RETURN.
        return;
      }
      case OP_RETURN: {
        const b = (i >>> 23) & 0x1ff;
        if (b !== 0) L.top = ra + b - 1;
        const hadBridge = frame.bridge !== undefined;
        const wanted = poscallLua(L, frame, ra);
        if (L.frames.length <= barrier) {
          return;
        }
        if (!hadBridge && wanted >= 0) {
          L.top = L.frames[L.frames.length - 1].top;
        }
        return; // caller frame resumes in outer loop
      }
      case OP_FORLOOP: {
        const step = L.stack[ra + 2] as number;
        const idx = fx.add(L.stack[ra] as number, step);
        const limit = L.stack[ra + 1] as number;
        const cur = L.stack[ra] as number;
        const cont = step > 0 ? cur <= idx : idx <= cur;
        if (cont) {
          const inRange = step > 0 ? idx <= limit : limit <= idx;
          if (inRange) {
            pc += getSJx(i);
            L.stack[ra] = idx;
            L.stack[ra + 3] = idx;
          }
        }
        frame.pc = pc;
        break;
      }
      case OP_FORPREP: {
        const n0 = toNumber(L.stack[ra]);
        if (n0 === undefined) {
          runtimeError(L, "'for' initial value must be a number");
        }
        const n1 = toNumber(L.stack[ra + 1]);
        if (n1 === undefined) {
          runtimeError(L, "'for' limit must be a number");
        }
        const n2 = toNumber(L.stack[ra + 2]);
        if (n2 === undefined) {
          runtimeError(L, "'for' step must be a number");
        }
        // luaV_tonumber writes converted values back in place
        L.stack[ra + 1] = n1;
        L.stack[ra + 2] = n2;
        L.stack[ra] = fx.sub(n0, n2);
        pc += getSJx(i);
        frame.pc = pc;
        break;
      }
      case OP_TFORCALL: {
        // cb = ra+3: copy (f, state, control) then call with C results
        L.stack[ra + 3] = L.stack[ra];
        L.stack[ra + 4] = L.stack[ra + 1];
        L.stack[ra + 5] = L.stack[ra + 2];
        L.top = ra + 6;
        const nresults = (i >>> 14) & 0x1ff;
        const doneCall = precall(L, ra + 3, nresults);
        if (doneCall) {
          L.top = frame.top;
        } else {
          // iterator is Lua: run it to completion here (nested), then fall
          // into TFORLOOP 閳?barrier = current frame stays below.
          execute(L, L.frames.length - 1);
          L.top = frame.top;
        }
        // fall into TFORLOOP semantics with the next instruction
        const j = code[pc++];
        frame.pc = pc;
        const jop = j & 0x3f;
        if (jop !== OP_TFORLOOP) {
          throw new Error("p8js: TFORCALL not followed by TFORLOOP");
        }
        const jA = (j >>> 6) & 0xff;
        if (L.stack[base + jA + 1] !== null) {
          L.stack[base + jA] = L.stack[base + jA + 1];
          pc += getSJx(j);
          frame.pc = pc;
        }
        break;
      }
      case OP_TFORLOOP: {
        // reached only when jumped into directly (compiler emits TFORCALL+1)
        if (L.stack[ra + 1] !== null) {
          L.stack[ra] = L.stack[ra + 1];
          pc += getSJx(i);
          frame.pc = pc;
        }
        break;
      }
      case OP_SETLIST: {
        let n = (i >>> 23) & 0x1ff;
        let c = (i >>> 14) & 0x1ff;
        if (n === 0) n = L.top - ra - 1;
        if (c === 0) {
          c = getAx(code[pc++]);
          frame.pc = pc;
        }
        const t = L.stack[ra] as Table;
        let last = (c - 1) * LFIELDS_PER_FLUSH + n;
        // luaH_resizearray: the array part covers at least the flush range
        if (last > t.arraySize) t.arraySize = last;
        // insert ascending (z8lua fills array[0..] in order 閳?pairs/next
        // iterate the array part1..n, so Map insertion order must match)
        const first = last - n + 1;
        for (let nn = 1; nn <= n; nn++) {
          t.set(fx.fromInt(first - 1 + nn), L.stack[ra + nn]);
        }
        L.top = frame.top;
        break;
      }
      case OP_CLOSURE: {
        const proto = p.p[getBx(i)];
        L.stack[ra] = makeClosure(L, proto, cl, base);
        break;
      }
      case OP_VARARG: {
        let b = ((i >>> 23) & 0x1ff) - 1;
        const n = (base - frame.func) - p.numparams - 1;
        if (b < 0) {
          b = n;
          L.top = ra + n;
        }
        for (let j = 0; j < b; j++) {
          L.stack[ra + j] = j < n ? L.stack[base - n + j] : null;
        }
        break;
      }
      case OP_EXTRAARG:
        throw new Error("p8js: stray EXTRAARG");
      default:
        throw new Error(`p8js: unknown opcode ${op}`);
    }
  }
}

// ---------------------------------------------------------------------------
// calling into Lua from natives / top-level drivers

/** run a chunk to completion inside a fresh protected frame. */
export function runChunk(
  L: LuaState, cl: Closure, loaderFrame = true,
): Value[] {
  const idx = L.stack.length;
  L.stack.push(cl);
  const prevTop = L.top;
  L.top = idx + 1;
  const base = L.frames.length;
  // synthetic [C] frame so traceback/where match lua.c's docall shape
  if (loaderFrame) {
    L.frames.push({
      cl: null,
      native: (() => []) as NativeFn,
      func: idx, base: idx + 1, pc: 0, top: idx + 1, nresults: MULTRET,
    });
  }
  const barrier = L.frames.length;
  const cleanup = (): void => {
    while (L.frames.length > base) L.frames.pop();
    L.closeUpvals(idx);
    L.stack.length = idx;
    L.top = prevTop;
  };
  try {
    const done = precall(L, idx, MULTRET);
    if (!done) execute(L, barrier);
    const results = L.stack.slice(idx, L.top);
    cleanup();
    return results;
  } catch (e) {
    if (e instanceof LuaError) {
      // leave frames + stack intact so the driver can build a traceback
      // (z8lua's msghandler runs before luaD_pcall unwinds; same shape).
      throw e;
    }
    cleanup();
    throw e;
  }
}

/** undump + make a chunk closure bound to `env` (lua_load's upvalue rule). */
export function loadProto(data: Uint8Array, name: string): Proto {
  return undump(data, name);
}

export function chunkClosure(L: LuaState, proto: Proto, env: Table): Closure {
  const ups: UpVal[] = [];
  for (let i = 0; i < proto.upvalues.length; i++) {
    const uv = new UpVal(L.stack, null);
    uv.set(null);
    ups.push(uv);
  }
  if (proto.upvalues.length === 1) ups[0].set(env);
  return new Closure(proto, ups);
}

/** Load a binary dump and run it to completion; returns results. */
export function runDump(
  L: LuaState, data: Uint8Array, name: string, env: Table,
): Value[] {
  const proto = loadProto(data, name);
  const cl = chunkClosure(L, proto, env);
  return runChunk(L, cl);
}

// ---------------------------------------------------------------------------
// coroutine resume driver (ldo.c lua_resume + PLAN 鎼? gap handling)

const LEVELS1 = 12;
const LEVELS2 = 10;

/** pushfuncname (lauxlib.c) 閳?the "in 閳? description of one frame. */
function frameFuncName(L1: LuaState, idx: number): string {
  const frame = L1.frames[idx];
  const caller = idx > 0 ? L1.frames[idx - 1] : null;
  let name: string | null = null;
  let namewhat = "";
  if (caller && caller.cl && !frame.tail) {
    const out = { name: "" };
    const r = getfuncname(caller, out);
    if (r !== null) {
      name = out.name;
      namewhat = r.kind;
    }
  }
  if (namewhat !== "") return `function '${name}'`;
  if (frame.cl) {
    const p = frame.cl.proto;
    if (p.linedefined === 0) return "main chunk";
    return `function <${chunkId(p.source ?? "=?")}:${p.linedefined}>`;
  }
  // C function: search _G (and one nested level) for its value
  const fn = L1.stack[frame.func];
  if (fn !== undefined && fn !== null) {
    const gname = findFieldName(L1.globals, fn, 2);
    if (gname !== null) return `function '${gname}'`;
  }
  return "?";
}

/** luaL_traceback 閳?"msg\nstack traceback:" + per-level lines. */
export function tracebackString(
  L1: LuaState, msg: string | null, level: number,
): string {
  let out = msg !== null ? msg + "\n" : "";
  out += "stack traceback:";
  const numlevels = L1.frames.length;
  const mark = numlevels > LEVELS1 + LEVELS2 ? LEVELS1 : 0;
  let lvl = level;
  while (lvl < numlevels) {
    const idx = numlevels - 1 - lvl;
    const frame = L1.frames[idx];
    lvl++; // z8lua reads level post-incremented inside the loop body
    if (lvl === mark) {
      out += "\n\t...";
      lvl = numlevels - LEVELS2;
      continue;
    }
    let src: string;
    let line = -1;
    if (frame.cl) {
      const p = frame.cl.proto;
      src = chunkId(p.source ?? "=?");
      line = frameLine(frame);
    } else {
      src = "[C]";
    }
    out += "\n\t" + src + ":";
    if (line > 0) out += `${line}:`;
    out += " in " + frameFuncName(L1, idx);
    if (frame.tail) out += "\n\t(...tail calls...)";
  }
  return out;
}

export interface ResumeResult {
  ok: boolean;
  values: Value[];
}

function pendingCallTarget(frame: Frame): {
  dst: number; wanted: number;
} | null {
  const p = frame.cl!.proto;
  const idx = frame.pc - 1;
  if (idx < 0 || idx >= p.code.length) return null;
  const i = p.code[idx];
  const op = i & 0x3f;
  const A = (i >>> 6) & 0xff;
  if (op === OP_CALL) {
    return { dst: frame.base + A, wanted: ((i >>> 14) & 0x1ff) - 1 };
  }
  if (op === OP_TAILCALL) {
    return { dst: frame.base + A, wanted: MULTRET };
  }
  if (op === OP_TFORCALL) {
    return { dst: frame.base + A + 3, wanted: (i >>> 14) & 0x1ff };
  }
  return null;
}

/**
 * resumeState 閳?drive a coroutine until it yields or finishes.
 *
 * Gap handling (PLAN 鎼?): a yield that unwound through native frames leaves
 * them abandoned. On resume we (1) pop natives above the topmost Lua frame,
 * (2) deliver resume args as that frame's pending-call results, wrapping with
 * `true` when the unwound chain bottom was pcall/xpcall (matches observed
 * z8lua pcall-yield semantics), and (3) bridge later returns past abandoned
 * natives down to the real Lua caller.
 */
export function resumeState(co: LuaState, args: Value[]): ResumeResult {
  if (co.status === "dead") {
    return { ok: false, values: ["cannot resume dead coroutine"] };
  }
  // currently inside a resume of this same coroutine (yieldActive set) 閳?  // z8lua: "cannot resume non-suspended coroutine"
  if (co.yieldActive) {
    return { ok: false, values: ["cannot resume non-suspended coroutine"] };
  }
  const wasFresh = co.status === "ok" && co.frames.length === 0;
  co.yieldActive = true;
  const savedStatus = co.status;
  try {
    if (wasFresh) {
      co.stack.push(...args);
      co.top = co.stack.length;
      const done = precall(co, 0, MULTRET);
      if (done) {
        const values = co.stack.slice(0, co.top);
        finishCoroutine(co);
        return { ok: true, values };
      }
      execute(co, 0);
      const values = co.stack.slice(0, co.top);
      finishCoroutine(co);
      return { ok: true, values };
    }

    // resumed after yield: repair frames, deliver args, continue
    repairAfterYield(co, args);
    execute(co, 0);
    const values = co.stack.slice(0, co.top);
    finishCoroutine(co);
    return { ok: true, values };
  } catch (e) {
    co.yieldActive = false;
    if (e instanceof YieldSignal) {
      co.status = "yielded";
      return { ok: true, values: e.values };
    }
    if (e instanceof LuaError) {
      co.status = "dead";
      co.frames.length = 0;
      co.stack.length = 0;
      co.top = 0;
      return { ok: false, values: [e.value] };
    }
    if (e instanceof BudgetSignal) {
      // host converts this into a timelimit error at the tick boundary;
      // the coroutine cannot resume meaningfully past an interrupted run.
      co.status = "dead";
      co.frames.length = 0;
      co.stack.length = 0;
      co.top = 0;
      throw e;
    }
    co.status = savedStatus;
    throw e;
  }
}

function finishCoroutine(co: LuaState): void {
  co.yieldActive = false;
  co.status = "dead";
  co.frames.length = 0;
  // results already gathered by caller; reset stack afterwards
  co.stack.length = 0;
  co.top = 0;
}

function repairAfterYield(co: LuaState, args: Value[]): void {
  // find topmost Lua frame
  let topLua = -1;
  for (let i = co.frames.length - 1; i >= 0; i--) {
    if (co.frames[i].cl !== null) {
      topLua = i;
      break;
    }
  }
  if (topLua === -1) {
    // yield without a Lua frame (e.g. coroutine.yield as the body itself):
    // the resume args become the coroutine's results.
    const n = co.frames.length;
    let target = 0;
    let wanted = MULTRET;
    if (n > 0) {
      target = co.frames[0].func;
      wanted = co.frames[0].nresults;
    }
    co.frames.length = 0;
    poscallResults(co, target, wanted, args);
    return;
  }

  // 1) pop abandoned natives above the topmost Lua frame
  const popped = co.frames.splice(topLua + 1);
  // 2) replay continuations of the unwound native chain (bottom-up, excluding
  //    the yield frame itself which is the top of `popped`): pcall/xpcall
  //    complete as `true, <resume args>` 閳?the observed z8lua semantics.
  let result = args;
  let wrapOk = true;
  for (let i = popped.length - 2; i >= 0; i--) {
    const nf = popped[i];
    if (nf.pcallish) result = [true, ...result];
    else wrapOk = false;
  }
  if (!wrapOk) result = args;

  // 3) deliver to the top Lua frame's pending call
  const frame = co.frames[topLua];
  const target = pendingCallTarget(frame);
  if (target === null) {
    throw new LuaError(
      addInfo(co, "attempt to yield across a C-call boundary"),
      true, null,
    );
  }
  if (target.wanted === MULTRET) {
    for (let i = 0; i < result.length; i++) {
      co.stack[target.dst + i] = result[i];
    }
    co.top = target.dst + result.length;
  } else {
    const take = Math.min(target.wanted, result.length);
    for (let i = 0; i < take; i++) co.stack[target.dst + i] = result[i];
    for (let i = take; i < target.wanted; i++) co.stack[target.dst + i] = null;
    co.top = frame.top;
  }

  // 4) natives between this frame and the Lua frame below it: mark abandoned
  //    and bridge this frame's eventual return to the real call site.
  let j = topLua - 1;
  let anyMarked = false;
  let allPcallish = true;
  while (j >= 0 && co.frames[j].cl === null && !co.frames[j].abandoned) {
    co.frames[j].abandoned = true;
    if (!co.frames[j].pcallish) allPcallish = false;
    anyMarked = true;
    j--;
  }
  if (anyMarked && j >= 0 && co.frames[j].cl !== null) {
    const luaNext = co.frames[j];
    const t = pendingCallTarget(luaNext);
    if (t !== null) {
      frame.bridge = {
        dst: t.dst, wanted: t.wanted, nextTop: luaNext.top,
        wrap: allPcallish,
      };
    }
  }
}
