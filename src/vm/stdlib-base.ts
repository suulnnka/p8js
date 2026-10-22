// Lua 5.2 base + coroutine + table + debug(2 functions) + eris(stub) libraries.
// Port of lbaselib.c / lcorolib.c / ltablib.c / ldblib.c with z8lua's PICO-8
// divergences (type() of a missing arg returns nothing; pairs(nil) yields an
// empty iterator; no LUA_COMPAT_* globals — no unpack/loadstring/table.maxn/
// global pack, all verified against the native z8lua binary).

import { LuaError, YieldSignal } from "./errors.ts";
import { MULTRET, LuaState } from "./state.ts";
import {
  Closure, Table, isFalse, isCallable, typeOf,
  type NativeFn, type Value,
} from "./value.ts";
import * as fx from "./fix32.ts";
import {
  abortCall, argError, beginCall, callFunction, chunkClosure,
  invokeNoCleanup, ltValues, luaLError, rawEqual, resumeState, runtimeError,
  toNumber, tostringValue, tracebackString, typeErrorArg, where,
} from "./interp.ts";
import {
  checkAny, checkInt, checkNumber, checkString, checkTable, hasArg,
  isNoneOrNil, optInt, optString,
} from "./auxlib.ts";
import { undump } from "./undump.ts";
import { installPico8 } from "./stdlib-pico8.ts";
import { makeStringLib } from "./stdlib-string.ts";

export const LUA_VERSION_STR = "Lua+Eris 5.2";

function getMetafield(v: Value, event: string): Value | null {
  if (v instanceof Table && v.metatable !== null) return v.metatable.get(event);
  return null;
}

const isLuaFn = (v: Value): boolean =>
  v instanceof Closure || typeof v === "function";

function latin1Bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// ---------------------------------------------------------------------------
// base library

