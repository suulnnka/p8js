// PICO-8 Lua API bindings — port of fake-08 picoluaapi.cpp (call-shape logic
// per function; file:line noted). Registered into the VM globals by
// installApi(); host-side hooks (frame count, run/load requests, button scan)
// live on ApiHost so the emulator core stays in control of the frame loop.

import type { LuaState } from "../vm/state.ts";
import { Table, type NativeFn, type Value } from "../vm/value.ts";
import * as fx from "../vm/fix32.ts";
import { luaLError } from "../vm/interp.ts";
import { PicoMemory, DRAW, HW, ADDR, ROM_SIZE } from "./memory.ts";
import { Graphics } from "./graphics.ts";
import { Input, type HostInputState } from "./input.ts";

// ---------------------------------------------------------------------------
// value coercion (z8lua: lua_tonumber / lua_tointeger C semantics)

/** lua_tonumber: numbers convert, numeric strings parse, everything → 0. */
export function luaNum(v: Value | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return fx.strToNum(v) ?? 0;
  return 0;
}

/** `int x = lua_tonumber(...)` — double truncation toward zero (picoluaapi). */
export const cint = (v: Value | undefined): number =>
  Math.trunc(fx.toDouble(luaNum(v)));

/** (uint8_t) cast of a fix32 — low 8 bits of the integer part. */
export const u8 = (v: Value | undefined): number => cint(v) & 0xff;

/** (int16_t) cast. */
export const i16 = (v: Value | undefined): number => (cint(v) << 16) >> 16;

/** (uint16_t)lua_tointeger — toInt then wrap 16 bits (peek/poke addresses). */
export const u16 = (v: Value | undefined): number => fx.toInt(luaNum(v)) & 0xffff;

const arg = (args: Value[], i: number): Value | undefined => args[i - 1];

// ---------------------------------------------------------------------------
// host interface

export interface ApiHost {
  /** host frames elapsed (time() = frameCount / targetFps) */
  frameCount: number;
  targetFps: number;
  /** stat(7)/stat(8) reported fps */
  fps: number;
  /** stat(6) */
  cartParam: string;
  /** stat(100) */
  breadcrumb: string;
  /** printh sink (UTF-8 text handled by host) */
  printh(s: string): void;
  /**
   * _update_buttons: host samples input then drives Input.update.
   * Implemented in host.ts (needs scanInput + pause menu policy).
   */
  hookUpdateButtons(): void;
  /**
   * run(): request a full cart restart. Host performs it at the tick
   * boundary (fake-08 does it in-place; see file header of host.ts for the
   * sequencing note).
   */
  hookRun(): void;
  /** extcmd("reset"/"pause"/"shutdown") — host policy. Returns true if handled. */
  hookExtcmd(cmd: string): boolean;
  /**
   * load(name, crumb, param) — Phase 3.5 sub-cart switch. Returns false when
   * the name does not resolve; a successful call switches at the tick end.
   */
  hookLoad(name: string, crumb: string, param: string): boolean;
  /**
   * reload(dest, src, len, filename) — copy from a merged sub-cart ROM.
   * Returns false when the name does not resolve (caller raises the error).
   */
  hookReload(dest: number, src: number, len: number, filename: string): boolean;
  /**
   * print() core — injected by the host so api.ts does not depend on
   * print.ts at compile time. Signature matches corePrint.
   */
  printFn(g: Graphics, s: string, x: number, y: number, fg: number, bg: number): number;
}

export interface ApiContext {
  mem: PicoMemory;
  gfx: Graphics;
  input: Input;
  host: ApiHost;
  /** audio stubs (Phase 4b replaces these) */
  audio?: {
    apiMusic(n: number, fadems: number, mask: number): void;
    apiSfx(n: number, channel: number, offset: number, length: number): number;
    currentSfxId(ch: number): number;
    currentNote(ch: number): number;
    currentMusic(): number;
    musicPatternCount(): number;
    musicTickCount(): number;
  };
}

// ---------------------------------------------------------------------------
// memory family (picoluaapi.cpp:1068-1267)

