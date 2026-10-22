// z8::fix32 — 16.16 signed fixed point, ported from native/build/z8lua/fix32.h.
// A Lua number IS the int32 bit pattern (`|0`); no wrapping helpers needed for
// add/sub since JS int32 arithmetic already wraps.

// ---------------------------------------------------------------------------
// construction / conversion

export const fromDouble = (d: number): number => {
  // C++: int32_t(int64_t(d * 65536.0)) — truncates toward 0, then wraps to
  // 32 bits. Non-finite input and out-of-int64-range magnitudes land on 0
  // (matches x86 cvttsd2si → INT64_MIN whose low 32 bits are 0).
  const t = Math.trunc(d * 65536);
  return t === t && Number.isFinite(t) && Math.abs(t) < 0x8000000000000000
    ? t | 0
    : 0;
};

export const toDouble = (x: number): number => x * (1.0 / 65536);

/** fix32(int) — C++ fix32(int32_t x): m_bits = x << 16 (wraps). */
export const fromInt = (x: number): number => (x << 16) | 0;

/** fix32 → integer part, arithmetic shift (C++ operator int32_t). */
export const toInt = (x: number): number => x >> 16;

// ---------------------------------------------------------------------------
// arithmetic (bit pattern in, bit pattern out)

export const add = (a: number, b: number): number => (a + b) | 0;
export const sub = (a: number, b: number): number => (a - b) | 0;
export const neg = (a: number): number => -a | 0;
export const bnot = (a: number): number => ~a | 0;
export const band = (a: number, b: number): number => a & b;
export const bor = (a: number, b: number): number => a | b;
export const bxor = (a: number, b: number): number => a ^ b;

export const mul = (a: number, b: number): number => {
  // int64(a) * int64(b) >> 16, computed exactly in double via 16-bit splits:
  // each partial stays < 2^34, well inside double's 53-bit exact range.
  const ah = a >> 16;
  const al = a & 0xffff;
  const bh = b >> 16;
  const bl = b & 0xffff;
  const q = ah * bh * 65536 + (ah * bl + al * bh) + Math.floor((al * bl) / 65536);
  return q | 0;
};

// int64 truncating division. BigInt is correct and simple; hot paths can
// replace this later if profiling says so (see PLAN §8: perf tuning is Phase 5).
const i64div = (n: bigint, d: bigint): bigint => n / d; // BigInt / truncates toward 0

export const div = (a: number, b: number): number => {
  // 0x8000/0x1 must stay 0x8000 (fix32.h:126).
  if (b === 0x10000) return a;
  if (b !== 0) {
    const r = Number(i64div(BigInt(a) * 65536n, BigInt(b)));
    if (r >= -0x7fffffff && r <= 0x7fffffff) return r | 0;
  }
  // Saturation: +0x7fffffff / -0x8000.0001 like PICO-8; sign from a^b.
  return (a ^ b) >= 0 ? 0x7fffffff : (0x80000001 | 0);
};

export const fixAbs = (a: number): number =>
  a >= 0 ? a : a << 1 === 0 ? ~a | 0 : -a | 0;

export const mod = (a: number, b: number): number => {
  // PICO-8 always returns a positive result; x % 0 == 0 (0.2.5f).
  const x = fixAbs(b);
  const r = x !== 0 ? a % x : 0;
  return r >= 0 ? r : r + x;
};

export const pow = (a: number, b: number): number =>
  fromDouble(Math.pow(toDouble(a), toDouble(b)));

// Integer division "\ — luaconf.h: luai_numidiv = l_mathop(floor)((a)/(b)),
// i.e. fix32 division (with its saturation) then floor.
export const idiv = (a: number, b: number): number => floor(div(a, b));

// ---------------------------------------------------------------------------
// shifts / rotates — operand y is a raw shift count (int semantics)

export const lshr = (x: number, y: number): number => {
  if (y < 0) return x << -y;
  if (y >= 32) return 0;
  return (x >>> y) | 0;
};

export const shl = (x: number, y: number): number => {
  if (y < 0) return lshr(x, -y);
  if (y >= 32) return 0;
  return (x << y) | 0;
};

/** Arithmetic (signed) right shift: fix32.h operator >>. */
export const shr = (x: number, y: number): number => {
  if (y < 0) return x << -y;
  return x >> Math.min(y, 31);
};

export const rotl = (x: number, y: number): number => {
  const s = y & 31;
  // y=0: JS shift-by-32 wraps to 0, so (x<<0)|(x>>>32) === x — same as the
  // C code's intent (its >>32 is UB on 32-bit, benign here).
  return ((x << s) | (x >>> (32 - s))) | 0;
};

export const rotr = (x: number, y: number): number => {
  const s = y & 31;
  return ((x >>> s) | (x << (32 - s))) | 0;
};

// ---------------------------------------------------------------------------
// rounding / misc (fix32.h free functions)

export const floor = (x: number): number => x & 0xffff0000;
export const ceil = (x: number): number => -floor(-x);
export const abs = fixAbs;
export const sgn = (x: number): number =>
  x === 0 ? 0 : x > 0 ? fromInt(1) : fromInt(-1);
