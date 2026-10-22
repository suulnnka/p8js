pico-8 cartridge // http://www.pico-8.com
version 41
__lua__
-- p8js example cart (bouncing ball demo)
-- arrows steer, x/z flip gravity
x=64 y=20 dx=1.5 dy=0 col=8
function _update()
 dy+=0.15
 if btn(0) then dx-=0.2 end
 if btn(1) then dx+=0.2 end
 x+=dx y+=dy
 if x<5 then x=5 dx=-dx*0.9 end
 if x>122 then x=122 dx=-dx*0.9 end
 if y<5 then y=5 dy=-dy*0.9 end
 if y>122 then y=122 dy=-dy*1.05 col=(col+1)%16 end
end
function _draw()
 cls(1)
 for i=0,15 do
  rect(0,120-i,127,120-i,(i*3)%16)
 end
 line(x,0,x,127,3)
 circ(x,y,5,7)
 circfill(x,y,4,col)
 print("p8js demo",34,4,7)
 print("z/x flip - arrows steer",22,14,6)
end
