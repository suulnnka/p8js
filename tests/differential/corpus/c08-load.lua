-- c08: load / string.dump roundtrips (binary chunks only)

-- simple dumps
local d1 = string.dump(function() return 7 end)
local f1 = load(d1)
print(f1())
print(type(f1))

-- dump a function using globals (ENV upvalue survives via load's rule)
local d2 = string.dump(function(a) return a + GLOBAL_PLUS end)
GLOBAL_PLUS = 100
local f2 = load(d2)
print(f2(1))

-- dump a chunk with locals, upvalues, loops, tables
local function sample(n)
  local acc = {}
  local function helper(x) return x * 2 end
  for i = 1, n do acc[i] = helper(i) end
  local sum = 0
  for i = 1, #acc do sum = sum + acc[i] end
  local outer = n
  return sum, function() return outer end, acc
end
local d3 = string.dump(sample)
local f3 = load(d3)
local s, getter, tbl = f3(4)
print(s, getter(), #tbl, tbl[1], tbl[4])

-- nested function dump
local d4 = string.dump(function(x)
  local function inner(y)
    local function innermost(z) return z + y end
    return innermost(x)
  end
  return inner(10)
end)
print((load(d4))(5))

-- load with custom env (4th arg)
local d5 = string.dump(function()
  return alpha, beta
end)
local sandbox = {alpha = "A"}
local f5 = load(d5, "=chunk", "b", sandbox)
print(f5())
local f5b = load(d5, "=chunk", "bt", {alpha = "Z", beta = "B"})
print(f5b())

-- load keeps chunk name for errors
local d6 = string.dump(function() error("from-loaded") end)
local f6 = load(d6, "@myname.lua")
print(pcall(f6))
local f6b = load(d6)
print(pcall(f6b))

-- load returns nil + message on bad *binary* (text chunks are out of scope:
-- the native compiler parses source, this VM has no parser — PLAN §9)
print(load("\27Lua garbage that follows"))
print(load("\27Lua"))
print(pcall(load, nil))
print(pcall(load, true))

-- load with reader function returning binary pieces
local raw = string.dump(function() return "from-reader" end)
local pos = 1
local reader = function()
  if pos > #raw then return nil end
  local piece = string.sub(raw, pos, pos + 7)
  pos = pos + 8
  return piece
end
local fr = load(reader, "=reader")
print(fr())

-- reader returning non-string (a number would coerce and loop forever —
-- a table triggers the real error path)
print(pcall(load, function() return {} end, "=badreader"))

-- dump / load identities
print(type(string.dump(load(string.dump(function() return 1 end)))))

-- varargs and multret survive dump/load
local d7 = string.dump(function(...)
  local n = select("#", ...)
  local a, b = ...
  return n, a, b
end)
print((load(d7))(1, 2, 3))
print((load(d7))())

-- error messages inside loaded chunks (position prefix)
local d8 = string.dump(function() local z = nil return z.x end)
print(pcall((load(d8))))

-- pcall(load) edge values
print(pcall(load, nil))
print(pcall(load, true))

-- string.dump argument checks
print(pcall(string.dump, print))
print(pcall(string.dump, {}))
print(pcall(string.dump))

-- loaded function is callable multiple times
local d9 = string.dump(function(n) return n + 1 end)
local f9 = load(d9)
print(f9(1), f9(2), f9(3))
