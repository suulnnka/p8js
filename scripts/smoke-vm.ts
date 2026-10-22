// Smoke: compile a snippet via WSL p8luac, run it in the VM, print output.
// Usage: npx tsx scripts/smoke-vm.ts [file.lua]
import { readFileSync } from "node:fs";
import { compileBytecode } from "../tools/convert.ts";
import {
  chunkClosure, runChunk, tracebackString,
} from "../src/vm/interp.ts";
import { LuaState } from "../src/vm/state.ts";
import { undump } from "../src/vm/undump.ts";
import { LuaError } from "../src/vm/errors.ts";
import { openLibs } from "../src/vm/stdlib-base.ts";

const src = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : `
print(_VERSION, 1 + 1, 0.03125, 1/3, -0x0.0001)
print(tostring(1.5), string.format("%d %s %.2f %x", 42, "hi", 3.14159, 255))
local t = {3,1,2}
table.sort(t)
print(t[1], t[2], t[3])
local co = coroutine.create(function() local v = coroutine.yield(1) return v * 2 end)
print(coroutine.resume(co))
print(coroutine.resume(co, 21))
print(coroutine.status(co))
local ok, e = pcall(function() local x = nil; x.y = 1 end)
print(ok, e)
local mt = setmetatable({}, {__index = function() return "dflt" end, __tostring = function() return "OBJ" end})
print(mt.a, tostring(mt))
print(pcall(function() return ("hello"):sub(2, 4) end))
print(string.sub("hello", 2, 4))
print(string.gsub("hello", "l", "L"))
local s = 0
for i = 10, 1, -3 do s += i end
print(s)
print(flr(-1.5), ceil(-1.5), sqrt(2), sin(0.25), cos(0), atan2(1,1))
print(tostr(1,1), tostr(1,3), tonum("0x1.8"), chr(65), ord("B"))
print(split("a,b,c")[2], #split("a,b,c"))
local d = string.dump(function(q) return q + 1 end)
local f = load(d)
print(f(41))
print(pcall(function() no_such() end))
print(pcall(function() return {} < 1 end))
print(select("#", 1, 2, 3), select(2, "x", "y"))
print(#"", pcall(function() return ("\0\0\0"):len() end))
local co2 = coroutine.wrap(function(x) local y = coroutine.yield(x + 1) return y * 2 end)
print(co2(5), co2(10))
print(debug.traceback("msg"))
`;

let out = "";
const L = new LuaState();
openLibs(L, { print: (s) => (out += s) });
try {
  const bc = compileBytecode(src, "=smoke");
  const proto = undump(bc, "=smoke");
  const cl = chunkClosure(L, proto, L.globals);
  const results = runChunk(L, cl);
  if (results.length > 0) {
    out += `-- results: ${results.length}\n`;
  }
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(out);
  if (e instanceof LuaError) {
    process.stderr.write(e.fullMessage() + "\n");
    try {
      process.stderr.write(tracebackString(L, null, 0) + "\n");
    } catch { /* state may be inconsistent */ }
    process.exit(1);
  }
  throw e;
}
