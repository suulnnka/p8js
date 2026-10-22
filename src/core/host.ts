// Emulator host — the P3 frame loop. Ports fake-08's Vm::Step /
// vm_run / update_buttons orchestration (vm.cpp:614-665, 1193-1313) with one
// documented deviation: run() restarts at the tick boundary instead of
// in-place (see hookRun below).
//
// Frame sequencing (fake-08 host.cpp / vm.cpp):
//   per host frame: frameCount++ → pcall(__z8_tick) → (draw happens in P4)
// __z8_tick (bios) coresume()s __z8_loop; the glue inside the cart chunk does
//   yield()/flip() → 30fps carts skip every other host frame naturally.

// This module is browser-safe: no node:* imports — the bios bytecode is
// injected via EmulatorOptions.biosBytes (Node tests read assets/bios.bc in
// their own helpers; the web shell fetches it as a static asset).

import { LuaState } from "../vm/state.ts";
import { Table, isCallable, type Value } from "../vm/value.ts";
import { LuaError, YieldSignal, BudgetSignal } from "../vm/errors.ts";
import {
  abortCall, beginCall, callFunction, chunkClosure, invokeNoCleanup,
  runChunk, tracebackString,
} from "../vm/interp.ts";
import { openLibs } from "../vm/stdlib-base.ts";
import { undump, type Proto } from "../vm/undump.ts";
import * as fx from "../vm/fix32.ts";
import { PicoMemory, DRAW, HW, ROM_SIZE, MEM_SIZE } from "./memory.ts";
import { Graphics, PRINT_MODE } from "./graphics.ts";
import { Input, type HostInputState, EMPTY_HOST_INPUT } from "./input.ts";
import { installApi, type ApiContext, type ApiHost } from "./api.ts";
import { corePrint } from "./print.ts";
import { Audio } from "./audio.ts";
import type { P8cFile, P8cSub } from "./p8c.ts";

export interface EmulatorOptions {
  /** assets/bios.bc bytes (required — callers fetch/read it themselves) */
  biosBytes: Uint8Array;
  /** capture print() output (default: discard) */
  onPrint?: (s: string) => void;
  /** capture printh() output (default: discard) */
  onPrinth?: (s: string) => void;
  /** fixed srand seed for deterministic tests; default = wall clock */
  clockSeed?: number;
  /** print core; defaults to corePrint from print.ts */
  printFn?: (g: Graphics, s: string, x: number, y: number, fg: number, bg: number) => number;
}

export interface CartImage {
  /** z8lua bytecode dump of the cart (with glue appended at convert time) */
  bytecode: Uint8Array;
  /** 0x4300 ROM window */
  rom: Uint8Array;
}

/** bytecode bytes → JS latin1 string (the VM's byte-string representation). */
export function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return s;
}

type PcallResult = { ok: true; results: Value[] } | { ok: false; err: LuaError };

/** pcall semantics: LuaError → false+msg with frames aborted; Yield/Budget
 *  propagate (a host tick must never see them — bios yields stay inside
 *  coroutine.resume). */
function pcallLua(L: LuaState, fn: Value, args: Value[]): PcallResult {
  const site = beginCall(L);
  try {
    return { ok: true, results: invokeNoCleanup(L, site, fn, args) };
  } catch (e) {
    if (e instanceof LuaError) {
      const err = e;
      abortCall(L, site);
      return { ok: false, err };
    }
    throw e;
  }
}

/**
 * Minimal print used until corePrint (print.ts) is wired: draws glyphs via
 * Graphics.drawCharacter, handles \n, writes text_x/text_y PICO-8 style.
 * Control characters 0-15 are NOT handled here — print.ts replaces this.
 */
