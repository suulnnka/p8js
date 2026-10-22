# Third-party notices

p8js 的部分代码是下列上游项目的移植(port)或派生,按各自许可证要求在此保留
版权与许可声明。本项目整体以 MIT 发放(见 `LICENSE`);各上游许可均与 MIT 兼容。

| 来源 | 许可证 | p8js 中的对应物 |
|---|---|---|
| Lua 5.2.4 | MIT | `src/vm/` 的语义与 `undump`/`dump`/`fix32`/`opcodes` 移植 |
| z8lua (Sam Hocevar;fork suulnnka/z8lua) | MIT | 同上;z8lua 以 git 子模块 `z8lua/` 随仓库分发(`zepto8` 分支,上游 `4a7089e` + 兼容修改),`native/build/z8lua` 为构建期副本,不随仓库分发 |
| fake-08 (jtothebell 等) | MIT | `src/core/` 的 api/memory/graphics/print/input/audio 及 `tools/charset.ts` |
| zepto8 (Sam Hocevar) | WTFPL 2 | `assets/bios.bc`、`assets/glue.lua` 的源流;`tools/pxa.ts`、`include.ts`、`pngcart.ts` |
| PicoLove (Jez Kabanov) | zlib | `src/core/audio.ts` 的噪声合成公式(有改动) |
| fontdata | MIT(随 fake-08) | `src/core/fontdata.ts` 由 fake-08 `fontdata.cpp` 机械提取 |
| pngjs | MIT | PNG 卡带解析依赖(`tools/pngcart.ts`) |

注:曾在 fake-08 中以 CC BY-SA 3.0 授权的 StackOverflow 椭圆算法实现,已于
2026-10 由本项目按 J. Kennedy 的算法描述独立重写(`src/core/graphics.ts`
`oval`/`ovalfill`),不再包含 CC BY-SA 派生代码。

---

## Lua 5.2.4 — MIT

Copyright (C) 1994-2015 Lua.org, PUC-Rio.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## z8lua — MIT

Copyright © 2016–2024 Sam Hocevar <sam@hocevar.net>

https://github.com/samhocevar/z8lua — Lua 5.2.4 的 PICO-8 方言分支,MIT 许可
(见上游仓库声明)。上面的 MIT 许可文本同样适用。

本仓库以 git 子模块形式分发其 fork https://github.com/suulnnka/z8lua
(`zepto8` 分支:上游 `4a7089e` + p8js 的 fake-08 兼容修改与 `tools/` 驱动),
许可与上游一致。

## fake-08 — MIT

https://github.com/jtothebell/fake-08 — Copyright 其作者及贡献者,MIT 许可。
上面的 MIT 许可文本同样适用。

## zepto8 — WTFPL 2

Copyright © 2016–2024 Sam Hocevar <sam@hocevar.net>

http://www.wtfpl.net/ — WTFPL(Do What the Fuck You Want to Public License,
Version 2):可以任意复制、修改、再分发,不附加任何条件。

## PicoLove — zlib

Copyright (c) 2015 Jez Kabanov <thesleepless@gmail.com>

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the
use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a
   product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

改动说明(zlib 条款 2):`src/core/audio.ts` 的 NOISE 波形把上游的 C `rand()`
替换为 JavaScript `Math.random()`,其余公式保持一致。

## 其他 npm 依赖

构建/开发工具链(vite、vitest、tsx、typescript、@types/node、pngjs 等)经
npm 安装,各自的许可证随包分发;其中 typescript 为 Apache-2.0,其余为 MIT。
它们不构成运行时代码的一部分(除 pngjs 仅用于离线转换工具)。

## 商标与内容

- "PICO-8" 是 Lexaloffle Games 的商标。p8js 是非官方的兼容实现,与
  Lexaloffle 无关,亦未获得其支持或认可。
- 仓库不含任何 Lexaloffle 官方二进制、ROM 或资源;BIOS 为 zepto8 从零编写
  (WTFPL)的兼容实现。
- 卡带文件(项目内 `carts/`,已 gitignore)版权归其各自创作者,
  不在本项目分发范围内。
