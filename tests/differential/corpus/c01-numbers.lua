-- c01: fix32 arithmetic, literals, conversions (diff vs native z8lua)
-- pairs() only over sequential tables; no addresses; no text-load.

print(_VERSION)

-- arithmetic basics + wrap
print(1 + 1, 5 - 8, 3 * 4, 10 / 4, 7 % 3, -7 % 3, 7 % -3, 2 ^ 10)
print(10 \ 3, -10 \ 3, 10.7 \ 3)
print(0x7fffffff + 1, -0x80000000 - 1, 0x4000 * 0x4000)
print(0x80000000 * 2, 0x7fffffff * 0x7fffffff)

-- division saturation
print(1 / 0, -1 / 0, 1 / -0.0, 0x7fffffff / -1, -0x8000 / 0x8000)
print(0x7fffffff / 0x0.0001, 1 / 0x0.0001)

-- mod specials (always positive; x%0 == 0)
print(5 % 0, -5 % 0, 0 % 0)
print(0x8000 % 3, -0x8000 % 3)

-- bit ops on raw patterns
print(0xff & 0x0f, 0xf0 | 0x0f, 0xff ~ 0x0f, ~0, ~1, ~0x80000000)
print((0xffff ~ 0) & 0xffffffff)
print(1 << 4, 1 >> 4, -8 >> 1, -8 >>> 1)
print(8 <<> 1, 8 >>< 1, 1 << 0, 1 >>> 32, 1 << 33, 1 >>> -2)
print(0x12345678 << 8, 0x12345678 >>< 8)

-- int16-truncation semantics for integer conversion (LUA_INTEGER)
print(band(0x1.8, 1), bxor(0x10000.5, 1))

-- unary
print(-0, - -5, -0x80000000)

-- comparisons (numbers only; no string coercion)
print(1 == 1, 1 == 1.0, 1 < 1.5, 1 <= 1, 2 > 1.5, 1.5 >= 1.5)
print(-1 < 1, 0x7fffffff > 0)

-- literals: hex/binary incl fractional and wrap
print(0xff, 0xabcdef, 0x0.8, 0xa.a, 0b1010, 0b1010.01, 0b1.1, 0b0.0001)
print(0x7fffffff, 0x80000000, 0xffffffff, 0x100000000)
print(0b11111111111111111111111111111111, 0b10000000000000000000000000000000)

-- concat with numbers
print("n=" .. 1.5 .. "|" .. -0 .. "|" .. 0.3333333)

-- print formatting corners (lua_number2str = %.4f strip, half-even ties)
print(0.03125, -0.03125, 0.00005, -0.00001, 0.99999, 12345.67891)
print(2.5 * 0.000001, 0.0001 * 0.0001)
print(tostring(1), tostring(0.5), tostring(-1.5), tostring(32767.99998))

-- tonumber: standard conversions
print(tonumber("5"), tonumber("0x10"), tonumber("0b101"), tonumber("  12  "))
print(tonumber("0x1.8"), tonumber("0b1.1"), tonumber("1e3"), tonumber("1E-2"))
print(tonumber("12abc"), tonumber("abc"), tonumber(""), tonumber("  "))
print(tonumber("-7"), tonumber("+7"), tonumber(".5"), tonumber("5."))
print(tonumber("1e999"), tonumber("-1e999"), tonumber("0xg"))

-- tonumber with base
print(tonumber("ff", 16), tonumber("FF", 16), tonumber("zz", 36), tonumber("10", 2))
print(tonumber("7", 8), tonumber("-ff", 16), tonumber("11", 36))
print(pcall(tonumber, "ff", 1))
print(pcall(tonumber, "ff", 37))

-- p8 tostr / tonum flags
print(tostr(1.5), tostr(-1), tostr(0.0625))
print(tostr(1.5, 1), tostr(1.5, 2), tostr(1.5, 3))
print(tostr(0x1234abcd, 1), tostr(0x1234abcd, 3), tostr(-1, 2))
print(tostr("x"), tostr("x", 3), tostr(true), tostr(false))
print(tostr(nil), tostr(), tostr(print, 0))
print(tonum("123"), tonum("0x10"), tonum("0x10", 1), tonum("65536", 2))
print(tonum("ff", 3), tonum("zz", 3), tonum(true), tonum(nil), tonum({}))
print(tonum("12.5"), tonum("0x1.8", 1))

-- trig / math corners
print(flr(-1.5), flr(1.5), flr(-0.5), ceil(-1.5), ceil(1.5), ceil(0))
print(abs(-1.5), abs(0x8000), abs(0), sgn(1), sgn(-1), sgn(0), sgn(0x8000))
print(mid(3, 1, 2), mid(1, 2, 3), mid(3, 2, 1), mid(0, -1, 5))
print(max(1, 2), min(1, 2), max(-1, -2), min(0.5, 0.25))
print(sqrt(2), sqrt(1), sqrt(4), sqrt(0.5), sqrt(0), sqrt(-1), sqrt(0x7fffffff))
print(sin(0), cos(0), sin(0.25), cos(0.25), sin(0.5), cos(0.5), sin(1), cos(1))
print(sin(0.125), cos(0.125), sin(-0.25), cos(-0.25), sin(0.03125))
print(sin(2), cos(2), sin(-1), cos(-1), sin(0.75), cos(0.75))
print(atan2(0, 0), atan2(1, 0), atan2(0, 1), atan2(-1, 0), atan2(0, -1))
print(atan2(1, 1), atan2(-1, 1), atan2(-1, -1), atan2(1, -1))
print(atan2(1, 3), atan2(3, 1), atan2(1, 1000), atan2(1000, 1))
print(atan2(0x8000, 0x8000), atan2(1, 0x8000))

-- chr / ord
print(chr(65, 66, 67), chr(0), chr(255), chr())
print(ord("ABC"), ord("ABC", 2), ord("ABC", 2, 2), ord("ABC", 10))
print(ord("A", 1, 5), ord(123), ord("A", "x"), ord("A", 1, "y"))
print(#chr(49, 50, 51), ord(chr(0, 1, 2), 2))

-- string index (PICO-8 str[pos])
local s = "hello"
print(s[1], s[2], s[6], s[-1], s[-5], s[7], s[0], s[-6])
print(s[1.9], s["x"], pcall(function() return (#s)[1] end))

-- peek ops with no memory attached (z8lua standalone behaviour)
print(@0, %0, $0, @0x7fff, %0x8000)

-- select / assert basics that touch conversions
print(select("#", 1, 2), select(1, "a", "b"))
print(assert(1, "unused"), assert("x"))
print(pcall(assert, false, "boom"))
print(pcall(assert, false))
print(pcall(assert, false, 42))
