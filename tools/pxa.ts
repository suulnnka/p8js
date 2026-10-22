// Decompression of the code section found in .p8.png carts (and legacy carts).
// Ported 1:1 from zepto8 src/pico8/code.cpp (pxa_decompress / legacy_decompress).

/** Move-to-front state for the pxa format. */
class MoveToFront {
  private state = new Uint8Array(256);

  constructor() {
    this.reset();
  }

  reset(): void {
    for (let n = 0; n < 256; n++) this.state[n] = n;
  }

  /** Get the nth byte and move it to front. */
  get(n: number): number {
    const v = this.state[n];
    this.state.copyWithin(1, 0, n);
    this.state[0] = v;
    return v;
  }
}

// Legacy LUT: input code 1..0x3b maps to these characters; 0x00 marks a
// literal byte that follows; codes >= 0x3c are back references.
const LEGACY_LUT = "\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_";

function pxaDecompress(input: Uint8Array): string {
  const length = input[4] * 256 + input[5];
  const compressed = input[6] * 256 + input[7];

  let pos = 8 * 8; // stream position in bits
  const totalBits = compressed * 8;
  const getBits = (count: number): number => {
    let n = 0;
    for (let i = 0; i < count && pos < totalBits; i++, pos++) {
      n |= ((input[pos >> 3] >> (pos & 7)) & 1) << i;
    }
    return n >>> 0;
  };

  const mtf = new MoveToFront();
  const out: number[] = [];

  while (out.length < length && pos < totalBits) {
    if (getBits(1)) {
      // MTF literal
      let nbits = 4;
      while (getBits(1)) ++nbits;
      const n = getBits(nbits) + (1 << nbits) - 16;
      const ch = mtf.get(n);
      if (!ch) break;
      out.push(ch);
    } else {
      // Back reference or raw block
      const nbits = getBits(1) ? (getBits(1) ? 5 : 10) : 15;
      const offset = getBits(nbits) + 1;

      if (nbits === 10 && offset === 1) {
        // Raw block: 8-bit bytes until a zero byte
        let ch = getBits(8);
        while (ch) {
          out.push(ch);
          ch = getBits(8);
        }
      } else {
        let len = 3;
        let n: number;
        do {
          n = getBits(3);
          len += n;
        } while (n === 7);
        for (let i = 0; i < len; i++) {
          out.push(out[out.length - offset]);
        }
      }
    }
  }

  return Buffer.from(out).toString("latin1");
}

function legacyDecompress(input: Uint8Array): string {
  const out: number[] = [];
  // Expected data length (including trailing zero)
  const length = input[4] * 256 + input[5];

  for (let i = 8; i < input.length && out.length < length; i++) {
    if (input[i] >= 0x3c) {
      const a = (input[i] - 0x3c) * 16 + (input[i + 1] & 0xf);
      let b = Math.floor(input[i + 1] / 16) + 2;
      if (out.length >= a) {
        while (b--) out.push(out[out.length - a]);
      }
      i++;
    } else if (input[i]) {
      out.push(LEGACY_LUT.charCodeAt(input[i] - 1));
    } else {
      out.push(input[++i]);
    }
  }

  // Truncate at the first NUL (C++ does ret.resize(strlen(ret.c_str()))).
  let str = Buffer.from(out).toString("latin1");
  const nul = str.indexOf("\0");
  if (nul >= 0) str = str.slice(0, nul);

  // Some old PNG carts have a broken "if(_update60)_update…" compatibility
  // snippet appended by certain PICO-8 versions; strip it. zepto8 has the
  // same intent but its C++ pattern forgot to escape the parentheses (so the
  // groups never matched); the escape here makes it actually fire. Glued
  // right after a previous `end` (i.e. forming "endif"), the snippet must go
  // or the lexer reads a bogus `endif` name.
  str = str.replace(
    /\n?if\(_update60\)_update=function\(\)_update60([)_update_buttons(]*)_update60\(\)end$/,
    "",
  );
  return str;
}

/**
 * Decompress a cart code section: "\0pxa" → pxa, ":c:\0" → legacy,
 * otherwise plaintext up to the first NUL byte.
 */
export function decompressCode(code: Uint8Array): string {
  if (
    code.length >= 4 &&
    code[0] === 0 &&
    code[1] === 0x70 &&
    code[2] === 0x78 &&
    code[3] === 0x61
  ) {
    return pxaDecompress(code);
  }
  if (
    code.length >= 4 &&
    code[0] === 0x3a &&
    code[1] === 0x63 &&
    code[2] === 0x3a &&
    code[3] === 0
  ) {
    return legacyDecompress(code);
  }
  let end = code.indexOf(0);
  if (end < 0) end = code.length;
  return Buffer.from(code.subarray(0, end)).toString("latin1");
}
