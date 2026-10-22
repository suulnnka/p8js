// PICO-8 system palette — hostVmShared.h:11-44 (fake-08). Used by the web
// presenter and the golden-cart pixel tests.

/** 16 base colors + alt 127..143, as [r, g, b]. */
export const PICO8_PALETTE: readonly (readonly [number, number, number])[] = [
  [2, 4, 8], [29, 43, 83], [126, 37, 83], [0, 135, 81],
  [171, 82, 54], [95, 87, 79], [194, 195, 199], [255, 241, 232],
  [255, 0, 77], [255, 163, 0], [255, 236, 39], [0, 228, 54],
  [41, 173, 255], [131, 118, 156], [255, 119, 168], [255, 204, 170],
];

export const PICO8_ALT_PALETTE: readonly (readonly [number, number, number])[] = [
  [41, 24, 20], [17, 29, 53], [66, 33, 54], [18, 83, 89],
  [116, 47, 41], [73, 51, 59], [162, 136, 121], [243, 239, 125],
  [190, 18, 80], [255, 108, 36], [168, 231, 46], [0, 181, 67],
  [6, 90, 181], [117, 70, 101], [255, 110, 89], [255, 157, 129],
];

/** Color index after screen-palette mapping (&0x8f like fake-08 drawFrame).
 *  16..127 are black (hostCommonFunctions.cpp:47-49 fills i<128 with zeros);
 *  128..143 index the alt palette (COLOR_128..143). */
export function paletteColor(idx: number): readonly [number, number, number] {
  if (idx >= 0 && idx < 16) return PICO8_PALETTE[idx];
  if (idx >= 128 && idx <= 143) return PICO8_ALT_PALETTE[idx - 128];
  return [0, 0, 0];
}

/** RGBA lookup table for all 256 mapped indices (presentation fast path). */
export const PALETTE_RGBA: Uint8Array = (() => {
  const t = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = paletteColor(i & 0x8f);
    t[i * 4] = r;
    t[i * 4 + 1] = g;
    t[i * 4 + 2] = b;
    t[i * 4 + 3] = 255;
  }
  return t;
})();
