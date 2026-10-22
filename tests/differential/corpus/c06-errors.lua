-- c06: error messages — type errors with names, positions, handlers

-- typeerror with symbolic names: local / global / upvalue / field / method
print(pcall(function() local x = nil x.y = 1 end))
print(pcall(function() local t = {} local k = t t() end))
print(pcall(function() local f = nil f() end))
print(pcall(function() no_such_fn() end))
print(pcall(function() return nil + 1 end))
print(pcall(function() return "a" + 1 end))
print(pcall(function() return {} < 1 end))
print(pcall(function() return 1 < "a" end))
print(pcall(function() return {} .. "x" end))
print(pcall(function() return #nil end))
print(pcall(function() return "x" ~ {} end))

-- upvalue naming
local upf = nil
print(pcall(function() return upf() end))
local upn = nil
print(pcall(function() return upn + 1 end))

-- field naming
local obj = {nested = {deep = nil}}
print(pcall(function() return obj.nested.deep.x + 1 end))
print(pcall(function() return obj.nested.deep() end))

-- method naming via SELF
print(pcall(function() local t = {} return t:missing() end))
print(pcall(function() local t = {} return t:missing_field() end))

-- constant naming (operand is a K constant ⇒ no register name)
print(pcall(function() return nil + true end))
print(pcall(function() return true .. nil end))

-- call attempts
print(pcall(function() local t = {} t() end))
print(pcall(function() return (5)() end))
print(pcall(function() return (nil)() end))
print(pcall(function() local mt = setmetatable({}, {}) return mt() end))

-- for-loop errors
print(pcall(function() for i = "a", 3 do end end))
print(pcall(function() for i = 1, "b" do end end))
print(pcall(function() for i = 1, 3, {} do end end))

-- table index nil
print(pcall(function() local t = {} t[nil] = 1 end))
print(pcall(function() local t = {} local k = nil t[k] = 1 end))

-- compare two of same / different mismatched types
print(pcall(function() return {} < {} end))
print(pcall(function() return true < false end))
print(pcall(function() return nil < nil end))
print(pcall(function() return nil < {} end))
print(pcall(function() return "a" < 1 end))

-- error() levels and values
local function where1() error("plain") end
local function where2() error("wrapped", 2) end
print(pcall(where1))
print(pcall(where2))
print(pcall(error, "direct"))
print(pcall(error, "leveled", 0))
print(pcall(error, "lv2-outer"))
local function outer() return pcall(error, "x", 2) end
print(pcall(outer))
print(pcall(error))
print(pcall(error, 42))
print(pcall(error, true))
local eo = pcall(error, setmetatable({}, {__tostring = function() return "E!" end}))
print(eo)

-- assert
print(pcall(assert))
print(pcall(assert, true))
print(pcall(assert, false))
print(pcall(assert, false, "custom"))
print(pcall(assert, false, 123))
print(select("#", assert(true, "unused")))

-- xpcall
print(xpcall(function() return 1, 2 end, function() return "unused" end))
print(xpcall(function() error("boom") end, function(m) return "got:" .. m end))
print(xpcall(function() error("b2") end, function(m) return 42 end))
print(xpcall(function() error("b3") end, function(m) return nil end))
print(xpcall(function() error({tag = 9}) end, function(m) return type(m) end))
print(pcall(xpcall, function() error("b4") end, nil))
print(pcall(xpcall, function() error("b5") end, 42))
print(pcall(xpcall, function() error("b6") end, function() error("handler-boom") end))
print(xpcall(function() error("n") end, function(m) return m .. "!" end))
print(pcall(xpcall, function() error("b7") end))
print(xpcall(function() error("zero-level") end, function(m) return m end))

-- handler receives the SAME value pcall would return
print(pcall(function()
  local seen
  xpcall(function() error("inner-err") end, function(m) seen = m end)
  return seen
end))

-- pcall success passes through multiple results
print(pcall(function() return 1, 2, 3 end))
print(pcall(function() end))
print(pcall(print, "pcalled-print"))

-- bad argument errors (argerror naming through call styles)
print(pcall(table.sort, {1}, nil, "extra"))
print(pcall(table.concat, {1}, "-", 1, nil))
print(pcall(string.rep))
print(pcall(string.sub))
print(pcall(table.insert))
print(pcall(table.remove, {}))
print(pcall(select))
print(pcall(setmetatable, {}, 5))
print(pcall(setmetatable, 5, {}))
print(pcall(rawget, {}, nil))
print(pcall(string.char, "x"))
print(pcall(coroutine.resume, "not-a-thread"))
print(pcall(coroutine.status, 5))

-- name resolution of callee in argerror
local sl = string.lower
print(pcall(sl, 5))
local localRep = string.rep
print(pcall(localRep, "x", "y"))
local holder = {}
holder.fn = string.reverse
print(pcall(holder.fn, 5))

-- error inside pcall inside pcall (layered messages)
print(pcall(function()
  return pcall(function() error("layered") end)
end))

-- error object identity through pcall
local marker = {}
local ok, err = pcall(function() error(marker) end)
print(ok, err == marker)

-- traceback formatting (debug.traceback) at several depths
print(debug.traceback("top"))
local function tb2() return debug.traceback("at-tb2", 0) end
print(tb2())
print(debug.traceback("lv0", 0))
print(debug.traceback())
print(debug.traceback(nil, 0))
print(debug.traceback(5))
print(type(debug.traceback(function() end))) -- non-string msg returned untouched

-- traceback through xpcall handler
print(xpcall(function() error("tb-err") end, function(m)
  return debug.traceback(m, 0)
end))

-- nested traceback depth
local function d1() return debug.traceback("d1", 0) end
local function d2() return d1() end
local function d3() return d2() end
print(d3())

-- error message from pattern misuse (lstrlib luaL_error paths)
print(pcall(string.find, "abc", "%"))
print(pcall(string.find, "abc", "["))
print(pcall(string.gsub, "abc", "%", "x"))
print(pcall(string.match, "abc", "%1"))
print(pcall(string.format, "%q"))