function makeMemoryFns(ctx: ApiContext): [string, NativeFn][] {
  const { mem } = ctx;

  const peek: NativeFn = (_L, args) => {
    const addr = u16(arg(args, 1));
    let n = 1;
    if (args.length > 1) {
      const t = cint(arg(args, 2));
      if (t > 0) n = t > 8192 ? 8192 : t;
    }
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(fx.fromInt(mem.peek(addr + i)));
    return out;
  };

  const poke: NativeFn = (_L, args) => {
    const dest = u16(arg(args, 1));
    // value semantics, like fake-08 `uint8_t val = lua_tonumber(L, 2)` —
    // NOT the raw fix32 bits (that made every integer poke write 0).
    mem.poke(dest, args.length > 1 ? cint(arg(args, 2)) & 0xff : 0);
    if (args.length > 2) {
      let extra = args.length - 2;
      if (extra > 8192) extra = 8192;
      for (let i = 1; i <= extra; i++) {
        mem.poke(dest + i, cint(arg(args, 1 + i + 1)) & 0xff);
      }
    }
    return [];
  };

  const peek2: NativeFn = (_L, args) => [mem.peek2(u16(arg(args, 1)))];
  const poke2: NativeFn = (_L, args) => {
    const dest = u16(arg(args, 1));
    mem.poke2(dest, i16(arg(args, 2)));
    if (args.length > 2) {
      for (let i = 1; i <= args.length - 2; i++) {
        mem.poke2(dest + i, i16(arg(args, 2 + i)));
      }
    }
    return [];
  };
  const peek4: NativeFn = (_L, args) => [mem.peek4(u16(arg(args, 1)))];
  const poke4: NativeFn = (_L, args) => {
    const dest = u16(arg(args, 1));
    mem.poke4(dest, luaNum(arg(args, 2)));
    if (args.length > 2) {
      for (let i = 1; i <= args.length - 2; i++) {
        mem.poke4(dest + i, luaNum(arg(args, 2 + i)));
      }
    }
    return [];
  };

  const memcpy: NativeFn = (_L, args) => {
    mem.memcpy(u16(arg(args, 1)), u16(arg(args, 2)), u16(arg(args, 3)));
    return [];
  };
  const memset: NativeFn = (_L, args) => {
    mem.memset(u16(arg(args, 1)), u16(arg(args, 2)), u16(arg(args, 3)));
    return [];
  };

  const reload: NativeFn = (L, args) => {
    const dest = args.length > 0 ? u16(arg(args, 1)) : 0;
    const src = args.length > 1 ? u16(arg(args, 2)) : 0;
    const len = args.length > 2 ? u16(arg(args, 3)) : 0x4300;
    const fn = args.length > 3 && typeof arg(args, 4) === "string"
      ? (arg(args, 4) as string)
      : "";
    if (fn !== "") {
      // Phase 3.5: copy from a merged sub-cart's ROM window.
      if (!ctx.host.hookReload(dest, src, len, fn)) {
        luaLError(L, `reload: missing cart '${fn}'`);
      }
      return [];
    }
    mem.reload(dest, src, len);
    return [];
  };

  const dget: NativeFn = (_L, args) => [mem.dget(cint(arg(args, 1)))];
  const dset: NativeFn = (_L, args) => {
    mem.dset(cint(arg(args, 1)), luaNum(arg(args, 2)));
    return [];
  };

  /** __cartdata(key) → bool (vm.cpp:1022-1075, session-memory subset). */
  const cartdata: NativeFn = (_L, args) => {
    const v = arg(args, 1);
    if (typeof v !== "string") return [false];
    const key = v;
    if (key.length === 0 || key.length > 64) return [false];
    if (mem.cartdataKey !== key) {
      mem.cartdataKey = key;
      mem.data.fill(0, ADDR.CARTDATA, ADDR.CARTDATA + 0x100); // switching key clears
      return [false];
    }
    return [false]; // no file persistence in the session-memory subset
  };

  /** reset → vm_reset (vm.cpp:1353-1365): clear 0x5f00..0x5f7f + defaults. */
  const reset: NativeFn = () => {
    mem.data.fill(0, 0x5f00, 0x5f00 + 0x80);
    mem.data[HW.COLOR_BITMASK] = 0xff;
    mem.data[HW.SHEET_MAPPING] = 0x00;
    mem.data[HW.SCREEN_MAPPING] = 0x60;
    mem.data[HW.MAP_MAPPING] = 0x20;
    mem.data[HW.MAP_WIDTH] = 128;
    ctx.gfx.clip(0, 0, 128, 128);
    ctx.gfx.palReset();
    ctx.gfx.setColor(0);
    return [];
  };

  const cstore: NativeFn = () => []; // noop (picoluaapi.cpp:1068-1072)

  return [
    ["peek", peek], ["poke", poke],
    ["peek2", peek2], ["poke2", poke2],
    ["peek4", peek4], ["poke4", poke4],
    ["memcpy", memcpy], ["memset", memset],
    ["reload", reload], ["reset", reset],
    ["dget", dget], ["dset", dset],
    ["__cartdata", cartdata], ["cstore", cstore],
  ];
}

