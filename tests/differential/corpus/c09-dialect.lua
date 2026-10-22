-- c09: PICO-8 dialect surface + split/chr/ord depth + print misc

-- shortprint '?' as statement and expression (p8luac out-param dialect)
? "sp-statement"
?(1 + 2)
?42
local v = ?7
print("v=" .. tostring(v))
local x2 = ?8
print("x2=" .. tostring(x2))

-- compound assignment chains
local s = 10
s += 5
s -= 3
s *= 4
s /= 8
print(s)
local h = 0xf
h |= 0x0f
h &= 0xff
h = h ~ 0x01
print(h)
local pct = 10
pct %= 7
print(pct)
local pw = 2
pw ^= 3
print(pw)
local iv = 10
iv \= 3
print(iv)

-- != and dialect comparisons
print(1 != 2, 1 != 1, "a" != "b", nil != nil)
print(1 == 1 and "eq" or "ne")

-- // comments swallow the rest of the line
print("after-comment") // this is ignored
local c = 1 // another comment
print(c)

-- split: all modes
-- strtab: tables print as native heap addresses (unreproducible across
-- runs) — render as "[len] v1 v2 v3" instead so goldens are stable.
local function strtab(t)
  return "[" .. #t .. "] " .. tostring(t[1]) .. " " ..
    tostring(t[2]) .. " " .. tostring(t[3])
end
print(strtab(split("a,b,c")))
print(#split("a,b,c"))
print(split("a,b,c")[1], split("a,b,c")[3])
print(strtab(split("abc")))        -- no needle → single chunk? (whole string one)
print(#split("abc"))
print(strtab(split("a,,b")))
print(#split("a,,b"))
print(strtab(split("a,b,", ",")))
print(#split("a,b,"))
print(split("a,b,")[3])
print(strtab(split("a b c", " ")))
print(#split("a b c", " "))
print(strtab(split("1234", 2)))
print(#split("1234", 2))
print(split("12345", 2)[3])
print(#split("12345", 2))
print(split("x=1,y=2", ",")[1], split("x=1,y=2", "=")[2])
print(strtab(split("1,2,3", ",", false)))
print(type(split("1,2,3", ",", false)[1]))
print(type(split("1,2,3")[1]))
print(strtab(split("99,abc")))
print(type(split("99,abc")[1]), type(split("99,abc")[2]))
print(strtab(split("0x10,0b11")))
print(#split(""))
print(split(nil))
print(pcall(split, {}))
print(strtab(split("a b", " ", nil)))
print(type(split("a b", " ", nil)[1]))

-- str2d chunk conversion inside split (same luaO_str2d rules)
print(split(" 5 ,6")[1], type(split(" 5 ,6")[1]))
print(split("5x,6")[1], type(split("5x,6")[1]))

-- chr / ord deep
print(chr(0x10), #chr(0x10))
print(ord("\1\2\3\4"))
print(ord("\1\2\3\4", 2, 2))
print(ord("\1\2\3\4", 4))
print(ord("", 1))
print(chr(32, 33, 34))
print(#chr(255, 255))
print(pcall(ord, "abc", 4))
print(pcall(ord, "abc", 0))
print(pcall(ord, "abc", 1, 0))

-- more tostr / tonum matrix
print(tostr(0x1234.5678, 1))
print(tostr(0x1234.5678, 3))
print(tostr(0x1234.5678, 2))
print(tostr(0x1234.5678, 0))
print(tostr(0x1234.5678, 5))
print(tostr(-1, 1), tostr(-1, 3), tostr(-1, 5))
print(tostr(0, 1), tostr(0, 2), tostr(0, 3))
print(tonum("ffff", 1), type(tonum("ffff", 1)))
print(tonum("abc", 1))
print(tonum("0077", 2))
print(tonum("1010", 1))

-- print misc: tabs, embedded control chars, mixed args
print("tab\there", "nl\nhere")
print(nil, true, false, 1)
print()
print("", "")
print("a" .. "\0" .. "b")

-- bit funcs as globals (PICO-8 exposes band/bor/... as functions)
print(band(0xff, 0x0f), bor(1, 2), bxor(3, 1), bnot(0))
print(shl(1, 8), shr(0x100, 4), lshr(-1, 24), rotl(1, 1), rotr(1, 1))
print(pcall(band, 1))
print(pcall(shl, "a", 1))

-- rawset/get integer key identity through fix32 encoding
local mk = {}
mk[1] = "one"
print(rawget(mk, 1.0), rawlen(mk))
mk[65536] = "wrap?"
print(mk[1], mk[65536], rawlen(mk))

-- string.format %s uses tostring (number formatting corners)
print(string.format("%s %s %s", -0.03125, 0.0625, 0x1234.5678))

-- concat chains mixing everything
print("a" .. 1 .. "b" .. 2.5 .. "" .. "z")
print(1 .. 2 .. 3)
