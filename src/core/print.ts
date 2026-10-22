// PICO-8 print — port of fake-08 printHelper.cpp (whole file; file:line
// references inline). Single entry point:
//
//   corePrint(g, s, x, y, fg, bg) -> final x
//
// Coordinates are resolved by the caller (api.ts reads 0x5f26/0x5f27 for the
// no-coordinate print overload). No extra parameters were needed: printMode
// comes from 0x5f58 and lineHeight is derived inside, like the C++.
//
// Semantic choices vs the C++ blueprint:
// - Entry scroll (y >= 127 -> memmove screen up, y = 121; printHelper.cpp:
//   82-102) runs inside corePrint for every call. fake-08 only scrolls in
//   the no-coordinate overload; the p8js spec merges it into corePrint so
//   test-visible behaviour is "draw at 121". The exit-time scroll block
//   (printHelper.cpp:105-121, would set text_y = 122) is NOT ported — the
//   next call's entry scroll produces the same stacking (documented per
//   spec: only the entry scroll is in scope).
// - The scroll touches raw mem.data at ADDR.SCREEN (0x6000) and ignores the
//   0x5f55 screen mapping (spec; printHelper.cpp:88-97 uses screenBuffer
//   directly). copyWithin/fill stand in for memmove/memset; TypedArray
//   bounds clamping replaces fake-08's out-of-bounds UB for huge y.
// - bg seeds the local bgColor (printHelper.cpp:147): 0xff is the "no
//   background" sentinel (C++ initial value); api.ts passes 0 (black).
//   bg alone never enables SOLID_BG — that stays control char 2 / \^# /
//   0x5f58 like the C++.
// - \^1..\^9 and \^d keep fake-08's burn loops (printHelper.cpp:234-243,
//   562-567) — vm_flip is commented out there, so they are observable
//   no-ops. \a (ch 7) consumes its argument and discards it (audio stub,
//   :438-446); the 32-byte audioStrBytes storage is dropped (C++ can smash
//   its stack buffer on long args).
// - Reads past the end of s return 0 (C++ std::string::operator[](size())
//   is '\0'; beyond is UB). strtol is reduced to leading-hex-digit parsing
//   (no whitespace/sign/0x prefixes — those never occur in PICO-8 print
//   encodings); p0 nibble chars accept 0-9/a-z only, as in the C++.
// - '\t' with tabStopWidth 0 computes x % 0 -> NaN in JS -> no advance
//   (C++ would be UB).
// - !/@ RAM writes land in a Uint8Array: indices past 0xffff are dropped
//   (C++ writes out of bounds = UB). The '!'/'@' trailing byte quirk (C++
//   reads one byte past substr and writes a NUL) is preserved via at().
// - No 128-wide auto wrap: only the \^r soft wrap (printHelper.cpp:571-576)
//   wraps, then only when rhsWrap was explicitly set.
// - s is a byte string (latin-1 code units); emoji/UTF-8 conversion happens
//   at the source layer, print does not transform it.

import { DRAW, HW, ADDR } from "./memory.ts";
import { PRINT_MODE, type Graphics } from "./graphics.ts";

/** Custom-font header in work RAM (graphics.ts uses the same literals). */
const FONT_W = 0x5600;
const FONT_H = 0x5602;
const FONT_FLAGS = 0x5605;
const FONT_ADJ = 0x5608;

/** printHelper.cpp:33-43 — PICO-8 p0 nibble char: '0'-'9' / chars > '`'. */
function p0CharToNum(hexChar: number): number {
  let num = 0;
  if (hexChar > 47 && hexChar < 58) num = hexChar - 48;
  if (hexChar > 96) num = hexChar - 87;
  return num;
}

/** printHelper.cpp:45-76 — note case 8 returns 255 (fake-08 quirk, verbatim). */
function pow2(power: number): number {
  switch (power) {
    case 0: return 1;
    case 1: return 2;
    case 2: return 4;
    case 3: return 8;
    case 4: return 16;
    case 5: return 32;
    case 6: return 64;
    case 7: return 128;
    case 8: return 255;
    default: return 0;
  }
}

function hexDigit(ch: number): number {
  if (ch >= 48 && ch <= 57) return ch - 48;
  if (ch >= 97 && ch <= 102) return ch - 87;
  if (ch >= 65 && ch <= 70) return ch - 55;
  return -1;
}

