pico-8 cartridge // http://www.pico-8.com
version 41
__lua__
-- btnp edge-latch regression fixture (p8js own cart, no upstream content).
-- Counts btnp(4) presses into work RAM 0x4300 so a test can read the tally.
poke(0x4300, 0)
function _update()
  if btnp(4) then
    poke(0x4300, peek(0x4300) + 1)
  end
end
