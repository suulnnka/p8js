// Compilation tests against the real p8luac (WSL) — the Phase 0 toolchain
// plus the fake-08 dialect compatibility edits.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileBytecode } from "../tools/convert.ts";

const P8LUAC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "native",
  "build",
  "p8luac",
);

function wslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p.replace(/\\/g, "/"));
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : p;
}

function tryCompile(src: string): { ok: boolean; out: Buffer; err: string } {
  const res = spawnSync(
    "wsl.exe",
    ["-d", "Ubuntu-26.04", "--", wslPath(P8LUAC), "-", "test.lua"],
    {
      input: Buffer.from(src, "latin1"),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    ok: res.status === 0,
    out: res.stdout ?? Buffer.alloc(0),
    err: (res.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

describe("p8luac toolchain", () => {
  it("emits a Lua 5.2 dump header", () => {
    const r = tryCompile("return 1+1\n");
    expect(r.ok, r.err).toBe(true);
    expect(r.out.subarray(0, 4)).toEqual(Buffer.from([0x1b, 0x4c, 0x75, 0x61]));
    expect(r.out[4]).toBe(0x52);
  });

  it("reports compile errors with the chunk name", () => {
    const r = tryCompile("local x=\n");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("test.lua:");
  });
});

describe("dialect support (fake-08 parity)", () => {
  const cases: [string, string][] = [
    ["paren-less short if", "x=0\nif 1==1 x=1\nreturn x\n"],
    ["parenthesized short if", "x=0 if (1==1) x=1\nreturn x\n"],
    ["paren-less short while", "x=0\nwhile x<3 x+=1\nreturn x\n"],
    ["compound assignment", "x=6 x+=10 x-=3 x*=2 x/=4\nreturn x\n"],
    ["binary ~ bxor (PICO-8 official)", "return (0~1)\n"],
    ["^^ bxor", "return (0^^1)\n"],
    ["shortprint as statement", '?("hi")\n'],
    ["shortprint as return expression", "return ?1\n"],
    ["shortprint as assignment expression", "local v = ?1\nreturn v\n"],
    ["!= operator", "return (1!=2)\n"],
    ["// comment", "x=1 // comment\nreturn x\n"],
    ["binary literal", "return 0b1010.01\n"],
    ["peek operators", "return @0x6000 + %0x6000 + $0x6000\n"],
    ["shift dialect ops", "return (8 >>> 1) ~ (8 <<> 1) ~ (8 >>< 1)\n"],
  ];

  for (const [name, src] of cases) {
    it(name, () => {
      const r = tryCompile(src);
      expect(r.ok, `${name}: ${r.err}`).toBe(true);
      expect(r.out.length).toBeGreaterThan(18);
    });
  }
});

describe("compileBytecode helper", () => {
  it("pipes source through WSL and returns bytes", () => {
    const out = compileBytecode("return 1\n", "chip.p8");
    expect(out[0]).toBe(0x1b);
    expect(out.length).toBeGreaterThan(18);
  });
});