/** strtol(window, NULL, 16) over [start, start+count), stopping at the first
 *  non-hex char; 0 when no digits (printHelper.cpp uses strtol for hex
 *  strings — whitespace/sign/0x prefixes intentionally not handled). */
function strtolHexWindow(s: string, start: number, count: number): number {
  let v = 0;
  let any = false;
  for (let k = 0; k < count; k++) {
    const i = start + k;
    const d = i < s.length ? hexDigit(s.charCodeAt(i)) : -1;
    if (d < 0) break;
    v = v * 16 + d;
    any = true;
  }
  return any ? v : 0;
}

/** printHelper.cpp:15-24 — hex char pairs -> bytes. A trailing odd char
 *  parses alone (C++ buff[1] would be '\0'). */
function hexStrToBytes(hex: string, out: Uint8Array): void {
  for (let i = 0; i < hex.length; i += 2) {
    out[i >> 1] = strtolHexWindow(hex, i, 2) & 0xff;
  }
}

/**
 * Single print call (printHelper.cpp:130-584). Returns the final x.
 *
 * @param g  graphics (and via g.mem the PicoRam) to draw into
 * @param s  byte string; control chars 0..15 interpreted as in fake-08
 * @param x  starting x (caller-resolved; may be >= screen edge)
 * @param y  starting y; >= 127 triggers the entry screen scroll (y := 121)
 * @param fg pen color — setColor(fg) at entry, drawn through the draw palette
 * @param bg initial background color; 0xff = none (C++ default). Does not
 *           enable SOLID_BG by itself.
 * @returns the x cursor after the last drawn/consumed character
 */
