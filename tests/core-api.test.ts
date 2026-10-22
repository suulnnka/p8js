// api.ts — binding-layer shapes (overloads, coercion, stat codes, rng).
import { describe, expect, it } from "vitest";
import { LuaState } from "../src/vm/state.ts";
import { PicoMemory } from "../src/core/memory.ts";
import { Graphics } from "../src/core/graphics.ts";
import { Input } from "../src/core/input.ts";
import {
  installApi, type ApiContext, type ApiHost, luaNum, cint, u8, i16, u16,
} from "../src/core/api.ts";
import * as fx from "../src/vm/fix32.ts";
import { Table } from "../src/vm/value.ts";

function mkApi(): {
  L: LuaState; ctx: ApiContext; host: ApiHost; printed: { x: number; s: string }[];
} {
  const L = new LuaState();
  const mem = new PicoMemory();
  mem.reset();
  const gfx = new Graphics(mem);
  gfx.clip(0, 0, 128, 128);
  gfx.palReset();
  const input = new Input(mem);
  const printed: { x: number; s: string }[] = [];
  const host: ApiHost = {
    frameCount: 0,
    targetFps: 60,
    fps: 60,
    cartParam: "arg1",
    breadcrumb: "bc",
    printh: () => {},
    hookUpdateButtons: () => {},
    hookRun: () => {},
    hookExtcmd: () => false,
    hookLoad: () => false,
    hookReload: () => false,
    printFn: (g, s, x, y) => {
      printed.push({ x, s });
      // minimal: advance cursor by 4 per char
      g.cursor(x + s.length * 4, y);
      return x + s.length * 4;
    },
  };
  const ctx: ApiContext = { mem, gfx, input, host };
  installApi(L, ctx);
  return { L, ctx, host, printed };
}

function run(name: string, ctx: ApiContext, args: unknown[]) {
  const L = new LuaState();
  installApi(L, ctx);
  const fn = L.globals.get(name);
  if (typeof fn !== "function") throw new Error(`missing api ${name}`);
  return (fn as (l: LuaState, a: unknown[]) => unknown[])(L, args as never);
}

describe("coercion helpers", () => {
  it("luaNum/cint/u8/i16/u16 match C casts", () => {
    expect(luaNum("12")).toBe(fx.fromInt(12));
    expect(luaNum(true)).toBe(0);
    expect(cint(fx.fromInt(-3))).toBe(-3);
    expect(cint(fx.fromDouble(-1.5))).toBe(-1); // trunc toward 0
    expect(u8(fx.fromInt(255))).toBe(255);
    expect(u8(fx.fromInt(-1))).toBe(255);
    expect(i16(fx.fromInt(65535))).toBe(-1);
    expect(u16(fx.fromInt(0x12345))).toBe(0x2345); // toInt(=0x12)&0xffff? no:
    // u16 uses lua_tointeger: toInt(0x12345<<16 wraps)…
    expect(u16(fx.fromInt(0x12345))).toBe(0x12345 & 0xffff);
  });
});

describe("memory bindings", () => {
  it("peek with count returns multiple values", () => {
    const { ctx } = mkApi();
    ctx.mem.poke(0x6000, 1);
    ctx.mem.poke(0x6001, 2);
    ctx.mem.poke(0x6002, 3);
    const r = run("peek", ctx, [fx.fromInt(0x6000), fx.fromInt(3)]) as number[];
    expect(r).toEqual([fx.fromInt(1), fx.fromInt(2), fx.fromInt(3)]);
  });

  it("poke with extra args writes consecutive bytes", () => {
    const { ctx } = mkApi();
    run("poke", ctx, [fx.fromInt(0x4300), fx.fromInt(7), fx.fromInt(8), fx.fromInt(9)]);
    expect(ctx.mem.peek(0x4300)).toBe(7);
    expect(ctx.mem.peek(0x4301)).toBe(8);
    expect(ctx.mem.peek(0x4302)).toBe(9);
  });

  it("reload defaults to the full ROM window", () => {
    const { ctx } = mkApi();
    ctx.mem.rom[0] = 99;
    run("reload", ctx, []);
    expect(ctx.mem.peek(0)).toBe(99);
  });

  it("dget/dset round-trip; stat(6) returns cartParam", () => {
    const { ctx, host } = mkApi();
    run("dset", ctx, [fx.fromInt(3), fx.fromDouble(2.5)]);
    const r = run("dget", ctx, [fx.fromInt(3)]) as number[];
    expect(r[0]).toBe(163840); // 2.5 as fix32 bits
    host.cartParam = "p,1,2";
    const s = run("stat", ctx, [fx.fromInt(6)]) as number[];
    expect(s[0]).toBe("p,1,2");
  });
});

