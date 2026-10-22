// input.ts — fake-08 Input.cpp SetState / update_buttons semantics.
import { describe, expect, it } from "vitest";
import { PicoMemory, HW } from "../src/core/memory.ts";
import { Input, EMPTY_HOST_INPUT } from "../src/core/input.ts";

function mk(): { mem: PicoMemory; inp: Input } {
  const mem = new PicoMemory();
  return { mem, inp: new Input(mem) };
}

describe("Input SetState / btnp repeat", () => {
  it("writes held & 0x3F to 0x5f4c and exposes btn/btnp masks", () => {
    const { mem, inp } = mk();
    inp.setState(0b000011, 0b101011); // held has bit6? no — bits 0,1,3,5
    expect(mem.data[HW.BUTTONS]).toBe(0b101011);
    expect(inp.btnMask()).toBe(0b101011);
    expect(inp.btnpMask()).toBe(0b000011);
    expect(inp.btn(0)).toBe(true);
    expect(inp.btn(2)).toBe(false);
    expect(inp.btnp(1)).toBe(true);
    expect(inp.btnp(3)).toBe(false);
  });

  it("fires repeats after 15 held frames then every 4th (default regs)", () => {
    const { inp } = mk();
    // frames 1..14: no repeat yet (only raw edges)
    for (let f = 1; f <= 14; f++) inp.setState(0, 0b1);
    expect(inp.btnpMask() & 1).toBe(0);
    inp.setState(0, 0b1); // frame 15
    expect(inp.btnpMask() & 1).toBe(1);
    for (let f = 0; f < 3; f++) inp.setState(0, 0b1);
    expect(inp.btnpMask() & 1).toBe(0); // frames 16-18
    inp.setState(0, 0b1); // frame 19? 15+4=19 → repeat
    // framesHeld: 15 fired, 16,17,18, then 19 % 4 != 0...
    // repeat at framesHeld == 15, then fh>=15 && fh%4==0 → 16,20,24…
    // After the frame at fh=15, next frames: 16 (16%4==0 → fire)
    expect(inp.btnpMask() & 1).toBe(0); // fh=16 fired in previous loop? recount below
  });

  it("repeat schedule: fires at fh==delay, then every interval frames", () => {
    const { inp } = mk();
    const fired: number[] = [];
    for (let fh = 1; fh <= 30; fh++) {
      inp.setState(0, 0b1);
      if (inp.btnpMask() & 1) fired.push(fh);
    }
    // default delay 15, interval 4: fh==15 → fire; fh>=15 && fh%4==0 → 16,20,24,28
    expect(fired).toEqual([15, 16, 20, 24, 28]);
  });

  it("release resets the counter", () => {
    const { inp } = mk();
    for (let f = 0; f < 14; f++) inp.setState(0, 1);
    inp.setState(0, 0); // release → framesHeld = 0
    for (let f = 0; f < 14; f++) inp.setState(0, 1);
    expect(inp.btnpMask() & 1).toBe(0); // only 14 held
    inp.setState(0, 1);
    expect(inp.btnpMask() & 1).toBe(1); // 15th again
  });

  it("0x5f5c=255 disables repeats entirely (Input.cpp:30-32)", () => {
    const { mem, inp } = mk();
    mem.data[HW.BTNP_DELAY] = 255;
    for (let f = 0; f < 40; f++) inp.setState(0, 1);
    expect(inp.btnpMask() & 1).toBe(0);
    expect(inp.btnMask() & 1).toBe(1); // held still works
  });

  it("custom delay from 0x5f5c; interval fallback reads DELAY reg (bug)", () => {
    const { mem, inp } = mk();
    mem.data[HW.BTNP_DELAY] = 2;
    mem.data[HW.BTNP_INTERVAL] = 0; // → interval = 4
    const fired: number[] = [];
    for (let fh = 1; fh <= 8; fh++) {
      inp.setState(0, 1);
      if (inp.btnpMask() & 1) fired.push(fh);
    }
    // fh==2 (equality) then fh%4==0 → 4, 8 (6 % 4 != 0)
    expect(fired).toEqual([2, 4, 8]);

    // interval reg non-zero → fake-08 uses the DELAY value as interval (bug)
    const { mem: m2, inp: i2 } = mk();
    m2.data[HW.BTNP_DELAY] = 3;
    m2.data[HW.BTNP_INTERVAL] = 99; // ignored
    const fired2: number[] = [];
    for (let fh = 1; fh <= 9; fh++) {
      i2.setState(0, 1);
      if (i2.btnpMask() & 1) fired2.push(fh);
    }
    // fh==3 → fire; fh>=3 && fh%3==0 → 6, 9
    expect(fired2).toEqual([3, 6, 9]);
  });

  it("pause bit 6 fires for one frame only and never reaches 0x5f4c", () => {
    const { mem, inp } = mk();
    inp.setState(1 << 6, 1 << 6); // down+held
    expect(inp.btnMask() & (1 << 6)).toBe(1 << 6);
    expect(mem.data[HW.BUTTONS] & (1 << 6)).toBe(0); // only 0-5 stored
    inp.setState(0, 1 << 6); // still held, not down
    expect(inp.btnMask() & (1 << 6)).toBe(0); // cleared (Input.cpp:20-22)
  });

  it("btn(i,p)/btnp(i,p) with player != 0 is always false", () => {
    const { inp } = mk();
    inp.setState(0b111111, 0b111111);
    expect(inp.btn(0, 1)).toBe(false);
    expect(inp.btnp(0, 1)).toBe(false);
    expect(inp.btn(0, 0)).toBe(true);
  });
});

