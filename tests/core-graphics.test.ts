// graphics.ts — nibble layout, pen/clip/camera, palettes, primitives smoke.
import { describe, expect, it } from "vitest";
import { PicoMemory, DRAW, HW } from "../src/core/memory.ts";
import { Graphics, PRINT_MODE } from "../src/core/graphics.ts";

function mk(): { mem: PicoMemory; g: Graphics } {
  const mem = new PicoMemory();
  const g = new Graphics(mem);
  mem.reset(); // defaults: clip 0,0,128,128 after cls; set clip via g
  g.clip(0, 0, 128, 128);
  g.palReset();
  g.camera(0, 0);
  g.setColor(6);
  return { mem, g };
}

describe("nibble framebuffer", () => {
  it("even x → low nibble, odd x → high nibble (nibblehelpers.cpp)", () => {
    const { g } = mk();
    g.pset(0, 0, 3);
    g.pset(1, 0, 7);
    expect(g.pget(0, 0)).toBe(3);
    expect(g.pget(1, 0)).toBe(7);
    // same byte
    const { mem } = mk();
    const g2 = new Graphics(mem);
    g2.clip(0, 0, 128, 128);
    g2.pset(10, 5, 0xf);
    g2.pset(11, 5, 0x2);
    expect(mem.data[0x6000 + 5 * 64 + 5]).toBe(0x2f);
  });

  it("pset applies camera then clip", () => {
    const { g } = mk();
    g.camera(4, 2);
    g.pset(4, 2, 9); // → (0,0) on screen
    expect(g.pget(4, 2)).toBe(9); // pget also undoes camera → reads (0,0)
    g.clip(0, 0, 2, 2);
    g.pset(5, 3, 1); // → (1,1) inside clip
    g.pset(6, 4, 1); // → (2,2) outside clip → skipped
    g.camera(0, 0);
    expect(g.pget(1, 1)).toBe(1);
    expect(g.pget(2, 2)).toBe(0);
  });

  it("pget off-screen returns 0", () => {
    const { g } = mk();
    expect(g.pget(-1, 0)).toBe(0);
    expect(g.pget(128, 0)).toBe(0);
  });
});

describe("cls / rect / line", () => {
  it("cls fills both nibbles and resets cursor+clip", () => {
    const { mem, g } = mk();
    g.clip(10, 10, 5, 5);
    g.cursor(60, 70);
    g.cls(5);
    expect(mem.data[0x6000]).toBe(0x55);
    expect(mem.data[0x6000 + 8191]).toBe(0x55);
    expect(mem.data[DRAW.CLIP_XE]).toBe(128);
    expect(mem.data[DRAW.TEXT_X]).toBe(0);
  });

  it("rectfill draws inclusive bounds", () => {
    const { g } = mk();
    g.rectfill(2, 3, 5, 6, 11);
    expect(g.pget(2, 3)).toBe(11);
    expect(g.pget(5, 6)).toBe(11);
    expect(g.pget(4, 4)).toBe(11);
    expect(g.pget(1, 3)).toBe(0);
    expect(g.pget(6, 6)).toBe(0);
    expect(g.pget(2, 7)).toBe(0);
  });

  it("rect outlines only", () => {
    const { g } = mk();
    g.rect(0, 0, 4, 4, 8);
    expect(g.pget(0, 0)).toBe(8);
    expect(g.pget(4, 0)).toBe(8);
    expect(g.pget(0, 4)).toBe(8);
    expect(g.pget(4, 4)).toBe(8);
    expect(g.pget(2, 2)).toBe(0);
    expect(g.pget(2, 0)).toBe(8); // top edge
    expect(g.pget(0, 2)).toBe(8); // left edge
    expect(g.pget(2, 4)).toBe(8); // bottom edge
  });

  it("line draws diagonal via Bresenham and tracks line_x/y", () => {
    const { mem, g } = mk();
    g.drawLine(0, 0, 3, 3, 12);
    expect(g.pget(0, 0)).toBe(12);
    expect(g.pget(1, 1)).toBe(12);
    expect(g.pget(2, 2)).toBe(12);
    expect(g.pget(3, 3)).toBe(12);
    expect(mem.peekInt16(DRAW.LINE_X)).toBe(3);
    expect(mem.peekInt16(DRAW.LINE_Y)).toBe(3);
    expect(mem.data[DRAW.LINE_INVALID]).toBe(0);
    // line(x2,y2) continues from stored end
    g.lineTo(5, 5);
    expect(g.pget(4, 4)).toBe(12);
    expect(g.pget(5, 5)).toBe(12);
  });

  it("horizontal line uses the memset fast path identically", () => {
    const { g } = mk();
    g.drawLine(5, 8, 20, 8, 7);
    for (let x = 5; x <= 20; x++) expect(g.pget(x, 8)).toBe(7);
    expect(g.pget(4, 8)).toBe(0);
    expect(g.pget(21, 8)).toBe(0);
  });

  it("circfill fills a disk", () => {
    const { g } = mk();
    g.circfill(16, 16, 4, 10);
    expect(g.pget(16, 16)).toBe(10);
    expect(g.pget(16, 12)).toBe(10); // top edge
    expect(g.pget(16, 20)).toBe(10);
    expect(g.pget(12, 16)).toBe(10);
    expect(g.pget(16, 11)).toBe(0); // outside
    expect(g.pget(11, 11)).toBe(0);
  });
});

