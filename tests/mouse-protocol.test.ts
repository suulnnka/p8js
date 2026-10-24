// Regression for KNOWN-GAPS §7.2 (POOM title menu ignores the mouse): the VM
// only implemented stat(32-34) — the official 0.2.4 devkit protocol's motion
// stats (35-39) returned 0, so carts that accumulate stat(38)/stat(39) deltas
// (POOM's menu) never saw movement. Input now splits the 0x5f2d flag bits
// (0x1 enable, 0x2 mouse buttons → btn(4..6), 0x4 pointer tracking) and the
// host latches motion deltas across 30fps glue yield frames like button edges.
//
// The fixture cart pokes 0x5f2d,7 and tallies one frame of mouse input. A
// 1-tick motion pulse is fired at BOTH glue phases — before the latch it was
// lost on the yield phase, exactly like the §6.2 button edges.
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertCart } from "../tools/convert.ts";
import { loadP8c } from "../src/core/p8c.ts";
import { Emulator } from "../src/core/host.ts";
import { EMPTY_HOST_INPUT, type HostInputState } from "../src/core/input.ts";
import { readBios } from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function idle(): HostInputState {
  return { ...EMPTY_HOST_INPUT };
}

async function loadFixture(): Promise<Emulator> {
  const { p8c } = await convertCart(join(HERE, "fixtures", "mouse-protocol.p8"), {
    input: "", output: null, source: false, label: false,
  });
  const file = await loadP8c(p8c);
  const emu = new Emulator({ biosBytes: readBios(), clockSeed: 1 });
  expect(emu.loadCart(file), emu.lastError ?? "").toBe(true);
  return emu;
}