export function basicPrint(
  g: Graphics, s: string, x: number, y: number, fg: number, _bg: number,
): number {
  const startX = x;
  const d = g.mem.data;
  fg &= 0x0f;
  let lineMaxH = 6;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i) & 0xff;
    if (ch === 0x0a) {
      x = startX;
      y += lineMaxH;
      lineMaxH = 6;
      // scroll when past the bottom (printHelper.cpp:88-118 subset)
      if (y >= 127) {
        g.mem.data.copyWithin(0x6000, 0x6000 + 121, 0x6000 + 8192);
        g.mem.data.fill(0, 0x6000 + 8192 - 121, 0x6000 + 8192);
        y = 121;
      }
      continue;
    }
    if (ch < 0x10) continue; // control chars unsupported in basicPrint
    const extra = g.drawCharacter(ch, x, y, fg, 0, PRINT_MODE.ON, -1, -1);
    x += 4 + extra;
  }
  d[DRAW.TEXT_X] = startX & 0xff;
  d[DRAW.TEXT_Y] = (y + lineMaxH) & 0xff;
  return x;
}

export class Emulator {
  readonly mem = new PicoMemory();
  readonly gfx: Graphics;
  readonly input: Input;
  /** sfx/music mixer — fill via audio.fillMono() each host frame (Phase 4b). */
  readonly audio: Audio;
  L = new LuaState();
  private apiCtx!: ApiContext;
  private host!: ApiHost;
  private biosProto: Proto | null = null;
  private readonly biosBytes: Uint8Array;

  frameCount = 0;
  targetFps = 60; // fake-08 setFps is a no-op — host clock is fixed 60Hz
  fps = 60;
  cartParam = "";
  breadcrumb = "";
  lastError: string | null = null;
  /** last cart passed to loadCart (for hookRun restart) */
  private currentCart: CartImage | null = null;
  /** P8C2 sub-carts (Phase 3.5 merged games); null for plain v1 carts */
  private mergedSubs: Map<string, P8cSub> | null = null;
  /** load(name, crumb, param) queued for the tick boundary */
  private pendingLoad: { name: string; crumb: string; param: string } | null = null;
  private pendingInput: HostInputState = EMPTY_HOST_INPUT;
  private pendingRun = false;
  private biosRan = false;

  private readonly onPrint: (s: string) => void;
  private readonly userPrinth: (s: string) => void;
  private readonly clockSeed: number;
  private printFn: NonNullable<EmulatorOptions["printFn"]>;
  /** printh lines captured during the current tick (bios error reporting). */
  private printhRing: string[] = [];

  constructor(opts: EmulatorOptions) {
    this.gfx = new Graphics(this.mem);
    this.input = new Input(this.mem);
    this.audio = new Audio(this.mem);
    this.biosBytes = opts.biosBytes;
    this.onPrint = opts.onPrint ?? (() => {});
    this.userPrinth = opts.onPrinth ?? (() => {});
    this.clockSeed = opts.clockSeed ?? 0;
    this.printFn = opts.printFn ?? corePrint;
    this.buildState();
  }

  private buildState(): void {
    this.L = new LuaState();
    // z8lua's @ % $ peek opcodes read G(L)->pico8memory — inject the RAM
    // image so cart code (e.g. POOM's plain.lua mpeek stream) sees real bytes.
    this.L.pico8memory = this.mem.data;
    openLibs(this.L, { print: this.onPrint });
    this.host = {
      get frameCount() {
        return self.frameCount;
      },
      get targetFps() {
        return self.targetFps;
      },
      get fps() {
        return self.fps;
      },
      get cartParam() {
        return self.cartParam;
      },
      get breadcrumb() {
        return self.breadcrumb;
      },
      printh: (s) => {
        this.printhRing.push(s);
        this.userPrinth(s);
      },
      hookUpdateButtons: () => {
        // vm.cpp:1193-1225 — pause-menu policy is host-side; P3 has no menu,
        // so only the input state machine runs here.
        this.input.update(this.pendingInput);
        // The edges were just consumed — drop them so they can't fire again
        // on a later sample. Level fields (kHeld/mouse) stay; the platform
        // re-feeds them every tick.
        this.pendingInput.kDown = 0;
        this.pendingInput.kbDown = false;
        this.pendingInput.kbKey = "";
      },
      hookRun: () => {
        // fake-08 vm_run restarts immediately; restarting from inside a Lua
        // call would destroy the executing frame — defer to tick end.
        this.pendingRun = true;
      },
      hookExtcmd: (cmd) => {
        if (cmd === "reset") {
          this.pendingRun = true;
          return true;
        }
        return false; // pause/shutdown are P4 web-shell concerns
      },
      hookLoad: (name, crumb, param) => this.requestLoad(name, crumb, param),
      hookReload: (dest, src, len, filename) =>
        this.hookReload(dest, src, len, filename),
      printFn: (g, s, x, y, fg, bg) => this.printFn(g, s, x, y, fg, bg),
    };
    this.apiCtx = {
      mem: this.mem, gfx: this.gfx, input: this.input, host: this.host,
      audio: this.audio,
    };
    installApi(this.L, this.apiCtx);
    installBiosStubs(this.L);
    const self = this;
  }

