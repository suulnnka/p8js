// memory.ts — fake-08 PicoRam / vm_peek* / vm_memcpy semantics.
import { describe, expect, it } from "vitest";
import { PicoMemory, DRAW, HW, ADDR, MEM_SIZE, ROM_SIZE } from "../src/core/memory.ts";

describe("PicoMemory peek/poke", () => {
  it("reads and writes bytes, clamps out-of-range to 0 / no-op", () => {
    const m = new PicoMemory();
    m.poke(0x6000, 0xab);
    expect(m.peek(0x6000)).toBe(0xab);
    expect(m.peek(-1)).toBe(0);
    expect(m.peek(MEM_SIZE)).toBe(0);
    expect(m.peek(MEM_SIZE + 5)).toBe(0);
    m.poke(MEM_SIZE, 7); // no-op
    expect(m.peek(MEM_SIZE)).toBe(0);
  });

  it("peek2/poke2 are little-endian int16 with wraparound reads", () => {
    const m = new PicoMemory();
    m.poke2(0x4300, 0x1234);
    expect(m.peek(0x4300)).toBe(0x34);
    expect(m.peek(0x4301)).toBe(0x12);
    expect(m.peek2(0x4300)).toBe(0x1234);
    expect(m.peek2(0x4301)).toBe(0x12); // 0x12 followed by 0x00
    // partial read wraps to low memory (vm.cpp:960-973); result is int16
    m.poke(0x0000, 0xee);
    m.poke(0xffff, 0x77);
    expect(m.peek2(0xffff)).toBe(0xee77 << 16 >> 16); // signed: -4489
    expect(m.peek2(0x7fff)).toBe(0); // screen tail + 0
  });

  it("peek4/poke4 round-trip a fix32 bit pattern LE", () => {
    const m = new PicoMemory();
    m.poke4(0x5e00, 0x12345678 | 0);
    expect(m.peek(0x5e00)).toBe(0x78);
    expect(m.peek(0x5e03)).toBe(0x12);
    expect(m.peek4(0x5e00)).toBe(0x12345678 | 0);
    // wraparound read: 0xfffe, 0xffff, 0x10000→0x0000, 0x0001
    m.poke(0xffff, 0x5a);
    m.poke(0x0000, 0xa5);
    const w = m.peek4(0xfffe);
    expect(w & 0xff).toBe(0x00); // 0xfffe untouched
    expect((w >>> 8) & 0xff).toBe(0x5a);
    expect((w >>> 16) & 0xff).toBe(0xa5);
    expect((w >>> 24) & 0xff).toBe(0x00);
  });
});

describe("PicoMemory memcpy/memset bounds", () => {
  it("copies within range", () => {
    const m = new PicoMemory();
    m.poke(0x100, 0x11);
    m.poke(0x101, 0x22);
    m.memcpy(0x200, 0x100, 2);
    expect(m.peek(0x200)).toBe(0x11);
    expect(m.peek(0x201)).toBe(0x22);
  });

  it("rejects any range that pokes past 0x10000 (vm.cpp:1142-1158)", () => {
    const m = new PicoMemory();
    m.memset(0x10000 - 3, 0xaa, 4); // dest+len > 0x10000 → no-op
    expect(m.peek(0x10000 - 3)).toBe(0);
    m.memcpy(MEM_SIZE - 1, 0, 2); // dest overflow → no-op
    expect(m.peek(MEM_SIZE - 1)).toBe(0);
    m.memcpy(0, MEM_SIZE - 1, 2); // src overflow → no-op
    expect(m.peek(0)).toBe(0);
    m.memset(0x100, 0x55, 0); // len <= 0 → no-op
    expect(m.peek(0x100)).toBe(0);
  });
});

describe("PicoMemory reset / reload / cartdata", () => {
  it("reset clears resource + draw/hw/screen but keeps work RAM and cartdata", () => {
    const m = new PicoMemory();
    m.poke(0x0000, 1); // gfx
    m.poke(0x4300, 2); // work RAM
    m.poke(ADDR.CARTDATA, 3); // cartdata
    m.poke(DRAW.COLOR, 9);
    m.reset();
    expect(m.peek(0x0000)).toBe(0);
    expect(m.peek(0x4300)).toBe(2);
    expect(m.peek(ADDR.CARTDATA)).toBe(3);
    // reset defaults (PicoRam.h:286-290)
    expect(m.peek(HW.COLOR_BITMASK)).toBe(0xff);
    expect(m.peek(HW.SCREEN_MAPPING)).toBe(0x60);
    expect(m.peek(HW.MAP_MAPPING)).toBe(0x20);
    expect(m.peek(HW.SHEET_MAPPING)).toBe(0x00);
    expect(m.peek(HW.MAP_WIDTH)).toBe(128);
    expect(m.peek(DRAW.COLOR)).toBe(0);
  });

  it("reload copies from the ROM window with bounds checks", () => {
    const m = new PicoMemory();
    const rom = new Uint8Array(ROM_SIZE);
    rom[0] = 0x42;
    rom[0x42ff] = 0x99;
    m.loadRom(rom);
    expect(m.peek(0)).toBe(0x42);
    m.poke(0x6000, 0);
    m.reload(0x6000, 0, 1);
    expect(m.peek(0x6000)).toBe(0x42);
    // out-of-window source rejected (src > 0x4300)
    m.reload(0x6100, 0x4301, 1);
    expect(m.peek(0x6100)).toBe(0);
    // len clamp to ROM end
    m.reload(0x7ffe, 0x42ff, 0x100);
    expect(m.peek(0x7ffe)).toBe(0x99);
  });

  it("dget/dset store 64 fix32 values at 0x5e00", () => {
    const m = new PicoMemory();
    m.dset(0, 0x00018000); // 1.5
    m.dset(63, -0x00010000 | 0); // -1
    expect(m.dget(0)).toBe(0x00018000);
    expect(m.dget(63)).toBe(-0x00010000 | 0);
    expect(m.dget(64)).toBe(0); // out of range
    m.dset(64, 1); // no-op
    expect(m.peek4(ADDR.CARTDATA + 64 * 4)).toBe(0);
  });

  it("prng advances both words (vm.cpp:1163-1168)", () => {
    const m = new PicoMemory();
    m.poke4(HW.RNG, 0x12345678 | 0);
    m.poke4(HW.RNG + 4, 0x1 | 0);
    const before0 = m.peek4(HW.RNG);
    const before1 = m.peek4(HW.RNG + 4);
    m.updatePrng();
    expect(m.peek4(HW.RNG)).not.toBe(before0);
    expect(m.peek4(HW.RNG + 4)).not.toBe(before1);
    // s1' = s0 + rotl(s1,16); s0' = s0 + s1'
    const s1 = before1 >>> 0;
    const expected1 = ((before0 >>> 0) + (((s1 >>> 16) | (s1 << 16)) >>> 0)) >>> 0;
    expect(m.peek4(HW.RNG + 4) >>> 0).toBe(expected1);
  });
});