describe("Input.update (update_buttons)", () => {
  it("gates mouse/keyboard behind devkitMode 0x5f2d", () => {
    const { mem, inp } = mk();
    const host = {
      ...EMPTY_HOST_INPUT,
      mouseX: 42,
      mouseY: 77,
      mouseBtns: 1,
      kbDown: true,
      kbKey: "a",
    };
    inp.update(host);
    expect(inp.mouseX).toBe(0); // devkit off → cleared
    expect(inp.kbDown).toBe(false);
    mem.data[0x5f2d] = 1;
    inp.update(host);
    expect(inp.mouseX).toBe(42);
    expect(inp.mouseY).toBe(77);
    expect(inp.mouseBtns).toBe(1);
    expect(inp.kbDown).toBe(true);
    expect(inp.kbKey).toBe("a");
  });

  it("stat(31) key read consumes the kb buffer", () => {
    const { mem, inp } = mk();
    mem.data[0x5f2d] = 1;
    inp.update({ ...EMPTY_HOST_INPUT, kbDown: true, kbKey: "z" });
    expect(inp.consumeKey()).toBe("z");
    expect(inp.kbDown).toBe(false);
  });

  it("clearInputOnResume zeroes input until O/X released", () => {
    const { inp } = mk();
    inp.clearInputOnResume = true;
    // menu-closing key (O/X) still held → keep clearing, flag stays armed
    inp.update({ ...EMPTY_HOST_INPUT, kDown: 0x10, kHeld: 0x30 });
    expect(inp.btnMask()).toBe(0);
    expect(inp.clearInputOnResume).toBe(true);
    inp.update({ ...EMPTY_HOST_INPUT, kHeld: 0x30 });
    expect(inp.clearInputOnResume).toBe(true);
    inp.update({ ...EMPTY_HOST_INPUT, kHeld: 0 }); // released → flag clears
    expect(inp.clearInputOnResume).toBe(false);
  });

  it("reports pause press via return value", () => {
    const { inp } = mk();
    expect(inp.update({ ...EMPTY_HOST_INPUT, kDown: 1 << 6, kHeld: 1 << 6 })).toBe(true);
    expect(inp.update({ ...EMPTY_HOST_INPUT, kDown: 0, kHeld: 1 << 6 })).toBe(false);
  });
});