describe("graphics binding overloads", () => {
  it("color() no-arg sets pen 6 and returns previous", () => {
    const { ctx } = mkApi();
    ctx.gfx.setColor(3);
    const r = run("color", ctx, []) as number[];
    expect(r[0]).toBe(fx.fromInt(3));
    expect(ctx.mem.data[0x5f25]).toBe(6);
  });

  it("line overloads: 5-arg draws, 0-arg invalidates", () => {
    const { ctx } = mkApi();
    run("line", ctx, [fx.fromInt(0), fx.fromInt(0), fx.fromInt(4), fx.fromInt(4), fx.fromInt(9)]);
    expect(ctx.gfx.pget(2, 2)).toBe(9);
    run("line", ctx, []);
    expect(ctx.mem.data[0x5f35]).toBe(1);
  });

  it("pal table form iterates numeric pairs", () => {
    const { ctx } = mkApi();
    const t = new Table();
    t.set(fx.fromInt(1), fx.fromInt(10));
    t.set(fx.fromInt(2), fx.fromInt(11));
    run("pal", ctx, [t]);
    expect(ctx.mem.data[0x5f00 + 1]).toBe(10);
    expect(ctx.mem.data[0x5f00 + 2]).toBe(11);
  });

  it("palt bitfield form (single arg) sets transparency map", () => {
    const { ctx } = mkApi();
    // bit15 set → color 0 transparent; everything else off
    run("palt", ctx, [fx.fromInt(0x8000)]);
    expect(ctx.gfx.isColorTransparent(0)).toBe(true);
    expect(ctx.gfx.isColorTransparent(1)).toBe(false);
    // only color 1 transparent
    run("palt", ctx, [fx.fromInt(0x4000)]); // bit14 → color 1
    expect(ctx.gfx.isColorTransparent(0)).toBe(false);
    expect(ctx.gfx.isColorTransparent(1)).toBe(true);
  });

  it("clip returns previous rect in (xb,xe,yb,ye) order", () => {
    const { ctx } = mkApi();
    run("clip", ctx, [fx.fromInt(4), fx.fromInt(5), fx.fromInt(6), fx.fromInt(7)]);
    const r = run("clip", ctx, []) as number[];
    expect(r.map((n) => fx.toInt(n as number))).toEqual([4, 10, 5, 12]);
  });

  it("print coordinator dispatches to host printFn with parsed coords", () => {
    const { ctx, printed } = mkApi();
    run("print", ctx, ["hi", fx.fromInt(8), fx.fromInt(9), fx.fromInt(12)]);
    expect(printed).toEqual([{ x: 8, s: "hi" }]);
    run("print", ctx, [null]);
    expect(printed[1].s).toBe("[nil]");
    run("print", ctx, [fx.fromDouble(1.5)]);
    expect(printed[2].s).toBe("1.5");
  });
});

describe("system bindings", () => {
  it("btn mask / indexed forms", () => {
    const { ctx } = mkApi();
    ctx.input.setState(0, 0b001010);
    const r0 = run("btn", ctx, []) as number[];
    expect(r0[0]).toBe(fx.fromInt(0b001010));
    const r1 = run("btn", ctx, [fx.fromInt(1)]) as boolean[];
    expect(r1[0]).toBe(true);
    const r2 = run("btn", ctx, [fx.fromInt(1), fx.fromInt(2)]) as boolean[];
    expect(r2[0]).toBe(false); // player 2 unsupported
  });

  it("time = frameCount / targetFps", () => {
    const { ctx, host } = mkApi();
    host.frameCount = 150;
    host.targetFps = 60;
    const r = run("time", ctx, []) as number[];
    expect(fx.toDouble(r[0] as number)).toBeCloseTo(2.5, 3);
  });

  it("srand is deterministic and rnd respects range bits", () => {
    const { ctx } = mkApi();
    run("srand", ctx, [fx.fromInt(1)]);
    const a = run("rnd", ctx, [fx.fromInt(0x10000)]) as number[];
    run("srand", ctx, [fx.fromInt(1)]);
    const b = run("rnd", ctx, [fx.fromInt(0x10000)]) as number[];
    expect(a[0]).toBe(b[0]);
    // range = 1.0 (bits 0x10000): result bits < 0x10000 → integer part 0
    const c = run("rnd", ctx, [fx.fromInt(1)]) as number[];
    expect(fx.toInt(c[0] as number)).toBe(0);
  });

  it("rnd(table) picks an element within #t", () => {
    const { ctx } = mkApi();
    const t = new Table();
    t.set(fx.fromInt(1), "a");
    t.set(fx.fromInt(2), "b");
    t.set(fx.fromInt(3), "c");
    run("srand", ctx, [fx.fromInt(42)]);
    for (let i = 0; i < 20; i++) {
      const r = run("rnd", ctx, [t]) as unknown[];
      expect(["a", "b", "c"]).toContain(r[0]);
    }
  });

  it("stat codes: fps/keys/mouse/defaults", () => {
    const { ctx, host } = mkApi();
    host.fps = 30.5;
    expect((run("stat", ctx, [fx.fromInt(7)])[0] as number)).toBe(fx.fromDouble(30.5));
    ctx.input.kbDown = true;
    ctx.input.kbKey = "q";
    expect(run("stat", ctx, [fx.fromInt(30)])[0]).toBe(true);
    expect(run("stat", ctx, [fx.fromInt(31)])[0]).toBe("q");
    expect(run("stat", ctx, [fx.fromInt(30)])[0]).toBe(false); // consumed
    ctx.input.mouseX = 11;
    expect(fx.toInt(run("stat", ctx, [fx.fromInt(32)])[0] as number)).toBe(11);
    expect(run("stat", ctx, [fx.fromInt(9999)])[0]).toBe(0); // unknown → 0
  });

  it("run/extcmd route to host hooks", () => {
    const { ctx } = mkApi();
    const calls: string[] = [];
    ctx.host.hookRun = () => calls.push("run");
    ctx.host.hookExtcmd = (c) => (calls.push(`ext:${c}`), true);
    run("run", ctx, []);
    run("extcmd", ctx, ["reset"]);
    expect(calls).toEqual(["run", "ext:reset"]);
  });
});
