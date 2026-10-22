-- c05: metatables — full metamethod surface

-- __index: function and table forms, chains
local t = setmetatable({}, {
  __index = function(_, k) return "fn:" .. k end,
})
print(t.anything, t[1])

local base = {greet = "hi", n = 5}
local derived = setmetatable({}, {__index = base})
print(derived.greet, derived.n, derived.missing)
local deeper = setmetatable({}, {__index = derived})
print(deeper.greet, deeper.n)

-- __index via rawget bypass
local direct = setmetatable({x = 1}, {
  __index = function() return "shadowed" end,
})
print(direct.x, rawget(direct, "x"))

-- __newindex: function and table forms
local store = {}
local proxy = setmetatable({}, {
  __newindex = function(tbl, k, v) rawset(tbl, k, v .. "!" ) end,
  __index = function(tbl, k) return rawget(tbl, k) .. "?" end,
})
proxy.a = "set"
print(proxy.a)

local fixed = {"static"}
local guarded = setmetatable({}, {
  __newindex = fixed,
  __index = fixed,
})
guarded[1] = "written"
print(fixed[1], guarded[1], rawget(guarded, 1))

-- __newindex NOT called when key already exists
local plain = setmetatable({k = "orig"}, {
  __newindex = function() error("should not fire") end,
})
plain.k = "new"
print(plain.k)
print(pcall(function() plain.newkey = 1 end))

-- __call
local callable = setmetatable({}, {
  __call = function(self, a, b) return a + b end,
})
print(callable(3, 4))
print(pcall(callable))
print(pcall(function() return (5)(1) end))

-- __len (tables only via Lua; strings use raw len)
local lenned = setmetatable({1, 2, 3}, {__len = function() return 99 end})
print(#lenned, rawlen(lenned))
print(#"" , #"abc")

-- __eq / __lt / __le
local function mk(id)
  return setmetatable({id = id}, {
    __eq = function(a, b) return a.id == b.id end,
    __lt = function(a, b) return a.id < b.id end,
    __le = function(a, b) return a.id <= b.id end,
  })
end
local o1, o2, o3 = mk(1), mk(2), mk(1)
print(o1 == o2, o1 == o3, o1 ~= o2, o1 ~= o3)
print(o1 < o2, o2 < o1, o1 <= o3, o2 <= o1)
print(({}) == ({}))
print(pcall(function() return mk(1) < 5 end))
print(pcall(function() return 5 < mk(1) end))
print(pcall(function() return mk(1) <= "x" end))

-- __concat
local cat = setmetatable({}, {__concat = function(a, b) return "CAT" end})
print("x" .. cat, cat .. "y", "x" .. cat .. "y")
print(pcall(function() return {} .. {} end))
print(pcall(function() return 1 .. {} end))

-- __unm / arithmetic (z8lua TM names have upstream typos — ltm.c:33-41:
-- _idiv / __and / __or / __xor / rotr / __not are the ACTUAL field keys)
local num = setmetatable({}, {
  __unm = function() return "negated" end,
  __add = function(a, b) return "add" end,
  __sub = function() return "sub" end,
  __mul = function() return "mul" end,
  __div = function() return "div" end,
  __mod = function() return "mod" end,
  __pow = function() return "pow" end,
  _idiv = function() return "idiv" end,
  __and = function() return "band" end,
  __or = function() return "bor" end,
  __xor = function() return "bxor" end,
  __shl = function() return "shl" end,
  __shr = function() return "shr" end,
  __lshr = function() return "lshr" end,
  __rotl = function() return "rotl" end,
  rotr = function() return "rotr" end,
  __not = function() return "bnot" end,
})
print(-num)
print(num + 1, 1 + num, num + num)
print(num - 1, num * 2, num / 2, num % 2, num ^ 2)
print(num \ 2, num & 1, num | 1, num ~ 1)
print(num << 1, num >> 1, num >>> 1, num <<> 1, num >>< 1)
print(~num)
print(1 & num, 1 | num, 1 ~ num, 1 << num, 1 >> num, 1 >>> num)

-- standard-spelling TM fields are IGNORED by z8lua (typo'd names only)
local std = setmetatable({}, {
  __idiv = function() return "nope" end,
  __band = function() return "nope" end,
  __bor = function() return "nope" end,
  __bxor = function() return "nope" end,
  __rotr = function() return "nope" end,
  __bnot = function() return "nope" end,
})
print(pcall(function() return std \ 2 end))
print(pcall(function() return std & 1 end))
print(pcall(function() return std | 1 end))
print(pcall(function() return std ~ 1 end))
print(pcall(function() return std >>< 1 end))
print(pcall(function() return ~std end))

print(pcall(function() return "x" + num end))
print(pcall(function() return num + "x" end))

-- __tostring
local ts = setmetatable({}, {__tostring = function() return "TS!" end})
print(tostring(ts))
print("val: " .. tostring(ts))
print(type(tostring(ts)))

-- errors raised inside metamethods
local bad = setmetatable({}, {
  __index = function() error("in-index") end,
})
print(pcall(function() return bad.k end))
local badadd = setmetatable({}, {__add = function() error("in-add") end})
print(pcall(function() return badadd + 1 end))

-- loop guards: __index returning tables that chain forever
local loopA = {}
local loopB = {}
setmetatable(loopA, {__index = loopB})
setmetatable(loopB, {__index = loopA})
print(pcall(function() return loopA.x end))

-- setmetatable protections
local protected = setmetatable({}, {__metatable = "locked"})
print(getmetatable(protected))
print(pcall(setmetatable, protected, {}))
print(pcall(function() protected.x = 1 end)) -- only setmetatable is blocked

-- getmetatable on builtin types
print(type(getmetatable("")))
print(getmetatable("") ~= nil)
print(getmetatable(5))
print(getmetatable(true))
print(getmetatable(function() end))
print(getmetatable({}))

-- metatable field retrieval through getmetatable
local mt = setmetatable({}, {myfield = 42})
print(getmetatable(mt).myfield)

-- __pairs / __ipairs
local ppairs = setmetatable({}, {
  __pairs = function() return next, {10, 20}, nil end,
})
for k, v in pairs(ppairs) do print("pp", k, v) end
local pipairs = setmetatable({}, {
  __ipairs = function() return function(_, i) i = i + 1 if i <= 2 then return i, i * 10 end end, {}, 0 end,
})
for i, v in ipairs(pipairs) do print("pi", i, v) end

-- inherited metatables through __index of metatable (no)
local parent = {tag = "p"}
local child = setmetatable({}, {__index = parent})
local grand = setmetatable({}, {__index = child})
print(grand.tag)

-- rawset inside __newindex + rawget reads
local log = setmetatable({}, {
  __newindex = function(tbl, k, v)
    rawset(tbl, k, {key = k, val = v})
  end,
})
log.entry = 99
print(log.entry.key, log.entry.val)

-- empty __index table means nil
local quiet = setmetatable({}, {__index = {}})
print(quiet.nope)
