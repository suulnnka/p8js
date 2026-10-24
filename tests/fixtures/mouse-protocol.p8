pico-8 cartridge // http://www.pico-8.com
version 41
__lua__
-- mouse protocol fixture (KNOWN-GAPS §7.2): devkit flags 7 =
-- 0x1 enable | 0x2 btn emulation | 0x4 pointer tracking.
-- Tallies one frame of host mouse input into work RAM:
--   0x4300 stat(38) dx seen   0x4301 stat(39) dy seen
--   0x4302 stat(34) left held 0x4303 stat(36) wheel event
--   0x4304 btnp(4) edge from the emulated mouse button
poke(0x5f2d, 7)
function _update()
 if stat(38) != 0 then poke(0x4300, min(255, peek(0x4300)+1)) end
 if stat(39) != 0 then poke(0x4301, min(255, peek(0x4301)+1)) end
 if stat(34)%2 == 1 then poke(0x4302, 1) end
 if stat(36) != 0 then poke(0x4303, min(255, peek(0x4303)+1)) end
 if btnp(4) then poke(0x4304, min(255, peek(0x4304)+1)) end
end