  /** Load + execute assets/bios.bc in the current state (fake-08 vm ctor:
   *  register C functions → luaL_dostring(bios), vm.cpp:154-168). */
  private runBios(): void {
    if (this.biosProto === null) {
      this.biosProto = undump(this.biosBytes, "@bios.bc");
    }
    const cl = chunkClosure(this.L, this.biosProto, this.L.globals);
    runChunk(this.L, cl);
    this.biosRan = true;
  }

  /**
   * vm_run equivalent (vm.cpp:1274-1313): fresh bios state + reset memory +
   * srand + graphics defaults + pcall(__z8_run_cart, cartBytes).
   *
   * Cart bytecode is passed to the bios as a byte string; the bios calls
   * load() on it (our load undumps binary chunks). The glue frame loop is
   * already inside the bytecode (converter-appended), which is why the bios
   * was rewritten to a single-arg load — see extract-bios.ts.
   */
  loadCart(cart: CartImage | P8cFile): boolean {
    // P8C2 merged file: remember sub-carts for load()/reload(fn), run entry.
    if ("subs" in cart) {
      this.mergedSubs = cart.subs;
      return this.runCartCore(
        { bytecode: cart.bytecode, rom: cart.rom },
        true,
      );
    }
    this.mergedSubs = null;
    return this.runCartCore(cart, true);
  }

  /**
   * Boot / reboot one cart into a fresh VM state (buildState + runBios +
   * reset + __z8_run_cart). `freshRun` mirrors vm_run's frame counter reset;
   * sub-cart switches (Phase 3.5 load()) keep the host frame count, like
   * fake-08's LoadCart+vm_run sequence.
   */
  private runCartCore(cart: CartImage, freshRun: boolean): boolean {
    this.currentCart = cart;
    this.lastError = null;
    this.pendingRun = false;
    this.pendingLoad = null;
    if (freshRun) this.frameCount = 0;

    // fresh VM state per run (state survives across run() in fake-08 only
    // through globals; rebuilding keeps P3 simple & deterministic)
    this.buildState();
    this.runBios();

    this.mem.rom = cart.rom.length === ROM_SIZE
      ? cart.rom
      : cart.rom.subarray(0, ROM_SIZE);
    this.mem.reset();
    this.input.reset();
    this.audio.reset(); // fake-08 vm_run resets audio (vm.cpp:1291)
    // fake-08 vm_run: srand(clock) + graphics defaults after Reset
    const seed = this.clockSeed !== 0
      ? this.clockSeed
      : Math.trunc(Date.now() / 1000) | 0;
    this.srandSeed(fx.fromInt(seed));
    this.gfx.clip(0, 0, 128, 128);
    this.gfx.palReset();
    this.gfx.setColor(6);

    const runCart = this.L.globals.get("__z8_run_cart");
    if (!isCallable(runCart)) {
      this.lastError = "bios did not define __z8_run_cart";
      return false;
    }
    const cartCode = bytesToLatin1(cart.bytecode);
    const r = pcallLua(this.L, runCart, [cartCode]);
    if (!r.ok) {
      this.lastError = r.err.fullMessage();
      return false;
    }
    this.biosRan = true;
    return true;
  }