function makeBaseLib(write: (s: string) => void): [string, NativeFn][] {
  const luaB_print: NativeFn = (S, args) => {
    const ts = S.globals.get("tostring");
    let out = "";
    for (let i = 0; i < args.length; i++) {
      const r = ts === null
        ? [tostringValue(S, args[i])]
        : callFunction(S, ts, [args[i]]);
      const s = r.length > 0 ? r[0] : null;
      if (typeof s !== "string") {
        luaLError(S, "'tostring' must return a string to 'print'");
      }
      if (i > 0) out += "\t";
      out += s;
    }
    write(out + "\n");
    return [];
  };

  const luaB_tonumber: NativeFn = (S, args) => {
    if (isNoneOrNil(args, 2)) {
      const v = args[0];
      if (typeof v === "number") return [v];
      if (typeof v === "string") {
        const n = fx.strToNum(v);
        if (n !== null) return [n];
      }
      checkAny(S, args, 1);
      return [null];
    }
    // with explicit base
    const s = checkString(S, args, 1);
    const base = checkInt(S, args, 2);
    if (base < 2 || base > 36) argError(S, 2, "base out of range");
    let i = 0;
    while (i < s.length && isSpaceByte(s[i])) i++;
    let neg = false;
    if (s[i] === "-") { neg = true; i++; }
    else if (s[i] === "+") i++;
    const isAlnum = (c: string): boolean =>
      (c >= "0" && c <= "9") || (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z");
    if (i < s.length && isAlnum(s[i])) {
      let n = 0;
      do {
        const c = s[i];
        const d = c >= "0" && c <= "9"
          ? c.charCodeAt(0) - 48
          : c.toUpperCase().charCodeAt(0) - 65 + 10;
        if (d >= base) break;
        n = fx.add(fx.mul(n, fx.fromInt(base)), fx.fromInt(d));
        i++;
      } while (i < s.length && isAlnum(s[i]));
      while (i < s.length && isSpaceByte(s[i])) i++;
      if (i === s.length) return [neg ? fx.neg(n) : n];
    }
    return [null];
  };

  const luaB_error: NativeFn = (S, args) => {
    const level = optInt(S, args, 2, 1);
    const v: Value = hasArg(args, 1) ? args[0] : null;
    if (typeof v === "string" && level > 0) {
      const full = where(S, level) + v;
      throw new LuaError(full, true, null, full);
    }
    if (typeof v === "string") throw new LuaError(v, true, null, v);
    // non-string error values are thrown as-is; message is only for JS logs
    throw new LuaError(String(tostringValue(S, v)), true, null, v);
  };

  const luaB_getmetatable: NativeFn = (S, args) => {
    checkAny(S, args, 1);
    const v = args[0];
    let mt: Table | null | undefined;
    if (typeof v === "string") {
      const sm = S.registry.get("STRING_META");
      mt = sm instanceof Table ? sm : null;
    } else if (v instanceof Table) {
      mt = v.metatable;
    } else {
      return [null];
    }
    if (mt === null || mt === undefined) return [null];
    const prot = mt.get("__metatable");
    return [prot !== null ? prot : mt];
  };

  const luaB_setmetatable: NativeFn = (S, args) => {
    const t = args[1];
    if (!(args[0] instanceof Table)) typeErrorArg(S, args, 1, "table");
    if (!(t === null || t instanceof Table)) {
      argError(S, 2, "nil or table expected");
    }
    const mt = args[0] as Table;
    if (getMetafield(mt, "__metatable") !== null) {
      luaLError(S, "cannot change a protected metatable");
    }
    mt.metatable = t;
    return [args[0]];
  };

  const luaB_rawequal: NativeFn = (S, args) => {
    checkAny(S, args, 1);
    checkAny(S, args, 2);
    return [rawEqual(args[0], args[1])];
  };

  const luaB_rawlen: NativeFn = (S, args) => {
    const v = args[0];
    if (v instanceof Table) return [fx.fromInt(v.length())];
    if (typeof v === "string") return [fx.fromInt(v.length)];
    argError(S, 1, "table or string expected");
  };

  const luaB_rawget: NativeFn = (S, args) => {
    const t = checkTable(S, args, 1);
    checkAny(S, args, 2);
    return [t.get(args[1])];
  };

  const luaB_rawset: NativeFn = (S, args) => {
    const t = checkTable(S, args, 1);
    checkAny(S, args, 2);
    checkAny(S, args, 3);
    if (args[1] === null) runtimeError(S, "table index is nil");
    t.set(args[1], args[2]);
    return [t];
  };

  const luaB_collectgarbage: NativeFn = (S, args) => {
    const opt = optString(S, args, 1, "collect") ?? "collect";
    switch (opt) {
      case "count": return [fx.fromInt(0), fx.fromInt(0)];
      case "step": case "isrunning": return [true];
      case "stop": case "restart": case "collect": case "setpause":
      case "setstepmul": case "setmajorinc": case "generational":
      case "incremental":
        return [fx.fromInt(0)];
      default:
        argError(S, 1, "invalid option");
    }
  };

  const luaB_type: NativeFn = (_S, args) => {
    // PICO-8: type() of a missing argument returns nothing (no error)
    if (!hasArg(args, 1)) return [];
    return [typeOf(args[0])];
  };

  const emptyFn: NativeFn = () => [];

  const luaB_next: NativeFn = (S, args) => {
    const t = checkTable(S, args, 1);
    const key = args.length >= 2 ? args[1] : null;
    const e = nextEntry(S, t, key);
    if (e === null) return [null];
    return [e[0], e[1]];
  };

  function pairsmeta(
    S: LuaState, args: Value[], method: string, iszero: boolean,
    iter: NativeFn,
  ): Value[] {
    // PICO-8 0.2.0: pairs(nil) returns an empty function
    if (args[0] === null) return [emptyFn];
    const tm = getMetafield(args[0], method);
    if (tm === null) {
      if (!(args[0] instanceof Table)) typeErrorArg(S, args, 1, "table");
      return [iter, args[0], iszero ? fx.fromInt(0) : null];
    }
    return callFunction(S, tm, [args[0]]); // 3 values (padded with nil)
  }

  const luaB_pairs: NativeFn = (S, args) =>
    pairsmeta(S, args, "__pairs", false, luaB_next);

  const ipairsaux: NativeFn = (S, args) => {
    const i = checkInt(S, args, 2); // plain int (luaL_checkint)
    const t = checkTable(S, args, 1);
    const j = fx.fromInt(i + 1); // back to fix32 for the raw key
    const v = t.get(j);
    if (v === null) return [null];
    return [j, v];
  };

  const luaB_ipairs: NativeFn = (S, args) =>
    pairsmeta(S, args, "__ipairs", true, ipairsaux);

  const luaB_assert: NativeFn = (S, args) => {
    if (isFalse(args[0])) {
      const msg = optString(S, args, 2, "assertion failed!");
      luaLError(S, msg ?? "assertion failed!");
    }
    return args;
  };

  const luaB_select: NativeFn = (S, args) => {
    const n = args.length;
    const first = args[0];
    if (typeof first === "string" && first.charCodeAt(0) === 35 /* # */) {
      return [fx.fromInt(n - 1)];
    }
    let idx = checkInt(S, args, 1);
    if (idx < 0) idx = n + idx;
    else if (idx > n) idx = n;
    if (idx < 1) argError(S, 1, "index out of range");
    return args.slice(idx);
  };

  const luaB_pcall: NativeFn = (S, args) => {
    checkAny(S, args, 1);
    markPcallish(S);
    const site = beginCall(S);
    try {
      const res = invokeNoCleanup(S, site, args[0], args.slice(1));
      return [true, ...res];
    } catch (e) {
      if (e instanceof LuaError) {
        abortCall(S, site);
        return [false, e.value];
      }
      throw e; // YieldSignal / BudgetSignal pass through
    }
  };

  const luaB_xpcall: NativeFn = (S, args) => {
    if (args.length < 2) argError(S, 2, "value expected");
    markPcallish(S);
    const site = beginCall(S);
    try {
      const res = invokeNoCleanup(S, site, args[0], args.slice(2));
      return [true, ...res];
    } catch (e) {
      if (e instanceof LuaError) {
        const handler = args[1];
        if (!isLuaFn(handler)) {
          // errfunc slot set but not a function → LUA_ERRERR
          abortCall(S, site);
          return [false, "error in error handling"];
        }
        // handler runs BEFORE unwinding — its traceback must see the
        // failing frames (z8lua calls it from luaG_errormsg pre-restore)
        try {
          const hr = callFunction(S, handler, [e.value]);
          abortCall(S, site);
          return [false, hr.length > 0 ? hr[0] : null];
        } catch (e2) {
          if (e2 instanceof LuaError) {
            abortCall(S, site);
            return [false, "error in error handling"];
          }
          throw e2;
        }
      }
      throw e;
    }
  };

  const luaB_tostring: NativeFn = (S, args) => {
    checkAny(S, args, 1);
    return [tostringValue(S, args[0])];
  };

  const luaB_load: NativeFn = (S, args) => doLoad(S, args);

  const luaB_loadfile: NativeFn = (S, args) => {
    const name = optString(S, args, 1, null);
    return [null, `${name ?? "?"}: cannot open`];
  };

  const luaB_dofile: NativeFn = (S, args) => {
    const name = optString(S, args, 1, null);
    luaLError(S, `${name ?? "?"}: cannot open`);
  };

  return [
    ["assert", luaB_assert],
    ["collectgarbage", luaB_collectgarbage],
    ["dofile", luaB_dofile],
    ["error", luaB_error],
    ["getmetatable", luaB_getmetatable],
    ["ipairs", luaB_ipairs],
    ["loadfile", luaB_loadfile],
    ["load", luaB_load],
    ["next", luaB_next],
    ["pairs", luaB_pairs],
    ["pcall", luaB_pcall],
    ["print", luaB_print],
    ["rawequal", luaB_rawequal],
    ["rawlen", luaB_rawlen],
    ["rawget", luaB_rawget],
    ["rawset", luaB_rawset],
    ["select", luaB_select],
    ["setmetatable", luaB_setmetatable],
    ["tonumber", luaB_tonumber],
    ["tostring", luaB_tostring],
    ["type", luaB_type],
    ["xpcall", luaB_xpcall],
  ];
}

function markPcallish(S: LuaState): void {
  const self = S.frames[S.frames.length - 1];
  if (self && self.cl === null) self.pcallish = true;
}

function isSpaceByte(c: string): boolean {
  return c === " " || c === "\f" || c === "\n" || c === "\r" ||
    c === "\t" || c === "\v";
}

function nextEntry(
  L: LuaState, t: Table, key: Value,
): [Value, Value] | null {
  if (key === null) {
    const e = t.map.entries().next();
    return e.done ? null : [e.value[0], e.value[1]];
  }
  let seen = false;
  for (const [k, v] of t.map) {
    if (seen) return [k, v];
    if (rawEqual(k, key)) seen = true;
  }
  if (seen) return null; // was the last entry
  // key not present (value.ts documents the deleted-array-key latitude gap)
  runtimeError(L, "invalid key to 'next'");
}

function doLoad(S: LuaState, args: Value[]): Value[] {
  const chunk = args[0];
  const env = hasArg(args, 4) ? args[3] : undefined;
  let data: Uint8Array;
  let defaultName: string;
  if (typeof chunk === "string") {
    data = latin1Bytes(chunk);
    defaultName = chunk;
  } else if (isLuaFn(chunk)) {
    const parts: string[] = [];
    // Reader-phase errors are caught by lua_load's protected parser on the
    // native side: load returns (nil, msg) instead of raising.
    try {
      for (;;) {
        const r = callFunction(S, chunk, []);
        const v = r.length > 0 ? r[0] : null;
        if (v === null) break;
        if (typeof v !== "string") {
          return [null, "reader function must return a string"];
        }
        parts.push(v);
      }
    } catch (e) {
      if (e instanceof LuaError) return [null, e.fullMessage()];
      throw e;
    }
    data = latin1Bytes(parts.join(""));
    defaultName = "=(load)";
  } else {
    typeErrorArg(S, args, 1, "function");
  }
  const name = optString(S, args, 2, defaultName) ?? defaultName;
  const mode = optString(S, args, 3, "bt") ?? "bt";
  if (data.length === 0 || data[0] !== 0x1b) {
    // text chunk: this VM has no source parser (PLAN §9). Match checkmode's
    // message shape for the first mode character that would apply.
    if (mode.indexOf("t") < 0) {
      return [null, `attempt to load a text chunk (mode is '${mode[0]}')`];
    }
    return [null, `attempt to load a text chunk (mode is '${mode}')`];
  }
  if (mode.indexOf("b") < 0) {
    return [null, `attempt to load a binary chunk (mode is '${mode}')`];
  }
  try {
    const proto = undump(data, name);
    const target = env instanceof Table ? env : S.globals;
    const cl = chunkClosure(S, proto, target);
    if (env !== undefined && !(env instanceof Table)) cl.upvals[0].set(env);
    return [cl];
  } catch (e) {
    return [null, e instanceof Error ? e.message : String(e)];
  }
}

// ---------------------------------------------------------------------------
// coroutine library

function makeCoroutineLib(): [string, NativeFn][] {
  const luaB_cocreate: NativeFn = (S, args) => {
    const f = args[0];
    if (!isLuaFn(f)) typeErrorArg(S, args, 1, "function");
    const co = new LuaState(undefined, S);
    co.stack.push(f);
    co.top = 1;
    return [co];
  };

  const luaB_coresume: NativeFn = (S, args) => {
    const co = args[0];
    if (!(co instanceof LuaState)) argError(S, 1, "coroutine expected");
    const r = resumeState(co, args.slice(1));
    if (r.ok) return [true, ...r.values];
    return [false, r.values[0] ?? null];
  };

  const luaB_cowrap: NativeFn = (S, args) => {
    const create = luaB_cocreate(S, args);
    const co = create[0] as LuaState;
    const wrapped: NativeFn = (S2,wargs) => {
      const r = resumeState(co, wargs);
      if (!r.ok) {
        const v = r.values[0] ?? null;
        if (typeof v === "string") {
          const full = where(S2, 1) + v;
          throw new LuaError(full, true, null, full);
        }
        throw new LuaError(
          String(tostringValue(S2, v)), true, null, v,
        );
      }
      return r.values;
    };
    return [wrapped];
  };

  const luaB_yield: NativeFn = (S, args) => {
    if (!S.yieldActive) {
      runtimeError(
        S,
        S.isMain
          ? "attempt to yield from outside a coroutine"
          : "attempt to yield across a C-call boundary",
      );
    }
    throw new YieldSignal(args);
  };

  const luaB_costatus: NativeFn = (S, args) => {
    const co = args[0];
    if (!(co instanceof LuaState)) argError(S, 1, "coroutine expected");
    if (co === S) return ["running"];
    switch (co.status) {
      case "yielded": return ["suspended"];
      case "dead": return ["dead"];
      case "ok":
        if (co.frames.length > 0) return ["normal"];
        if (co.stack.length > 0) return ["suspended"];
        return ["dead"];
    }
  };

  const luaB_corunning: NativeFn = (S) => [S, S.isMain];

  return [
    ["create", luaB_cocreate],
    ["resume", luaB_coresume],
    ["running", luaB_corunning],
    ["status", luaB_costatus],
    ["wrap", luaB_cowrap],
    ["yield", luaB_yield],
  ];
}

// ---------------------------------------------------------------------------
// table library (ltablib.c)

function makeTableLib(): [string, NativeFn][] {
  const auxGetn = (L: LuaState, args: Value[]): number =>
    checkTable(L, args, 1).length();

  const tinsert: NativeFn = (L, args) => {
    const t = checkTable(L, args, 1);
    const e = fx.add(fx.fromInt(auxGetn(L, args)), fx.fromInt(1));
    if (args.length === 2) {
      t.set(e, args[1]);
      return [];
    }
    if (args.length === 3) {
      let pos = checkInt(L, args, 2);
      const eInt = fx.toInt(e);
      if (pos < 1 || pos > eInt) argError(L, 2, "position out of bounds");
      for (let i = eInt; i > pos; i--) {
        t.set(fx.fromInt(i), t.get(fx.fromInt(i - 1)));
      }
      t.set(fx.fromInt(pos), args[2]);
      return [];
    }
    luaLError(L, "wrong number of arguments to 'insert'");
  };

  const tremove: NativeFn = (L, args) => {
    const t = checkTable(L, args, 1);
    const size = auxGetn(L, args);
    let pos = optInt(L, args, 2, size);
    if (pos !== size && (pos < 1 || pos > size + 1)) {
      argError(L, 1, "position out of bounds");
    }
    const res = t.get(fx.fromInt(pos));
    for (; pos < size; pos++) {
      t.set(fx.fromInt(pos), t.get(fx.fromInt(pos + 1)));
    }
    t.set(fx.fromInt(pos), null);
    return [res];
  };

  function addfield(L: LuaState, t: Table, i: number): string {
    const v = t.get(fx.fromInt(i));
    if (typeof v === "string") return v;
    if (typeof v === "number") return fx.numToString(v);
    luaLError(
      L,
      `invalid value (${typeOf(v)}) at index ${i} in table for 'concat'`,
    );
  }

  const tconcat: NativeFn = (L, args) => {
    const sep = optString(L, args, 2, "") ?? "";
    const t = checkTable(L, args, 1);
    let i = optInt(L, args, 3, 1);
    const last = optInt(L, args, 4, t.length());
    let out = "";
    for (; i < last; i++) out += addfield(L, t, i) + sep;
    if (i === last) out += addfield(L, t, i);
    return [out];
  };

  const pack: NativeFn = (L, args) => {
    const t = new Table();
    const n = args.length;
    t.arraySize = n; // lua_createtable(n, 1) → array part of size n
    for (let i = 0; i < n; i++) t.set(fx.fromInt(i + 1), args[i]);
    t.set("n", fx.fromInt(n));
    return [t];
  };

  const unpack: NativeFn = (L, args) => {
    const t = checkTable(L, args, 1);
    const i = optInt(L, args, 2, 1);
    const e = optInt(L, args, 3, t.length());
    if (i > e) return [];
    const out: Value[] = [];
    for (let j = i; j <= e; j++) out.push(t.get(fx.fromInt(j)));
    return out;
  };

  function sortComp(
    L: LuaState, comp: Value, a: Value, b: Value,
  ): boolean {
    if (comp !== null && comp !== undefined) {
      const r = callFunction(L, comp, [a, b]);
      return !isFalse(r.length > 0 ? r[0] : null);
    }
    return ltValues(L, a, b);
  }

  function auxsort(
    L: LuaState, t: Table, comp: Value, l: number, u: number,
  ): void {
    const get = (i: number): Value => t.get(fx.fromInt(i));
    const set = (i: number, v: Value): void => t.set(fx.fromInt(i), v);
    while (l < u) {
      // order a[l] and a[u]
      let vl = get(l);
      let vu = get(u);
      if (sortComp(L, comp, vu, vl)) {
        set(l, vu);
        set(u, vl);
      }
      if (u - l === 1) break;
      const i = (l + u) >> 1;
      // order a[i] between them
      let vi = get(i);
      vl = get(l);
      if (sortComp(L, comp, vi, vl)) {
        set(i, vl);
        set(l, vi);
      } else {
        vu = get(u);
        if (sortComp(L, comp, vu, vi)) {
          set(i, vu);
          set(u, vi);
        }
      }
      if (u - l === 2) break;
      // pivot P = a[i]; swap a[i] with a[u-1]
      const P = get(i);
      const vu1 = get(u - 1);
      set(i, vu1);
      set(u - 1, P);
      // partition (scan from l+1 .. u-2)
      let ii = l;
      let jj = u - 1;
      for (;;) {
        let vii: Value;
        for (;;) {
          ii++;
          vii = get(ii);
          if (!sortComp(L, comp, vii, P)) break;
          if (ii >= u) luaLError(L, "invalid order function for sorting");
        }
        let vjj: Value;
        for (;;) {
          jj--;
          vjj = get(jj);
          if (!sortComp(L, comp, P, vjj)) break;
          if (jj <= l) luaLError(L, "invalid order function for sorting");
        }
        if (jj < ii) break;
        set(ii, vjj);
        set(jj, vii);
      }
      // place pivot at position ii
      const vuNow = get(u - 1);
      const viNow = get(ii);
      set(u - 1, viNow);
      set(ii, vuNow);
      // recurse into the smaller half
      if (i - l < u - i) {
        auxsort(L, t, comp, l, ii - 1);
        l = ii + 1;
      } else {
        auxsort(L, t, comp, ii + 1, u);
        u = ii - 1;
      }
    }
  }

  const sort: NativeFn = (L, args) => {
    const n = auxGetn(L, args);
    let comp: Value = null;
    if (!isNoneOrNil(args, 2)) {
      if (!isLuaFn(args[1])) typeErrorArg(L, args, 2, "function");
      comp = args[1];
    }
    auxsort(L, args[0] as Table, comp, 1, n);
    return [];
  };

  return [
    ["concat", tconcat],
    ["insert", tinsert],
    ["pack", pack],
    ["unpack", unpack],
    ["remove", tremove],
    ["sort", sort],
  ];
}

// ---------------------------------------------------------------------------
// debug library (bios needs only getregistry + traceback)

function makeDebugLib(): [string, NativeFn][] {
  const getregistry: NativeFn = (S) => [S.registry];

  const traceback: NativeFn = (S, args) => {
    // debug.traceback([thread,] [msg [, level]]) — args are 0-based here;
    // z8lua's `arg + 1` (1-based) maps to args[arg0].
    let arg0 = 0;
    let L1: LuaState = S;
    if (args[0] instanceof LuaState) {
      L1 = args[0];
      arg0 = 1;
    }
    const msgVal = args[arg0];
    // lua_tostring converts numbers; other non-string values pass through
    let msg: string | null;
    if (msgVal === undefined || msgVal === null) msg = null;
    else if (typeof msgVal === "string") msg = msgVal;
    else if (typeof msgVal === "number") msg = fx.numToString(msgVal);
    else return [msgVal]; // non-string msg returned untouched
    let level: number;
    const lv = args[arg0 + 1];
    if (lv !== undefined && lv !== null) {
      const n = toNumber(lv);
      level = n === undefined ? (L1 === S ? 1 : 0) : fx.toInt(n);
    } else {
      level = L1 === S ? 1 : 0;
    }
    return [tracebackString(L1, msg, level)];
  };

  return [
    ["getregistry", getregistry],
    ["traceback", traceback],
  ];
}

export { tracebackString };

// ---------------------------------------------------------------------------
// eris stub (bios indexes `eris` at load time; persistence is out of scope —
// PLAN §9 "明确不做" eris state serialization)

function makeErisLib(): [string, NativeFn][] {
  const unsupported = (L: LuaState, name: string): never =>
    luaLError(L, `eris.${name} is not supported by p8js`);
  return [
    ["persist", (L) => unsupported(L, "persist")],
    ["unpersist", (L) => unsupported(L, "unpersist")],
    ["settings", () => []],
  ];
}

// ---------------------------------------------------------------------------
// assembly

export interface OpenLibsOptions {
  /** print writer; defaults to console.log */
  print?: (s: string) => void;
}

/** Populate `L.globals` with the standard library set (luaL_openlibs). */
export function openLibs(L: LuaState, opts: OpenLibsOptions = {}): void {
  const write = opts.print ?? ((s: string) => {
    // eslint-disable-next-line no-console
    console.log(s.endsWith("\n") ? s.slice(0, -1) : s);
  });

  // _G self-reference first
  L.globals.set("_G", L.globals);

  for (const [name, fn] of makeBaseLib(write)) L.globals.set(name, fn);
  L.globals.set("_VERSION", LUA_VERSION_STR);

  // pico8 functions join _G (luaopen_pico8 writes into the global table)
  installPico8(L);

  const coroutine = new Table();
  for (const [name, fn] of makeCoroutineLib()) coroutine.set(name, fn);
  L.globals.set("coroutine", coroutine);

  const table = new Table();
  for (const [name, fn] of makeTableLib()) table.set(name, fn);
  L.globals.set("table", table);

  const string = new Table();
  for (const [name, fn] of makeStringLib()) string.set(name, fn);
  L.globals.set("string", string);
  // createmetatable (lstrlib.c): shared metatable for all strings with
  // __index = the string library (kept for fidelity; z8lua's gettable
  // string-path hijack means __index is unreachable through `s[k]`).
  const stringMeta = new Table();
  stringMeta.set("__index", string);
  L.registry.set("STRING_META", stringMeta);

  const debug = new Table();
  for (const [name, fn] of makeDebugLib()) debug.set(name, fn);
  L.globals.set("debug", debug);

  const eris = new Table();
  for (const [name, fn] of makeErisLib()) eris.set(name, fn);
  L.globals.set("eris", eris);
}

// register PICO-8 functions (called by openlibs after stdlib-pico8 exists)
export function installInto(
  target: Table, entries: [string, NativeFn][],
): void {
  for (const [name, fn] of entries) target.set(name, fn);
}

export { makeBaseLib, makeCoroutineLib, makeTableLib, makeDebugLib, makeErisLib };