// ---------------------------------------------------------------------------
// system / input / rng (picoluaapi.cpp:765-1371)

function makeSystemFns(ctx: ApiContext): [string, NativeFn][] {
  const { mem, gfx, input, host } = ctx;

  const btn: NativeFn = (_L, args) => {
    if (args.length === 0) return [fx.fromInt(input.btnMask())];
    const i = cint(arg(args, 1));
    const p = args.length > 1 ? cint(arg(args, 2)) : 0;
    return [input.btn(i, p) as boolean];
  };
  const btnp: NativeFn = (_L, args) => {
    if (args.length === 0) return [fx.fromInt(input.btnpMask())];
    const i = cint(arg(args, 1));
    const p = args.length > 1 ? cint(arg(args, 2)) : 0;
    return [input.btnp(i, p) as boolean];
  };

  const time: NativeFn = () => [
    fx.div(fx.fromInt(host.frameCount), fx.fromInt(host.targetFps)),
  ];

  const stat: NativeFn = (_L, args) => {
    const n = cint(arg(args, 1));
    switch (n) {
      case 0: return [fx.fromInt(1)];
      case 1: case 2: return [fx.fromDouble(0.5)];
      case 4: return [""];
      case 5: return [fx.fromInt(22)];
      case 6: return [host.cartParam];
      case 7: case 8: return [fx.fromDouble(host.fps)];
      case 16: case 46: return [fx.fromInt(ctx.audio?.currentSfxId(0) ?? -1)];
      case 17: case 47: return [fx.fromInt(ctx.audio?.currentSfxId(1) ?? -1)];
      case 18: case 48: return [fx.fromInt(ctx.audio?.currentSfxId(2) ?? -1)];
      case 19: case 49: return [fx.fromInt(ctx.audio?.currentSfxId(3) ?? -1)];
      case 20: case 50: return [fx.fromInt(ctx.audio?.currentNote(0) ?? 0)];
      case 21: case 51: return [fx.fromInt(ctx.audio?.currentNote(1) ?? 0)];
      case 22: case 52: return [fx.fromInt(ctx.audio?.currentNote(2) ?? 0)];
      case 23: case 53: return [fx.fromInt(ctx.audio?.currentNote(3) ?? 0)];
      case 24: case 54: return [fx.fromInt(ctx.audio?.currentMusic() ?? -1)];
      case 25: case 55: return [fx.fromInt(ctx.audio?.musicPatternCount() ?? 0)];
      case 26: case 56: return [fx.fromInt(ctx.audio?.musicTickCount() ?? 0)];
      case 28: return [false];
      case 29: return [fx.fromInt(0)];
      case 30: return [input.kbDown];
      case 31: return [input.consumeKey()];
      case 32: return [fx.fromInt(input.mouseX)];
      case 33: return [fx.fromInt(input.mouseY)];
      case 34: return [fx.fromInt(input.mouseBtns)];
      case 90: return [fx.fromInt(new Date().getFullYear())];
      case 91: return [fx.fromInt(new Date().getMonth() + 1)];
      case 92: return [fx.fromInt(new Date().getDate())];
      case 93: return [fx.fromInt(new Date().getHours())];
      case 94: return [fx.fromInt(new Date().getMinutes())];
      case 95: return [fx.fromInt(new Date().getSeconds())];
      case 100: return [host.breadcrumb];
      case 101: return [null];
      case 102: return [fx.fromInt(0)];
      case 108: return [fx.fromInt(32)];
      case 120: case 121: case 122: return [false];
      default: return [fx.fromInt(0)]; // noopreturns (picoluaapi.cpp:43-48)
    }
  };

  const printh: NativeFn = (_L, args) => {
    const v = arg(args, 1);
    if (typeof v === "string") host.printh(v);
    return [];
  };

  const rnd: NativeFn = (_L, args) => {
    const step = (): number => {
      mem.updatePrng();
      const b = mem.peek4(HW.RNG + 4) >>> 0;
      return b;
    };
    if (args.length === 0) {
      return [step() % 0x10000]; // range = fix32 bits of 1.0 = 0x10000
    }
    const v = arg(args, 1);
    if (v instanceof Table) {
      // native: range = fix32(len) whose BITS are len<<16; idx = int(rnd)+1
      const len = v.length();
      const rangeBits = (len << 16) | 0;
      const b = step();
      const r = rangeBits > 0 ? b % rangeBits : 0;
      const idx = Math.trunc(r / 65536) + 1;
      return [v.get(fx.fromInt(idx))];
    }
    const rangeBits = luaNum(v) | 0;
    const b = step();
    return [rangeBits > 0 ? (b % rangeBits) | 0 : 0];
  };

  const srand: NativeFn = (_L, args) => {
    const seedBits = luaNum(arg(args, 1)) | 0;
    mem.poke4(HW.RNG, seedBits !== 0 ? seedBits : 0xdeadbeef | 0);
    mem.poke4(HW.RNG + 4, (mem.peek4(HW.RNG) ^ 0xbead29ba) | 0);
    for (let i = 0; i < 32; i++) mem.updatePrng();
    return [];
  };

  const updateButtons: NativeFn = () => {
    host.hookUpdateButtons();
    return [];
  };

  const run: NativeFn = () => {
    host.hookRun();
    return [];
  };

  const extcmd: NativeFn = (_L, args) => {
    const v = arg(args, 1);
    if (typeof v === "string") host.hookExtcmd(v);
    return [];
  };

  const setFps: NativeFn = () => []; // noop (picoluaapi.cpp:1367-1371)

  // audio bindings — routed to the real mixer (src/core/audio.ts, Phase 4b)
  const music: NativeFn = (_L, args) => {
    ctx.audio?.apiMusic(cint(arg(args, 1)), args.length > 1 ? cint(arg(args, 2)) : 0,
      args.length > 2 ? cint(arg(args, 3)) : 0);
    return [];
  };
  const sfx: NativeFn = (_L, args) => {
    const r = ctx.audio?.apiSfx(
      cint(arg(args, 1)),
      args.length > 1 ? cint(arg(args, 2)) : -1,
      args.length > 2 ? cint(arg(args, 3)) : 0,
      args.length > 3 ? cint(arg(args, 4)) : -1,
    );
    return [fx.fromInt(r ?? 0)];
  };

  // Cart-switch load — registered as "__load" (fake-08 vm.cpp:60); the global
  // `load` name must stay the base chunk-loader (bios captures it into
  // __z8_load_code at line 21 before defining its own wrapper). Phase 3.5:
  // resolves against the merged sub-cart table and switches at tick end.
  const load: NativeFn = (_L, args) => {
    if (args.length === 0 || typeof arg(args, 1) !== "string") return [];
    const name = arg(args, 1) as string;
    const crumb = typeof arg(args, 2) === "string" ? (arg(args, 2) as string) : "";
    const param = typeof arg(args, 3) === "string" ? (arg(args, 3) as string) : "";
    return [ctx.host.hookLoad(name, crumb, param)];
  };

  return [
    ["btn", btn], ["btnp", btnp],
    ["time", time], ["t", time],
    ["stat", stat], ["printh", printh],
    ["rnd", rnd], ["srand", srand],
    ["_update_buttons", updateButtons],
    ["run", run], ["extcmd", extcmd], ["_set_fps", setFps],
    ["music", music], ["sfx", sfx],
    ["__load", load],
  ];
}