  // ------------------------------------------------------------------
  // Phase 3.5 multi-cart: load(name, crumb, param) / reload(..., fn)

  /** Resolve a sub-cart name: exact → append .p8 / .p8.png (zepto8-style). */
  findSub(name: string): P8cSub | null {
    if (!this.mergedSubs) return null;
    const direct = this.mergedSubs.get(name);
    if (direct) return direct;
    for (const ext of [".p8", ".p8.png"]) {
      const hit = this.mergedSubs.get(name + ext);
      if (hit) return hit;
    }
    return null;
  }

  /** api `__load` handler — validates now, switches at the tick boundary. */
  requestLoad(name: string, crumb: string, param: string): boolean {
    const sub = this.findSub(name);
    if (!sub || sub.bytecode === null || sub.bytecode.length === 0) {
      return false; // unknown name or data-only cart (fake-08: load fails)
    }
    // stat(6)/stat(100) become readable immediately (official behaviour:
    // param is readable right after load is requested).
    this.cartParam = param;
    this.breadcrumb = crumb;
    this.pendingLoad = { name, crumb, param };
    return true;
  }

  /** api `reload(dest,src,len,filename)` handler — copy from a sub-cart ROM. */
  hookReload(dest: number, src: number, len: number, filename: string): boolean {
    const sub = this.findSub(filename);
    if (!sub) return false; // caller reports the missing cart
    if (len <= 0 || dest < 0 || dest > MEM_SIZE) return true; // silent no-op
    if (src < 0 || src > ROM_SIZE) return true;
    if (dest + len > MEM_SIZE) return true;
    const n = Math.min(len, ROM_SIZE - src);
    if (n > 0) this.mem.data.set(sub.rom.subarray(src, src + n), dest);
    return true;
  }

  /** Switch to a queued sub-cart after the current tick finished. */
  private applyPendingLoad(): void {
    const p = this.pendingLoad;
    if (!p) return;
    const sub = this.findSub(p.name);
    if (!sub || !sub.bytecode) {
      this.pendingLoad = null;
      this.lastError = `load: sub-cart ${p.name} became unavailable`;
      return;
    }
    // keep frameCount (fake-08 does not reset the pico frame counter on
    // LoadCart); everything else is a full runCartCore.
    this.runCartCore({ bytecode: sub.bytecode, rom: sub.rom }, false);
    this.cartParam = p.param; // runCartCore keeps host fields, but be explicit
    this.breadcrumb = p.crumb;
  }

  private srandSeed(seed: number): void {
    const srand = this.L.globals.get("srand");
    if (typeof srand === "function") callFunction(this.L, srand, [seed]);
  }

