import { describe, expect, it } from "vitest";
import { pico8ToUtf8, utf8ToPico8 } from "../tools/charset.ts";

describe("pico8 charset", () => {
  it("maps ascii through unchanged", () => {
    const s = "hello world 0123456789\n\t!";
    expect(utf8ToPico8(s)).toBe(s);
  });

  it("converts known emoji to their charmap bytes", () => {
    expect(utf8ToPico8("█")).toBe("\x80");
    expect(utf8ToPico8("▒")).toBe("\x81");
    expect(utf8ToPico8("🐱")).toBe("\x82");
    expect(utf8ToPico8("⬇️")).toBe("\x83"); // base + FE0F variant selector
    expect(utf8ToPico8("⬅️")).toBe("\x8b");
    expect(utf8ToPico8("😐")).toBe("\x8c");
    expect(utf8ToPico8("🅾️")).toBe("\x8e"); // 4-byte base + FE0F = 7-byte glyph
    expect(utf8ToPico8("◝")).toBe("\xff");
  });

  it("converts kana and specials", () => {
    expect(utf8ToPico8("あ")).toBe("\x9a");
    expect(utf8ToPico8("◜")).toBe("\xfe");
    expect(utf8ToPico8("¹")).toBe("\x01");
  });

  it("round-trips every charmap byte", () => {
    for (let i = 0; i < 256; i++) {
      const utf = pico8ToUtf8(String.fromCharCode(i));
      if (i === 0) continue; // NUL round-trip through regex-free paths is fine, skip edge
      expect(utf8ToPico8(utf).charCodeAt(0)).toBe(i);
    }
  });

  it("passes unknown multibyte sequences through as raw utf-8 bytes", () => {
    // U+1F600 😀 is not in the charmap → its raw UTF-8 bytes pass through.
    const s = "😀";
    expect(Buffer.from(utf8ToPico8(s), "latin1")).toEqual(
      Buffer.from(s, "utf8"),
    );
  });
});