export function corePrint(
  g: Graphics,
  s: string,
  x: number,
  y: number,
  fg: number,
  bg: number,
): number {
  const d = g.mem.data;

  // entry scroll (printHelper.cpp:82-102), raw 0x6000 window per spec
  if (y >= 127) {
    const linesToCopy = 127 - 6; // 121 rows
    const startY = y - linesToCopy;
    const base = ADDR.SCREEN;
    d.copyWithin(base, base + startY * 64, base + (startY + linesToCopy) * 64);
    d.fill(0, base + linesToCopy * 64, base + linesToCopy * 64 + startY * 64);
    y = 127 - 6; // 121
  }

  g.setColor(fg); // :131 color(c)
  d[DRAW.TEXT_X] = x & 0xff; // :133
  d[DRAW.TEXT_Y] = y & 0xff; // :134

  const length = s.length;
  /** s[i], with s[length] = '\0' like C++ (beyond is UB -> 0). */
  const at = (i: number): number => (i >= 0 && i < length ? s.charCodeAt(i) : 0);

  let homeX = x; // :137-140
  let homeY = y;
  let prevX = x;
  let prevY = y;
  let tabStopWidth = 4; // :141
  let charWidth = 4;
  let charHeight = 6;
  let lineHeight = 0;
  let forceCharWidth = -1;
  let forceCharHeight = -1;
  let bgColor = bg & 0xff; // :147 — 0xff = no background
  let fgColor = d[DRAW.COLOR]; // :148 — back-read after setColor
  const charBytes = new Uint8Array(8); // :149
  let cancelWrap = false;
  let outlineColor = 0;
  let outlineNeighbors = 0;
  let underline = false;

  let printMode = d[HW.PRINT_ATTR]; // :156
  if ((printMode & 0x1) === 0) printMode = 0; // :158-160
  if (printMode & PRINT_MODE.CUSTOM_FONT) {
    // :162-165
    charWidth = d[FONT_W];
    charHeight = d[FONT_H];
  }

  let framesBetweenChars = 0; // :169
  let framesToPause = 0;
  let rhsWrap = -1; // :171

  /** bg arg for drawCharacter: 0xff sentinel -> 0 (drawPal-mapped otherwise). */
  const bgForDraw = (): number => (bgColor === 0xff ? 0 : g.drawPalMapped(bgColor));

  for (let n = 0; n < length; n++) {
    let ch = at(n);
    framesToPause = framesBetweenChars; // :176

    if (ch === 0) {
      // :177-182 null stop — write back current cursor, return current x
      d[DRAW.TEXT_X] = x & 0xff;
      d[DRAW.TEXT_Y] = y & 0xff;
      return x;
    } else if (ch === 1) {
      // :183-200 "\*{p0}" repeat next char p0 times
      const times = p0CharToNum(at(n + 1));
      ch = at(n + 2);
      n += 2;
      for (let i = 0; i < times; i++) {
        x += charWidth + g.drawCharacter(
          ch, x, y,
          g.drawPalMapped(fgColor), bgForDraw(),
          printMode, forceCharWidth, forceCharHeight,
        );
      }
    } else if (ch === 2) {
      // :201-206 "\#{p0}" solid background color
      bgColor = p0CharToNum(at(++n)) & 0xff; // uint8_t in C++
      printMode |= PRINT_MODE.ON | PRINT_MODE.SOLID_BG;
    } else if (ch === 3) {
      // :207-213 "\-{p0}" move cursor horizontally by 16-p0
      x += p0CharToNum(at(++n)) - 16;
    } else if (ch === 4) {
      // :214-220 "\|{p0}" move cursor vertically by 16-p0
      y += p0CharToNum(at(++n)) - 16;
    } else if (ch === 5) {
      // :221-230 "\+{p0}{p0}" move cursor diagonally
      const dx = p0CharToNum(at(n + 1)) - 16;
      const dy = p0CharToNum(at(n + 2)) - 16;
      n += 2;
      x += dx;
      y += dy;
    } else if (ch === 6) {
      // :231-437 "\^" special command
      const commandChar = at(++n);
      const cmd = String.fromCharCode(commandChar);
      if (commandChar > 48 && commandChar < 58) {
        // \^1..\^9 skip frames — fake-08's burn loop (vm_flip commented out)
        let frameCount = pow2(p0CharToNum(commandChar) - 1);
        while (frameCount > 0) frameCount--;
      } else if (cmd === "d") {
        // :245-248 pause P0 frames between chars (burn loop: no-op)
        framesBetweenChars = p0CharToNum(at(++n));
      } else if (cmd === "c") {
        // :249-254 cls with color
        g.cls(p0CharToNum(at(++n)));
      } else if (cmd === "g") {
        // :255-258 back to home
        x = homeX;
        y = homeY;
      } else if (cmd === "h") {
        // :259-262 set home to current position
        homeX = x;
        homeY = y;
      } else if (cmd === "j") {
        // :263-268 x/y = p0 * 4
        const cx = p0CharToNum(at(n + 1));
        const cy = p0CharToNum(at(n + 2));
        n += 2;
        x = cx * 4;
        y = cy * 4;
      } else if (cmd === "r") {
        // :269-272 soft-wrap right edge = p0 * 4
        rhsWrap = p0CharToNum(at(++n)) * 4;
      } else if (cmd === "s") {
        // :273-276 tab stop width
        tabStopWidth = p0CharToNum(at(++n));
      } else if (cmd === "x") {
        // :277-281 force char width
        forceCharWidth = p0CharToNum(at(++n));
        charWidth = forceCharWidth;
      } else if (cmd === "y") {
        // :282-288 force char height
        forceCharHeight = p0CharToNum(at(++n));
        charHeight = forceCharHeight;
      } else if (cmd === "w") {
        // :289-293 wide
        printMode |= PRINT_MODE.ON | PRINT_MODE.WIDE;
        charWidth = 8;
      } else if (cmd === "t") {
        // :294-298 tall
        printMode |= PRINT_MODE.ON | PRINT_MODE.TALL;
        charHeight = 12;
      } else if (cmd === "=") {
        // :299-302 stripey
        printMode |= PRINT_MODE.ON | PRINT_MODE.STRIPEY;
      } else if (cmd === "p") {
        // :303-310 wide + tall + stripey
        printMode |= PRINT_MODE.ON | PRINT_MODE.WIDE | PRINT_MODE.TALL | PRINT_MODE.STRIPEY;
        charWidth = 8;
        charHeight = 12;
      } else if (cmd === "i") {
        // :311-314 inverted
        printMode |= PRINT_MODE.ON | PRINT_MODE.INVERTED;
      } else if (cmd === "b") {
        // :315-318 padding
        printMode |= PRINT_MODE.ON | PRINT_MODE.PADDING;
      } else if (cmd === "#") {
        // :319-322 solid bg (color stays whatever bgColor holds)
        printMode |= PRINT_MODE.ON | PRINT_MODE.SOLID_BG;
      } else if (cmd === ":" || cmd === ";" || cmd === "." || cmd === ",") {
        // :323-353 embedded 8-byte glyph
        charHeight = forceCharHeight > 0 ? forceCharHeight : 8;
        if (cmd === ":" || cmd === ";") {
          const hexStr = s.substring(n + 1, n + 1 + 16);
          n += 16;
          hexStrToBytes(hexStr, charBytes);
        } else {
          for (let i = 0; i < 8; i++) charBytes[i] = at(n + 1 + i) & 0xff;
          n += 8;
        }
        const values = g.drawCharacterFromBytes(
          charBytes, x, y,
          g.drawPalMapped(fgColor), bgForDraw(),
          printMode, 8, charHeight,
        );
        x += 8 + values[0];
        charHeight = charHeight + values[1];
        lineHeight = charHeight > lineHeight ? charHeight : lineHeight;
      } else if (cmd === "-") {
        // :354-385 turn a mode off
        const offChar = String.fromCharCode(at(++n));
        if (printMode) {
          if (offChar === "w") {
            printMode &= ~PRINT_MODE.WIDE;
            charWidth = 4;
          } else if (offChar === "t") {
            printMode &= ~PRINT_MODE.TALL;
            charHeight = 6;
          } else if (offChar === "=") {
            printMode &= ~PRINT_MODE.STRIPEY;
          } else if (offChar === "p") {
            printMode &= ~(PRINT_MODE.WIDE | PRINT_MODE.TALL | PRINT_MODE.STRIPEY);
            charWidth = 4;
            charHeight = 6;
          } else if (offChar === "i") {
            printMode &= ~PRINT_MODE.INVERTED;
          } else if (offChar === "b") {
            printMode &= ~PRINT_MODE.PADDING;
          } else if (offChar === "#") {
            printMode &= ~PRINT_MODE.SOLID_BG;
          }
        }
      } else if (cmd === "!") {
        // :386-401 write 4-hex-addr + rest of string into RAM, no wrap after
        cancelWrap = true;
        const addr = strtolHexWindow(s, n + 1, 4);
        n += 4;
        const size = length - n;
        for (let i = 0; i < size; i++) {
          d[addr + i] = at(n + 1 + i) & 0xff; // trailing at()==0 = C++ '\0' quirk
        }
        n += size;
      } else if (cmd === "@") {
        // :402-418 write 4-hex-addr + 4-hex-size + bytes into RAM
        const addr = strtolHexWindow(s, n + 1, 4);
        n += 4;
        const size = strtolHexWindow(s, n + 1, 4);
        n += 4;
        for (let i = 0; i < size; i++) {
          d[addr + i] = at(n + 1 + i) & 0xff;
        }
        n += size;
      } else if (cmd === "o") {
        // :419-433 outline: color p0 + 2-hex-char neighbours bitfield
        outlineColor = p0CharToNum(at(++n)) & 0xff; // uint8_t in C++
        outlineNeighbors = strtolHexWindow(s, n + 1, 2) & 0xff;
        n += 2;
      } else if (cmd === "u") {
        // :434-436 underline
        underline = true;
      }
    } else if (ch === 7) {
      // :438-446 "\a" audio command — consume until space; audio is a stub
      let nextChar = at(++n);
      while (nextChar !== 32 && n < length) {
        nextChar = at(++n);
      }
    } else if (ch === 11) {
      // :447-464 "\v" decorate previous character
      const offset = p0CharToNum(at(n + 1));
      const toPrint = at(n + 2);
      n += 2;
      const xOffset = (offset % 4) - 2;
      const yOffset = Math.trunc(offset / 4) - 8;
      g.drawCharacter(
        toPrint, prevX + xOffset, prevY + yOffset,
        g.drawPalMapped(fgColor), bgForDraw(),
        printMode, forceCharWidth, forceCharHeight,
      );
    } else if (ch === 12) {
      // :465-469 "\f{p0}" foreground color
      fgColor = p0CharToNum(at(++n)) & 0xff; // uint8_t in C++
      g.setColor(fgColor);
    } else if (ch === 14) {
      // :470-474 custom font on (0x5600)
      printMode |= PRINT_MODE.CUSTOM_FONT;
      charWidth = d[FONT_W];
      charHeight = d[FONT_H];
    } else if (ch === 15) {
      // :475-479 custom font off
      printMode &= ~PRINT_MODE.CUSTOM_FONT;
      charWidth = 4;
      charHeight = 6;
    } else if (ch === 10) {
      // :480-485 '\n' — back to homeX, advance by line height
      x = homeX;
      lineHeight = lineHeight > 0 ? lineHeight : 6;
      y += lineHeight;
      lineHeight = 0;
    } else if (ch === 9) {
      // :486-490 '\t' — advance to next tab stop
      while (x % (tabStopWidth * 4) > 0) {
        x++;
      }
    } else if (ch === 8) {
      // :491-493 '\b'
      x -= charWidth;
    } else if (ch === 13) {
      // :494-496 '\r'
      x = homeX;
    } else if (ch >= 0x10) {
      // :497-568 draw a glyph
      lineHeight = charHeight > lineHeight ? charHeight : lineHeight;
      if (printMode & PRINT_MODE.SOLID_BG) {
        // :499-503 — rectfill uses raw bgColor (pen path applies drawPal)
        const prevPenColor = d[DRAW.COLOR];
        g.rectfill(x - 1, y - 1, x + charWidth - 1, y + lineHeight - 1, bgColor);
        d[DRAW.COLOR] = prevPenColor;
      }
      prevX = x;
      prevY = y;
      if (outlineColor !== 0 && outlineNeighbors !== 0) {
        // :506-534 — neighbour bitfield 0x01..0x80 = 8 directions
        const xOffsets = [-1, 0, 1, -1, 1, -1, 0, 1];
        const yOffsets = [-1, -1, -1, 0, 0, 1, 1, 1];
        for (let i = 0; i < 8; i++) {
          if (xOffsets[i] === 0 && yOffsets[i] === 0) continue;
          if (outlineNeighbors & (1 << i)) {
            g.drawCharacter(
              ch, x + xOffsets[i], y + yOffsets[i],
              g.drawPalMapped(outlineColor), bgForDraw(),
              printMode, forceCharWidth, forceCharHeight,
            );
          }
        }
      }
      if (underline) {
        // :535-537 — raw fgColor (pen path applies drawPal)
        g.rectfill(x - 1, y + lineHeight, x + charWidth - 1, y + lineHeight, fgColor);
      }
      const extraWidth = g.drawCharacter(
        ch, x, y,
        g.drawPalMapped(fgColor), bgForDraw(),
        printMode, forceCharWidth, forceCharHeight,
      );
      // :548-560 per-character width adjustment (custom font flag 0x5605.0)
      let perCharWidthAdj = 0;
      if ((printMode & PRINT_MODE.CUSTOM_FONT) && (d[FONT_FLAGS] & 0x01)) {
        const nibbleIdx = ch - 16;
        if (nibbleIdx >= 0 && nibbleIdx < 240) {
          const adjByte = d[FONT_ADJ + ((nibbleIdx / 2) | 0)];
          const adjNibble = nibbleIdx % 2 === 0 ? adjByte & 0x0f : adjByte >> 4;
          perCharWidthAdj = adjNibble & 0x07;
          if (perCharWidthAdj >= 4) perCharWidthAdj -= 8;
        }
      }
      x += charWidth + extraWidth + perCharWidthAdj;
      // :562-567 framesToPause burn loop (vm_flip commented out -> no-op)
      while (framesToPause > 0) {
        framesToPause--;
      }
    }

    // :570-576 soft wrap if \^r was set (no 128-wide auto wrap)
    if (rhsWrap > 0 && x >= rhsWrap) {
      x = homeX;
      lineHeight = lineHeight > 0 ? lineHeight : 6;
      y += lineHeight;
      lineHeight = 0;
    }
  }

  // :579-581 — text_y = y + line height; text_x stays at the starting x
  lineHeight = lineHeight > 0 ? lineHeight : cancelWrap ? 0 : 6;
  d[DRAW.TEXT_Y] = (y + lineHeight) & 0xff;
  return x;
}