  /**
   * One host frame: sample input, frameCount++, pcall(__z8_tick).
   * Returns false when the bios reports a cart error (-1) — see __z8_tick
   * (p8GlobalLuaFunctions.h:599-632).
   */
  tick(input: HostInputState = EMPTY_HOST_INPUT): boolean {
    if (!this.biosRan) return false;
    // Latch button edges (and the keyboard buffer) until the bios's
    // _update_buttons consumes them: the 30fps glue only samples input every
    // other frame, so a 1-frame platform edge would be dropped ~50% of the
    // time (KNOWN-GAPS §6.2). Level fields always carry the latest sample.
    this.pendingInput = {
      kDown: this.pendingInput.kDown | input.kDown,
      kHeld: input.kHeld,
      mouseX: input.mouseX,
      mouseY: input.mouseY,
      mouseBtns: input.mouseBtns,
      kbDown: input.kbDown || this.pendingInput.kbDown,
      kbKey: input.kbKey || this.pendingInput.kbKey,
    };
    this.frameCount++;
    this.printhRing = [];

    const tickFn = this.L.globals.get("__z8_tick");
    if (!isCallable(tickFn)) {
      this.lastError = "bios did not define __z8_tick";
      return false;
    }
    try {
      const r = pcallLua(this.L, tickFn, []);
      if (!r.ok) {
        this.lastError = r.err.fullMessage();
        return false;
      }
      const code = r.results[0];
      if (code === null) {
        // pcall failed inside tick? treat nil as failure
        this.lastError = "tick returned nil";
        return false;
      }
      if (typeof code === "number" && fx.toInt(code) === -1) {
        // __z8_tick returns -1 both after a coroutine error (which it printh()s
        // first — p8GlobalLuaFunctions.h:626) and when a loopless cart's
        // coroutine simply finishes (costatus "dead" with nothing to do —
        // same as PICO-8 freezing on the last frame). Only the printh
        // message means failure; a bare -1 is a clean run-to-completion.
        const reported = this.printhRing.at(-1);
        if (reported !== undefined) {
          this.lastError = reported;
          return false;
        }
        return true;
      }
    } catch (e) {
      if (e instanceof YieldSignal || e instanceof BudgetSignal) {
        throw new Error(
          "host tick saw a yield/budget signal escape the bios — " +
            "coroutine boundary bug",
        );
      }
      if (e instanceof LuaError) {
        this.lastError = e.fullMessage() + "\n" + tracebackString(this.L, null, 0);
        return false;
      }
      throw e;
    }

    // tick-boundary cart switches (Phase 3.5): load() first, then run()/reset
    if (this.pendingLoad) {
      this.applyPendingLoad();
    } else if (this.pendingRun && this.currentCart) {
      // restart the current entry cart — go through the core so P8C2 subs
      // stay registered (loadCart(CartImage) would clear them).
      this.runCartCore(this.currentCart, true);
    }
    return this.lastError === null;
  }

  /** Current framebuffer (8KB at the mapped address) — presentation reads it. */
  framebuffer(): Uint8Array {
    const base = this.gfx.framebufferBase();
    return this.mem.data.subarray(base, base + 8192);
  }

  /** Screen palette map (16 bytes at 0x5f10). */
  screenPalette(): Uint8Array {
    return this.mem.data.subarray(DRAW.SCREEN_PAL, DRAW.SCREEN_PAL + 16);
  }
}

// ---------------------------------------------------------------------------
// bios-side C function stubs (vm.cpp:50-71) — menu/shell surface the bios
// references at load time or on error paths. P3 runs carts headless: the
// stubs keep the bios alive without a platform shell.

function installBiosStubs(L: LuaState): void {
  const put = (name: string, fn: () => Value[]) => L.globals.set(name, fn);

  put("__ispaused", () => [false]); // no pause menu in P3
  put("__togglepausemenu", () => []);
  put("__getbioserror", () => [""]);
  put("__loaddefaultcart", () => {
    // Error path of __z8_tick: fake-08 queues the default cart. P3 has no
    // shell menu — record and no-op (host keeps lastError for tests).
    return [];
  });
  put("__resetcart", () => []);
  // NOTE: __load is registered by installApi (Phase 3.5 sub-cart switching) —
  // do not stub it here; the stub used to shadow the real binding.
  put("__loadsettingscart", () => [false]);
  put("__loadlabel", () => [false]);
  put("__getlualine", () => [fx.fromInt(0)]);
  put("__getsetting", () => [null]);
  put("__setsetting", () => []);
  put("__installpackins", () => []);
  put("__listcarts", () => {
    const t = new Table();
    return [t];
  });
  put("__listdirs", () => {
    const t = new Table();
    return [t];
  });
  put("__cd", () => [true]);
  put("__pwd", () => ["/"]);
  // menuitem lives in the bios (Lua side); nothing to register here.
}
