-- c03: tables — constructors, insert/remove/concat/sort/unpack, next/ipairs

local out = ""
local function w(s) out = out .. s end

-- constructor + SETLIST (multi-flush >50 elements via literal constructor)
local t = {10, 20, 30}
print(#t, t[1], t[2], t[3])
local big = {
  2, 4, 6, 8, 10, 12, 14, 16, 18, 20,
  22, 24, 26, 28, 30, 32, 34, 36, 38, 40,
  42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
  62, 64, 66, 68, 70, 72, 74, 76, 78, 80,
  82, 84, 86, 88, 90, 92, 94, 96, 98, 100,
  102, 104, 106, 108, 110, 112, 114, 116, 118, 120,
  122, 124, 126, 128, 130, 132, 134, 136, 138, 140,
  142, 144, 146, 148, 150, 152, 154, 156, 158, 160,
  162, 164, 166, 168, 170, 172, 174, 176, 178, 180,
  182, 184, 186, 188, 190, 192, 194, 196, 198, 200,
  202, 204, 206, 208, 210, 212, 214, 216, 218, 220,
  222, 224, 226, 228, 230, 232, 234, 236, 238, 240,
}
print(#big, big[1], big[50], big[51], big[100], big[120])
local mixed = {1, 2, x = "s", [10] = "ten", 3}
print(mixed[1], mixed[2], mixed[3], mixed.x, mixed[10], mixed[4])
print(#{nil, nil, 3, 4})

-- nested constructors
local n = {{1, 2}, {3, {4}}}
print(n[1][2], n[2][2][1])

-- length
local e = {}
print(#e, #t, #big, #{})
print(#"hello", #"", #"\0")

-- insert / remove
local a = {1, 2, 3}
table.insert(a, 4)
print(#a, a[4])
table.insert(a, 1, 0)
print(a[1], a[2], a[5], #a)
table.insert(a, 3, 99)
print(a[1], a[2], a[3], a[4], #a)
print(table.remove(a))
print(#a, a[#a])
print(table.remove(a, 1))
print(a[1], #a)
print(pcall(table.insert, {1}, 5, 1, 2))
print(pcall(table.insert, {}, 0, "x"))
print(pcall(table.remove, {1}, 5))
print(pcall(table.remove, {}, 0))

-- concat
print(table.concat({1, 2, 3}, "-"))
print(table.concat({"a", "b", "c"}, "", 2))
print(table.concat({"a", "b", "c"}, ",", 2, 3))
print(table.concat({"a", "b", "c"}, ",", 3, 2))
print(table.concat({}))
print(table.concat({"x"}))
print(table.concat({1, 2}, ", ", 1, 1))
print(pcall(table.concat, {1, "a"}, " "))
print(pcall(table.concat, {true}, " "))

-- pack / unpack
local p = table.pack(1, "two", nil, 4)
print(p.n, p[1], p[2], p[4], p[3])
print(table.unpack({1, 2, 3}))
print(table.unpack({1, 2, 3}, 2))
print(table.unpack({1, 2, 3}, 2, 3))
print(table.unpack({}, 1, 0))
print(select("#", table.unpack({1, 2, 3})))
print(select("#", table.unpack({})))

-- sort: same algorithm as native ⇒ identical arrangement for ties
local s1 = {5, 3, 1, 4, 2}
table.sort(s1)
print(s1[1], s1[2], s1[3], s1[4], s1[5])
table.sort(s1, function(x, y) return x > y end)
print(s1[1], s1[2], s1[3], s1[4], s1[5])
local s2 = {3, 3, 1, 1, 2, 2, 1}
table.sort(s2)
print(table.concat(s2, ","))
local s3 = {"pear", "apple", "fig", "apple", "banana"}
table.sort(s3)
print(table.concat(s3, ","))
table.sort(s3, function(x, y) return #x < #y end)
print(table.concat(s3, ","))
local s4 = {42}
table.sort(s4)
print(s4[1])
table.sort({})
local s5 = {2, 1}
table.sort(s5)
print(s5[1], s5[2])
local s6 = {10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0}
table.sort(s6)
print(table.concat(s6, ","))
-- invalid order functions / bad args
print(pcall(table.sort, {1, 2, 3}, function() return true end))
print(pcall(table.sort, {1, 2, 3}, function() return false end))
print(pcall(table.sort, {1, 2, 3}, 5))
print(pcall(table.sort, "notatable"))

-- next / pairs on sequential tables (insertion == array order)
local q = {5, 6, 7}
for k, v in pairs(q) do w(k .. "=" .. v .. " ") end
print(out)
out = ""
local r = {}
local cnt = 0
for k, v in pairs(r) do cnt = cnt + 1 end
print(cnt)
print(next({}))
print(pcall(next, {}, "nope"))
local first_k, first_v = next(q)
print(first_k, first_v)
print(next(q, first_k))
print(pcall(next, {1}, 1))
print(pcall(next, {1}, 99))

-- ipairs
for i, v in ipairs({"a", "b", "c"}) do print("ip", i, v) end
for i, v in ipairs({}) do print("never2", i) end
print(pcall(ipairs, 5))
print(pcall(ipairs))
print(pcall(pairs))

-- raw operations
local raw = {1}
print(rawget(raw, 1), rawget(raw, 2))
rawset(raw, 2, "two")
print(raw[2], #raw)
print(rawequal(raw, raw), rawequal(raw, {}), rawequal(1, 1), rawequal("a", "a"))
print(rawlen({1, 2, 3}), rawlen("abcd"))
print(pcall(rawset, {}, nil, 1))
print(pcall(rawget, 5, 1))
print(pcall(rawlen, 5))

-- key rules
local kn = {}
kn[1] = "one"
kn[1.0] = "one2"
print(kn[1])
kn[0] = "zero"
print(kn[0], kn[-1])
print(pcall(function() local u = {} u[nil] = 1 end))
print(pcall(function() local u = {} u[0 / 0] = 1 end))

-- table as key / identity
local tk = {}
local kk = {}
tk[kk] = "byid"
print(tk[kk], tk[{}])
tk[true] = "yes"
tk[false] = "no"
print(tk[true], tk[false])
tk[1] = "num"
print(tk[1], tk[1.0])
