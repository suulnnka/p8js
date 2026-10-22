// .p8 text cartridge parsing → ROM image + Lua source + label.
// Ported from zepto8 src/pico8/cart.cpp (p8_reader / load_p8) with section
// layout per PICO-8's RAM map (see fake-08 source/PicoRam.h).

import { fileBytesToPico8 } from "./charset.ts";

export const ROM_CODE_START = 0x4300;
export const LABEL_WIDTH = 128;
export const LABEL_HEIGHT = 128;
export const LABEL_SIZE = LABEL_WIDTH * LABEL_HEIGHT;

export interface ParsedCart {
  version: number;
  minor: number;
  /** RAM image of gfx/map/gff/music/sfx, exactly 0x4300 bytes. */
  rom: Uint8Array;
  /** Lua source as a PICO-8 byte string (already utf8→pico8 converted). */
  lua: string;
  /** 128×128 label color indices, or null when the cart has no label. */
  label: Uint8Array | null;
}

type SectionName = "lua" | "gfx" | "gff" | "map" | "sfx" | "music" | "label";

function isHexChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x61 && c <= 0x66) ||
    (c >= 0x41 && c <= 0x46)
  );
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return c - 0x41 + 10;
}

/** Decode a section body: hex pairs (nybbles swapped for gfx) or base32 (label). */
function decodeSection(name: SectionName, body: string): Uint8Array {
  const bytes = Buffer.from(body, "latin1");
  const out: number[] = [];

  if (name === "label") {
    for (let i = 0; i < bytes.length; i++) {
      const ch = bytes[i];
      let b = -1;
      if (ch >= 0x30 && ch <= 0x39) b = ch - 0x30;
      else if (ch >= 0x61 && ch <= 0x76) b = ch - 0x61 + 10;
      else if (ch >= 0x41 && ch <= 0x56) b = ch - 0x41 + 10;
      if (b >= 0) out.push(b);
    }
    return Uint8Array.from(out);
  }

  const swapped = name === "gfx";
  for (let i = 0; i < bytes.length; i++) {
    if (isHexChar(bytes[i]) && i + 1 < bytes.length) {
      const a = swapped ? bytes[i + 1] : bytes[i];
      const b = swapped ? bytes[i] : bytes[i + 1];
      if (isHexChar(a) && isHexChar(b)) {
        out.push(hexValue(a) * 16 + hexValue(b));
        i++;
      }
    }
  }
  return Uint8Array.from(out);
}

/**
 * Parse a .p8 text cart. Lenient about the header (matches real-world files):
 * any `__xxx__` line starts a section, `version N` sets the cart version.
 */
