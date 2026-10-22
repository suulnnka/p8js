// PICO-8 memory: the 64KB RAM image plus the vm_peek/vm_poke family.
// Port of fake-08 PicoRam.h + Vm::vm_peek* / vm_poke* / vm_memcpy* / vm_reload
// / vm_dget* (file:line noted per function).
//
// Layout (PicoRam.h:9-22):
//   0x0000 gfx (0-127) / 0x1000 gfx (128-255)+map rows 32-63 / 0x2000 map
//   0x3000 sprite flags / 0x3100 music / 0x3200 sfx / 0x4300 work RAM
//   0x5e00 cartdata / 0x5f00 draw state / 0x5f40 hw state / 0x5f80 GPIO
//   0x6000 screen (8k, 4bpp nibbles)
//
// Known divergence: fake-08's vm_peek accepts addr == 0x10000 (its check is
// `addr > 0x10000`) and then reads one byte past PicoRam — C undefined
// behaviour. We clamp to 0; peek_large_count-style carts get calibrated
// against golden frames during Phase 3 acceptance if they depend on it.

import * as fx from "../vm/fix32.ts";

export const MEM_SIZE = 0x10000;
/** Cart ROM image size (0x0000-0x42ff) — the reload() source window. */
export const ROM_SIZE = 0x4300;

/** Draw-state register offsets (drawState_t @ 0x5f00, PicoRam.h:179-227). */
export const DRAW = {
  DRAW_PAL: 0x5f00, // drawPaletteMap[16]
  SCREEN_PAL: 0x5f10, // screenPaletteMap[16]
  CLIP_XB: 0x5f20,
  CLIP_YB: 0x5f21,
  CLIP_XE: 0x5f22,
  CLIP_YE: 0x5f23,
  COLOR: 0x5f25,
  TEXT_X: 0x5f26,
  TEXT_Y: 0x5f27,
  CAMERA_X: 0x5f28, // int16 LE
  CAMERA_Y: 0x5f2a, // int16 LE
  DRAW_MODE: 0x5f2c, // fake-08 drawMode (persist flag set by pal/palt paths)
  DEVKIT_MODE: 0x5f2d,
  PERSIST_PALETTE: 0x5f2e,
  SOUND_PAUSE: 0x5f2f,
  SUPPRESS_PAUSE: 0x5f30,
  FILL_PATTERN: 0x5f31, // [2] bytes, hi/lo
  FILL_PTrans: 0x5f33, // fillPatternTransparencyBit (0x5f34 alt naming
  //                      in official docs; struct field order rules: 0x5f33)
  COLOR_SETTING_FLAG: 0x5f34,
  LINE_INVALID: 0x5f35,
  TLINE_MAP_W: 0x5f38,
  TLINE_MAP_H: 0x5f39,
  TLINE_MAP_X: 0x5f3a,
  TLINE_MAP_Y: 0x5f3b,
  LINE_X: 0x5f3c, // int16 LE
  LINE_Y: 0x5f3e, // int16 LE
} as const;

/** Hardware-state register offsets (hwState_t @ 0x5f40, PicoRam.h:230-275). */
export const HW = {
  HALF_RATE: 0x5f40,
  REVERB: 0x5f41,
  DISTORT: 0x5f42,
  LOWPASS: 0x5f43,
  RNG: 0x5f44, // rngState[2] uint32 LE ×2 (0x5f44-0x5f4b)
  BUTTONS: 0x5f4c, // buttonStates[8] (0x5f4c-0x5f53)
  SHEET_MAPPING: 0x5f54,
  SCREEN_MAPPING: 0x5f55,
  MAP_MAPPING: 0x5f56,
  MAP_WIDTH: 0x5f57,
  PRINT_ATTR: 0x5f58,
  PRINT_CHAR_DIM: 0x5f59,
  PRINT_TAB: 0x5f5a,
  PRINT_OFFSET_DIM: 0x5f5b,
  BTNP_DELAY: 0x5f5c,
  BTNP_INTERVAL: 0x5f5d,
  COLOR_BITMASK: 0x5f5e,
  ALT_PAL_FLAG: 0x5f5f,
  ALT_PAL_MAP: 0x5f60, // [16]
  ALT_PAL_LINE: 0x5f70, // [16]
  GPIO: 0x5f80,
} as const;

export const ADDR = {
  CARTDATA: 0x5e00,
  SCREEN: 0x6000,
} as const;

export class PicoMemory {
  readonly data = new Uint8Array(MEM_SIZE);
  /** Current cart's ROM window (0x4300) — source for reload(). */
  rom: Uint8Array = new Uint8Array(ROM_SIZE);
  /** Active cartdata key (session-level; shared across carts, P3.5 TODO). */
  cartdataKey: string | null = null;

  /** PicoRam::Reset (PicoRam.h:281-291): clears gfx/map/sfx + draw/hw/screen,
   *  leaves work RAM (0x4300-0x5dff) and cartdata (0x5e00-0x5eff) intact. */
  reset(): void {
    this.data.fill(0, 0, 0x4300);
    this.data.fill(0, 0x5f00, 0x8000);
    this.data[HW.COLOR_BITMASK] = 0xff;
    this.data[HW.SHEET_MAPPING] = 0x00;
    this.data[HW.SCREEN_MAPPING] = 0x60;
    this.data[HW.MAP_MAPPING] = 0x20;
    this.data[HW.MAP_WIDTH] = 128;
  }

