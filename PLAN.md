# 网页版 PICO-8 模拟器 · 实施计划

状态：**已实施** · 实现语言：TypeScript（产物为网页 JS）

## 1. 目标

在浏览器里运行 PICO-8 卡带，兼容度对齐 **fake-08**。按用户指定的技术路线拆成三大件：

1. **编译工具**（z8lua）：把 PICO-8 方言 Lua 源码编译成字节码——z8lua 仓库没有现成 luac，自研一个 `p8luac` 驱动（~50 行 C，`luaL_loadbuffer` + `lua_dump`），在 WSL 里链接 `liblua.a` 构建。
2. **z8lua VM**（TS）：加载并执行上述字节码——Lua 5.2.4 语义 + z8lua 扩展的 6 个 opcode + fix32 定点数。
3. **卡带转换工具**：`.p8` / `.p8.png` → 私有格式 **`.p8c`**（资源 rom 镜像 + 编译好的字节码），离线一次性转换，浏览器只加载 `.p8c`。

再加一个模拟器核心（64KB 内存 / 图形 / 输入 / 音频 / API 绑定），整体达到 fake-08 的功能与不完美程度。

```svg
<svg viewBox="0 0 680 450" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <defs>
    <marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#2563EB" stroke-width="1.4"/></marker>
  </defs>
  <rect x="0" y="0" width="680" height="450" rx="8" fill="#FFFFFF"/>
  <text x="30" y="24" font-size="11" fill="#94A3B8">离线转换（一次性）</text>
  <text x="30" y="262" font-size="11" fill="#94A3B8">浏览器运行时</text>

  <!-- row 1 -->
  <rect x="30" y="40" width="150" height="44" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="105" y="63" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">.p8 / .p8.png</text>

  <rect x="220" y="40" width="200" height="44" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="320" y="53" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">convert（Node）</text>
  <text x="320" y="71" font-size="11" fill="#64748B" text-anchor="middle" dominant-baseline="central">解析 · 解压 · #include</text>

  <rect x="470" y="40" width="180" height="44" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="560" y="53" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">p8luac（z8lua）</text>
  <text x="560" y="71" font-size="11" fill="#64748B" text-anchor="middle" dominant-baseline="central">源码 → 字节码 · WSL</text>

  <line x1="180" y1="62" x2="220" y2="62" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <line x1="420" y1="62" x2="470" y2="62" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="445" y="52" font-size="11" fill="#2563EB" text-anchor="middle">源码</text>

  <!-- row 2: .p8c -->
  <rect x="220" y="140" width="260" height="56" rx="8" fill="#EFF6FF" stroke="#2563EB" stroke-width="1"/>
  <text x="350" y="159" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">.p8c 私有格式</text>
  <text x="350" y="178" font-size="11" fill="#64748B" text-anchor="middle" dominant-baseline="central">rom 镜像 + 字节码 + label</text>

  <line x1="320" y1="84" x2="320" y2="140" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="326" y="116" font-size="11" fill="#2563EB" text-anchor="start">资源</text>
  <polyline points="560,84 560,112 440,112 440,140" fill="none" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="500" y="104" font-size="11" fill="#2563EB" text-anchor="middle">字节码</text>

  <!-- row 3: runtime -->
  <rect x="30" y="270" width="190" height="56" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="125" y="289" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">undump + z8lua VM（TS）</text>
  <text x="125" y="308" font-size="11" fill="#64748B" text-anchor="middle" dominant-baseline="central">预载 bios + glue 字节码</text>

  <rect x="470" y="270" width="180" height="56" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="560" y="289" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">模拟器核心</text>
  <text x="560" y="308" font-size="11" fill="#64748B" text-anchor="middle" dominant-baseline="central">RAM · 图形 · 输入 · 音频</text>

  <polyline points="300,196 300,240 125,240 125,270" fill="none" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="212" y="232" font-size="11" fill="#2563EB" text-anchor="middle">加载 .p8c</text>

  <line x1="220" y1="288" x2="470" y2="288" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="345" y="280" font-size="11" fill="#2563EB" text-anchor="middle">API 调用</text>
  <line x1="470" y1="310" x2="220" y2="310" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="345" y="326" font-size="11" fill="#2563EB" text-anchor="middle">内存 / 寄存器（@ % $·peek/poke）</text>

  <rect x="470" y="380" width="180" height="44" rx="8" fill="#F8FAFC" stroke="#64748B" stroke-width="1"/>
  <text x="560" y="403" font-size="13" font-weight="500" fill="#0F172A" text-anchor="middle" dominant-baseline="central">canvas + WebAudio</text>
  <line x1="560" y1="326" x2="560" y2="380" stroke="#2563EB" stroke-width="1" marker-end="url(#ar)"/>
  <text x="576" y="356" font-size="11" fill="#2563EB" text-anchor="start">显示 / 声音</text>
</svg>
```