export function parseP8Text(text: string): ParsedCart {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const lines = text.split(/\r\n|\n|\r/);

  let version = -1;
  let minor = 0;
  let current: SectionName | null = null;
  let sawHeader = false;

  const bodies: Partial<Record<SectionName, string[]>> = {};

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li === 0 && line.includes("pico-8 cartridge")) {
      sawHeader = true;
      continue;
    }
    if (current === null && /^\d+$/.test(line.trim()) && sawHeader && version < 0) {
      continue; // stray line between header and "version N"
    }
    const vm = /^version\s+(\d+)(?:\.(\d+))?/.exec(line);
    if (vm && version < 0 && current === null) {
      version = parseInt(vm[1], 10);
      if (vm[2]) minor = parseInt(vm[2], 10);
      continue;
    }
    const sec = /^__(\w+)__$/.exec(line.trim());
    if (sec) {
      const name = sec[1];
      if (name === "lua" || name === "gfx" || name === "gff" || name === "map" ||
          name === "sfx" || name === "music" || name === "label") {
        current = name;
        bodies[name] = [];
        continue;
      } else {
        current = null; // unknown section (e.g. __gff__ typo-proof): skip its data
        continue;
      }
    }
    if (current) {
      bodies[current]!.push(line);
    }
  }

  if (version < 0 && !sawHeader) {
    throw new Error("not a pico-8 cartridge (missing header)");
  }
  if (version < 0) version = 0;

  const rom = new Uint8Array(ROM_CODE_START);

  // Default music patterns point at the "disabled" sfx ids 65–68, exactly as
  // PICO-8 leaves them in RAM and as zepto8's cart::init_rom() sets them.
  // Patterns actually present in __music__ overwrite these below.
  for (let i = 0; i < 64; i++) {
    rom[0x3100 + i * 4 + 0] = 65;
    rom[0x3100 + i * 4 + 1] = 66;
    rom[0x3100 + i * 4 + 2] = 67;
    rom[0x3100 + i * 4 + 3] = 68;
  }

  const gfx = decodeSection("gfx", (bodies.gfx ?? []).join("\n"));
  rom.set(gfx.subarray(0, 0x2000), 0x0000);

  const gff = decodeSection("gff", (bodies.gff ?? []).join("\n"));
  rom.set(gff.subarray(0, 0x100), 0x3000);

  // Map: first 4096 bytes go to 0x2000; any extra (shared map2 rows 32–63)
  // is OR-ed into 0x1000 because old carts duplicated the shared region.
  const map = decodeSection("map", (bodies.map ?? []).join("\n"));
  const mapLen = Math.min(0x1000, map.length);
  rom.set(map.subarray(0, mapLen), 0x2000);
  if (map.length > 0x1000) {
    const extra = Math.min(0x1000, map.length - 0x1000);
    for (let i = 0; i < extra; i++) rom[0x1000 + i] |= map[0x1000 + i];
  }

  // Music: 5 text bytes per pattern → 4 RAM bytes with flags folded in.
  const mus = decodeSection("music", (bodies.music ?? []).join("\n"));
  const songCount = Math.min(64, Math.floor(mus.length / 5));
  for (let i = 0; i < songCount; i++) {
    const m = i * 5;
    rom[0x3100 + i * 4 + 0] = mus[m + 1] | ((mus[m] << 7) & 0x80);
    rom[0x3100 + i * 4 + 1] = mus[m + 2] | ((mus[m] << 6) & 0x80);
    rom[0x3100 + i * 4 + 2] = mus[m + 3] | ((mus[m] << 5) & 0x80);
    rom[0x3100 + i * 4 + 3] = mus[m + 4] | ((mus[m] << 4) & 0x80);
  }

  // SFX: 84 text bytes (4 header + 32×20-bit notes) → 68 RAM bytes.
  // RAM layout per fake-08 PicoRam.h sfx struct: notes[32] at bytes 0–63,
  // then filters/speed/loop_start/loop_end at bytes 64–67. Speed defaults
  // to 16 for sfx the cart does not define (fake-08 Cart::setSfx rule).
  for (let i = 0; i < 64; i++) rom[0x3200 + i * 68 + 65] = 16;
  const sfxSection = decodeSection("sfx", (bodies.sfx ?? []).join("\n"));
  const sfxCount = Math.min(64, Math.floor(sfxSection.length / 84));
  for (let i = 0; i < sfxCount; i++) {
    const base = i * 84;
    const dst = 0x3200 + i * 68;
    for (let j = 0; j < 32; j++) {
      const o = base + 4 + Math.floor((j * 5) / 2);
      const ins =
        (sfxSection[o] << 16) | (sfxSection[o + 1] << 8) | sfxSection[o + 2];
      const v = j & 1 ? ins & 0xfffff : ins >>> 4;
      const key = (v & 0x3f000) >>> 12;
      const custom = (v & 0x800) >>> 11;
      const instrument = (v & 0x700) >>> 8;
      const volume = (v & 0x70) >>> 4;
      const effect = v & 0x7;
      // RAM note bitfield layout (LSB first): key:6, instrument:3,
      // volume:3, effect:3, custom:1 — matches fake-08 note setters.
      const note =
        (key & 0x3f) |
        ((instrument & 7) << 6) |
        ((volume & 7) << 9) |
        ((effect & 7) << 12) |
        ((custom & 1) << 15);
      rom[dst + j * 2] = note & 0xff;
      rom[dst + j * 2 + 1] = note >>> 8;
    }
    rom[dst + 64] = sfxSection[base + 0]; // filters
    rom[dst + 65] = sfxSection[base + 1]; // speed
    rom[dst + 66] = sfxSection[base + 2]; // loop start
    rom[dst + 67] = sfxSection[base + 3]; // loop end
  }

  // Lua source: join, drop CRs, convert UTF-8 emoji to PICO-8 bytes
  // (byte-level: luaText is a latin1 byte-per-char string of file bytes).
  const luaText = (bodies.lua ?? []).join("\n");
  const lua = fileBytesToPico8(luaText);

  let label: Uint8Array | null = null;
  if (bodies.label) {
    const raw = decodeSection("label", bodies.label.join("\n"));
    if (raw.length > 0) {
      label = new Uint8Array(LABEL_SIZE);
      label.set(raw.subarray(0, LABEL_SIZE));
    }
  }

  return { version, minor, rom, lua, label };
}
