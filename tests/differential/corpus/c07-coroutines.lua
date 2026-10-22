-- c07: coroutines — resume/yield/status/wrap, pcall-across-yield

-- basic create/resume/yield/finish
local co = coroutine.create(function() return 42 end)
print(type(co))
print(coroutine.resume(co))
print(coroutine.status(co))
print(coroutine.resume(co))

local co2 = coroutine.create(function()
  coroutine.yield(1)
  coroutine.yield(2)
  return "done"
end)
print(coroutine.resume(co2))
print(coroutine.status(co2))
print(coroutine.resume(co2))
print(coroutine.status(co2))
print(coroutine.resume(co2))
print(coroutine.status(co2))

-- yield with multiple values / receive multiple
local co3 = coroutine.create(function(a, b)
  local x, y = coroutine.yield(a + b, a * b)
  return x, y
end)
print(coroutine.resume(co3, 3, 4))
print(coroutine.resume(co3, "p", "q"))
print(coroutine.resume(co3))

-- resume args feed the FIRST resume too
local co4 = coroutine.create(function(a, ...)
  local n = select("#", ...)
  coroutine.yield(a, n, ...)
  return "end"
end)
print(coroutine.resume(co4, "A", "B", "C"))
print(coroutine.resume(co4))

-- yield no values
local co5 = coroutine.create(function()
  coroutine.yield()
  return 1
end)
print(coroutine.resume(co5))
print(coroutine.resume(co5))

-- status: running from inside, dead, suspended
local co6 = coroutine.create(function()
  print("inside", coroutine.status(coroutine.running()))
  print("type-running", type(coroutine.running()))
  coroutine.yield("paused")
end)
print(coroutine.resume(co6))
print(coroutine.status(co6))

-- coroutine errors: false + message, dead afterwards
local co7 = coroutine.create(function() error("co-err") end)
print(coroutine.resume(co7))
print(coroutine.status(co7))
print(coroutine.resume(co7))

local co8 = coroutine.create(function() error({tag = 1}) end)
local ok8, err8 = coroutine.resume(co8)
print(ok8, type(err8))

-- error inside pcall inside coroutine (stays alive)
local co9 = coroutine.create(function()
  local ok, e = pcall(function() error("inner") end)
  return ok, e
end)
print(coroutine.resume(co9))
print(coroutine.status(co9))

-- *** yield across pcall (z8lua continuation semantics) ***
local co10 = coroutine.create(function()
  local a, b = pcall(coroutine.yield, 7)
  return type(a), tostring(b)
end)
print(coroutine.resume(co10))
print(coroutine.resume(co10, "x", "y"))
print(coroutine.status(co10))

-- yield inside a function called by pcall
local co11 = coroutine.create(function()
  local f = function() coroutine.yield("inner") return "fin" end
  print(pcall(f))
end)
print(coroutine.resume(co11))
print(coroutine.resume(co11))
print(coroutine.status(co11))

-- yield with resume value into table.insert
local co12 = coroutine.create(function()
  local t = {}
  table.insert(t, coroutine.yield("y1"))
  return t[1]
end)
print(coroutine.resume(co12))
print(coroutine.resume(co12, "got"))

-- yield inside generic-for iterator (native gmatch-ish via Lua iterator)
local co13 = coroutine.create(function()
  for v in function(_, i)
    if i < 3 then coroutine.yield(i) return i + 1 end
  end, {}, 0 do
    print("iter", v)
  end
  return "loop-done"
end)
print(coroutine.resume(co13))
print(coroutine.resume(co13))
print(coroutine.resume(co13))
print(coroutine.resume(co13))

-- wrap
local w1 = coroutine.wrap(function(x)
  local y = coroutine.yield(x + 1)
  return y * 2
end)
print(w1(5))
print(w1(10))
print(pcall(w1))

local w2 = coroutine.wrap(function() return "only" end)
print(w2())
print(pcall(w2))

local w3 = coroutine.wrap(function() error("wrap-err") end)
print(pcall(w3))

-- wrap yield across pcall
local w4 = coroutine.wrap(function()
  local a = pcall(coroutine.yield, "wy")
  return "wrapped:" .. tostring(a)
end)
print(w4())
print(w4())

-- nested coroutines
local outer = coroutine.create(function()
  local inner = coroutine.create(function()
    coroutine.yield("in-1")
    return "in-2"
  end)
  print(coroutine.resume(inner))
  print(coroutine.resume(inner))
  coroutine.yield("out-1")
  return "out-2"
end)
print(coroutine.resume(outer))
print(coroutine.resume(outer))

-- resume while running (same coroutine)
local selfco
selfco = coroutine.create(function()
  print(pcall(coroutine.resume, selfco))
  coroutine.yield("self")
end)
print(coroutine.resume(selfco))

-- coroutine values as data
local ck = {}
ck[coroutine.create(function() end)] = "keyed"
print(type(next(ck)))

-- yield from main thread is an error (observed z8lua message)
print(pcall(function() coroutine.yield(1) end))

-- yield with no active resume (via pcall on main)
print(pcall(coroutine.yield))

-- many yields (stress the suspend/repair path)
local coN = coroutine.create(function()
  for i = 1, 50 do coroutine.yield(i) end
  return "done50"
end)
local last = nil
local count = 0
while true do
  local ok, v = coroutine.resume(coN)
  count = count + 1
  if not ok then print("fail", v) break end
  if v == nil then break end
  last = v
end
print(count, last)

-- run to exhaustion returning nothing
local coEmpty = coroutine.create(function() end)
print(coroutine.resume(coEmpty))
print(coroutine.status(coEmpty))
print(pcall(coroutine.resume, coEmpty))

-- coroutine as argument to native expecting thread
print(pcall(coroutine.status, coroutine.create(function() end)))
print(type(coroutine.resume), type(yield))