## 2. 调研结论（决策依据，均来自本地参考代码）

### 2.1 z8lua（离线编译器的底座）
- **Lua 5.2.4 + Eris 补丁**，不是 5.3：`z8lua/lua.h:19-26`。分支 `zepto8`。
- **没有 luac**：`z8lua/makefile:55-56` 中 `LUAC_T` 被注释；`lua.c` 也没有 `-b` 选项。但 dump 链路齐全：`string.dump`（`lstrlib.c:174`）→ `lua_dump`（`lapi.c:1005`）→ `luaU_dump`（`ldump.c:162`）。**结论：自写 `p8luac.c` 驱动即可。**
- **数字 = `z8::fix32`，有符号 16.16 定点，底层 int32**（`luaconf.h:574`、`fix32.h`）：加减环绕溢出；乘用 int64 定标；除饱和到 `0x7fffffff` / `0x80000001`（仿 PICO-8 的 ±∞）；`%` 恒正、`x%0==0`；`abs(0x8000)=0x7fffffff`；`^` 走 double pow；`LUA_INTEGER=int16_t`（`luaconf.h:573`，位运算/整数转换按 16 位截断）。
- **指令格式 = Lua 5.2**（op 6bit / A 8 / B 9 / C 9 / Bx 18，`lopcodes.h:38-51`），共 **53 个 opcode** = 5.2 全集 + 6 个扩展：`LSHR/ROTL/ROTR`（`>>> <<> >><`）插在 `SHR` 后，`PEEK/PEEK2/PEEK4`（`@ % $`）插在 `NOT` 与 `LEN` 之间（`lopcodes.h:199-208`）——从 `OP_UNM` 起编号比标准 5.2 偏移 +3，`OP_LEN` 起 +6。
- **dump 二进制头 18 字节**（`lundump.c:244-258`）：`\033Lua` + `0x52` + format 0 + 端序 + int/size_t/指令/number 大小 + 非整型 flag + tail。**负载不做大小端转换**（`ldump.c:26-27`），number 就是 4 字节 fix32 位模式；`sizeof(size_t)` 随 32/64 位构建变化——JS 加载器按头字节动态读即可。
- Proto 序列化顺序（`ldump.c:139-150`）：`linedefined, lastlinedefined, numparams, is_vararg, maxstacksize, code[], constants[], protos[], upvalues[], debug(source/lineinfo/locvars/upvalue names)`；常量 tag：nil=0 bool=1 number=3 string=4。
- 方言特性已全部在 lexer/parser：短 if/while（`lparser.c:1441-1450, 1287-1292`）、`?` print（`llex.c:431`）、`+=` 系（`llex.c:465-482`）、`!=`、`//` 注释、`0b` 二进制字面量、一元 `@ % $`（`lparser.c:995`）。
- `lpico8lib.c:345-372` 提供 `flr/cos/sin/atan2/shr/mid/split…`，sin/atan2 查 `trigtables.h` 位精确表；`@ % $` 在 VM 内直读 `pico8memory`（`lvm.c:221-240`，`lua_setpico8memory` API）。
- 构建：`CC=g++ -std=c++17`；本机与 WSL 均无编译器 → Phase 0 在 WSL 装 `build-essential libreadline-dev`；Windows 侧 makefile 的 readline 链接用 `MYLIBS=` 覆盖。

