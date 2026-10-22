// Phase 3.5 runtime — merged P8C2 through Emulator: load() switch at the
// tick boundary, stat(6)/stat(100) params, reload(fn) sub-cart copies.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileBytecode } from "../tools/convert.ts";
import { buildP8c2 } from "../tools/merge.ts";
import { loadP8c } from "../src/core/p8c.ts";
import { Emulator } from "../src/core/host.ts";
import { readBios } from "./helpers.ts";
import { ROM_SIZE } from "../src/core/memory.ts";

const GLUE = readFileSync(
  join(import.meta.dirname ?? "", "..", "assets", "glue.lua"),
  "latin1",
);

/** Build a tiny cart: resources seeded at rom[0].., code = src + glue. */
function cart(name: string, src: string, seed: number): {
  name: string;
  rom: Buffer;
  bytecode: Buffer;
} {
  const rom = Buffer.alloc(ROM_SIZE);
  rom[0] = seed;
  rom[1] = seed + 1;
  const bc = compileBytecode(src + GLUE, name);
  return { name, rom, bytecode: Buffer.from(bc) };
}

async function mergedFixture() {
  const entry = cart(
    "entry.p8",
    `
function _init()
  -- switch to the data cart with a state param
  local ok = load("data.p8", "crumbA", "X9")
  printh("load-ok=" .. tostr(ok))
end
function _draw()
  pset(2, 2, 7)
end
`,
    0x11,
  );
  const data = cart(
    "data.p8",
    `
function _init()
  -- pull 4 bytes from the ENTRY cart's resources via reload(fn)
  reload(0x4300, 0, 4, "entry.p8")
end
function _draw()
  pset(3, 3, 8)
end
`,
    0x55,
  );
  const p8c = buildP8c2("entry.p8", [entry, data]);
  const file = await loadP8c(new Uint8Array(p8c));
  return { file, entry, data };
}

describe("merged P8C2 runtime", () => {
  it("load() switches carts at the tick boundary with stat params", async () => {
    const { file } = await mergedFixture();
    const printh: string[] = [];
    const emu = new Emulator({
      biosBytes: readBios(), clockSeed: 1, onPrinth: (s) => printh.push(s),
    });
    const ok = emu.loadCart(file);
    expect(ok, emu.lastError ?? "").toBe(true);
    expect(emu.findSub("entry.p8")).not.toBeNull();
    expect(emu.findSub("data.p8")).not.toBeNull();

    // frame 1: entry runs _init → queues the load
    expect(emu.tick(), emu.lastError ?? "").toBe(true);
    expect(printh.join("\n"), "see load-ok line").toContain("load-ok=true");
    expect(emu.cartParam).toBe("X9"); // set immediately at request time
    expect(emu.breadcrumb).toBe("crumbA");

    // switch applied at end of frame 1; frame 2 runs the data cart
    expect(emu.tick(), emu.lastError ?? "").toBe(true);
    expect(emu.lastError).toBeNull();
    // frame counter continues across the switch (fake-08 LoadCart behaviour)
    expect(emu.frameCount).toBe(2);

    // data cart's _init did reload(0x4300, 0, 4, "entry.p8") on its first
    // frame after the switch — entry rom seed 0x11 landed at dest
    // (reload dest=0x4300 is work RAM; the copy targets data cart init)
    // verify the copy happened by checking bootRom of entry:
    // NOTE: runCartCore mem.reset() clears 0x0000-0x42ff AFTER loadRom, then
    // the new cart's reload copies entry bytes into 0x4300.
    expect(emu.mem.peek(0x4300)).toBe(0x11);
    expect(emu.mem.peek(0x4301)).toBe(0x12);
  });

  it("unknown sub-cart names fail load() with false", async () => {
    const { file } = await mergedFixture();
    const emu = new Emulator({ biosBytes: readBios(), clockSeed: 1 });
    emu.loadCart(file);
    expect(emu.requestLoad("nope.p8", "", "")).toBe(false);
    // name without extension resolves via the .p8 fallback
    expect(emu.requestLoad("data", "", "")).toBe(true);
    expect(emu.requestLoad("data.p8.png", "", "")).toBe(false); // not present
  });

  it("reload with a missing sub-cart name reports an error", async () => {
    const { file } = await mergedFixture();
    const emu = new Emulator({ biosBytes: readBios(), clockSeed: 1 });
    emu.loadCart(file);
    // hookReload returns false for unknown names (api layer raises)
    expect(emu.hookReload(0, 0, 4, "ghost.p8")).toBe(false);
    expect(emu.hookReload(0, 0, 4, "entry.p8")).toBe(true);
  });
});
