// Runtime value model for the TS z8lua VM.
//
// Conventions (PLAN §4.3):
//  - nil        → null          (never `undefined` as a Lua value)
//  - boolean    → boolean
//  - number     → int32 fix32 bit pattern (see fix32.ts)
//  - string     → JS string of code units 0–255 (byte semantics; JS ===
//                 is Lua string equality, no interning needed)
//  - table      → Table
//  - function   → Closure (Lua) | NativeFn (C/host)

import type { Proto } from "./undump.ts";
import type { LuaState } from "./state.ts";

export type Value =
  | null
  | boolean
  | number
  | string
  | Table
  | Closure
  | LuaState
  | NativeFn;

export type NativeFn = (L: LuaState, args: Value[]) => Value[];

function luaTypeof(v: Value): string {
  if (v === null) return "nil";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "function") return "function"; // NativeFn
  const c = v as { proto?: Proto; frames?: unknown[] };
  if (c.proto !== undefined) return "function"; // Closure
  if (Array.isArray(c.frames)) return "thread"; // LuaState (coroutine)
  return "table";
}
export { luaTypeof as typeOf };

/** Lua falsiness. NOTE: `undefined` (our "none" slot) behaves like nil —
 *  z8lua's index2addr returns the nil object for out-of-range C-function
 *  indices, so `assert()` with no arguments fails with "assertion failed!". */
export const isFalse = (v: Value): boolean =>
  v === null || v === false || v === undefined;

/** true for anything callable: Lua closures and native functions. */
export const isCallable = (v: Value): v is Closure | NativeFn =>
  typeof v === "function" || (v instanceof Closure);

// ---------------------------------------------------------------------------
// Upvalues: open = box on the shared stack; closed = private copy.

export class UpVal {
  private closed: Value = null;
  constructor(
    readonly stack: Value[],
    public slot: number | null, // null ⇒ closed
  ) {}

  get(): Value {
    return this.slot === null ? this.closed : this.stack[this.slot];
  }
  set(v: Value): void {
    if (this.slot === null) this.closed = v;
    else this.stack[this.slot] = v;
  }
  close(): void {
    if (this.slot !== null) {
      this.closed = this.stack[this.slot];
      this.slot = null;
    }
  }
  get isOpen(): boolean {
    return this.slot !== null;
  }
}

export class Closure {
  constructor(
    readonly proto: Proto,
    readonly upvals: UpVal[],
  ) {}
}

// ---------------------------------------------------------------------------
// Table: Map-backed. JS Map keeps insertion order (matches Lua's "any border/
// any order" latitude for pairs(); native hash order may differ — documented
// gap, see tests/differential corpus notes).

export class Table {
  map = new Map<Value, Value>();
  metatable: Table | null = null;
  /**
   * z8lua's `sizearray` — the array-part capacity (luaH_resize/SETLIST).
   * Affects `#t` exactly like ltable.c luaH_getn (see length()).
   */
  arraySize = 0;

  get(key: Value): Value {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  /** Raw set (no metamethods). nil value deletes. */
  set(key: Value, value: Value): void {
    if (key === null) throw new Error("table index is nil");
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
  }
  has(key: Value): boolean {
    return this.map.has(key);
  }

  /** integer key i (1-based) as the fix32 bit pattern */
  private at(i: number): Value {
    return this.get((i << 16) | 0);
  }

  /** true when no keys live "outside" the array range 1..arraySize
   *  (z8lua: isdummy(node) — the hash part is empty). */
  private hashEmpty(): boolean {
    const j = this.arraySize;
    for (const k of this.map.keys()) {
      if (typeof k !== "number") return false; // string/table/… keys → hash
      const bits = k | 0;
      if (bits <= 0 || (bits & 0xffff) !== 0) return false; // non-int / ≤0
      const i = bits >> 16;
      if (i > j || i < 1) return false;
    }
    return true;
  }

  /** Lua length operator: a border of the sequence 1..n — exact port of
   *  z8lua ltable.c luaH_getn (array-part binary search + unbound_search).
   *  NOTE: keys wrap at 32768 like fix32 (arrays > 32767 are outside PICO-8
   *  cart practice — documented gap). */
  length(): number {
    let j = this.arraySize;
    if (j > 0 && this.at(j) === null) {
      // boundary inside the array part: binary search (i=0, j=sizearray)
      let i = 0;
      while (j - i > 1) {
        const m = (i + j) >> 1;
        if (this.at(m) === null) j = m;
        else i = m;
      }
      return i;
    }
    // array part's last slot is occupied (or arraySize == 0)
    if (this.hashEmpty()) return j;
    return this.unboundSearch(j);
  }

  private unboundSearch(j: number): number {
    let i = j;
    j++;
    while (this.at(j) !== null) {
      i = j;
      if (j > 0x20000000) {
        // (z8lua: guard against overflow — return the binary result)
        break;
      }
      j *= 2;
    }
    while (j - i > 1) {
      const m = Math.floor((i + j) / 2);
      if (this.at(m) === null) j = m;
      else i = m;
    }
    return i;
  }
}