### 2.2 fake-08（功能清单与运行架构的参照）
- **直接解释执行源码**（z8lua 子模块），不走字节码；`__lua__` 段 → bios 里 `__z8_run_cart` 拼接 glue（`_init/_update/_draw` 循环）→ 沙盒 `load` 执行（`p8GlobalLuaFunctions.h:535-596`）。
- **帧循环 = 协程**：C 侧每帧 pcall `__z8_tick` → `coresume(__z8_loop)`；30fps 卡 glue 自动隔帧 yield；**`flip()` 是 Lua 函数**（`p8GlobalLuaFunctions.h:398-401`）= `_update_buttons(); yield()`。C 侧在 tick 之后统一 `drawFrame`。
- **76 个 C 绑定**（`vm.cpp:50-148`）+ bios Lua 函数，白名单 `__is_api`（`p8GlobalLuaFunctions.h:425-449`）。bios 源码就在 `p8GlobalLuaFunctions.h`（提取自 zepto8 `bios.p8`）——**我们的 VM 可以直接复用这份 Lua 源码，构建期编译成 bios.bc**。
- **内存 = PICO-8 官方布局**，`PicoRam.h:9-22` 注释即文档：gfx 0x0000 / map 0x2000 / gff 0x3000 / music 0x3100 / sfx 0x3200 / work 0x4300 / cartdata 0x5e00 / drawState 0x5f00 / hwState 0x5f40 / GPIO 0x5f80 / screen 0x6000；peek/poke 64KB。
- **图形**：128×128 4bpp nibble framebuffer（两像素一字节，直接落在 RAM 0x6000），pal/palt 用 16 项映射表，sprite 拷贝、sspr、tline、fillp、emoji 字体（`emojiconvision` 移植自 zepto8）。
- **输入**：held 低 6 位写 0x5f4c，btnp 长按重复 delay 15 / interval 4（0x5f5c/0x5f5d 可改）。
- **音频**：22050 Hz、4 通道混音（`Audio.cpp:578+`），music 每音符 183 samples；noise 来自 PicoLove；**官方自评不完美**。
- **卡带解析**：`.p8` 逐段（gfx 半字节交换 hex、label base32、sfx 5hex/音符）；`.p8.png` 160×205，每像素 ARGB 各取低 2 位拼 1 字节（`cart.cpp:171-176`），代码段三态解压：`\0pxa`（MTF）、`:c:\0`（legacy LUT）、明文。
- **测试**：doctest 套件（cart 解析、方言语法、peek/poke、graphics、audio 数值）——可移植断言。
- **“fake-08 程度” = 不做**：splore/BBS、v0.2.2 新特性（fill patterns/自定义字体/控制码）、完美音频、`save/export/mkdir` 等 shell 命令（stub）、eris 存档（仅 libretro 有）。

### 2.3 zepto8（卡带格式与寄存器的权威参考）
- PNG 字节流 = 连续 ROM 镜像，1 字节/像素公式 `byte=(A&3)<<6|(R&3)<<4|(G&3)<<2|(B&3)`（`cart.cpp:83-87`）；布局：`0x0000 gfx / 0x1000 gfx2·map2 / 0x2000 map / 0x3000 gff / 0x3100 music / 0x3200 sfx / 0x4300 code`；**version 字节在 0x8000**（实测 dickwave：0x8000=41 与文本卡 `version 41` 一致），0x8005-0x801F 空闲。
- label 不在字节流：可见区 (x=16..143, y=24..151)。
- `.p8` 文本段解码规则（半字节交换 gfx、sfx 20-bit 打包、music flags、label base32 `0-9a-v`）：`cart.cpp:358-516`。
- `doc/PICO-8-language.md` = 方言 EBNF；`src/pico8/memory.h:89-257` = 0x5f00-0x5f80 寄存器逐字段注释；sfx 音符位域 `key:6, instrument:3, volume:3, effect:3, custom:1`（`memory.h:36-43`）。
- 卡带里**永远是源码**（pxa 压缩），没有字节码存盘路径——我们的 `.p8c` 存字节码是本项目私有设计。

## 3. 私有格式 `.p8c` v1 规范

设计原则：**自描述、与运行时 RAM 同布局、字节码原样保存**（z8lua dump 头自带端序/字宽信息，JS 加载器按头解析，转换工具无需重序列化）。

| 偏移 | 大小 | 内容 |
|---|---|---|
| 0 | 4 | magic `P8C1` |
| 4 | 1 | 格式版本 = 1 |
| 5 | 1 | pico-8 卡带 version（如 41） |
| 6 | 4 | pico-8 minor（LE u32） |
| 10 | 1 | flags：bit0=含原始源码，bit1=含 label，其余保留 0 |
| 11 | 1 | 保留 0 |
| 12 | 4 | rom_len（LE u32，v1 恒为 0x4300） |
| 16 | rom_len | rom 镜像 0x0000–0x42FF：gfx/gfx2/map/gff/music/sfx（与 RAM 完全同偏移，加载即 `reload`） |
| +4 | 4 | code_len（LE u32） |
| +code_len | code_len | **z8lua 字节码 dump 原始字节**（含 18 字节头；已做 #include 展开与 utf8→pico8 字符集转换；保留 debug 行号信息供运行时报错） |
| +4 | 4 | label_len（LE u32，0 或 16384） |
| + | label_len | label 128×128 色号图（1 字节/像素），可选 |

