// PICO-8 charset conversion between UTF-8 and the 8-bit PICO-8 byte charset.
// The 256-glyph table is ported byte-for-byte from fake-08's
// source/emojiconversion.cpp (originally zepto8), including its glyph-length
// decoding rule (a trailing U+FE0F variation selector belongs to the glyph).
//
// All runtime strings in this project are *byte strings*: JS strings whose
// code units are 0–255. Conversions to real UTF-8 happen only at display
// boundaries.

const UTF8_CHARS =
  "\0¹²³⁴⁵⁶⁷⁸\t\nᵇᶜ\rᵉᶠ▮■□⁙⁘‖◀▶「」¥•、。゛゜" +
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNO" +
  "PQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~○" +
  "█▒🐱⬇️░✽●♥☉웃⌂⬅️😐♪🅾️◆…➡️★⧗⬆️ˇ∧❎▤▥あいうえおか" +
  "きくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよ" +
  "らりるれろわをんっゃゅょアイウエオカキクケコサシスセソタチツテト" +
  "ナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンッャュョ◜◝";

function codePointByteLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  return 4;
}

// Split the charmap into 256 (utf8 bytes, pico8 byte) entries.
function buildTables(): { toUtf8: string[]; toPico8: Map<string, number> } {
  const bytes = Buffer.from(UTF8_CHARS, "utf8");
  const toUtf8: string[] = [];
  const toPico8 = new Map<string, number>();
  const fe0f = Buffer.from([0xef, 0xb8, 0x8f]);

  let p = 0;
  for (let i = 0; i < 256; i++) {
    if (p >= bytes.length) {
      throw new Error(`charset table truncated at glyph ${i}`);
    }
    const cpLen = codePointByteLength(bytes[p]);
    let len = cpLen;
    // The glyph owns a following U+FE0F (variation selector-16), if any.
    if (
      p + cpLen + fe0f.length <= bytes.length &&
      bytes.compare(fe0f, 0, fe0f.length, p + cpLen, p + cpLen + fe0f.length) === 0
    ) {
      len += fe0f.length;
    }
    const slice = bytes.subarray(p, p + len);
    toUtf8.push(Buffer.from(slice).toString("utf8"));
    toPico8.set(slice.toString("latin1"), i);
    p += len;
  }
  return { toUtf8, toPico8 };
}

const { toUtf8, toPico8 } = buildTables();

/** Glyph matcher over raw file bytes (fake-08 emojiconversion.cpp:84-106:
 * multibyte start bytes try the glyph table, everything else passes through
 * byte-for-byte — including invalid UTF-8 sequences). */
function bytesToPico8(bytes: Buffer): string {
  const out: number[] = [];
  let p = 0;
  while (p < bytes.length) {
    let matched = false;
    // Longest glyph = 4-byte codepoint + FE0F (7 bytes); try up to 8.
    for (let len = 8; len >= 2; len--) {
      if (p + len > bytes.length) continue;
      const key = bytes.subarray(p, p + len).toString("latin1");
      const idx = toPico8.get(key);
      if (idx !== undefined) {
        out.push(idx);
        p += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(bytes[p]);
      p++;
    }
  }
  return Buffer.from(out).toString("latin1");
}

/** Convert a UTF-8 JS string to a PICO-8 byte string (code units 0–255). */
export function utf8ToPico8(str: string): string {
  return bytesToPico8(Buffer.from(str, "utf8"));
}

/** Convert cart/section *file text* (a latin1 byte-per-char string, as read
 * with readFileSync(..., "latin1")) to a PICO-8 byte string. Runs the glyph
 * matcher on the raw bytes directly — passing a latin1-decoded string to
 * utf8ToPico8 would re-encode high bytes as UTF-8 (double encoding), miss
 * every glyph table key and expand them. */
export function fileBytesToPico8(latin1Text: string): string {
  return bytesToPico8(Buffer.from(latin1Text, "latin1"));
}

/** Convert a PICO-8 byte string back to a UTF-8 JS string. */
export function pico8ToUtf8(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += toUtf8[str.charCodeAt(i) & 0xff];
  }
  return out;
}

/** Encode a byte string to bytes (for writing files). */
export function byteStringToBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** Decode raw bytes to a byte string (code units 0–255). */
export function bytesToByteString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}