describe("palettes / transparency / fillp", () => {
  it("draw palette remaps pen writes", () => {
    const { g } = mk();
    g.palSet(1, 14, 0);
    g.pset(0, 0, 1);
    expect(g.pget(0, 0)).toBe(14);
  });

  it("palt: color 0 transparent by default, others opaque; spr skips transparent", () => {
    const { g } = mk();
    expect(g.isColorTransparent(0)).toBe(true);
    expect(g.isColorTransparent(5)).toBe(false);
    g.palt(0, false);
    expect(g.isColorTransparent(0)).toBe(false);
    g.palt(5, true);
    expect(g.isColorTransparent(5)).toBe(true);
  });

  it("spr samples sheet pixels and skips transparent colors", () => {
    const { mem, g } = mk();
    // sprite 0 at sheet (0,0): pixel(0,0)=3 (low nibble of byte 0), pixel(1,0)=0
    mem.data[0x0000] = 0x03;
    g.spr(0, 10, 10);
    expect(g.pget(10, 10)).toBe(3);
    expect(g.pget(11, 10)).toBe(0); // transparent source stays
  });

  it("fillp alternates colors by 4×4 bit grid with transparency", () => {
    const { g } = mk();
    // pattern with only bit15 clear → uses alt color everywhere bit=1; use a
    // checker: 0xF0F0 top row pattern (no transparency bit)
    g.fillp(0x0f0f0000); // bits 15..0; bit15=0 (no transparency)
    g.setColor(0x21); // low=1 primary, high=2 alt
    // bitPlace = 15 - ((x&3) + 4*(y&3)); pattern bit at bitPlace
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const bitPlace = 15 - ((x & 3) + 4 * (y & 3));
        const alt = (0x0f0f >>> bitPlace) & 1;
        g.pset(4 + x, 4 + y); // pen write
        expect(g.pget(4 + x, 4 + y)).toBe(alt ? 2 : 1);
      }
    }
    // transparency bit = original bit15, pattern = bits 16-31 (fillp C layout)
    g.fillp(0);
    g.pset(4, 4, 7); // clear pattern, write 7 first
    g.fillp((0x0f0f << 16) | 0x8000); // pattern 0x0f0f, transp=1
    g.pset(4, 4); // bitPlace(4,4)=15 → alt → skip → stays 7
    expect(g.pget(4, 4)).toBe(7);
  });

  it("screen palette only affects presentation mapping (screenPalMapped)", () => {
    const { g } = mk();
    g.palSet(3, 9, 1);
    expect(g.screenPalMapped(3)).toBe(9);
    g.pset(0, 0, 3);
    expect(g.pget(0, 0)).toBe(3); // draw path untouched by screen pal
  });
});

describe("map cells", () => {
  it("mget/mset use 0x2000 region and shared 0x1000 rows 32+", () => {
    const { mem, g } = mk();
    g.mset(0, 0, 42);
    expect(mem.data[0x2000]).toBe(42);
    g.mset(5, 40, 77); // idx = 40*128+5 = 5125 ≥ 4096 → shared region
    expect(mem.data[5125]).toBe(77);
    expect(g.mget(5, 40)).toBe(77);
    expect(g.mget(-1, 0)).toBe(0);
    expect(g.mget(0, 1000)).toBe(0);
  });
});

describe("custom font / print mode flags", () => {
  it("drawCharacter renders glyph bits with bit0 = leftmost", () => {
    const { g } = mk();
    // glyph byte 0b00000101 → pixels at col 0 and col 2
    const glyph = [0b00000101, 0, 0, 0, 0, 0, 0, 0];
    g.drawCharacterFromBytes(glyph, 20, 30, 12, 0, PRINT_MODE.ON, 4, 5);
    expect(g.pget(20, 30)).toBe(12);
    expect(g.pget(21, 30)).toBe(0);
    expect(g.pget(22, 30)).toBe(12);
    expect(g.pget(23, 30)).toBe(0);
    expect(g.pget(20, 31)).toBe(0);
  });

  it("SOLID_BG paints background pixels", () => {
    const { g } = mk();
    const glyph = [0b00000001, 0, 0, 0, 0, 0, 0, 0];
    g.drawCharacterFromBytes(
      glyph, 0, 0, 12, 5, PRINT_MODE.ON | PRINT_MODE.SOLID_BG, 4, 5,
    );
    expect(g.pget(0, 0)).toBe(12);
    expect(g.pget(1, 0)).toBe(5);
  });
});