- 源码（flags bit0）：原始 `__lua__` 文本，供错误对照与调试；默认保留，几 KB 可接受。
- 校验：magic/版本不符直接报错；code 必须通过 undump 全量校验。
- 不压缩 v1（整卡通常 20–40KB）；后续可加整包 deflate（flags 预留位）。

## 4. 组件设计

### 4.1 编译工具链（Phase 0 · 小）
- WSL：`sudo apt install build-essential libreadline-dev`（一次性，需用户配合输密码）。
- 构建 z8lua（git 子模块 `z8lua/` → suulnnka/z8lua `zepto8` 分支，fake-08 兼容
  修改与 `tools/` 驱动已直接提交在 fork 里；在 WSL 内操作）：
  - `make -C z8lua a MYLIBS=` 得 `liblua.a`（用 `liblua.a` 不需要 readline；顺手把 `z8lua` 解释器也构建出来，`MYLIBS=` 去掉 readline，供差分测试当基准）。
  - `g++ native/p8luac.c -I z8lua z8lua/liblua.a -o native/build/p8luac`（p8luac.c 同步副本存于子模块 `z8lua/tools/p8luac.c`）。
- `p8luac.c` 驱动（~50 行）：读 stdin 全部字节 → `luaL_loadbuffer`（错误走 stderr，带行号，exit≠0）→ `lua_dump(writer→stdout)`。**stdin/stdout 二进制管道**，Node 一次 spawn 完成，规避 WSL 路径映射与每次调用开销。
- 验收：手写一段含短 if、`+=`、`@`、`?`、二进制字面量的 PICO-8 方言源码 → 输出 dump 头 = `1b4c7561 52 00 01 04 08 04 04 00 19930d0a1a0a`（64 位构建预期）。

### 4.2 卡带转换器（Phase 1 · 中）
Node CLI：`npm run convert -- in.p8|in.p8.png [-o out.p8c] [--no-source]`
1. **输入解析**：`.p8` 文本按 zepto8 规则切段（gfx 半字节交换、gff、map 兼容重复区 OR、sfx 5hex/音符 20-bit、music flags、label base32）；`.p8.png` 用 pngjs 解码 160×205，低 2 位拼字节（`cart.cpp:83-87`），version 在 0x8000。
2. **源码解压**：代码段判魔数 `\0pxa`（MTF 解压）/ `:c:\0`（legacy LUT）/ 明文——从 zepto8 `src/pico8/code.cpp:154-308` 移植，两种格式共 ~150 行。
3. **`#include` 展开**：仿 zepto8 `preprocess_code`（`cart.cpp:528-585`），相对卡带目录递归，深度上限，防环。
4. **utf8 → pico8 字符集**：移植 fake-08 `charset` 转换（emoji 字节映射），编译前转换——与 fake-08 行为一致。
5. **编译**：spawn `wsl -d Ubuntu-26.04 -- <path>/p8luac`，管道送源码收 dump；编译错误原样带回（行号即源码行号）。
6. **拼装 `.p8c`**：按 §3 规范写出（label：文本卡直取；png 卡对 PICO-8 调色板做最近色量化，v1 可降级为不带 label）。
- 验收：zepto8/carts + fake-08/carts 的样例卡全部转换成功；资源字节与 fake-08 装载结果逐字节一致（借 doctest 断言思路）；pxa 解压以 dickwave（已验证 magic/长度）为金样本。

### 4.3 z8lua VM（Phase 2 · 大，核心工作量）
TypeScript，`src/vm/`，分四层：

**a. 加载器 `undump.ts`**
按 18 字节头读端序与 size_t 宽度，递归读 Proto（字段顺序照 `ldump.c:139-150`），常量 number 直接 `DataView.getInt32` 得 fix32 位模式，字符串按 `size_t` 含 NUL 读入。校验 opcode < 53。

