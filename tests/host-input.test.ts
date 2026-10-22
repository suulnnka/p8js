// Regression for KNOWN-GAPS §6.2 (POOM "can't enter the map"): a button edge
// arriving on a 30fps glue yield frame used to be dropped entirely — the web
// shell's edgeMask is 1 frame wide and Input never synthesizes btnp from a
// fresh kHeld. The host now latches edges in pendingInput until _update_buttons
// consumes them, so a press is delivered no matter which tick it lands on.
//
// The fixture cart tallies btnp(4) into work RAM 0x4300. The press is fired as
// a single-frame kDown at BOTH glue phases (the 30fps loop yields every other
// tick; the phase relative to tick numbers is an implementation detail) —
// before the fix exactly one phase lost the press.
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertCart } from "../tools/convert.ts";
import { loadP8c } from "../src/core/p8c.ts";
import { Emulator } from "../src/core/host.ts";
import { EMPTY_HOST_INPUT, type HostInputState } from "../src/core/input.ts";
import { readBios } from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESS = 1 << 4; // 🅾 / Z

function input(down: boolean): HostInputState {
  return down ? { ...EMPTY_HOST_INPUT, kDown: PRESS, kHeld: PRESS } : { ...EMPTY_HOST_INPUT };
}

describe("host input edge latch (KNOWN-GAPS §6.2)", () => {
  for (const pressTick of [3, 4]) {
    it(`delivers a single-frame edge fired on tick ${pressTick}`, async () => {
      const { p8c } = await convertCart(join(HERE, "fixtures", "btnp-edge.p8"), {
        input: "", output: null, source: false, label: false,
      });
      const file = await loadP8c(p8c);
      const emu = new Emulator({ biosBytes: readBios(), clockSeed: 1 });
      expect(emu.loadCart(file), emu.lastError ?? "").toBe(true);

      for (let f = 1; f < pressTick; f++) {
        expect(emu.tick(input(false)), `tick ${f}`).toBe(true);
      }
      expect(emu.tick(input(true)), `press @ ${pressTick}`).toBe(true);
      for (let f = pressTick + 1; f <= 12; f++) {
        expect(emu.tick(input(false)), `tick ${f}`).toBe(true);
      }

      // exactly one btnp, counted by the cart itself
      expect(emu.mem.peek(0x4300), emu.lastError ?? "").toBe(1);
    });
  }
});
