-- c04: closures, varargs, control flow, calls, tail calls, goto

-- upvalues: open/close across returns and calls
local counter = (function()
  local n = 0
  return function() n = n + 1 return n end
end)()
print(counter(), counter(), counter())

local getset
do
  local v = "initial"
  getset = {
    get = function() return v end,
    set = function(x) v = x end,
  }
end
print(getset.get())
getset.set("changed")
print(getset.get())

-- shared upvalue between siblings
local mk = function()
  local shared = 0
  return function() shared = shared + 1 return shared end,
         function() return shared end
end
local inc, get = mk()
inc()
inc()
print(get())

-- closure capturing loop variable (per-iteration in Lua 5.2? NO — one var per loop)
local fns = {}
for i = 1, 3 do fns[i] = function() return i end end
print(fns[1](), fns[2](), fns[3]())

-- upvalue closed by pcall unwind
local leaked
local ok = pcall(function()
  local x = "inside"
  leaked = function() return x end
  error("bye")
end)
print(ok, leaked())

-- varargs
local function va(a, ...)
  local n = select("#", ...)
  return a, n, ...
end
print(va(1))
print(va(1, 2, 3))
print(select("#", va(1, 2, 3, 4, 5)))

local function all(...) return ... end
print(all())
print(all(1))
print(all(1, 2, 3))

local function count(...) return select("#", ...) end
print(count(), count(nil), count(nil, nil), count(1, nil, 3))

-- varargs in middle-position usage
local function grab2(a, ...) return ..., a end
print(grab2("x", "p", "q"))

-- multiple returns adjustment
local function three() return 1, 2, 3 end
print(three())
print((three()))
print(select(2, three()))
local t5 = {three()}
print(#t5, t5[1], t5[3])

-- call styles
local function add(a, b) return a + b end
print(add(2, 3))
print((function(x) return x * 2 end)(21))
local obj = {val = 10}
function obj:get() return self.val end
print(obj:get())
print(pcall(function() return ("abc"):upper() end)) -- z8lua: string methods unavailable

-- tail calls (trampoline through replacement frames)
local function down(n) if n == 0 then return "end" end return down(n - 1) end
print(down(1000))
local function even(n) if n == 0 then return true end return odd(n - 1) end
function odd(n) if n == 0 then return false end return even(n - 1) end
print(even(998), even(999))

-- mutual recursion (non-tail)
local function ping(n, acc)
  if n == 0 then return acc end
  return pong(n - 1, acc .. "p")
end
function pong(n, acc)
  if n == 0 then return acc end
  return ping(n - 1, acc .. "o")
end
print(ping(10, ""))

-- deep non-tail recursion (guarded)
local function depth(n)
  if n == 0 then return 0 end
  return 1 + depth(n - 1)
end
print(depth(200))

-- numeric for: standard / negative / float steps / coerced limits
local s = 0
for i = 1, 10 do s = s + i end
print(s)
s = 0
for i = 10, 1, -3 do s = s + i end
print(s)
s = 0
for i = 0.5, 2, 0.5 do s = s + i end
print(s)
s = 0
for i = 1, 3 do for j = 1, 3 do s = s + i * j end end
print(s)
for i = 5, 4 do print("never-loop", i) end
local fi = 0
for i = 1, 10, 0 do fi = fi + 1 if fi > 3 then break end end
print(fi)
print(pcall(function() for i = "a", 3 do end end))
print(pcall(function() for i = 1, "b" do end end))
print(pcall(function() for i = 1, 3, "c" do end end))
-- for with values near fix32 wrap
local w = 0
for i = 0x7ffffff0, 0x7fffffff do w = w + 1 end
print(w)

-- generic for: Lua iterator + state/control
local function irange(state, control)
  if control >= state.limit then return nil end
  return control + 1
end
for v in irange, {limit = 4}, 0 do print("gv", v) end
local function ipair2(t, i)
  i = i + 1
  local v = t[i]
  if v ~= nil then return i, v end
end
for i, v in ipair2, {"x", "y"}, 0 do print("gi", i, v) end
-- iterator errors
print(pcall(function()
  for v in function() error("iter") end do end
end))

-- while / repeat / break / continue-less
local n = 0
while n < 5 do n = n + 1 end
print(n)
local m = 0
repeat m = m + 1 until m >= 3
print(m)
local b = 0
while true do b = b + 1 if b >= 7 then break end end
print(b)
local rb = 0
repeat rb = rb + 1 if rb == 2 then break end until false
print(rb)

-- if / elseif / else chains
local function grade(x)
  if x >= 90 then return "A"
  elseif x >= 80 then return "B"
  elseif x >= 70 then return "C"
  else return "D" end
end
print(grade(95), grade(85), grade(75), grade(10))

-- dialect short forms (compiled by p8luac)
local sh = 0
if sh == 0 sh = 1
if sh ~= 0 then sh = 2 end
while sh < 5 sh += 1
print(sh)
local cmp = 0
if (cmp == 0) cmp = 7
print(cmp)
if 1 != 2 print("ne-ok")
local sq = 0
if 1 == 1 then sq += 100 else sq -= 100 end
print(sq)

-- goto / labels (Lua 5.2)
do
  local g = 0
  ::top::
  g = g + 1
  if g < 3 then goto top end
  print(g)
end
do
  local skipped = false
  goto skip
  skipped = true
  ::skip::
  print(skipped)
end

-- errors inside calls with frames
local function level3() error("deep") end
local function level2() return level3() end
local function level1() return level2() end
print(pcall(level1))

-- error object propagation through calls (type only — addresses are
-- nondeterministic and must not be printed)
local okE, errE = pcall(function() error({code = 5}) end)
print(okE, type(errE))

-- select edge cases
print(select("#", 1, 2, 3))
print(select(3, "a", "b", "c", "d"))
print(select(-1, "a", "b", "c"))
print(pcall(select, 0, "a"))
print(pcall(select, 5, "a"))

-- boolean logic producing values
print(true and 1 or 2, false and 1 or 2, nil and 1 or 2)
print(not nil, not false, not 0, not "")
print(1 and 2 and 3, nil or false or 4)