**b. fix32 层 `fix32.ts`（位模式即真值）**
VM 中数字的规范表示 = **int32 原始 16.16 位模式**（`|0`）：加减天然环绕、相等/序关系天然正确、与 dump 常量零转换、表键唯一。全部运算逐条照 `fix32.h` 移植：
- `mul`：32×32→64 位用 16 位拆分在 double 里精确计算再 `>>>16`（避免 BigInt 慢）；`div`：int64 定标 + 饱和到 `0x7fffffff`/`0x80000001`；`mod` 恒正、`x%0==0`；`pow` 走 double→fix32。
- flr/ceil/abs（`0x8000` 特例）/sgn；位运算按 `luaconf.h:579-590`（注意 **int16 截断语义**）。
- 字符串↔数字按 `lobject.c` 的 `lua_strany2number`（10/16/2b 进制、fix32 小数位折入）；`tostr/tonum` 按 PICO-8 显示规则。
- **差分测试兜底**（§6）：每个运算符的边界值与原生 z8lua 对拍。

**c. 解释器 `interp.ts`（可恢复执行）**
- **显式 CallInfo 帧栈**，`execute()` 从帧栈驱动循环——这是三个需求的公共地基：① `coroutine.yield`/`flip()` 挂起（bios 胶水的核心机制）；② 每帧指令预算（防死循环卡死浏览器，超限抛 timelimit 错误，预算可配，默认 ~10M/帧）；③ 单帧内部分多次 tick 的可能。
- 挂起实现：host 函数（yield/flip/预算检查）抛 `YieldSignal`，**每一级递归 catch 后把本地 pc 存回帧再 rethrow**，到 `execute()` 顶层为止；resume 从帧栈原样继续。可变状态全部放帧对象里，JS 局部变量只作单步派生缓存。
- 53 个 opcode 全量（5.2 语义）：调用/变参/闭包/upvalue 开闭、`GETTABUP/SETTABUP`（_ENV 上值模型）、metatable 全套（`__index __newindex __call __len __concat __unm __eq __lt __le __tostring __name`）、pcall/xpcall、error + 行号栈回溯（用 dump 里的 lineinfo）。
- `PEEK/PEEK2/PEEK4`（`@ % $`）→ 经 `setPico8Memory()` 注入的 64KB 视图直读，移植 `lvm.c:221-240`（地址 `&0x7fff`，装入 fix32 整数位）。
- **coroutine 库**：create/resume/yield/status/wrap——与帧栈/挂起机制共用一套。

**d. 标准库与 API `stdlib.ts` + `core/api.ts`**
- 移植 5.2 标准库的 C 部分：base（assert/type/next/pairs/ipairs/raw*/setmetatable/getmetatable/pcall/xpcall/error/select/unpack）、string 全套（JS 移植 ~500 行，注意 Lua 用字节语义：**VM 字符串 = 码元 0–255 的 JS 字符串**，仅在显示边界转 UTF-8）、table（insert/remove/concat/sort）、coroutine。
- **不移植 math 库**（z8lua linit 不注册 math）；PICO-8 数学函数按 fake-08 分工：位精确的 `flr/ceil/cos/sin/atan2/sqrt/abs/sgn/mid/max/min/shr/…` **用 TS 移植 `lpico8lib.c` + `trigtables.h` 表**（52KB 表数据机械转换），注册进 `_G`。
- 沙盒：沿用 fake-08 模式——bios + cart 在受限 env 中执行，`__is_api` 白名单决定卡带可见名字（白名单直接从 `p8GlobalLuaFunctions.h:425-449` 抄）。
- `string.dump`、`load` 等按 fake-08 的支持程度给（load 支持从内存加载，供多段卡用）。

**bios + glue**：从 fake-08 `p8GlobalLuaFunctions.h` 提取 bios Lua 源码 → 构建期用 p8luac 编成 `assets/bios.bc` → 运行时 VM 预载。帧循环、30/60fps 判定、flip 语义、add/del/all/split 等表函数**原样跑真实 bios 代码**，与 fake-08 行为对齐且零移植成本。

