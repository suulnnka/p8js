-- c10: tracebacks at depth, error positions, frame naming

-- traceback from nested Lua frames (all-Lua stack)
local function l1() return debug.traceback("t-l1", 0) end
local function l2() return l1() end
local function l3() return l2() end
print(l3())

-- traceback with default level (skips itself, shows caller chain)
local function t0() return debug.traceback() end
print(t0())

-- traceback across a native boundary (pcall between frames)
local function inner() return debug.traceback("cross-native", 0) end
print(pcall(inner))

-- traceback INSIDE an xpcall handler (failing frames must be visible)
print(xpcall(function()
  local function fail() error("deep-fail") end
  fail()
end, function(m)
  return debug.traceback(m, 0)
end))

-- deeper: handler sees several frames
print(xpcall(function()
  local function a() error("at-a") end
  local function b() return a() end
  local function c() return b() end
  c()
end, function(m)
  return debug.traceback(m, 1)
end))

-- traceback with level argument selecting frames
local function pick(level) return debug.traceback("L" .. level, level) end
print(pick(0))
print(pick(1))
print(pick(2))
print(pick(5))
print(pick(99))

-- traceback of a suspended coroutine (thread arg)
local tco = coroutine.create(function()
  coroutine.yield("hold")
end)
coroutine.resume(tco)
print(debug.traceback(tco, "from-main", 0))
print(type(debug.traceback(tco)))
print(debug.traceback(tco, "msg2"))
coroutine.resume(tco) -- finish it
print(debug.traceback(tco, "after-dead", 0))

-- error position: line numbers in nested defs
local function e1()
  error("at-e1")
end
local function e2()
  return e1()
end
print(pcall(e2))

-- error with position through metamethod call chain
local mt = setmetatable({}, {
  __add = function() error("mm-add") end,
})
print(pcall(function() return mt + 1 end))

-- error inside iterator during generic for
print(pcall(function()
  for v in function() error("iter-boom") end do end
end))

-- error inside sort comparator
print(pcall(table.sort, {3, 1, 2}, function() error("cmp-boom") end))

-- error inside gsub replacement function
print(pcall(string.gsub, "abc", ".", function() error("gsub-boom") end))

-- error inside __index chain
local badmt = setmetatable({}, {__index = function() error("idx-boom") end})
print(pcall(function() return badmt.k end))

-- assert with position
local function ae() assert(false, "assert-here") end
print(pcall(ae))

-- error() level 2 from helper inside table.sort-like nesting
local function lvl2caller()
  return pcall(error, "lv2", 2)
end
print(lvl2caller())
print(pcall(lvl2caller))

-- stack overflow-ish depth (bounded, no crash expected at this size)
local function deep(n)
  if n == 0 then return debug.traceback("bottom", 0) end
  return deep(n - 1)
end
local okd, td = pcall(deep, 12)
print(okd, td)

-- count frames in a traceback (stable depth ⇒ stable output)
local function cnt(t)
  local n = 0
  for _ in string.gmatch(t, "\n\t") do n = n + 1 end
  return n
end
local function cf() return debug.traceback("x", 0) end
local function cg() return cf() end
print(cnt(cg()))

-- error message WITHOUT position (level 0) vs with
print(pcall(error, "nopos", 0))
print(pcall(function() error("withpos", 0) end))
print(pcall(function() error("withpos1") end))

-- non-string errors bypass position entirely
print(pcall(error, 12345))
print(pcall(error, true))
print(pcall(error, nil))

-- yield + traceback interplay inside coroutine
local yco = coroutine.create(function()
  coroutine.yield()
  return debug.traceback("post-yield", 0)
end)
coroutine.resume(yco)
print(coroutine.resume(yco))
