-- p8js fixture: PICO-8 dialect smoke test
-- covers: short if (paren-less + parenthesized), standard one-line if/then/end,
-- short while, +=, ?print, @ operator, binary literals, !=
local t=0
local seed=0b1010.01

function _update()
  t+=1
  if t>10 t=0                -- paren-less short if (fake-08 style)
  if (t==3) t=4              -- parenthesized short if (PICO-8 canonical)
  if (t==5) then t=6 end     -- standard one-line if/then/end
  while t<2 t+=1              -- paren-less short while
  t=(t+seed)%8
end

function _draw()
  cls(0)
  ?"hello "..t
  local v=@0x6000
  print(tostr(0b1010))
  if 1!=2 then
    poke(0x5f25, shr(8,1))
  end
end