// ---------------------------------------------------------------------------
// graphics family (picoluaapi.cpp:52-770)

function makeGraphicsFns(ctx: ApiContext): [string, NativeFn][] {
  const { gfx, mem, host } = ctx;

  const cls: NativeFn = (_L, args) => {
    if (args.length === 0) gfx.cls();
    else gfx.cls(u8(arg(args, 1)));
    return [];
  };

  const pset: NativeFn = (_L, args) => {
    const x = cint(arg(args, 1));
    const y = cint(arg(args, 2));
    if (args.length <= 2) gfx.pset(x, y);
    else gfx.pset(x, y, u8(arg(args, 3)));
    return [];
  };

  const pget: NativeFn = (_L, args) => [
    fx.fromInt(gfx.pget(cint(arg(args, 1)), cint(arg(args, 2)))),
  ];

  const color: NativeFn = (_L, args) => {
    if (args.length > 0) return [fx.fromInt(gfx.setColor(i16(arg(args, 1))))];
    // no-arg: Graphics::color() — sets pen to 6, returns previous
    const prev = gfx.getColor();
    gfx.setColor(6);
    return [fx.fromInt(prev)];
  };

  const line: NativeFn = (_L, args) => {
    switch (args.length) {
      case 0: gfx.resetLine(); break;
      case 1: gfx.setColor(i16(arg(args, 1))); gfx.resetLine(); break;
      case 2: gfx.lineTo(cint(arg(args, 1)), cint(arg(args, 2))); break;
      case 3:
        gfx.lineTo(cint(arg(args, 1)), cint(arg(args, 2)), i16(arg(args, 3)));
        break;
      case 4:
        gfx.drawLine(
          cint(arg(args, 1)), cint(arg(args, 2)),
          cint(arg(args, 3)), cint(arg(args, 4)), gfx.getColor(),
        );
        break;
      default:
        gfx.drawLine(
          cint(arg(args, 1)), cint(arg(args, 2)),
          cint(arg(args, 3)), cint(arg(args, 4)), i16(arg(args, 5)),
        );
    }
    return [];
  };

  const tline: NativeFn = (_L, args) => {
    let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    let mx = 0, my = 0;
    const mdx = 0x2000; // 1/8 default
    let mdy = 0;
    if (args.length >= 6) {
      x0 = cint(arg(args, 1)); y0 = cint(arg(args, 2));
      x1 = cint(arg(args, 3)); y1 = cint(arg(args, 4));
      mx = luaNum(arg(args, 5)); my = luaNum(arg(args, 6));
    }
    if (args.length > 7) {
      // picoluaapi.cpp:162-165 — mdx is arg 7, mdy arg 8
      gfx.tlineStep(x0, y0, x1, y1, mx, my, luaNum(arg(args, 7)), luaNum(arg(args, 8)));
      return [];
    }
    gfx.tlineStep(x0, y0, x1, y1, mx, my, mdx, mdy);
    return [];
  };

  const circ: NativeFn = (_L, args) => {
    const ox = cint(arg(args, 1));
    const oy = cint(arg(args, 2));
    if (args.length === 2) gfx.circ(ox, oy);
    else if (args.length === 3) gfx.circ(ox, oy, cint(arg(args, 3)));
    else gfx.circ(ox, oy, cint(arg(args, 3)), i16(arg(args, 4)));
    return [];
  };

  const circfill: NativeFn = (_L, args) => {
    const ox = cint(arg(args, 1));
    const oy = cint(arg(args, 2));
    if (args.length === 2) gfx.circfill(ox, oy, 4, gfx.getColor());
    else if (args.length === 3) gfx.circfill(ox, oy, cint(arg(args, 3)), gfx.getColor());
    else gfx.circfill(ox, oy, cint(arg(args, 3)), i16(arg(args, 4)));
    return [];
  };

  const oval: NativeFn = (_L, args) => {
    if (args.length >= 4) {
      const a = cint(arg(args, 1)), b = cint(arg(args, 2));
      const c = cint(arg(args, 3)), d = cint(arg(args, 4));
      if (args.length === 4) gfx.oval(a, b, c, d);
      else gfx.oval(a, b, c, d, i16(arg(args, 5)));
    }
    return [];
  };

  const ovalfill: NativeFn = (_L, args) => {
    if (args.length >= 4) {
      const a = cint(arg(args, 1)), b = cint(arg(args, 2));
      const c = cint(arg(args, 3)), d = cint(arg(args, 4));
      if (args.length === 4) gfx.ovalfill(a, b, c, d);
      else gfx.ovalfill(a, b, c, d, i16(arg(args, 5)));
    }
    return [];
  };

  const rect: NativeFn = (_L, args) => {
    if (args.length >= 4) {
      const a = cint(arg(args, 1)), b = cint(arg(args, 2));
      const c = cint(arg(args, 3)), d = cint(arg(args, 4));
      if (args.length === 4) gfx.rect(a, b, c, d);
      else gfx.rect(a, b, c, d, i16(arg(args, 5)));
    }
    return [];
  };

  const rectfill: NativeFn = (_L, args) => {
    if (args.length >= 4) {
      const a = cint(arg(args, 1)), b = cint(arg(args, 2));
      const c = cint(arg(args, 3)), d = cint(arg(args, 4));
      if (args.length === 4) gfx.rectfill(a, b, c, d);
      else gfx.rectfill(a, b, c, d, i16(arg(args, 5)));
    }
    return [];
  };

  const rrect: NativeFn = (_L, args) => {
    if (args.length >= 5) {
      const w = cint(arg(args, 1)), h = cint(arg(args, 2));
      const ww = cint(arg(args, 3)), hh = cint(arg(args, 4));
      const r = cint(arg(args, 5));
      if (args.length === 5) gfx.rrect(w, h, ww, hh, r);
      else gfx.rrect(w, h, ww, hh, r, i16(arg(args, 6)));
    }
    return [];
  };

  const rrectfill: NativeFn = (_L, args) => {
    if (args.length >= 5) {
      const w = cint(arg(args, 1)), h = cint(arg(args, 2));
      const ww = cint(arg(args, 3)), hh = cint(arg(args, 4));
      const r = cint(arg(args, 5));
      if (args.length === 5) gfx.rrectfill(w, h, ww, hh, r);
      else gfx.rrectfill(w, h, ww, hh, r, i16(arg(args, 6)));
    }
    return [];
  };

  /** print (picoluaapi.cpp:343-403) — value coercion + coord/color overloads. */
  const print: NativeFn = (_L, args) => {
    const n = args.length;
    if (n === 0) return [];
    const v = arg(args, 1);
    let s: string;
    if (v === null || v === undefined) s = "[nil]";
    else if (typeof v === "string") s = v;
    else if (typeof v === "number") s = fx.numToString(v);
    else if (typeof v === "boolean") s = v ? "true" : "false";
    else if (typeof v === "function") s = "[function]";
    else if (v instanceof Table || (typeof v === "object" && v !== null)) {
      // non-string/number/bool/function (incl. Lua closures with proto): only
      // NativeFn reaches "[function]" above; Closure falls through here.
      const anyV = v as { proto?: unknown };
      s = anyV.proto !== undefined ? "[function]" : "";
    } else s = "";

    let newx: number;
    if (n < 2) {
      newx = host.printFn(gfx, s, gfx.mem.data[DRAW.TEXT_X], gfx.mem.data[DRAW.TEXT_Y],
        gfx.getColor(), 0);
    } else if (n === 2) {
      gfx.setColor(i16(arg(args, 2)));
      newx = host.printFn(gfx, s, gfx.mem.data[DRAW.TEXT_X], gfx.mem.data[DRAW.TEXT_Y],
        gfx.getColor(), 0);
    } else if (n === 3) {
      newx = host.printFn(gfx, s, cint(arg(args, 2)), cint(arg(args, 3)),
        gfx.getColor(), 0);
    } else {
      newx = host.printFn(gfx, s, cint(arg(args, 2)), cint(arg(args, 3)),
        i16(arg(args, 4)), 0);
    }
    return [fx.fromInt(newx)];
  };

  const spr: NativeFn = (_L, args) => {
    if (args.length < 3) return [];
    let w = 0x10000;
    let h = 0x10000;
    if (args.length > 3) w = luaNum(arg(args, 4));
    if (args.length > 4) h = luaNum(arg(args, 5));
    const fxX = args.length > 5 ? arg(args, 6) === true : false;
    const fxY = args.length > 6 ? arg(args, 7) === true : false;
    gfx.spr(cint(arg(args, 1)), cint(arg(args, 2)), cint(arg(args, 3)),
      w, h, fxX, fxY);
    return [];
  };

  const sspr: NativeFn = (_L, args) => {
    if (args.length < 6) return [];
    const sx = cint(arg(args, 1)), sy = cint(arg(args, 2));
    const sw = cint(arg(args, 3)), sh = cint(arg(args, 4));
    const dx = cint(arg(args, 5)), dy = cint(arg(args, 6));
    let dw = sw;
    let dh = sh;
    if (args.length > 6) dw = cint(arg(args, 7));
    if (args.length > 7) dh = cint(arg(args, 8));
    const flipX = args.length > 8 ? arg(args, 9) === true : false;
    const flipY = args.length > 9 ? arg(args, 10) === true : false;
    gfx.sspr(sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY);
    return [];
  };

  const fget: NativeFn = (_L, args) => {
    if (args.length === 1) return [fx.fromInt(gfx.fget(u8(arg(args, 1))) as number)];
    return [gfx.fget(u8(arg(args, 1)), u8(arg(args, 2))) as boolean];
  };

  const fset: NativeFn = (_L, args) => {
    if (args.length > 2) gfx.fset(u8(arg(args, 1)), u8(arg(args, 2)), arg(args, 3) === true);
    else gfx.fset(u8(arg(args, 1)), u8(arg(args, 2)));
    return [];
  };

  const sget: NativeFn = (_L, args) => [
    fx.fromInt(gfx.sget(u8(arg(args, 1)), u8(arg(args, 2)))),
  ];
  const sset: NativeFn = (_L, args) => {
    gfx.sset(u8(arg(args, 1)), u8(arg(args, 2)), i16(arg(args, 3)) & 0xff);
    return [];
  };

  const camera: NativeFn = (_L, args) => {
    const x = args.length > 0 ? i16(arg(args, 1)) : 0;
    const y = args.length > 1 ? i16(arg(args, 2)) : 0;
    const prev = gfx.camera(x, y);
    return [fx.fromInt(prev[0]), fx.fromInt(prev[1])];
  };

  const clip: NativeFn = (_L, args) => {
    const prev = args.length >= 4
      ? gfx.clip(cint(arg(args, 1)), cint(arg(args, 2)), cint(arg(args, 3)), cint(arg(args, 4)))
      : gfx.clip(0, 0, 128, 128);
    return [prev.xb, prev.xe, prev.yb, prev.ye].map((n) => fx.fromInt(n));
  };

  const mget: NativeFn = (_L, args) => [
    fx.fromInt(gfx.mget(cint(arg(args, 1)), cint(arg(args, 2)))),
  ];
  const mset: NativeFn = (_L, args) => {
    gfx.mset(cint(arg(args, 1)), cint(arg(args, 2)), i16(arg(args, 3)) & 0xff);
    return [];
  };

  const mapFn: NativeFn = (_L, args) => {
    const d = mem.data;
    const bigMap = d[HW.MAP_MAPPING] >= 0x80;
    const bigMapLocation = d[HW.MAP_MAPPING] << 8;
    const mapSize = bigMap ? 0x10000 - bigMapLocation : 8192;
    const mapW = d[HW.MAP_WIDTH] === 0 ? 256 : d[HW.MAP_WIDTH];
    const mapH = mapSize / mapW;
    const celx = args.length > 0 ? cint(arg(args, 1)) : 0;
    const cely = args.length > 1 ? cint(arg(args, 2)) : 0;
    const sx = args.length > 2 ? cint(arg(args, 3)) : 0;
    const sy = args.length > 3 ? cint(arg(args, 4)) : 0;
    const celw = args.length > 4 ? cint(arg(args, 5)) : mapW;
    const celh = args.length > 5 ? cint(arg(args, 6)) : mapH;
    const layer = args.length > 6 ? i16(arg(args, 7)) : 0;
    gfx.map(celx, cely, sx, sy, celw, celh, layer);
    return [];
  };

  const pal: NativeFn = (_L, args) => {
    if (args.length === 0) {
      gfx.palReset();
      return [];
    }
    const first = arg(args, 1);
    if (first instanceof Table) {
      const p = args.length > 1 ? i16(arg(args, 2)) : 0;
      for (const [k, val] of first.map) {
        if (typeof k === "number" && typeof val === "number") {
          gfx.palSet(i16(k), i16(val), p);
        }
      }
      return [];
    }
    if (args.length === 1) {
      gfx.palResetSide(i16(first));
      return [];
    }
    const c0 = i16(first);
    const c1 = args.length > 1 ? i16(arg(args, 2)) : c0;
    const p = args.length > 2 ? i16(arg(args, 3)) : 0;
    return [fx.fromInt(gfx.palSet(c0, c1, p))];
  };

  const palt: NativeFn = (_L, args) => {
    if (args.length < 2) {
      // bitfield form: default only color 0 transparent (bit15)
      const c = args.length === 1 ? i16(arg(args, 1)) : -32768; // 0x8000
      let prev = 0;
      for (let i = 0; i < 16; i++) {
        const bit = ((c >> (15 - i)) & 1) !== 0;
        if (gfx.palt(i, bit)) prev |= 1 << (15 - i);
      }
      return [fx.fromInt(prev)];
    }
    const c = i16(arg(args, 1));
    const t = arg(args, 2) === true;
    return [fx.fromInt(gfx.palt(c, t) ? 1 : 0)];
  };

  const cursor: NativeFn = (_L, args) => {
    const x = cint(arg(args, 1));
    const y = cint(arg(args, 2));
    const prev = args.length < 3
      ? gfx.cursor(x, y)
      : gfx.cursor(x, y, i16(arg(args, 3)));
    return [fx.fromInt(prev[0]), fx.fromInt(prev[1])];
  };

  const fillp: NativeFn = (_L, args) => [
    gfx.fillp(args.length > 0 ? luaNum(arg(args, 1)) : 0),
  ];

  return [
    ["cls", cls], ["pset", pset], ["pget", pget], ["color", color],
    ["line", line], ["tline", tline],
    ["circ", circ], ["circfill", circfill],
    ["oval", oval], ["ovalfill", ovalfill],
    ["rect", rect], ["rectfill", rectfill],
    ["rrect", rrect], ["rrectfill", rrectfill],
    ["print", print], ["spr", spr], ["sspr", sspr],
    ["fget", fget], ["fset", fset], ["sget", sget], ["sset", sset],
    ["camera", camera], ["clip", clip],
    ["mget", mget], ["mset", mset],
    ["map", mapFn], ["mapdraw", mapFn],
    ["pal", pal], ["palt", palt],
    ["cursor", cursor], ["fillp", fillp],
  ];
}

// ---------------------------------------------------------------------------
// registration

/** Register every fake-08 Lua binding into L.globals. */
export function installApi(L: LuaState, ctx: ApiContext): void {
  const entries = [
    ...makeMemoryFns(ctx),
    ...makeSystemFns(ctx),
    ...makeGraphicsFns(ctx),
  ];
  for (const [name, fn] of entries) L.globals.set(name, fn);
}