describe("devkit mouse protocol (stat 35-39)", () => {
  for (const pressTick of [3, 4]) {
    it(`delivers a 1-tick motion pulse fired on tick ${pressTick}`, async () => {
      const emu = await loadFixture();

      for (let f = 1; f < pressTick; f++) {
        expect(emu.tick(idle()), `tick ${f}`).toBe(true);
      }
      // the motion/wheel pulse is a one-tick DELTA; the click is a LEVEL
      // held for 4 ticks (like a real button press)
      const pulse = (): HostInputState => ({
        ...EMPTY_HOST_INPUT,
        mouseDX: 1,
        mouseDY: -1,
        mouseWheel: 1,
        mouseClicked: true,
        mouseBtns: 1,
      });
      const hold = (): HostInputState => ({
        ...EMPTY_HOST_INPUT,
        mouseBtns: 1,
      });
      expect(emu.tick(pulse()), `pulse @ ${pressTick}`).toBe(true);
      for (let f = pressTick + 1; f <= pressTick + 3; f++) {
        expect(emu.tick(hold()), `hold tick ${f}`).toBe(true);
      }
      for (let f = pressTick + 4; f <= 12; f++) {
        expect(emu.tick(idle()), `tick ${f}`).toBe(true);
      }

      const m = emu.mem;
      expect(m.peek(0x4300), `stat(38) dx @${pressTick} — ${emu.lastError ?? ""}`).toBe(1);
      expect(m.peek(0x4301), `stat(39) dy @${pressTick} — ${emu.lastError ?? ""}`).toBe(1);
      expect(m.peek(0x4302), `stat(34) left @${pressTick}`).toBe(1);
      expect(m.peek(0x4303), `stat(36) wheel @${pressTick}`).toBe(1);
      expect(m.peek(0x4304), `btnp(4) click edge @${pressTick}`).toBe(1);
    });
  }

  it("emits each motion field exactly once per sample (no re-fire)", async () => {
    const emu = await loadFixture();
    const pulse = { ...EMPTY_HOST_INPUT, mouseDX: 5, mouseWheel: 1 };
    // tick 1 is the glue's yield phase — the sample lands on tick 2
    expect(emu.tick(pulse), "pulse").toBe(true);
    for (let f = 0; f < 4; f++) expect(emu.tick(idle()), `idle ${f}`).toBe(true);
    expect(emu.mem.peek(0x4300), "dx counted").toBe(1);
    expect(emu.mem.peek(0x4303), "wheel counted").toBe(1);
  });

  it("btn emulation flags: left→4, right→5, middle→6, edges only on new press", async () => {
    const emu = await loadFixture();
    const left = { ...EMPTY_HOST_INPUT, mouseBtns: 1 };
    // hold long enough to span both glue phases: sample, yield, sample
    for (let f = 0; f < 3; f++) expect(emu.tick(left), `left ${f}`).toBe(true);
    expect(emu.mem.peek(0x4304), "one click edge").toBe(1);
    expect(emu.mem.peek(0x4302), "level seen").toBe(1);
    // release (2 ticks: yield + sample) → re-press (2 ticks) → second edge
    for (let f = 0; f < 2; f++) expect(emu.tick(idle()), `rel ${f}`).toBe(true);
    for (let f = 0; f < 2; f++) expect(emu.tick(left), `re ${f}`).toBe(true);
    expect(emu.mem.peek(0x4304), "second click edge").toBe(2);

    // middle → btnp(6) — the pause signal comes from Input.update, one frame
    const { Input } = await import("../src/core/input.ts");
    const { PicoMemory } = await import("../src/core/memory.ts");
    const mem = new PicoMemory();
    const inp = new Input(mem);
    inp.update({ ...EMPTY_HOST_INPUT, mouseBtns: 4 }); // no flags set → gated
    expect(inp.btnp(6)).toBe(false);
    mem.data[0x5f2d] = 0x7; // enable | btn-emu | tracking
    expect(inp.update({ ...EMPTY_HOST_INPUT, mouseBtns: 4 }), "middle fires pause").toBe(true);
    expect(inp.btnp(6)).toBe(true);
    expect(inp.update({ ...EMPTY_HOST_INPUT, mouseBtns: 4 }), "held middle no re-fire").toBe(false);
    expect(inp.btn(4)).toBe(false);
    expect(inp.update({ ...EMPTY_HOST_INPUT, mouseBtns: 1 }), "left → btn(4)").toBe(false);
    expect(inp.btn(4)).toBe(true);
    expect(inp.btn(5)).toBe(false);
    expect(inp.update({ ...EMPTY_HOST_INPUT, mouseBtns: 2 }), "right → btn(5)").toBe(false);
    expect(inp.btn(5)).toBe(true);
  });

  it("flags: motion stats need 0x4, everything needs 0x1 (POOM pokes 7)", async () => {
    const emu = await loadFixture();
    // 0x1 only (no 0x4): position passes through, deltas stay 0
    // (indirectly observable: the fixture tallies stat(38) via 0x4300)
    const { Input } = await import("../src/core/input.ts");
    const { PicoMemory } = await import("../src/core/memory.ts");
    const mem = new PicoMemory();
    const inp = new Input(mem);
    const host = {
      ...EMPTY_HOST_INPUT,
      mouseX: 10, mouseY: 20,
      mouseDX: 3, mouseDY: -4,
      mouseWheelH: 7, mouseWheel: 1, mouseClicked: true,
    };
    mem.data[0x5f2d] = 0x1;
    inp.update(host);
    expect(inp.mouseX).toBe(10);
    expect(inp.mouseDX).toBe(0); // 0x4 missing
    expect(inp.mouseDY).toBe(0);
    expect(inp.mouseWheelH).toBe(7); // wheel rides on 0x1
    expect(inp.mouseWheel).toBe(1);
    expect(inp.mouseAccel).toBe(4); // click → stat(37)
    mem.data[0x5f2d] = 0x5; // | 0x4 pointer tracking
    inp.update(host);
    expect(inp.mouseDX).toBe(3);
    expect(inp.mouseDY).toBe(-4);
    mem.data[0x5f2d] = 0x4; // tracking bit without enable → all gated
    inp.update(host);
    expect(inp.mouseDX).toBe(0);
    expect(inp.mouseX).toBe(0);
  });
});
