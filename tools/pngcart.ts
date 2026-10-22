// .p8.png cartridge parsing → ROM image + Lua source + label.
// Ported from zepto8 src/pico8/cart.cpp (load_png): the image is 160×205, and
// every pixel encodes one cart byte in the low two bits of ARGB.

import { decompressCode } from "./pxa.ts";
import { fileBytesToPico8 } from "./charset.ts";
import { ROM_CODE_START, LABEL_SIZE } from "./p8.ts";
import type { ParsedCart } from "./p8.ts";
import { PNG } from "pngjs";

export const PNG_WIDTH = 160;
export const PNG_HEIGHT = 205;

/** PICO-8 default palette (used to quantize the visible label). */
export const PICO8_PALETTE = [
  0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
  0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa,
];

function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PICO8_PALETTE.length; i++) {
    const c = PICO8_PALETTE[i];
    const dr = r - ((c >> 16) & 0xff);
    const dg = g - ((c >> 8) & 0xff);
    const db = b - (c & 0xff);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export async function parseP8Png(file: Uint8Array): Promise<ParsedCart> {
  const png = PNG.sync.read(Buffer.from(file));

  if (png.width !== PNG_WIDTH || png.height !== PNG_HEIGHT) {
    throw new Error(
      `not a pico-8 cart png (expected ${PNG_WIDTH}×${PNG_HEIGHT}, got ${png.width}×${png.height})`,
    );
  }

  const data = png.data; // RGBA
  const count = PNG_WIDTH * PNG_HEIGHT;
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const a = data[o + 3] & 3;
    const r = data[o] & 3;
    const g = data[o + 1] & 3;
    const b = data[o + 2] & 3;
    bytes[i] = (a << 6) | (r << 4) | (g << 2) | b;
  }

  const rom = bytes.subarray(0, ROM_CODE_START);
  const romCopy = Uint8Array.from(rom);

  // Code section 0x4300–0x7fff, then version byte at 0x8000 (+ 4 minor bytes).
  const sourceRaw = decompressCode(bytes.subarray(ROM_CODE_START, 0x8000));
  const lua = fileBytesToPico8(sourceRaw);

  const version = bytes[0x8000];
  const minor =
    ((bytes[0x8001] << 24) |
      (bytes[0x8002] << 16) |
      (bytes[0x8003] << 8) |
      bytes[0x8004]) >>>
    0;

  // Label: visible pixels (16..143, 24..151) quantized to the PICO-8 palette.
  const label = new Uint8Array(LABEL_SIZE);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const o = (((y + 24) * PNG_WIDTH + (x + 16)) * 4);
      label[y * 128 + x] = nearestPaletteIndex(
        data[o],
        data[o + 1],
        data[o + 2],
      );
    }
  }

  return { version, minor, rom: romCopy, lua, label };
}