export const min = (a: number, b: number): number => (a < b ? a : b);
export const max = (a: number, b: number): number => (a > b ? a : b);

// ---------------------------------------------------------------------------
// string ↔ number conversions (lobject.c luaO_str2d / luaconf.h lua_number2str)

/**
 * lua_number2str (luaconf.h:592): sprintf("%1.4f") then strip trailing zeros
 * and one trailing dot. printf rounds the *exact* binary value, half-to-even
 * on exact ties; JS toFixed rounds half away from zero, so ties are handled
 * explicitly. x*10000 is exact for every fix32 (bits*625/4096, both factors
 * inside double's exact range).
 */
export const numToString = (x: number): string => {
  const neg = x < 0;
  const v = Math.abs(toDouble(x)) * 10000; // x is the bit pattern — convert!
  const n = Math.floor(v);
  const frac = v - n;
  const r = frac === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.round(v);
  const ip = Math.floor(r / 10000);
  let fp = String(r % 10000).padStart(4, "0");
  while (fp.length > 0 && fp.endsWith("0")) fp = fp.slice(0, -1);
  const body = fp.length > 0 ? `${ip}.${fp}` : String(ip);
  return neg ? `-${body}` : body;
};

const isSpaceByte = (c: string): boolean =>
  c === " " || c === "\f" || c === "\n" || c === "\r" || c === "\t" ||
  c === "\v";

const hexVal = (c: string): number => {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  return (c.toLowerCase().charCodeAt(0) - 97) + 10;
};

const isHexByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) ||
    (code >= 65 && code <= 70);
};

/**
 * lua_strany2number (lobject.c:187) — 0x/0b prefixed integers and fractions.
 * Fraction digits are accumulated as fix32 then folded into the integer bit
 * pattern by a logical right shift (4 bits per hex digit, 1 per binary digit).
 * Returns null when nothing was recognized (endptr == start in C).
 */
function strAny2Number(s: string, base: 2 | 16): number | null {
  let i = 0;
  while (i < s.length && isSpaceByte(s[i])) i++;
  let neg = false;
  if (s[i] === "-") { neg = true; i++; }
  else if (s[i] === "+") i++;
  const marker = base === 2 ? ["b", "B"] : ["x", "X"];
  if (s[i] !== "0" || i + 1 >= s.length || !marker.includes(s[i + 1])) {
    return null; // invalid format (no '0b'/'0x')
  }
  i += 2;
  // integer part: r = r * base + d in fix32 arithmetic (wraps like C++)
  let r = 0;
  let icount = 0;
  const readAny = (limit: number, countRef: { n: number }): number => {
    let acc = 0;
    let max = limit;
    while (i < s.length && isHexByte(s[i])) {
      if (max > 0) {
        const d = hexVal(s[i]);
        if (d >= base) break;
        acc = mul(acc, fromInt(base)) + fromInt(d) | 0;
        countRef.n++;
        max--;
      }
      i++; // digits beyond `limit` are consumed and ignored (C for-loop does it)
    }
    return acc;
  };
  const ic = { n: 0 };
  r = readAny(Number.MAX_SAFE_INTEGER, ic);
  icount = ic.n;
  let e = 0;
  if (s[i] === ".") {
    i++;
    const fc = { n: 0 };
    const f = readAny(base === 2 ? 16 : 4, fc);
    e = fc.n;
    if (icount === 0 && e === 0) return null;
    const shift = base === 2 ? e : e * 4;
    r = (r | ((f >>> 0) >>> shift)) | 0;
  } else if (icount === 0) {
    return null;
  }
  return neg ? -r | 0 : r;
}

/** luaO_str2d (lobject.c:211): full-string conversion or null. */
export const strToNum = (s: string): number | null => {
  if (s.length === 0) return null;
  if (/[nN]/.test(s)) return null; // reject 'inf'/'nan' (strpbrk "nN")
  if (/[xX]/.test(s)) return strAny2Number(s, 16);
  if (/[bB]/.test(s)) return strAny2Number(s, 2);
  // decimal: strtod semantics (leading spaces/sign, digits, '.', [eE][+-]?digits)
  let i = 0;
  const n = s.length;
  while (i < n && isSpaceByte(s[i])) i++;
  const start = i;
  if (s[i] === "-" || s[i] === "+") i++;
  let digits = 0;
  while (i < n && s[i] >= "0" && s[i] <= "9") { i++; digits++; }
  if (s[i] === ".") {
    i++;
    while (i < n && s[i] >= "0" && s[i] <= "9") { i++; digits++; }
  }
  if (digits === 0) return null;
  const numEnd = i;
  if (s[i] === "e" || s[i] === "E") {
    let j = i + 1;
    if (s[j] === "+" || s[j] === "-") j++;
    let ed = 0;
    while (j < n && s[j] >= "0" && s[j] <= "9") { j++; ed++; }
    if (ed > 0) i = j;
  }
  const parsed = s.slice(start, numEnd) + (i > numEnd ? s.slice(numEnd, i) : "");
  let pos = i;
  while (pos < n && isSpaceByte(s[pos])) pos++;
  if (pos !== n) return null; // trailing garbage (incl. embedded NULs)
  return fromDouble(Number(parsed));
};
