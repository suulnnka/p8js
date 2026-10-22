// PICO-8 graphics — port of fake-08 graphics.cpp (whole file; file:line
// references inline). All drawing lands in the RAM image at the address
// chosen by hwState.screenDataMemMapping (0x5f55); default 0x6000.
//
// Ordering for every primitive: camera → clip (half-open [xb,xe)×[yb,ye))
// → pen/sprite color path (draw palette bit4=transparent for sprite samples,
// fillp for the pen) → colorBitmask merge → nibble write.

import { PicoMemory, DRAW, HW } from "./memory.ts";
import * as fx from "../vm/fix32.ts";
import { fontGlyph } from "./fontdata.ts";

const BIT = (n: number): number => 1 << n;

/** Combined byte index in a 128×64 nibble buffer (nibblehelpers.h:8). */
const COMBINED_IDX = (x: number, y: number): number => (y << 6) | (x >> 1);
const IS_VALID_SPR_IDX = (x: number, y: number): boolean =>
  y >= 0 && y < 128 && x >= 0 && x < 128;

// hostVmShared.h:84-91
export const PRINT_MODE = {
  ON: 0x1,
  PADDING: 0x2,
  WIDE: 0x4,
  TALL: 0x8,
  SOLID_BG: 0x10,
  INVERTED: 0x20,
  STRIPEY: 0x40,
  CUSTOM_FONT: 0x80,
} as const;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export interface ClipRect {
  xb: number;
  xe: number;
  yb: number;
  ye: number;
}

export class Graphics {
  constructor(public readonly mem: PicoMemory) {}

  // ------------------------------------------------------------------
  // buffer mapping (graphics.cpp:39-64)

  /** Base offset of the active draw buffer inside mem.data. */
  framebufferBase(): number {
    const m = this.mem.data[HW.SCREEN_MAPPING];
    if (m === 0) return 0x0000;
    if (m === 0x60) return 0x6000;
    if (m >= 0x80) return 0x8000 + ((m - 0x80) << 8);
    return 0x6000;
  }

  /** Base offset of the active sprite sheet buffer. */
  spriteSheetBase(): number {
    const m = this.mem.data[HW.SHEET_MAPPING];
    if (m === 0) return 0x0000;
    if (m === 0x60) return 0x6000;
    if (m >= 0x80) return 0x8000 + ((m - 0x80) << 8);
    return 0x0000;
  }

  // ------------------------------------------------------------------
  // nibble access (nibblehelpers.cpp:22-33) — even x = low nibble

  private setNibble(x: number, y: number, value: number, base: number): void {
    const i = base + COMBINED_IDX(x, y);
    const d = this.mem.data;
    d[i] = (1 & x)
      ? (d[i] & 0x0f) | ((value << 4) & 0xf0)
      : (d[i] & 0xf0) | (value & 0x0f);
  }

  private getNibble(x: number, y: number, base: number): number {
    const b = this.mem.data[base + COMBINED_IDX(x, y)];
    return 1 & x ? b >> 4 : b & 0x0f;
  }

  // ------------------------------------------------------------------
  // state predicates (graphics.cpp:464-545)

  cameraX(): number {
    return this.mem.peekInt16(DRAW.CAMERA_X);
  }

  cameraY(): number {
    return this.mem.peekInt16(DRAW.CAMERA_Y);
  }

  applyCamera(p: { x: number; y: number }): void {
    p.x -= this.cameraX();
    p.y -= this.cameraY();
  }

  clipRect(): ClipRect {
    const d = this.mem.data;
    return {
      xb: d[DRAW.CLIP_XB],
      yb: d[DRAW.CLIP_YB],
      xe: d[DRAW.CLIP_XE],
      ye: d[DRAW.CLIP_YE],
    };
  }

  isWithinClip(x: number, y: number): boolean {
    const d = this.mem.data;
    return (
      x >= d[DRAW.CLIP_XB] && x < d[DRAW.CLIP_XE] &&
      y >= d[DRAW.CLIP_YB] && y < d[DRAW.CLIP_YE]
    );
  }

  isOnScreen(x: number, y: number): boolean {
    return x >= 0 && x <= 127 && y >= 0 && y <= 127;
  }

  clampXToClip(x: number): number {
    const d = this.mem.data;
    return clamp(x, d[DRAW.CLIP_XB], d[DRAW.CLIP_XE] - 1);
  }

  clampYToClip(y: number): number {
    const d = this.mem.data;
    return clamp(y, d[DRAW.CLIP_YB], d[DRAW.CLIP_YE] - 1);
  }

  /** draw palette: bit4 = transparent flag (graphics.cpp:494-502). */
  isColorTransparent(color: number): boolean {
    return (this.mem.data[DRAW.DRAW_PAL + (color & 0x0f)] >> 4) > 0;
  }

  drawPalMapped(color: number): number {
    return this.mem.data[DRAW.DRAW_PAL + (color & 0x0f)] & 0x0f;
  }

  screenPalMapped(color: number): number {
    return this.mem.data[DRAW.SCREEN_PAL + (color & 0x0f)] & 0x8f;
  }

  // ------------------------------------------------------------------
  // pixel write cores (graphics.cpp:548-630)

  private safePen(x: number, y: number): void {
    if (this.isWithinClip(x, y)) this.setPixelFromPen(x, y);
  }

  /** Sprite-sample write: draw palette, no fillp (graphics.cpp:554-578). */
  setPixelFromSprite(x: number, y: number, col: number): void {
    x &= 127;
    y &= 127;
    const d = this.mem.data;
    const base = this.framebufferBase();
    let c = d[DRAW.DRAW_PAL + (col & 0x0f)] & 0x0f;
    const bm = d[HW.COLOR_BITMASK];
    if (bm !== 0xff) {
      const writeMask = bm & 15;
      const readMask = bm >> 4;
      const source = 1 & x
        ? this.mem.data[base + COMBINED_IDX(x, y)] >> 4
        : this.mem.data[base + COMBINED_IDX(x, y)] & 0x0f;
      c = (source & ~writeMask) | (c & writeMask & readMask);
    }
    this.setNibble(x, y, c, base);
  }