  // ------------------------------------------------------------------
  // vm_peek / vm_poke family (vm.cpp:952-1020)

  peek(addr: number): number {
    if (addr < 0 || addr >= MEM_SIZE) return 0;
    return this.data[addr];
  }

  /** Little-endian u16; partial reads at the top wrap to low addresses
   *  (vm.cpp:960-973). */
  peek2(addr: number): number {
    let bits = 0;
    for (let i = 0; i < 2; i++) {
      const a = addr + i;
      if (a < MEM_SIZE) bits |= this.data[a] << (8 * i);
      else if (a >= MEM_SIZE) bits |= this.data[a - MEM_SIZE] << (8 * i);
    }
    return bits << 16 >> 16; // int16
  }

  /** fix32 bit pattern from 4 LE bytes with wraparound (vm.cpp:976-989). */
  peek4(addr: number): number {
    let bits = 0;
    for (let i = 0; i < 4; i++) {
      const a = addr + i;
      if (a < MEM_SIZE) bits |= this.data[a] << (8 * i);
      else if (a >= MEM_SIZE) bits |= this.data[a - MEM_SIZE] << (8 * i);
    }
    return bits | 0;
  }

  poke(addr: number, value: number): void {
    if (addr < 0 || addr >= MEM_SIZE) return;
    this.data[addr] = value & 0xff;
  }

  poke2(addr: number, value: number): void {
    if (addr < 0 || addr > MEM_SIZE - 1) return;
    this.data[addr] = value & 0xff;
    this.data[addr + 1] = (value >> 8) & 0xff;
  }

  poke4(addr: number, bits: number): void {
    if (addr < 0 || addr > MEM_SIZE - 3) return;
    this.data[addr] = bits & 0xff;
    this.data[addr + 1] = (bits >>> 8) & 0xff;
    this.data[addr + 2] = (bits >>> 16) & 0xff;
    this.data[addr + 3] = (bits >>> 24) & 0xff;
  }

  // ------------------------------------------------------------------
  // vm_memcpy / vm_memset (vm.cpp:1138-1161): whole-range bounds check,
  // out-of-range requests are a no-op.

  memcpy(dest: number, src: number, len: number): void {
    if (len <= 0) return;
    if (src < 0 || src + len > MEM_SIZE) return;
    if (dest < 0 || dest + len > MEM_SIZE) return;
    this.data.copyWithin(dest, src, src + len);
  }

  memset(dest: number, val: number, len: number): void {
    if (len <= 0) return;
    if (dest < 0 || dest + len > MEM_SIZE) return;
    this.data.fill(val & 0xff, dest, dest + len);
  }

  // ------------------------------------------------------------------
  // reload (vm.cpp:1091-1136): copy len bytes from cart ROM into RAM.
  // The multi-cart filename variant is Phase 3.5 (load/reload(fn)).

  reload(dest: number, src: number, len: number): void {
    if (len <= 0) return;
    if (dest < 0 || dest > MEM_SIZE) return;
    if (src < 0 || src > ROM_SIZE) return;
    if (dest + len > MEM_SIZE) return;
    const n = Math.min(len, ROM_SIZE - src);
    if (n <= 0) return;
    this.data.set(this.rom.subarray(src, src + n), dest);
  }

  // ------------------------------------------------------------------
  // cartdata / dget / dset (vm.cpp:1077-1089): 64 × fix32 at 0x5e00.

  dget(n: number): number {
    if (n >= 0 && n < 64) return this.peek4(ADDR.CARTDATA + 4 * n);
    return 0;
  }

  dset(n: number, bits: number): void {
    if (n >= 0 && n < 64) this.poke4(ADDR.CARTDATA + 4 * n, bits);
  }

  // ------------------------------------------------------------------
  // PRNG (vm.cpp:1163-1168): xorshift-rotate pair, state at 0x5f44.

  updatePrng(): void {
    const s0 = this.peek4(HW.RNG);
    const s1 = this.peek4(HW.RNG + 4) >>> 0;
    const rot = ((s1 >>> 16) | (s1 << 16)) >>> 0;
    const ns1 = (s0 + rot) >>> 0;
    const ns0 = (s0 + ns1) >>> 0;
    this.poke4(HW.RNG, ns0 | 0);
    this.poke4(HW.RNG + 4, ns1 | 0);
  }

  /** LE int16 at addr (camera/line registers). */
  peekInt16(addr: number): number {
    return this.data[addr] | (this.data[addr + 1] << 8) << 16 >> 16;
  }

  pokeInt16(addr: number, v: number): void {
    this.data[addr] = v & 0xff;
    this.data[addr + 1] = (v >> 8) & 0xff;
  }

  /** Load a ROM image into both the ROM window and RAM (cart boot). */
  loadRom(rom: Uint8Array): void {
    this.rom = rom.length === ROM_SIZE ? rom : rom.subarray(0, ROM_SIZE);
    // Initial cart load fills the resource area (official "reload all").
    this.data.set(this.rom.subarray(0, Math.min(this.rom.length, 0x4300)), 0);
  }
}

export { fx };