### 4.4 模拟器核心（Phase 3 · 大）
`src/core/`，以 fake-08 为逐文件蓝本移植（C++→TS，机械度高）：
- **memory.ts**：`Uint8Array(0x10000)` + 各段 DataView 视图；`address_translate`（0x5f54 等重映射）；reload/copy/repeat、dget/dset（0x5e00×64）；绘制状态寄存器 0x5f00-0x5f40 与结构体字段一一对应（poke 即改寄存器，照 `PicoRam.h`）。
- **api.ts**：按 fake-08 `vm.cpp:50-148` 的 76 个绑定清单逐个实现（cls/pset/line/circ/rect/oval/spr/sspr/camera/clip/pal/palt/print/cursor/tline/fillp/btn/btnp/stat/time/music/sfx/peek/poke/memcpy/memset/reload/dget/dset/rnd/srand/run/load/…），stat 支持 fake-08 已实现的码位（0/1/2/4-8/16-26/28-34/90-95/100-102/108/120-122）。
- **graphics.ts**：128×128 nibble 帧缓冲直接写 RAM 0x6000（与 PICO-8/fake-08 同真源），精灵拷贝、sspr 缩放、tline、fillp、clip/camera、draw/screen 双调色板、16 色 PICO-8 调色板 → RGBA 转换只在上屏时做；**字体**移植 `fontdata`，emoji 双向转换移植 fake-08 版（与转换器共用映射表）。
- **input.ts**：键盘→位掩码（0⬅1➡2⬆3⬇4🅾5❎6 pause，沙盒常量来自 `p8GlobalLuaFunctions.h:483-488`），held 写 0x5f4c，btnp 复制 PICO-8 规则；鼠标 stat(30-34)。
- **audio.ts（Phase 4b）**：移植 fake-08 `Audio.cpp`+`synth.cpp`+`filter.cpp`——4 sfx 通道 + music 通道、22050Hz、每音符 183 samples、音符位域解码、7 种音效、noise 用 PicoLove 实现、简单 reverb/damp；输出 Int16 流给 **AudioWorklet**。精度目标 = fake-08（它自己也不完美）。
- **帧循环（host.ts）**：`每帧：收集按键 → VM resume(__z8_tick) → 从 RAM 取帧缓冲 → 调色板转换 → canvas 上屏 → 音频块推送`；30fps 卡由 glue 自动隔帧；`requestAnimationFrame` + 时间累加器，切后台自动暂停。

### 4.5 Web 壳（Phase 4 · 中）
- Vite + TS，单页：canvas 128×128 整数倍放大（`image-rendering: pixelated`）、全屏切换。
- 卡带载入：拖放 / 文件选择 `.p8c`；开发模式另加 `.p8` 直读（浏览器内只做明文段解析，**不做 pxa、不编译**——编译永远离线）。
- 首次交互解锁 AudioWorklet；键盘映射 + 可选手柄（标准 Gamepad API，非 fake-08 必须项）。
- 开发者面板：FPS、Lua 错误叠层（行号 + traceback）、控制台转发 print、指令预算/步进开关。

## 5. 项目结构

```
p8js/
├── PLAN.md
├── package.json / tsconfig.json / vite.config.ts
├── z8lua/                  # git 子模块：suulnnka/z8lua（zepto8 分支，含兼容修改与 tools/ 驱动）
├── native/
│   ├── p8luac.c            # stdin→stdout 字节码驱动（同步副本见 z8lua/tools/p8luac.c）
│   ├── build.sh            # WSL 内执行：make z8lua + 编译 p8luac
│   └── build/p8luac        # 产物（Linux ELF，经 wsl 调用）
├── tools/
│   ├── convert.ts          # CLI 主入口
│   ├── p8parse.ts          # .p8 文本段解析
│   ├── pngcart.ts          # 160×205 低 2 位解码（pngjs）
│   ├── pxa.ts              # \0pxa / :c:\0 解压（移植 code.cpp）
│   ├── include.ts          # #include 展开
│   └── charset.ts          # utf8 ↔ pico8（与运行时共用）
├── src/
│   ├── vm/                 # undump / fix32 / interp / table / string / coroutine / stdlib
│   ├── core/               # memory / graphics / font / emoji / input / audio / api / bios 加载
│   └── web/                # main / host / canvas / worklet
├── assets/bios.bc          # 构建期生成（提交前生成一次）
├── tests/
│   ├── differential/       # 与原生 z8lua 对拍语料
│   ├── fixtures/           # 样例卡 + 期望输出
│   └── *.test.ts           # vitest 单测
└── scripts/extract-bios.mjs # 从 fake-08 头文件提取 bios 源码
```

依赖：vite、vitest、tsx（跑 TS 版 CLI）、pngjs。无其他运行时依赖。

## 6. 测试策略（贯穿各 Phase）

