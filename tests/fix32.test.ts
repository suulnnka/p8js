// fix32 semantics ported from z8lua fix32.h — hand-checked edge cases plus a
// BigInt oracle for mul (the double-split implementation must match int64 math).
import { describe, expect, it } from "vitest";
import * as fx from "../src/vm/fix32.ts";

const F = (x: number): number => fx.fromDouble(x); // test helper: value → bits
const V = (x: number): number => fx.toDouble(x);

describe("fix32 construction", () => {
  it("round-trips simple values", () => {
    for (const v of [0, 1, -1, 1.5, -2.25, 32767.99998, -32768, 0.0000152587890625]) {
      expect(V(F(v))).toBeCloseTo(v < 0 ? Math.max(v, -32768) : v, 4);
    }
  });

  it("fromInt / toInt shift by 16", () => {
    expect(fx.fromInt(3)).toBe(0x00030000);
    expect(fx.toInt(0x00038000)).toBe(3);
    expect(fx.toInt(0xfffd8000)).toBe(-3); // -2.5 → -3? arithmetic: >>16 of -0x28000
  });
});

describe("fix32 arithmetic", () => {
  it("add/sub wrap at int32 bounds", () => {
    expect(fx.add(0x7fffffff, 1) | 0).toBe(-0x80000000 | 0);
    expect(fx.sub(-0x80000000 | 0, 1)).toBe(0x7fffffff);
    expect(fx.neg(0x80000000 | 0)).toBe(0x80000000 | 0); // -(-32768) saturates to itself
  });

  it("mul matches the int64 oracle over edge operands", () => {
    const edges = [
      0, 1, -1, 0x10000, -0x10000 | 0, 0x18000, -0x18000 | 0,
      0x7fffffff, 0x80000000 | 0, 0x12340000, 0x0000ffff, 0xffff0000 | 0,
      0x01000000, 0xff000000 | 0, 0x00018001, 0xfffe7fff | 0,
    ];
    for (const a of edges) {
      for (const b of edges) {
        const want = Number((BigInt(a) * BigInt(b)) >> 16n) | 0;
        expect(fx.mul(a, b), `mul(${a},${b})`).toBe(want);
      }
    }
  });

  it("div: exact, ÷1 fast path, and PICO-8 saturation", () => {
    expect(fx.div(F(3), F(2))).toBe(F(1.5));
    expect(fx.div(F(1), F(4))).toBe(F(0.25));
    // 0x8000 / 1 must stay 0x8000 (fix32.h:126)
    expect(fx.div(0x80000000 | 0, 0x10000)).toBe(0x80000000 | 0);
    // ÷0 → +inf saturation for positive dividend, -inf (0x8000.0001) negative
    expect(fx.div(F(1), 0)).toBe(0x7fffffff);
    expect(fx.div(F(-1), 0)).toBe(0x80000001 | 0);
    // quotient out of range saturates with the sign of a^b
    expect(fx.div(F(1), 0x00000001)).toBe(0x7fffffff); // 1.0 / tiny
    expect(fx.div(0x00010000, 0xffffffff | 0)).toBe(0x80000001 | 0);
  });

  it("mod is always positive and x % 0 == 0", () => {
    expect(fx.mod(F(-1.5), F(1))).toBe(F(0.5));
    expect(fx.mod(F(1.5), F(-1))).toBe(F(0.5));
    expect(fx.mod(F(-1.5), F(-1))).toBe(F(0.5));
    expect(fx.mod(F(7), F(3))).toBe(F(1));
    expect(fx.mod(F(7), 0)).toBe(0);
  });

  it("idiv floors (luaconf luai_numidiv)", () => {
    expect(fx.idiv(F(-3), F(2))).toBe(F(-2));
    expect(fx.idiv(F(3), F(2))).toBe(F(1));
    expect(fx.idiv(F(3), F(-2))).toBe(F(-2));
    expect(fx.idiv(F(-3), F(-2))).toBe(F(1));
  });

  it("abs/floor/ceil edge cases", () => {
    expect(fx.abs(0x80000000 | 0)).toBe(0x7fffffff); // abs(0x8000) = 0x7fff.ffff
    expect(fx.abs(F(-1.5))).toBe(F(1.5));
    expect(fx.floor(F(1.5))).toBe(F(1));
    expect(fx.floor(F(-1.5))).toBe(F(-2));
    expect(fx.ceil(F(1.5))).toBe(F(2));
    expect(fx.ceil(F(-1.5))).toBe(F(-1));
    expect(fx.ceil(F(2))).toBe(F(2));
  });

  it("pow goes through double", () => {
    expect(fx.pow(F(2), F(10))).toBe(F(1024));
    expect(fx.pow(F(1.5), F(2))).toBe(F(2.25));
    expect(fx.pow(F(4), F(0.5))).toBe(F(2));
  });
});

describe("fix32 shifts", () => {
  it("shl / lshr / shr honour sign, negatives, and ≥32", () => {
    expect(fx.shl(F(8), 1)).toBe(F(16));
    expect(fx.lshr(F(8), 1)).toBe(F(4));
    expect(fx.shl(F(8), -1)).toBe(F(4)); // negative y flips to lshr
    expect(fx.lshr(F(8), -1)).toBe(F(16));
    expect(fx.shl(1, 32)).toBe(0);
    expect(fx.lshr(0x7fffffff, 33)).toBe(0);
    expect(fx.shr(0x80000000 | 0, 1)).toBe(0xc0000000 | 0); // arithmetic fill
    expect(fx.shr(0x80000000 | 0, 100)).toBe(-1); // >>31 arithmetic fill, as in C
    expect(fx.shr(1, -1)).toBe(1 << 1);
  });

  it("rotl / rotr (y masked with &31, y=0 is identity)", () => {
    expect(fx.rotl(1, 0)).toBe(1);
    expect(fx.rotr(1, 0)).toBe(1);
    expect(fx.rotl(1, 1)).toBe(2);
    expect(fx.rotl(0x80000000 | 0, 1)).toBe(1);
    expect(fx.rotr(1, 1)).toBe(0x80000000 | 0);
    expect(fx.rotl(0x12345678, 4)).toBe(0x23456781);
    expect(fx.rotl(1, 33)).toBe(2); // y & 31
  });
});