  /** Pen write: fillp picks color/alt/skip, then palette + bitmask. */
  setPixelFromPen(x: number, y: number): void {
    x &= 127;
    y &= 127;
    const d = this.mem.data;
    const base = this.framebufferBase();

    const col = d[DRAW.COLOR];
    const col0 = col & 0x0f;
    const col1 = (col & 0xf0) >> 4;
    let finalC = col0;

    const bitPlace = 15 - ((x & 3) + 4 * (y & 3));
    const fillp = (d[DRAW.FILL_PATTERN + 1] << 8) + d[DRAW.FILL_PATTERN];
    const altColor = (fillp >> bitPlace) & 0x1;
    if (altColor) {
      if (d[DRAW.FILL_PTrans] & 1) return;
      finalC = col1;
    }

    finalC = d[DRAW.DRAW_PAL + (finalC & 0x0f)] & 0x0f;

    const bm = d[HW.COLOR_BITMASK];
    if (bm !== 0xff) {
      const writeMask = bm & 15;
      const readMask = bm >> 4;
      const source = 1 & x
        ? this.mem.data[base + COMBINED_IDX(x, y)] >> 4
        : this.mem.data[base + COMBINED_IDX(x, y)] & 0x0f;
      finalC = (source & ~writeMask) | (finalC & writeMask & readMask);
    }

    this.setNibble(x, y, finalC, base);
  }

  // ------------------------------------------------------------------
  // cls / pset / pget / color (graphics.cpp:632-684)

  cls(color = 0): void {
    const c = color & 15;
    const val = (c << 4) | c;
    this.mem.data.fill(val, this.framebufferBase(), this.framebufferBase() + 8192);
    const d = this.mem.data;
    d[DRAW.TEXT_X] = 0;
    d[DRAW.TEXT_Y] = 0;
    d[DRAW.CLIP_XB] = 0;
    d[DRAW.CLIP_YB] = 0;
    d[DRAW.CLIP_XE] = 128;
    d[DRAW.CLIP_YE] = 128;
  }

  pset(x: number, y: number, col?: number): void {
    if (col !== undefined) this.setColor(col);
    x -= this.cameraX();
    y -= this.cameraY();
    if (this.isWithinClip(x, y)) this.setPixelFromPen(x, y);
  }

  pget(x: number, y: number): number {
    x -= this.cameraX();
    y -= this.cameraY();
    if (this.isOnScreen(x, y)) {
      return this.getNibble(x, y, this.framebufferBase());
    }
    return 0;
  }

  setColor(col: number): number {
    const prev = this.mem.data[DRAW.COLOR];
    this.mem.data[DRAW.COLOR] = col & 0xff;
    return prev;
  }

  getColor(): number {
    return this.mem.data[DRAW.COLOR];
  }

  // ------------------------------------------------------------------
  // line (graphics.cpp:686-858)

  /** Invalidate continuous-line state (line()). */
  resetLine(): void {
    const d = this.mem.data;
    this.mem.pokeInt16(DRAW.LINE_X, 0);
    this.mem.pokeInt16(DRAW.LINE_Y, 0);
    d[DRAW.LINE_INVALID] = 1;
  }