1. **差分测试（VM 的生命线）**：原生 `z8lua` 解释器当基准——同一份语料（fix32 边界：溢出/除法饱和/`%`/`abs(0x8000)`/`^`/位运算 int16 语义/`@%$`；字符串/表/闭包/coroutine/metatable/错误信息），原生跑出期望文本 → 保存为金样本 → JS VM 加载同一 dump 跑出结果 → 逐字节 diff。任何语义修复都先加语料再改码。
2. **卡带解析**：移植 fake-08 `carttests` 断言；zepto8/fake-08 自带 carts 做转换冒烟；png 往返（p8→c→资源 = 原图低 2 位流）。
3. **渲染**：移植 fake-08 `graphicstests` 的像素级断言；稳定后对 3-5 张金卡做「N 帧 framebuffer hash」快照回归。
4. **端到端**：headless 跑卡 N 秒不报错 + 帧 hash 稳定；交互验收靠真实卡带（本地 zepto8/fake-08 carts + 用户自选 BBS 卡，如 Celeste Classic）。
5. 框架：vitest；可选 Playwright 做浏览器冒烟。

## 7. 里程碑

| Phase | 内容 | 体量 | 退出标准 |
|---|---|---|---|
| 0 工具链 | WSL 装编译器 → 构建 z8lua → p8luac | 小 | 方言样例编译出合法 dump，头字节符合预期 |
| 1 转换器 | .p8/.p8.png → .p8c 全流程 | 中 | 本地样例卡全部转换成功，资源逐字节核对通过 |
| 2 VM | undump → fix32 → 解释器 → stdlib → 挂起/协程 | **大** | 差分测试全绿；bios.bc 能在 VM 里加载不报错 |
| 3 核心 | memory / 76 API / 图形字体 / 输入 / bios 帧循环 | **大** | headless 跑通 3+ 张金卡，像素断言通过 |
| 4a Web 壳 | canvas / 输入 / 载入 UI / 主循环 | 中 | 浏览器里可玩第一张卡 |
| 4b 音频 | mixer 移植 + AudioWorklet | 中 | sfx/music 出声，与 fake-08 粗对拍 |
| 5 打磨 | 兼容性跑卡、性能、差距清单 | 持续 | 选定验收卡列表全部可玩；文档化已知差距 |

Phase 0→1 与 Phase 2 的 fix32/loader 部分可并行；1 与 2 的依赖点只有「dump 字节格式」，格式在 Phase 0 已冻结。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| WSL 安装需 sudo 交互 | Phase 0 第一步，用户输一次密码；WSL 若不可用则回退 `scoop install make mingw`（已具备 scoop） |
| fix32 语义细微差别（int16 截断、饱和、恒正 mod） | 差分测试语料覆盖每个运算符边界，先测后修 |
| coroutine/flip 挂起实现复杂 | 显式帧栈 + 分级 catch-rethrow 设计；**兜底方案 B**：宿主直接驱动 `_update/_draw` + 把 bios 表函数移植成 JS（工作量增加但确定性高） |
| 字符串字节语义（pico8 字符集、内嵌 NUL、>0x7F 字节） | VM 内统一 0–255 码元 JS 字符串，转换只发生在显示/输入边界；与 fake-08 对拍 emoji 往返 |
| JS 解释器性能 | switch 派发、typed array、帧预算；Phase 5 再做表数组分区、调用快路径等优化；基准卡来自验收列表 |
| 音频精度 | fake-08 自身即不完美（README 明示），移植其算法即达标；noise 已知偏差记入差距清单 |
| WSL 每次 spawn 开销 | p8luac 单次 stdin/stdout 管道调用，每卡 <1s 可接受 |

## 9. 明确不做（对齐 fake-08 范围）

- splore / BBS 下载 / 联网 / cstore / help
- v0.2.2+ 新特性：sprite fill patterns、text control codes、自定义字体
- `save/export/mkdir/dir/reboot…` 等 shell 命令（按 fake-08 方式 stub）
- eris 状态序列化存档（fake-08 也仅 libretro 有）
- 音频的高保真（reverb 精度、noise 准确性以 fake-08 为上限）
- 浏览器内直接编译 .p8（需把 z8lua 编成 WASM——列为未来项）

## 10. 未来可选（超出本计划）

- z8lua → WASM，浏览器内免转换直接跑 .p8 / .p8.png
- `.p8c` 整包压缩；存档状态（VM 帧栈 + RAM 快照）；手柄震动；多卡带管理 UI；对拍真 PICO-8 的帧级金样本（若用户有 PICO-8 可用）

