// print.ts — corePrint: end-of-print cursor, \n, entry scroll (y >= 127),
// control chars 12/0, SOLID_BG gap painting.
import { describe, expect, it } from "vitest";
import { PicoMemory, DRAW } from "../src/core/memory.ts";
import { Graphics } from "../src/core/graphics.ts";
import { corePrint } from "../src/core/print.ts";

function mk(): { mem: PicoMemory; g: Graphics } {
  const mem = new PicoMemory();
  const g = new Graphics(mem);
  mem.reset(); // screen + draw/hw state zeroed
  g.clip(0, 0, 128, 128);
  g.palReset();
  g.camera(0, 0);
  g.setColor(6);
  return { mem, g };
}

/** distinct colors present in the inclusive pixel box */
function boxColors(
  g: Graphics, x0: number, y0: number, x1: number, y1: number,
): number[] {
  const out = new Set<number>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) out.add(g.pget(x, y));
  }
  return [...out];
}

describe("corePrint basics", () => {
  it('print("A"): text_x stays at start, text_y += 6, returns advanced x', () => {
    const { mem, g } = mk();
    const rx = corePrint(g, "A", 5, 10, 7, 0xff);
    expect(rx).toBe(9); // x = start + charWidth(4) + extra(0)
    expect(mem.data[DRAW.TEXT_X]).toBe(5); // stays at the starting x (:581)
    expect(mem.data[DRAW.TEXT_Y]).toBe(16); // y + lineHeight(6)
    expect(mem.data[DRAW.COLOR]).toBe(7); // color(c) at entry (:131)
    expect(boxColors(g, 5, 10, 8, 14)).toContain(7); // glyph drawn with fg
  });

  it("\\n returns to homeX and advances y by line height", () => {
    const { mem, g } = mk();
    const rx = corePrint(g, "A\nB", 6, 12, 12, 0xff);
    expect(rx).toBe(10); // B ends one char past homeX
    expect(mem.data[DRAW.TEXT_X]).toBe(6);
    expect(mem.data[DRAW.TEXT_Y]).toBe(24); // (12 + 6) + 6
    expect(boxColors(g, 6, 12, 9, 16)).toContain(12); // A on line 1
    expect(boxColors(g, 6, 18, 9, 22)).toContain(12); // B on line 2
    expect(boxColors(g, 6, 17, 9, 17)).toEqual([0]); // gap row untouched
  });
});

describe("corePrint entry scroll", () => {
  it("y >= 127 scrolls the screen up and draws at y = 121", () => {
    const { mem, g } = mk();
    g.pset(3, 126, 3); // marker on the bottom row
    const rx = corePrint(g, "A", 5, 127, 12, 0xff);
    expect(rx).toBe(9);
    // rows 6..126 moved to 0..120 — marker 126 -> 120
    expect(g.pget(3, 120)).toBe(3);
    // vacated rows 121..126 cleared
    expect(g.pget(3, 126)).toBe(0);
    // glyph drawn at y = 121 (rows 121..125), not at 127
    expect(boxColors(g, 5, 121, 8, 125)).toContain(12);
    expect(boxColors(g, 5, 120, 8, 120)).toEqual([0]);
    expect(mem.data[DRAW.TEXT_Y]).toBe(127); // 121 + 6
    expect(mem.data[DRAW.TEXT_X]).toBe(5);
  });
});

describe("corePrint control characters", () => {
  it("control 12 switches the foreground color", () => {
    const { mem, g } = mk();
    const rx = corePrint(g, "\x0c7A", 0, 0, 1, 0xff);
    expect(rx).toBe(4);
    expect(mem.data[DRAW.COLOR]).toBe(7); // g.setColor inside ch 12
    expect(mem.data[DRAW.TEXT_Y]).toBe(6);
    const colors = boxColors(g, 0, 0, 3, 4);
    expect(colors).toContain(7); // drawn after the switch
    expect(colors).not.toContain(1); // initial fg never used
  });

  it("control 0 truncates and writes back the current cursor", () => {
    const { mem, g } = mk();
    const rx = corePrint(g, "AB\x00CD", 0, 0, 12, 0xff);
    expect(rx).toBe(8); // current x at the NUL
    expect(mem.data[DRAW.TEXT_X]).toBe(8);
    expect(mem.data[DRAW.TEXT_Y]).toBe(0);
    expect(boxColors(g, 4, 0, 7, 4)).toContain(12); // B drawn
    expect(boxColors(g, 8, 0, 11, 4)).toEqual([0]); // C/D never drawn
  });
});

describe("corePrint SOLID_BG", () => {
  it("control 2 paints gaps around and inside the glyph", () => {
    const { mem, g } = mk();
    const rx = corePrint(g, "\x025A", 10, 10, 12, 0xff);
    expect(rx).toBe(14);
    expect(mem.data[DRAW.COLOR]).toBe(12); // pen restored after bg rectfill
    // rectfill box (9,9)-(13,15) with bg 5
    expect(g.pget(9, 9)).toBe(5); // corner outside the glyph
    expect(g.pget(10, 15)).toBe(5); // row below the glyph
    expect(g.pget(9, 16)).toBe(0); // outside the rectfill
    const glyph = boxColors(g, 10, 10, 13, 14);
    expect(glyph).toContain(12); // on pixels
    expect(glyph).toContain(5); // off/gap pixels filled with bg
  });
});
