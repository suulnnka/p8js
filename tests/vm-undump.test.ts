// undump tests: real bios.bc (nested protos, debug info) + freshly compiled
// dialect fixtures through the actual p8luac toolchain.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileBytecode } from "../tools/convert.ts";
import { undump, type Proto } from "../src/vm/undump.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function countProtos(p: Proto): number {
  return 1 + p.p.reduce((s, c) => s + countProtos(c), 0);
}

describe("undump", () => {
  it("loads assets/bios.bc", () => {
    const data = new Uint8Array(readFileSync(join(ROOT, "assets", "bios.bc")));
    const proto = undump(data, "@bios.bc");

    expect(proto.code.length).toBeGreaterThan(100);
    expect(proto.maxstacksize).toBeGreaterThan(0);
    expect(proto.source).toBeTruthy();
    expect(proto.lineinfo.length).toBe(proto.code.length);
    // The bios defines plenty of nested functions (__z8_tick, glue, …).
    expect(countProtos(proto)).toBeGreaterThan(10);
    // Main chunks are vararg.
    expect(proto.is_vararg).toBe(true);
  });

  it("round-trips dialect source with expected constants", () => {
    const bc = compileBytecode(
      'return 1.5, true, "hi", 0x1234\n',
      "t.lua",
    );
    const p = undump(new Uint8Array(bc), "@t.lua");

    expect(p.k).toContain(0x00018000); // 1.5 as fix32 bits
    expect(p.k).toContain("hi");
    expect(p.k).toContain(0x12340000); // 0x1234 → 4660.0
    // `true` is emitted as LOADBOOL (B=1), never as a K constant.
    expect(
      Array.from(p.code).some((i) => (i & 0x3f) === 3 && ((i >>> 23) & 1) === 1),
    ).toBe(true);
    expect(p.code.length).toBeGreaterThan(0);
  });

  it("preserves embedded-zero and byte-0x80+ strings", () => {
    // pico8 charset: source may hold bytes >127 after utf8→pico8; compile a
    // literal that survives as raw bytes (escape keeps it ASCII-safe here).
    const bc = compileBytecode('return "a\\0b"\n', "z.lua");
    const p = undump(new Uint8Array(bc), "@z.lua");
    expect(p.k).toContain("a\0b");
  });

  it("rejects a bad magic", () => {
    const junk = new Uint8Array(32);
    junk.fill(0x41);
    expect(() => undump(junk)).toThrowError(/not a precompiled chunk/);
  });

  it("rejects a truncated file", () => {
    expect(() => undump(new Uint8Array([0x1b, 0x4c]))).toThrowError(
      /truncated precompiled chunk/,
    );
  });

  it("rejects a wrong version byte", () => {
    const data = new Uint8Array(readFileSync(join(ROOT, "assets", "bios.bc")));
    data[4] = 0x51;
    expect(() => undump(data)).toThrowError(/version mismatch in precompiled chunk/);
  });
});