  lineTo(x1: number, y1: number, col?: number): void {
    const d = this.mem.data;
    if (d[DRAW.LINE_INVALID] === 0) {
      this.drawLine(
        this.mem.peekInt16(DRAW.LINE_X),
        this.mem.peekInt16(DRAW.LINE_Y),
        x1,
        y1,
        col ?? d[DRAW.COLOR],
      );
    }
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, col: number): void {
    const d = this.mem.data;
    this.mem.pokeInt16(DRAW.LINE_X, x1);
    this.mem.pokeInt16(DRAW.LINE_Y, y1);
    d[DRAW.LINE_INVALID] = 0;

    x0 -= this.cameraX();
    y0 -= this.cameraY();
    x1 -= this.cameraX();
    y1 -= this.cameraY();

    this.setColor(col);

    if (x0 === x1) {
      this.privateVLine(y0, y1, x0);
    } else if (y0 === y1) {
      this.privateHLine(x0, x1, y0);
    } else {
      // Bresenham (graphics.cpp:837-857)
      const dx = Math.abs(x1 - x0);
      const sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0);
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.safePen(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy;
        }
      }
    }
  }

  /** Horizontal line with clip + memset fast path (graphics.cpp:715-770). */
  privateHLine(x1: number, x2: number, y: number): void {
    const d = this.mem.data;
    const base = this.framebufferBase();
    if (!(y >= d[DRAW.CLIP_YB] && y < d[DRAW.CLIP_YE])) return;
    if (
      (x1 < d[DRAW.CLIP_XB] && x2 < d[DRAW.CLIP_XB]) ||
      (x1 > d[DRAW.CLIP_XE] && x2 > d[DRAW.CLIP_XE])
    ) {
      return;
    }
    let maxx = clamp(Math.max(x1, x2), d[DRAW.CLIP_XB], d[DRAW.CLIP_XE] - 1);
    let minx = clamp(Math.min(x1, x2), d[DRAW.CLIP_XB], d[DRAW.CLIP_XE] - 1);

    const canmemset =
      d[HW.COLOR_BITMASK] === 0xff &&
      d[DRAW.FILL_PATTERN] === 0 &&
      d[DRAW.FILL_PATTERN + 1] === 0 &&
      maxx - minx > 1;

    if (canmemset) {
      const p = base + y * 64;
      const color = this.drawPalMapped(d[DRAW.COLOR]);
      if (minx & 1) {
        const i = p + (minx >> 1);
        this.mem.data[i] = (this.mem.data[i] & 0x0f) | (color << 4);
        ++minx;
      }
      if ((maxx & 1) === 0) {
        const i = p + (maxx >> 1);
        this.mem.data[i] = (this.mem.data[i] & 0xf0) | color;
        --maxx;
      }
      this.mem.data.fill(color * 0x11, p + (minx >> 1), p + ((maxx - minx + 1) >> 1) + (minx >> 1));
    } else {
      for (let x = minx; x <= maxx; x++) this.setPixelFromPen(x, y);
    }
  }

  /** Vertical line with clip + direct nibble fast path (772-817). */
  privateVLine(y1: number, y2: number, x: number): void {
    const d = this.mem.data;
    const base = this.framebufferBase();
    if (!(x >= d[DRAW.CLIP_XB] && x < d[DRAW.CLIP_XE])) return;
    if (
      (y1 < d[DRAW.CLIP_YB] && y2 < d[DRAW.CLIP_YB]) ||
      (y1 > d[DRAW.CLIP_YE] && y2 > d[DRAW.CLIP_YE])
    ) {
      return;
    }
    const maxy = clamp(Math.max(y1, y2), d[DRAW.CLIP_YB], d[DRAW.CLIP_YE] - 1);
    const miny = clamp(Math.min(y1, y2), d[DRAW.CLIP_YB], d[DRAW.CLIP_YE] - 1);

    const skipPen =
      d[HW.COLOR_BITMASK] === 0xff &&
      d[DRAW.FILL_PATTERN] === 0 &&
      d[DRAW.FILL_PATTERN + 1] === 0;

    if (skipPen) {
      const color = this.drawPalMapped(d[DRAW.COLOR]);
      const mask = x & 1 ? 0x0f : 0xf0;
      const nibble = x & 1 ? color << 4 : color;
      for (let y = miny; y <= maxy; y++) {
        const i = base + COMBINED_IDX(x, y);
        this.mem.data[i] = (this.mem.data[i] & mask) | nibble;
      }
    } else {
      for (let y = miny; y <= maxy; y++) this.setPixelFromPen(x, y);
    }
  }

  // ------------------------------------------------------------------
  // circ / circfill (graphics.cpp:961-1102)

  circ(ox: number, oy: number, r = 4, col?: number): void {
    if (col !== undefined) this.setColor(col);
    ox -= this.cameraX();
    oy -= this.cameraY();
    let x = r;
    let y = 0;
    let decisionOver2 = 1 - x;
    while (y <= x) {
      this.safePen(ox + x, oy + y);
      this.safePen(ox + y, oy + x);
      this.safePen(ox - x, oy + y);
      this.safePen(ox - y, oy + x);
      this.safePen(ox - x, oy - y);
      this.safePen(ox - y, oy - x);
      this.safePen(ox + x, oy - y);
      this.safePen(ox + y, oy - x);
      y += 1;
      if (decisionOver2 < 0) {
        decisionOver2 = decisionOver2 + 2 * y + 1;
      } else {
        x = x - 1;
        decisionOver2 = decisionOver2 + 2 * (y - x) + 1;
      }
    }
  }

  circfill(ox: number, oy: number, r: number, col: number): void {
    // inverted fill mode (colorSettingFlag bit1, graphics.cpp:1070-1076)
    if ((this.mem.data[DRAW.COLOR_SETTING_FLAG] & 0x02) !== 0) {
      this.invertedCircfill(ox, oy, r, col);
      return;
    }
    this.setColor(col);
    ox -= this.cameraX();
    oy -= this.cameraY();
    if (r === 0) {
      this.safePen(ox, oy);
    } else if (r === 1) {
      this.safePen(ox, oy - 1);
      this.privateHLine(ox - 1, ox + 1, oy);
      this.safePen(ox, oy + 1);
    } else if (r > 0) {
      let x = -r;
      let y = 0;
      let err = 2 - 2 * r;
      do {
        this.privateHLine(ox - x, ox + x, oy + y);
        this.privateHLine(ox - x, ox + x, oy - y);
        const rv = err;
        if (rv > x) {
          x += 1;
          err += x * 2 + 1;
        }
        if (rv <= y) {
          y += 1;
          err += y * 2 + 1;
        }
      } while (x < 0);
    }
  }

  private invertedCircfill(ox: number, oy: number, r: number, col: number): void {
    this.setColor(col);
    ox -= this.cameraX();
    oy -= this.cameraY();
    const clipLeft = this.mem.data[DRAW.CLIP_XB];
    const clipRight = this.mem.data[DRAW.CLIP_XE];
    const clipTop = this.mem.data[DRAW.CLIP_YB];
    const clipBottom = this.mem.data[DRAW.CLIP_YE];

    const circleTop = oy - r;
    const circleBottom = oy + r;

    for (let row = clipTop; row < circleTop && row < clipBottom; row++) {
      this.privateHLine(clipLeft, clipRight - 1, row);
    }

    if (r >= 0) {
      let x = -r;
      let y = 0;
      let err = 2 - 2 * r;
      let lastY = -1;
      do {
        if (oy + y !== lastY) {
          if (ox + x + 1 < clipRight) {
            this.privateHLine(ox - x + 1, clipRight - 1, oy + y);
          }
          if (ox + x - 1 >= clipLeft) {
            this.privateHLine(clipLeft, ox + x - 1, oy + y);
          }
        }
        if (y > 0 && oy - y !== lastY) {
          if (ox + x + 1 < clipRight) {
            this.privateHLine(ox - x + 1, clipRight - 1, oy - y);
          }
          if (ox + x - 1 >= clipLeft) {
            this.privateHLine(clipLeft, ox + x - 1, oy - y);
          }
        }
        lastY = oy + y;
        const savedR = err;
        if (savedR > x) {
          x += 1;
          err += x * 2 + 1;
        }
        if (savedR <= y) {
          y += 1;
          err += y * 2 + 1;
        }
      } while (x < 0);
    }

    for (let row = circleBottom + 1; row < clipBottom; row++) {
      this.privateHLine(clipLeft, clipRight - 1, row);
    }
  }

  // ------------------------------------------------------------------
  // oval / ovalfill — independent midpoint-ellipse rasterizer (J. Kennedy,
  // "A Fast Bresenham Type Algorithm For Drawing Ellipses"). Not
  // pixel-identical to fake-08's oval: that one is StackOverflow-derived
  // (CC BY-SA 3.0) and had to be replaced, and fake-08's own test carts
  // note their oval is not pixel-exact either.

  oval(x0: number, y0: number, x1: number, y1: number, col?: number): void {
    if (col !== undefined) this.setColor(col);
    x0 -= this.cameraX();
    y0 -= this.cameraY();
    x1 -= this.cameraX();
    y1 -= this.cameraY();
    ({ a: x0, b: x1 } = sort2(x0, x1));
    ({ a: y0, b: y1 } = sort2(y0, y1));

    const a = ((x1 - x0) / 2) | 0;
    const b = ((y1 - y0) / 2) | 0;
    const xc = x0 + a;
    const yc = y0 + b;

    if (a === 0 || b === 0) {
      // A zero semi-axis collapses the ellipse to a segment.
      for (let y = yc - b; y <= yc + b; y++) this.safePen(xc, y);
      for (let x = xc - a; x <= xc + a; x++) this.safePen(x, yc);
      return;
    }

    this.traceEllipse(a, b, (x, y) => {
      this.safePen(xc + x, yc + y);
      this.safePen(xc - x, yc + y);
      this.safePen(xc + x, yc - y);
      this.safePen(xc - x, yc - y);
    });
  }

  ovalfill(x0: number, y0: number, x1: number, y1: number, col?: number): void {
    if (col !== undefined) this.setColor(col);
    x0 -= this.cameraX();
    y0 -= this.cameraY();
    x1 -= this.cameraX();
    y1 -= this.cameraY();
    ({ a: x0, b: x1 } = sort2(x0, x1));
    ({ a: y0, b: y1 } = sort2(y0, y1));

    const a = ((x1 - x0) / 2) | 0;
    const b = ((y1 - y0) / 2) | 0;
    const xc = x0 + a;
    const yc = y0 + b;

    // Scanline fill: ellipse half-width at each row's pixel centers.
    for (let y = yc - b; y <= yc + b; y++) {
      const ny = b === 0 ? 0 : (y - yc) / b;
      const half = a * Math.sqrt(Math.max(0, 1 - ny * ny));
      this.privateHLine(Math.round(xc - half), Math.round(xc + half), y);
    }
  }

  /** One-quadrant midpoint trace of an ellipse with semi-axes a, b > 0;
   *  plot receives quadrant offsets (x, y) ≥ (0, 0) from the center. */
  private traceEllipse(
    a: number,
    b: number,
    plot: (x: number, y: number) => void,
  ): void {
    const a2 = a * a;
    const b2 = b * b;
    let x = 0;
    let y = b;
    let dx = 0;
    let dy = 2 * a2 * b;
    // Region 1: tangent slope steeper than -1 — step in x.
    let d = b2 - a2 * b + a2 / 4;
    while (dx < dy) {
      plot(x, y);
      x++;
      dx += 2 * b2;
      if (d < 0) {
        d += dx + b2;
      } else {
        y--;
        dy -= 2 * a2;
        d += dx - dy + b2;
      }
    }
    // Region 2: shallower than -1 — step in y.
    d = b2 * (x + 0.5) * (x + 0.5) + a2 * (y - 1) * (y - 1) - a2 * b2;
    while (y >= 0) {
      plot(x, y);
      if (d > 0) {
        y--;
        dy -= 2 * a2;
        d += a2 - dy;
      } else {
        x++;
        y--;
        dx += 2 * b2;
        dy -= 2 * a2;
        d += dx - dy + a2;
      }
    }
  }

  // ------------------------------------------------------------------
  // rect / rectfill / rrect / rrectfill (graphics.cpp:1306-1551)

  rect(x1: number, y1: number, x2: number, y2: number, col?: number): void {
    if (col !== undefined) this.setColor(col);
    x1 -= this.cameraX();
    y1 -= this.cameraY();
    x2 -= this.cameraX();
    y2 -= this.cameraY();
    ({ a: x1, b: x2 } = sort2(x1, x2));
    ({ a: y1, b: y2 } = sort2(y1, y2));
    this.privateHLine(x1, x2, y1);
    this.privateHLine(x1, x2, y2);
    this.privateVLine(y1, y2, x1);
    this.privateVLine(y1, y2, x2);
  }

  rectfill(x1: number, y1: number, x2: number, y2: number, col?: number): void {
    if (col !== undefined) this.setColor(col);
    x1 -= this.cameraX();
    y1 -= this.cameraY();
    x2 -= this.cameraX();
    y2 -= this.cameraY();
    ({ a: x1, b: x2 } = sort2(x1, x2));
    ({ a: y1, b: y2 } = sort2(y1, y2));
    for (let y = y1; y <= y2; y++) this.privateHLine(x1, x2, y);
  }

  /** rrect cut table (graphics.cpp:1376-1426). */
  private static rrectCut(radius: number, row: number): number {
    const tables: Record<number, number[]> = {
      6: [5, 3, 2, 1, 1, 0],
      7: [6, 4, 3, 2, 1, 1, 0],
      8: [7, 5, 3, 2, 2, 1, 1, 0],
      9: [7, 5, 4, 3, 2, 1, 1, 0],
      10: [7, 5, 4, 3, 2, 1, 1, 0],
      11: [9, 7, 5, 4, 3, 2, 2, 1, 1, 0, 0],
      12: [9, 7, 5, 4, 3, 2, 2, 1, 1, 0, 0],
      13: [11, 8, 7, 5, 4, 3, 3, 2, 1, 1, 1, 0, 0],
      14: [11, 8, 7, 5, 4, 3, 3, 2, 1, 1, 1, 0, 0],
      15: [13, 10, 8, 7, 5, 4, 4, 3, 2, 2, 1, 1, 1, 0, 0],
      16: [13, 10, 8, 7, 5, 4, 4, 3, 2, 2, 1, 1, 1, 0, 0],
    };
    const t = tables[radius];
    if (t) return row < t.length ? (t[row] ?? 0) : 0;
    // not pixel perfect, but rounded (circle equation)
    if (row >= radius) return 0;
    const y = radius - row - 1;
    const discriminant = radius * radius - y * y;
    if (discriminant <= 0) return 0;
    let cut = Math.round(radius - Math.sqrt(discriminant)) - 1;
    if (cut === 0 && row < radius - 1) {
      const tailY = radius - row;
      if (tailY <= 2.5) cut = 1;
    }
    return cut < 0 ? 0 : cut;
  }

  private rrectCore(
    x: number, y: number, w: number, h: number, r: number, col: number, fill: boolean,
  ): void {
    this.setColor(col);
    const maxRadius = (w < h ? w : h) / 2;
    if (r > maxRadius) r = maxRadius;
    if (r <= 0) {
      if (fill) this.rectfill(x, y, x + w - 1, y + h - 1, col);
      else this.rect(x, y, x + w - 1, y + h - 1, col);
      return;
    }
    x -= this.cameraX();
    y -= this.cameraY();

    for (let row = 0; row < h; row++) {
      let cutAmount = 0;
      if (row < r) {
        if (r <= 5) {
          cutAmount = r - 1 - row;
        } else if (fill) {
          cutAmount = Graphics.rrectCut(r, row);
        } else {
          const yFromCorner = row;
          const rSquared = r * r;
          let maxX = 0;
          for (let testX = 0; testX < r; testX++) {
            if (testX * testX + yFromCorner * yFromCorner <= rSquared) {
              maxX = testX;
            }
          }
          cutAmount = r - 1 - maxX;
        }
      } else if (row >= h - r) {
        const bottomRow = h - 1 - row;
        if (r <= 5) {
          cutAmount = r - 1 - bottomRow;
        } else {
          cutAmount = Graphics.rrectCut(r, bottomRow);
        }
      }
      if (cutAmount < 0) cutAmount = 0;
      if (cutAmount * 2 >= w) cutAmount = ((w - 1) / 2) | 0;

      const lineStart = x + cutAmount;
      const lineEnd = x + w - 1 - cutAmount;
      if (lineStart <= lineEnd) {
        if (fill || row === 0 || row === h - 1) {
          this.privateHLine(lineStart, lineEnd, y + row);
        } else {
          this.safePen(lineStart, y + row);
          if (lineStart !== lineEnd) this.safePen(lineEnd, y + row);
        }
      }
    }
  }

  rrect(x: number, y: number, w: number, h: number, r: number, col?: number): void {
    this.rrectCore(x, y, w, h, r, col ?? this.getColor(), false);
  }

  rrectfill(x: number, y: number, w: number, h: number, r: number, col?: number): void {
    this.rrectCore(x, y, w, h, r, col ?? this.getColor(), true);
  }

  // ------------------------------------------------------------------
  // fillp (graphics.cpp:1553-1569) — returns the previous pattern

  fillp(patBits: number): number {
    const d = this.mem.data;
    const prev =
      (d[DRAW.FILL_PATTERN] << 16) |
      (d[DRAW.FILL_PATTERN + 1] << 24) |
      (d[DRAW.FILL_PTrans] << 8);
    d[DRAW.FILL_PATTERN] = (patBits >>> 16) & 0xff;
    d[DRAW.FILL_PATTERN + 1] = (patBits >>> 24) & 0xff;
    d[DRAW.FILL_PTrans] = (patBits >>> 15) & 1;
    return prev | 0;
  }

  // ------------------------------------------------------------------
  // sprite blitting (graphics.cpp:72-455)

  /** Normal blitter: camera → clip → palette+bitmask nibble writes.
   *  Half-byte source alignment quirks preserved verbatim from fake-08. */
  copySpriteToScreen(
    sheetBase: number,
    scrX: number,
    scrY: number,
    sprX: number,
    sprY: number,
    sprW: number,
    sprH: number,
    flipX: boolean,
    flipY: boolean,
  ): void {
    const d = this.mem.data;
    const screenBase = this.framebufferBase();
    const writeMask = d[HW.COLOR_BITMASK] & 15;
    const readMask = d[HW.COLOR_BITMASK] >> 4;

    let scrW = sprW;
    let scrH = sprH;

    scrX -= this.cameraX();
    scrY -= this.cameraY();

    // left clip
    if (scrX < d[DRAW.CLIP_XB]) {
      const nclip = d[DRAW.CLIP_XB] - scrX;
      scrX = d[DRAW.CLIP_XB];
      scrW -= nclip;
      if (!flipX) sprX += nclip;
      else sprW -= nclip;
    }
    // right clip
    if (scrX + scrW > d[DRAW.CLIP_XE]) {
      scrW -= scrX + scrW - d[DRAW.CLIP_XE];
    }
    // top clip
    if (scrY < d[DRAW.CLIP_YB]) {
      const nclip = d[DRAW.CLIP_YB] - scrY;
      scrY = d[DRAW.CLIP_YB];
      scrH -= nclip;
      if (!flipY) sprY += nclip;
      else sprH -= nclip;
    }
    // bottom clip
    if (scrY + scrH > d[DRAW.CLIP_YE]) {
      scrH -= scrY + scrH - d[DRAW.CLIP_YE];
    }

    let lastByte = 0;
    let lastIdx = -1;
    const startWithHalf = (sprX & 1) !== 0;

    for (let y = 0; y < scrH; y++) {
      let x = 0;
      while (x < scrW) {
        const absSprX = sprX + (flipX ? sprW - (x + 1) : x);
        const absSprY = sprY + (flipY ? scrH - (y + 1) : y);
        if (!IS_VALID_SPR_IDX(absSprX, absSprY)) {
          ++x;
          continue;
        }
        const bothPix = d[sheetBase + COMBINED_IDX(absSprX, absSprY)];
        const lc0 = bothPix & 0x0f;
        const rc = (bothPix >> 4) & 0x0f;

        const finalY = scrY + y;
        let finalX = scrX + (flipX ? x + 1 : x);

        if (x > 0 || !startWithHalf) {
          let lc = lc0 & 0x0f;
          if (!(d[DRAW.DRAW_PAL + lc] >> 4)) {
            lc = d[DRAW.DRAW_PAL + lc] & 0x0f;
            const idx = screenBase + COMBINED_IDX(finalX, finalY);
            if (lastIdx !== idx) {
              lastByte = d[idx];
              lastIdx = idx;
            }
            const source = (finalX & 1) === 0 ? lastByte & 0x0f : lastByte >> 4;
            lc = (source & ~writeMask) | (lc & writeMask & readMask);
            this.setNibble(finalX, finalY, lc, screenBase);
          }
          ++x;
          if (flipX) --finalX;
          else ++finalX;
        }

        if (x < scrW) {
          let rc2 = rc & 0x0f;
          if (!(d[DRAW.DRAW_PAL + rc2] >> 4)) {
            rc2 = d[DRAW.DRAW_PAL + rc2] & 0x0f;
            const idx = screenBase + COMBINED_IDX(finalX, finalY);
            if (lastIdx !== idx) {
              lastByte = d[idx];
              lastIdx = idx;
            }
            const source = (finalX & 1) === 0 ? lastByte & 0x0f : lastByte >> 4;
            rc2 = (source & ~writeMask) | (rc2 & writeMask & readMask);
            this.setNibble(finalX, finalY, rc2, screenBase);
          }
          ++x;
        }
      }
    }
  }

  /** Stretch blitter (graphics.cpp:222-455): 16.16 fixed-point resample. */
  copyStretchSpriteToScreen(
    sheetBase: number,
    sprX: number,
    sprY: number,
    sprW: number,
    sprH: number,
    scrX: number,
    scrY: number,
    scrW: number,
    scrH: number,
    flipX: boolean,
    flipY: boolean,
    skipStretchPx = false,
  ): void {
    if (scrW === 0 || scrH === 0) return;
    if (sprH === scrH && sprW === scrW && !flipX) {
      this.copySpriteToScreen(sheetBase, scrX, scrY, sprX, sprY, scrW, scrH, flipX, flipY);
      return;
    }

    const d = this.mem.data;
    const screenBase = this.framebufferBase();
    const bm = d[HW.COLOR_BITMASK];
    const writeMask = bm & 15;
    const readMask = bm >> 4;

    scrX -= this.cameraX();
    scrY -= this.cameraY();
    if (scrW < 0) {
      flipX = !flipX;
      scrW = -scrW;
      scrX -= scrW;
    }
    if (scrH < 0) {
      flipY = !flipY;
      scrH = -scrH;
      scrY -= scrH;
    }

    let spx = (sprX << 16) | 0;
    let spy = (sprY << 16) | 0;
    let spw = (sprW << 16) | 0;
    let sph = (sprH << 16) | 0;

    const dx = Math.trunc(spw / scrW);
    let dy = Math.trunc(sph / scrH);

    // clip
    if (scrX < d[DRAW.CLIP_XB]) {
      const nclip = d[DRAW.CLIP_XB] - scrX;
      scrX = d[DRAW.CLIP_XB];
      scrW -= nclip;
      if (!flipX) spx = (spx + nclip * dx) | 0;
      else spw = (spw - nclip * dx) | 0;
    }
    if (scrX + scrW > d[DRAW.CLIP_XE]) {
      scrW -= scrX + scrW - d[DRAW.CLIP_XE];
    }
    if (scrY < d[DRAW.CLIP_YB]) {
      const nclip = d[DRAW.CLIP_YB] - scrY;
      scrY = d[DRAW.CLIP_YB];
      scrH -= nclip;
      if (!flipY) spy = (spy + nclip * dy) | 0;
      else sph = (sph - nclip * dy) | 0;
    }
    if (scrY + scrH > d[DRAW.CLIP_YE]) {
      scrH -= scrY + scrH - d[DRAW.CLIP_YE];
    }

    if (flipY) {
      spy = (spy + sph - 1 * dy) | 0;
      dy = -dy;
    }

    let prevSprX = -1;
    let prevSprY = -1;

    if (bm === 0xff) {
      for (let y = 0; y < scrH; y++) {
        const sprYRow = ((spy + y * dy) | 0) >> 16;
        if (sprYRow > 127) continue;
        const rowBase = sheetBase + sprYRow * 64;
        if (skipStretchPx && prevSprY === sprYRow) continue;
        prevSprY = sprYRow;

        if (!flipX) {
          for (let x = 0; x < scrW; x++) {
            const shiftedPixIndex = (((spx + x * dx) | 0) >> 16);
            if (shiftedPixIndex > 127) continue;
            if (skipStretchPx && prevSprX === shiftedPixIndex) continue;
            prevSprX = shiftedPixIndex;
            const bothPix = d[rowBase + (shiftedPixIndex >> 1)];
            let c = shiftedPixIndex % 2 === 0 ? bothPix & 0x0f : (bothPix >> 4) & 0x0f;
            c &= 0x0f;
            if (d[DRAW.DRAW_PAL + c] >> 4) continue;
            c = d[DRAW.DRAW_PAL + c] & 0x0f;
            this.setNibble(scrX + x, scrY + y, c, screenBase);
          }
        } else {
          for (let x = 0; x < scrW; x++) {
            const pixIndex = (spx + spw - (x + 1) * dx) | 0;
            const shiftedPixIndex = pixIndex >> 16;
            if (shiftedPixIndex > 127) continue;
            const bothPix = d[rowBase + (shiftedPixIndex >> 1)];
            let c = shiftedPixIndex % 2 === 0 ? bothPix & 0x0f : bothPix >> 4;
            if (d[DRAW.DRAW_PAL + c] >> 4) continue;
            c = d[DRAW.DRAW_PAL + c] & 0x0f;
            this.setNibble(scrX + x, scrY + y, c, screenBase);
          }
        }
      }
    } else {
      for (let y = 0; y < scrH; y++) {
        const sprYRow = ((spy + y * dy) | 0) >> 16;
        if (sprYRow > 127) continue;
        const rowBase = sheetBase + sprYRow * 64;

        if (!flipX) {
          for (let x = 0; x < scrW; x++) {
            const shiftedPixIndex = (((spx + x * dx) | 0) >> 16);
            if (shiftedPixIndex > 127) continue;
            const bothPix = d[rowBase + (shiftedPixIndex >> 1)];
            let c = shiftedPixIndex % 2 === 0 ? bothPix & 0x0f : (bothPix >> 4) & 0x0f;
            c &= 0x0f;
            if (d[DRAW.DRAW_PAL + c] >> 4) continue;
            c = d[DRAW.DRAW_PAL + c] & 0x0f;
            const finalX = scrX + x;
            const finalY = scrY + y;
            const byte = d[screenBase + COMBINED_IDX(finalX, finalY)];
            const source = (finalX & 1) === 0 ? byte & 0x0f : byte >> 4;
            c = (source & ~writeMask) | (c & writeMask & readMask);
            this.setNibble(finalX, finalY, c, screenBase);
          }
        } else {
          for (let x = 0; x < scrW; x++) {
            const pixIndex = (spx + spw - (x + 1) * dx) | 0;
            const shiftedPixIndex = pixIndex >> 16;
            if (shiftedPixIndex > 127) continue;
            const bothPix = d[rowBase + (shiftedPixIndex >> 1)];
            let c = shiftedPixIndex % 2 === 0 ? bothPix & 0x0f : bothPix >> 4;
            if (d[DRAW.DRAW_PAL + c] >> 4) continue;
            c = d[DRAW.DRAW_PAL + c] & 0x0f;
            const finalX = scrX + x;
            const finalY = scrY + y;
            const byte = d[screenBase + COMBINED_IDX(finalX, finalY)];
            const source = (finalX & 1) === 0 ? byte & 0x0f : byte >> 4;
            c = (source & ~writeMask) | (c & writeMask & readMask);
            this.setNibble(finalX, finalY, c, screenBase);
          }
        }
      }
    }
  }

  /** spr(n,x,y[,w=1,h=1,fx,fy]) (graphics.cpp:1719-1733). */
  spr(
    n: number,
    x: number,
    y: number,
    w = 0x10000,
    h = 0x10000,
    flipX = false,
    flipY = false,
  ): void {
    const sprX = (n % 16) * 8;
    const sprY = Math.trunc(n / 16) * 8;
    const sprW = (fx.toInt(fx.mul(w, 0x80000)) << 16) >> 16; // int16 cast
    const sprH = (fx.toInt(fx.mul(h, 0x80000)) << 16) >> 16;
    this.copySpriteToScreen(this.spriteSheetBase(), x, y, sprX, sprY, sprW, sprH, flipX, flipY);
  }

  sspr(
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
    flipX = false, flipY = false,
  ): void {
    this.copyStretchSpriteToScreen(
      this.spriteSheetBase(), sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY, false,
    );
  }

  // ------------------------------------------------------------------
  // tline (graphics.cpp:861-959, zepto8 port)

  tline(x0: number, y0: number, x1: number, y1: number, mx: number, my: number): void {
    this.tlineStep(x0, y0, x1, y1, mx, my, 0x2000 /* 1/8 */, 0);
  }

  tlineStep(x0: number, y0: number, x1: number, y1: number, mx: number, my: number, mdx: number, mdy: number): void {
    x0 -= this.cameraX();
    y0 -= this.cameraY();
    x1 -= this.cameraX();
    y1 -= this.cameraY();

    const xDifGreater = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const dx = xDifGreater ? (x0 <= x1 ? 1 : -1) : 0;
    const dy = xDifGreater ? 0 : y0 <= y1 ? 1 : -1;
    const vertical = x0 === x1;

    const xStart = this.clampXToClip(x0);
    const xEnd = this.clampXToClip(x1);
    const yStart = this.clampYToClip(y0);
    const yEnd = this.clampYToClip(y1);

    const d = this.mem.data;
    const xmask = tlineMask(d[DRAW.TLINE_MAP_W]);
    const ymask = tlineMask(d[DRAW.TLINE_MAP_H]);

    // advance texture coords to the clipped start (steps of 8192, graphics.cpp:906-912)
    let delta = Math.abs(xDifGreater ? xStart - x0 : yStart - y0);
    while (delta) {
      const step = Math.min(8192, delta);
      mx = (mx & ~xmask) | ((mx + fx.mul(mdx, step | 0)) & xmask);
      my = (my & ~ymask) | ((my + fx.mul(mdy, step | 0)) & ymask);
      delta -= step;
    }

    let x = xStart;
    let y = yStart;
    for (;;) {
      const sx = d[DRAW.TLINE_MAP_X] + fx.toInt(mx & xmask);
      const sy = d[DRAW.TLINE_MAP_Y] + fx.toInt(my & ymask);
      const sprite = this.mget(sx, sy);
      if (sprite) {
        const sprX = (sprite % 16) * 8;
        const sprY = Math.trunc(sprite / 16) * 8;
        const col = this.getNibble(
          sprX + (((mx << 3) >> 16) & 0x7),
          sprY + (((my << 3) >> 16) & 0x7),
          0x0000, // sprite sheet default mapping — see note below
        );
        if (!this.isColorTransparent(col) && this.isWithinClip(x, y)) {
          this.setPixelFromSprite(x, y, col);
        }
      }

      mx = (mx & ~xmask) | ((mx + mdx) & xmask);
      my = (my & ~ymask) | ((my + mdy) & ymask);

      if (xDifGreater) {
        if (x === xEnd) break;
        x += dx;
        y = y0 + Math.trunc(((x - x0) / (x1 - x0)) * (y1 - y0));
      } else {
        if (y === yEnd) break;
        y += dy;
        if (!vertical) {
          x = y0 === y1 ? x0 : x0 + Math.trunc(((y - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // flags / sheet pixel access (graphics.cpp:1750-1783)

  fget(n: number, f?: number): number | boolean {
    const v = this.mem.data[0x3000 + (n & 0xff)];
    if (f === undefined) return v;
    return ((v >> f) & 1) !== 0;
  }

  fset(n: number, fOrVal: number | boolean, v?: boolean): void {
    const i = 0x3000 + (n & 0xff);
    if (v === undefined) {
      this.mem.data[i] = (fOrVal as number) & 0xff;
    } else {
      const bit = fOrVal as number;
      if (v) this.mem.data[i] |= 1 << bit;
      else this.mem.data[i] &= ~(1 << bit);
    }
  }

  sget(x: number, y: number): number {
    if (IS_VALID_SPR_IDX(x, y)) return this.getNibble(x, y, this.spriteSheetBase());
    return 0;
  }

  sset(x: number, y: number, c: number): void {
    if (IS_VALID_SPR_IDX(x, y)) this.setNibble(x, y, c, this.spriteSheetBase());
  }

  // ------------------------------------------------------------------
  // camera / clip / cursor (graphics.cpp:1785-1985)

  camera(x = 0, y = 0): [number, number] {
    const prev: [number, number] = [this.cameraX(), this.cameraY()];
    this.mem.pokeInt16(DRAW.CAMERA_X, x);
    this.mem.pokeInt16(DRAW.CAMERA_Y, y);
    return prev;
  }

  clip(x = 0, y = 0, w = 128, h = 128): ClipRect {
    const d = this.mem.data;
    const prev: ClipRect = {
      xb: d[DRAW.CLIP_XB],
      xe: d[DRAW.CLIP_XE],
      yb: d[DRAW.CLIP_YB],
      ye: d[DRAW.CLIP_YE],
    };
    d[DRAW.CLIP_XB] = clamp(x, 0, 128);
    d[DRAW.CLIP_YB] = clamp(y, 0, 128);
    d[DRAW.CLIP_XE] = clamp(x + w, 0, 128);
    d[DRAW.CLIP_YE] = clamp(y + h, 0, 128);
    return prev;
  }

  cursor(x = 0, y = 0, col?: number): [number, number] {
    if (col !== undefined) this.setColor(col);
    const d = this.mem.data;
    const prev: [number, number] = [d[DRAW.TEXT_X], d[DRAW.TEXT_Y]];
    d[DRAW.TEXT_X] = x & 0xff;
    d[DRAW.TEXT_Y] = y & 0xff;
    return prev;
  }

  // ------------------------------------------------------------------
  // map cells (graphics.cpp:1821-1901)

  private mapInfo(): { bigMap: boolean; mapSize: number; mapW: number; mapH: number } {
    const d = this.mem.data;
    const bigMap = d[HW.MAP_MAPPING] >= 0x80;
    const bigMapLocation = d[HW.MAP_MAPPING] << 8;
    const mapSize = bigMap ? 0x10000 - bigMapLocation : 8192;
    const mapW = d[HW.MAP_WIDTH] === 0 ? 256 : d[HW.MAP_WIDTH];
    return { bigMap, mapSize, mapW, mapH: mapSize / mapW };
  }

  mget(celx: number, cely: number): number {
    const { bigMap, mapSize, mapW, mapH } = this.mapInfo();
    if (celx < 0 || celx > mapW - 1 || cely < 0 || cely > mapH - 1) return 0;
    const idx = cely * mapW + celx;
    if (bigMap) {
      const offset = 0x8000 - mapSize;
      return this.mem.data[0x8000 + offset + idx];
    }
    if (idx < 4096) return this.mem.data[0x2000 + idx];
    if (idx < 8192) return this.mem.data[idx]; // shared gfx2/map rows 32-63
    return 0;
  }

  mset(celx: number, cely: number, snum: number): void {
    const { bigMap, mapSize, mapW, mapH } = this.mapInfo();
    if (celx < 0 || celx > mapW - 1 || cely < 0 || cely > mapH - 1) return;
    const idx = cely * mapW + celx;
    if (bigMap) {
      const offset = 0x8000 - mapSize;
      this.mem.data[0x8000 + offset + idx] = snum & 0xff;
    } else if (idx < 4096) {
      this.mem.data[0x2000 + idx] = snum & 0xff;
    } else if (idx < 8192) {
      this.mem.data[idx] = snum & 0xff;
    }
  }

  map(
    celx: number, cely: number, sx: number, sy: number,
    celw: number, celh: number, layer = 0,
  ): void {
    for (let y = 0; y < celh; y++) {
      for (let x = 0; x < celw; x++) {
        const cell = this.mget(celx + x, cely + y);
        if (cell && (layer === 0 || ((this.fget(cell) as number) & layer) !== 0)) {
          this.spr(cell, sx + x * 8, sy + y * 8);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // palettes (graphics.cpp:1903-1965)

  palReset(): void {
    const d = this.mem.data;
    for (let c = 0; c < 16; c++) {
      d[DRAW.DRAW_PAL + c] = c;
      d[DRAW.SCREEN_PAL + c] = c;
    }
    this.paltReset();
  }

  /** pal(p): reset one palette. Draw side preserves transparency bits. */
  palResetSide(p: number): void {
    const d = this.mem.data;
    for (let c = 0; c < 16; c++) {
      if (p === 0) {
        let transp = d[DRAW.DRAW_PAL + c] & 0x10;
        if (c === 0 && transp === 0) transp = 0x10;
        d[DRAW.DRAW_PAL + c] = c | transp;
      } else if (p === 1) {
        d[DRAW.SCREEN_PAL + c] = c;
      }
    }
  }

  /** pal(c0,c1,p) — returns the previous low nibble. */
  palSet(c0: number, c1: number, p: number): number {
    const d = this.mem.data;
    c0 &= 0x0f;
    if (p === 0) {
      const prev = d[DRAW.DRAW_PAL + c0] & 0x0f;
      d[DRAW.DRAW_PAL + c0] = (d[DRAW.DRAW_PAL + c0] & 0x10) | (c1 & 0x0f);
      return prev;
    }
    const prev = d[DRAW.SCREEN_PAL + c0] & 0x0f;
    d[DRAW.SCREEN_PAL + c0] = c1 & 0x8f;
    return prev;
  }

  paltReset(): void {
    const d = this.mem.data;
    d[DRAW.DRAW_PAL] |= 1 << 4;
    for (let c = 1; c < 16; c++) d[DRAW.DRAW_PAL + c] &= ~(1 << 4);
  }

  palt(c: number, t: boolean): boolean {
    const d = this.mem.data;
    const i = DRAW.DRAW_PAL + (c & 15);
    const prev = (d[i] & 0xf0) !== 0;
    if (t) d[i] |= 1 << 4;
    else d[i] &= ~(1 << 4);
    return prev;
  }

  // ------------------------------------------------------------------
  // character drawing (graphics.cpp:1572-1717)

  drawCharacter(
    ch: number,
    x: number,
    y: number,
    fgColor: number,
    bgColor: number,
    printMode: number,
    forceCharWidth: number,
    forceCharHeight: number,
  ): number {
    let extraCharWidth = 0;
    const useCustomFont = (printMode & PRINT_MODE.CUSTOM_FONT) === PRINT_MODE.CUSTOM_FONT;
    const defaultCharWidth = useCustomFont ? this.mem.data[0x5600] : 4;
    const defaultWideCharWidth = useCustomFont ? this.mem.data[0x5601] : 8;
    const defaultCharHeight = useCustomFont ? this.mem.data[0x5602] : 5;

    if (ch > 0x0f) {
      const widthIsForced = forceCharWidth > -1 && forceCharWidth < 4;
      let renderWidth: number;
      if (widthIsForced) {
        renderWidth = ch < 0x80 ? forceCharWidth : forceCharWidth + 4;
      } else if (useCustomFont) {
        renderWidth = 8;
      } else {
        renderWidth = ch < 0x80 ? defaultCharWidth : defaultWideCharWidth;
      }
      if (ch >= 0x80) extraCharWidth = defaultWideCharWidth - defaultCharWidth;
      const renderHeight =
        forceCharHeight > -1 && forceCharHeight < 5 ? forceCharHeight : defaultCharHeight;

      const glyph = useCustomFont
        ? this.mem.data.subarray(0x5600 + ch * 8, 0x5600 + ch * 8 + 8)
        : fontGlyph(ch);
      extraCharWidth += this.drawCharacterFromBytes(
        glyph, x, y, fgColor, bgColor, printMode, renderWidth, renderHeight,
      )[0];
    }

    if ((printMode & PRINT_MODE.ON) === PRINT_MODE.ON) return 0;
    return extraCharWidth;
  }

  /** Returns [extraCharWidth, extraCharHeight]. */
  drawCharacterFromBytes(
    chBytes: ArrayLike<number>,
    x: number,
    y: number,
    fgColor: number,
    bgColor: number,
    printMode: number,
    charWidth: number,
    charHeight: number,
  ): [number, number] {
    x -= this.cameraX();
    y -= this.cameraY();
    const screenBase = this.framebufferBase();

    let extraCharWidth = 0;
    let extraCharHeight = 0;
    let wFactor = 1;
    let hFactor = 1;
    let evenPxOnly = false;
    let invertColors = false;
    let solidBg = false;

    if ((printMode & PRINT_MODE.ON) === PRINT_MODE.ON) {
      if ((printMode & PRINT_MODE.WIDE) === PRINT_MODE.WIDE) {
        wFactor = 2;
        extraCharWidth = charWidth;
      }
      if ((printMode & PRINT_MODE.TALL) === PRINT_MODE.TALL) {
        hFactor = 2;
        extraCharHeight = charHeight;
      }
      if ((printMode & PRINT_MODE.STRIPEY) === PRINT_MODE.STRIPEY) evenPxOnly = true;
      if ((printMode & PRINT_MODE.INVERTED) === PRINT_MODE.INVERTED) invertColors = true;
      if ((printMode & PRINT_MODE.SOLID_BG) === PRINT_MODE.SOLID_BG) solidBg = true;
    }

    fgColor &= 0x0f;
    bgColor &= 0x0f;
    const maxFontDataRows = 8;

    for (let relY = 0; relY < charHeight * hFactor; relY++) {
      for (let relX = 0; relX < charWidth * wFactor; relX++) {
        const fontRow = Math.trunc(relY / hFactor);
        const fontCol = Math.trunc(relX / wFactor);
        if (fontRow >= maxFontDataRows || fontCol >= maxFontDataRows) continue;
        let on = ((1 << fontCol) & chBytes[fontRow]) !== 0;
        on = on && (hFactor === 1 || !evenPxOnly || relY % 2 === 0);
        on = on && (wFactor === 1 || !evenPxOnly || relX % 2 === 0);

        const absX = x + relX;
        const absY = y + relY;
        if (this.isWithinClip(absX, absY)) {
          if (invertColors) on = !on;
          if (on) this.setNibble(absX, absY, fgColor, screenBase);
          else if (solidBg) this.setNibble(absX, absY, bgColor, screenBase);
        }
      }
    }
    return [extraCharWidth, extraCharHeight];
  }
}

function tlineMask(dim: number): number {
  if (dim === 0) return 0xffffff;
  return fx.sub(fx.fromInt(dim), 1);
}

function sort2(a: number, b: number): { a: number; b: number } {
  return a > b ? { a: b, b: a } : { a, b };
}
