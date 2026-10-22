// VM containers: one LuaState per Lua thread (main thread + each coroutine);
// globals + registry shared by reference across threads.

import type { Proto } from "./undump.ts";
import { Table, Closure, UpVal, type Value, type NativeFn } from "./value.ts";

/** LUA_MULTRET — caller wants however many results arrive. */
export const MULTRET = -1;

export interface Frame {
  /** null for native frames */
  cl: Closure | null;
  /** set for native frames (null/undefined for Lua frames) */
  native?: NativeFn;
  /** stack index of this frame's function slot (vararg math uses func+1). */
  func: number;
  /** register window start: func + 1 + (varargs …) + numparams layout per ldo.c */
  base: number;
  /** index of the next instruction to run */
  pc: number;
  /** fixed register end (base + proto.maxstacksize) — restored after open calls */
  top: number;
  /** results the *caller* asked for; MULTRET = all */
  nresults: number;
  /**
   * Dead native frame left behind by a yield that unwound through it; the
   * execute loop pops these on sight (see PLAN §8 gap: yield across natives).
   */
  abandoned?: boolean;
  /**
   * Set by pcall/xpcall natives on their own frame: if a yield unwinds
   * through them, resume wraps the resume-args with `true` to reproduce
   * z8lua's pcall-across-yield continuation semantics.
   */
  pcallish?: boolean;
  /**
   * Set on a Lua frame whose real caller was separated from it by abandoned
   * native frames: its results must be delivered to `dst` (stack index) with
   * `wanted` results instead of its own func slot. `wrap` re-applies the
   * pcall `true, ...` continuation when the abandoned chain was all pcalls.
   */
  bridge?: {
    dst: number;
    wanted: number;
    nextTop: number;
    wrap: boolean;
  };
  /** set when this frame was created by OP_TAILCALL (CIST_TAIL) */
  tail?: boolean;
}

export type ThreadStatus = "ok" | "yielded" | "dead";

export class LuaState {
  /** shared operand stack; registers are stack[base .. base+maxstacksize) */
  stack: Value[] = [];
  frames: Frame[] = [];
  globals: Table;
  /** registry table (LUA_REGISTRYINDEX) — shared across threads */
  registry: Table;
  /** open upvalues, any order; closed ones are removed by closeUpvals(). */
  openUpvals: UpVal[] = [];
  /** 64KB PICO-8 memory for PEEK/PEEK2/PEEK4 (set by the emulator core) */
  pico8memory: Uint8Array | null = null;
  /** instruction budget for the current tick; 0 = unlimited */
  budget = 0;
  /** current stack top (mirrors L->top in ldo.c/lvm.c) */
  top = 0;
  /** coroutine lifecycle (main thread stays "ok" and never resumes) */
  status: ThreadStatus = "ok";
  /** true while driven by resumeState — yield outside this = error */
  yieldActive = false;
  readonly isMain: boolean;

  constructor(globals?: Table, shareFrom?: LuaState) {
    this.globals = globals ?? shareFrom?.globals ?? new Table();
    this.registry = shareFrom?.registry ?? new Table();
    this.pico8memory = shareFrom?.pico8memory ?? null;
    this.isMain = shareFrom === undefined;
  }

  /** luaF_findupval: reuse an open UpVal already covering this slot. */
  findUpval(slot: number): UpVal {
    for (const uv of this.openUpvals) {
      if (uv.slot === slot) return uv;
    }
    const uv = new UpVal(this.stack, slot);
    this.openUpvals.push(uv);
    return uv;
  }

  /** luaF_close: close every open upvalue at or above `slot`. */
  closeUpvals(slot: number): void {
    if (this.openUpvals.length === 0) return;
    const keep: UpVal[] = [];
    for (const uv of this.openUpvals) {
      if (uv.slot !== null && uv.slot >= slot) uv.close();
      else keep.push(uv);
    }
    this.openUpvals = keep;
  }
}

/** Fresh closure for a proto with upvalues bound per Upvaldesc (OP_CLOSURE).
 *  Mirrors lvm.c getcached/pushclosure: a cached closure whose upvalues all
 *  match is reused (Lua 5.2 — same-prototype closures often identity-equal). */
export function makeClosure(
  L: LuaState,
  proto: Proto,
  enclosing: Closure | null,
  base: number,
): Closure {
  const ups: UpVal[] = [];
  for (const uv of proto.upvalues) {
    if (uv.instack) ups.push(L.findUpval(base + uv.idx));
    else {
      if (!enclosing) throw new Error("upvalue outside enclosing closure");
      ups.push(enclosing.upvals[uv.idx]);
    }
  }
  const cached = proto.cache as Closure | undefined;
  if (cached !== undefined && cached.upvals.length === ups.length) {
    let match = true;
    for (let i = 0; i < ups.length; i++) {
      if (cached.upvals[i] !== ups[i]) {
        match = false;
        break;
      }
    }
    if (match) return cached;
  }
  const cl = new Closure(proto, ups);
  proto.cache = cl;
  return cl;
}
