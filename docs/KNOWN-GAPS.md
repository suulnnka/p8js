# p8js 已知差距清单（KNOWN-GAPS）

对照 PLAN.md §9（明确不做）与实现过程中记录的语义差异。每条标注影响面与触发条件。更新时保持“规则 + 证据（file:line）”格式。

## 1. 对齐 fake-08 而非官方 PICO-8 的行为（by design）

- **cart 沙盒无 `error`/`pcall`**：`__is_api` 白名单（fake-08 `p8GlobalLuaFunctions.h:425-466`）不含 error/pcall/xpcall —— 与 fake-08 完全一致；卡内直接 `error()` 得 `attempt to call global 'error'`。官方 PICO-8 有 error。
- **bios 重定义 `assert`**：失败只 `print + stop()` 不抛（`p8GlobalLuaFunctions.h:133-139`）—— 测试卡的断言失败靠 printh/停机体现，不是 Lua 错误。
- **`color()` 无参 = 设 pen 6 并返回旧值**（fake-08 `picoluaapi.cpp:91-105`），与官方“读取当前色”不同。
- **btnp 重复间隔寄存器 bug**：`0x5f5d != 0` 时 interval 回退读 `0x5f5c`（delay）—— bug-for-bug 移植 `Input.cpp:36`。
- **stat 桩**：stat(0)=1、stat(1/2)=0.5、stat(4)=""、stat(7/8)=宿主 fps；音频码位齐全但依赖 mixer 状态。
- **debug 库只有 getregistry/traceback**；**eris persist/unpersist 为抛错 stub**（tick 里仅 `btnp(13)` 触发的实验分支会碰，正常卡不触发）。
- **无效/未知 UTF-8 序列按字节直通**：`fileBytesToPico8`（charset.ts，移植 fake-08 `emojiconversion.cpp:84-106` 的字节级匹配）——C2 80 这类“latin1→UTF-8 误转码”产物不会折回单字节 0x80，标识符与 png 版不同（doomy-1.p8 因此失败，见 §3）。

## 2. 架构性差异（有记录的取舍）

- **glue 在转换期拼进卡带源码**：`extract-bios.ts` 重写 bios 为单参 `load(cart_code)`，`convert.ts` 编译前 append `assets/glue.lua`。字节码无法做 `cart..glue` 字符串拼接；单 chunk 保留 local 可见语义。**影响**：旧流程（无 glue）转换的 `.p8c` 在本 VM 中没有帧循环 —— `.out/batch` 已于 2026-10-22 全量重转。
- **run()/extcmd("reset") 在 tick 边界重启**：fake-08 在调用点就地 `vm_run`；就地重启会摧毁正在执行的 JS 帧。差异窗口 = 当前 tick 剩余 Lua 语句仍会执行完。
- **`vm_peek` 的 `addr == 0x10000`**：C 版条件 `addr > 0x10000` 会越界读 1 字节（UB）；TS 钳制为 0。触发面：`peek(65536, n)` 多值读。
- **多卡 `load(name,msg,param)` / `reload(..., fn)` / cartdata 会话生命周期已实现**（Phase 3.5：`tools/merge.ts` 写 P8C2、`host.ts` applyPendingLoad/hookReload、验收 `tests/poom-merge.test.ts` 4/4）。差距：**官方换卡时自动加“返回上一卡”菜单项**未做（TODO.md §运行时，首版裁定可不做）；**cartdata 仅会话内存**（文件持久化不做，POOM 跨卡进度走 0x5e00 即可）。
- **print 控制字符 `\^` 子命令全集已移植**（print.ts），但 `?7` 音频控制、emoji 显示转换（pico8→UTF-8）留到显示边界（P4 壳目前按字节画）。
- **音频**：bass-loop 大样本对拍（audiotests.cpp:202-220，需 songtest.p8 + wav 落盘）未纳入自动化；NOISE 波形用 `Math.random()`（fake-08 用 `rand()`，同样非确定）。
- **金卡像素断言目前 4 张**（psetall/cliptest/fillptest/splittest）；fake-08 `screenshots/` 还有 ~40 张 `*_f01.png` 可按同模式加入（`tests/core-goldencart.test.ts` 的 GOLDENS）。
- **`oval`/`ovalfill` 为独立实现**(2026-10,MIT 化清理):原实现是 fake-08 的移植,而 fake-08 的椭圆算法来自 StackOverflow(CC BY-SA 3.0,其 LICENSE.MD 单列),不能随本项目以 MIT 分发。已按 J. Kennedy 中点椭圆算法的公开描述重写(未复制上游代码)。对比基准(12 组形状 × oval/ovalfill):正常尺寸的 `oval` 轮廓与旧实现**逐像素一致**;退化输入(半轴为 0/1)改为画标准线段——旧实现画出的是非线段的杂点,属上游 bug;`ovalfill` 改为扫描线填充,边缘行与旧实现差 0-2px(上游自己的测试也注明 oval 不做像素级对齐)。与 fake-08 的这一差异是**有意的**。
- **nil 操作数的报错名可能张冠李戴**：`typeError` 用 `stackSlotOf` 指针身份找寄存器（interp.ts:373-379），但 VM 里所有 nil 共享同一引用 → 命中帧内第一个 nil 槽 → 例如 doomy-1.p8 报 `local 'd'` 而实际是全局 `█`。仅影响报错文案，不影响行为。

## 3. 当前跑卡失败（scripts/run-carts.ts 120 帧 sweep）

**2026-10-22 复扫：97/100**（修复前 89/100）。已修（见 §5）。

| 卡 | 失败 | 归类 |
|---|---|---|
| dead_east-0 (.p8/.png) | 转换期 `:592 'end' expected` | 已知转换器遗留（会话裁定搁置） |
| doomy-1.p8 | line13 算术 on nil（全局 `█`=0x80） | **文件伪影**：.p8 文本被第三方 latin1→UTF-8 转码，标识符字节全变成 C2+字节两字节式；png 版为单字节且**已通过**（依赖 bios 的 `█ = 0` emoji 全局）。按 fake-08 字节直通语义这就是不同标识符 → 忠实失败；报错名与原生的差异见 §2 末条 |

## 6. 浏览器运行时问题（2026-10-22 用户实测 → 当日已修）

以下问题均为浏览器实测反馈；取证后确认核心/VM 层无回归，修复全部落在 web 壳与宿主输入层。
验证方式：无头驱动（`.out/repro3.mts`，scratch）+ 页面内 `__p8js.tick` 确定性驱动 + 截图对照。

### 6.1 蔚蓝（celeste-0）动态画面异常 → 已修（帧步进与刷新率解耦）

- **无头对照**：标题→章节转场→游戏内渲染全部正常、动画推进无 tick 错误（`cel2-f239.png`），核心层无回归。
- **根因**：`main.ts` 旧实现把逻辑步进挂在 `requestAnimationFrame` 上，固定 1/60s 累加——等效于把模拟速度绑定到显示刷新率。实测 ~50Hz 的机器上 30fps 卡变 25fps（-17%）且 1/2 步交替顿挫。
- **修复**：步进时钟改为链式 `setTimeout` 驱动的 60Hz 墙钟（累加器吸收定时器抖动，隐藏页签节流由 4 步/次的 catch-up 上限兜底），rAF 只负责 present 与音频泵送；fps 计数改显逻辑步进速率。实测页面前台 fps 62（此前 50）。

### 6.2 POOM 无法进入地图 → 已修（两个叠加的 web 壳 bug）

用户看到的"卡住"是**两个独立 bug 叠加**，分别卡在流程的不同位置：

- **Bug A：按键边沿被吞（卡在菜单确认）**。30fps 卡的 glue 每两帧才调 `_update_buttons`（`assets/glue.lua` yield 分支），浏览器壳 `edgeMask` 只有 1 帧宽，`Input.setState` 不从 kHeld 首帧补发 btnp（input.ts，framesHeld 只管 15 帧长按重复）——快速点按 ~50% 被吞，菜单 ❎ 时灵时不灵。
  **修复**：宿主层锁存边沿——`host.tick` 把 `kDown`/`kbDown` OR 进 `pendingInput`（电平字段始终取最新采样），`hookUpdateButtons` 采样后清掉已消费的边沿。60fps 卡每次 tick 都消费，行为不变。
  **回归测试**：`tests/host-input.test.ts` + 自制卡带 `tests/fixtures/btnp-edge.p8`（统计 btnp(4) 到 0x4300），在 yield 帧与采样帧两个相位各发一次 1 帧宽边沿，断言都计到（改回旧实现可复现失败，已验证测试有效）。
- **Bug B：合并卡子卡表被丢弃（卡在关卡加载）**。输入修好后流程能走到 "Entering Hangar"，但 `load()` 静默失败永远停在地图屏：web 壳的 `loadP8cFile`/`loadP8cBytes` 只把 `{bytecode, rom}` 传给 `Emulator.loadCart`，P8C2 的 `subs` 表被丢掉 → `findSub("poom_e1.p8")` 找不到子卡 → `load()` 返回 false 且无任何报错。无头测试没暴露它，因为测试直接 `emu.loadCart(file)` 传了完整 P8cFile。
  **修复**：`loadCartBytes` 改收 `CartImage | P8cFile` 全量透传（`currentCart` 仍只存 entry 的 CartImage）。
- **修复后验收**：浏览器内合成按键驱动 标题→菜单→剧集→难度→"Entering Hangar"→引擎 3D 画面（12549 非零像素、14 色、fps 59），`stat(6)` param="2,1"，无 tick 错误。调试探针 `__p8js.cartParam()/breadcrumb()` 顺带加入。

### 6.3 鼠标不可用 → 已修（web 壳接 pointer 事件）

- **现状**：核心层早已支持（stat(32/33/34)、devkitMode 门控、`Input.setMouse`），缺的只是 web 壳接线。
- **修复**：canvas 上监听 `pointermove/pointerdown`、window 上 `pointerup`，按 `getBoundingClientRect` 折算到 128×128 并钳制，喂给 `sampleInput()`；stat(34) 按钮位 left=1/right=2/middle=4；canvas 加 `touch-action: none` + 屏蔽 contextmenu（触屏拖动不滚页、右键不弹菜单）。仍受 devkitMode（`poke(0x5f2d,1)`）门控，与 fake-08 一致。
- **验证**：自制 devkit 光标卡（`.out/mousedot.p8c`），合成 PointerEvent 落点 (32,96) → 光标圆点精确出现在 (32,96)。
- **附带说明**：POOM 标题菜单本身就是鼠标+键盘双输入设计（title.lua `menu_state` 读 stat(38/39)），鼠标接通后菜单可按原设计用鼠标操作。暂停菜单不响应鼠标是 fake-08 同款行为，不在本条范围。

## 7. 待查问题（2026-10-22 用户真实浏览器复测 → **2026-10-24 已全部定位修复**）

§6 的修复在合成输入/无头驱动下验证通过后，用户在**真实浏览器**复测仍报告以下三个问题。
2026-10-24 复查：三个问题同根，分两层。

### 7.1 帧时钟依赖 setTimeout 链 → 已修（rAF + 真实增量累积）

- **现象**：所有卡带（含 demo）画面渲染不及预期。复现：集成浏览器里 stats 显示
  **fps 5**（应 60）——逻辑步进挂在链式 `setTimeout` 上，被浏览器计时器节流直接打塌
  （occluded webview/后台标签/节能策略下钳到 ~1Hz，catch-up 上限 4 步/次 → 4-5fps）。
- **连带 bug**：`pumpAudio()` 每次 rAF 固定产 `AUDIO_RATE/60` 样本——音频速度绑定刷新率
  （50Hz 屏慢 17% 且持续欠载，144Hz 屏快 2.4 倍）。
- **修复**（main.ts）：整个主循环挂回 rAF，用**真实帧间隔**做累加器（步进均速 60/s，
  与刷新率无关——§6.1 的旧问题是"每 rAF 固定 1/60s"，不是 rAF 本身）；音频按真实时间
  泵送；250ms dt 钳制 + 8 步 catch-up 上限；标签隐藏即暂停（与真机行为一致）。
- **验证**：Node harness 实测每 tick 0.2ms（VM 性能无碍）；132/132 测试过。

### 7.2 .p8 文本（v41+）压缩数据段解码错误 → 已修（转换优先 .p8.png）

- **现象**：蔚蓝等带图形数据的卡进入游戏后满屏花块（瓦片行错位）。无头帧序列截图对照
  确认 framebuffer 本身就是花块，而**同卡的 .p8.png 渲染完全正确**。
- **根因**：version 41+ 的 .p8 文本对 gfx/gff/map/sfx 段使用变长十六进制压缩
  （0→"0"，<0x10→1 字符，≥0x10→2 字符 MSB 在前；官方 wiki "P8FileFormat" 记载）。
  该编码**反向解析本质上信息有损**：文本 "80" 既可以编自 [0x80] 也可以编自
  [0x08, 0x00]（celeste 真实数据中两种都出现）。已严格证明：enc(png 字节) 与文本
  逐字节全等（8192/8192），且把 128 字节行的全部合法解析数出来是 2.7e16 种——
  任何局部规则都无法唯一还原。p8js 旧解码器（定长 hex 对 + gfx 半字节交换）是
  旧版格式假设，对 v41+ 从第一个非零字节起就错位。
- **修复**（tools/convert.ts）：转换时若 .p8 孪生 **.p8.png 存在则优先使用**
  （BBS 播放器与 pico-ios 均运行 .p8.png；两者 lua 完全一致，仅资源 ROM 编码不同）。
  控制台打印提示。批转 27 卡全过（dead_east-0 为 §3 既有语法问题，无关）。
- **验证**：浏览器实测 PNG 路径蔚蓝进游戏后画面完美（雪地/岩石/角色/浆果与真机一致）。
- **残留限制**：仅有 .p8 无 .png 的 v41+ 卡，gfx/map/sfx 数据段仍可能错位（信息已丢失，
  任何解码器都无法还原）；此类卡建议用真机另存 .p8.png。sfx/music 段的压缩结构
  （非 128 字节行）尚未完全破解，同受此限。

### 7.3 鼠标仍不可用 → 已修（stat 35-39 缺失）

- **根因**：VM 只实现 stat(32/33/34)（绝对坐标/按键）。官方 0.2.4 的 devkit
  鼠标协议还有 stat(35)（横向滚轮 px）、36（滚轮事件 1/0/-1）、37（点击加速）、
  **38/39（逐帧相对位移，宿主桌面像素）**——POOM 标题菜单靠 stat(38/39) 累加
  光标位置（`mouse_x=mid(mouse_x+stat(38)/mouse_acc,…)`），stat 恒 0 → 鼠标完全
  不动。fake-08 也没实现 35-39（其 stat 只到 34），p8js 照抄导致与官方行为有差距。
- **修复**：①0x5f2d 改为**位域**门控（0x1=enable、0x2=鼠标键映射 btn(4..6)、
  0x4=指针追踪，POOM poke(0x5f2d,7)=全开；fake-08 只判 !=0）；②实现 stat(35-39)；
  ③host 层按 `_update_buttons` 采样消费增量（30fps 卡 yield 帧不丢，与 §6.2 按键
  边沿锁存同构）；④web 壳收集指针位移/滚轮/点击。
- **验证**：新增 `tests/mouse-protocol.test.ts`（fixture 卡带断言 stat(38/39/34/36)
  与 btnp(4) 两个 glue 相位都送达）；浏览器实测真实鼠标移动驱动光标 (64,64)→
  (125,125)（累加触界），POOM 式累计语义成立。

### 7.4 POOM 移动表现 → 已修（2026-10-24 重融 + 全流程验证）

用户提供了官方 `poom_1.9_standalone.zip`（28 张子卡源）。关键发现：**子卡是 SDK 打包器
写出的旧版固定格式段**（gfx 128 字符/行=128 像素、map 256 字符/行，无压缩歧义），
现有解码器即可正确处理（poom_0 为 v29，1~25 数据卡为 v41 头+旧格式段）。
重融：`npx tsx tools/merge.ts .out/poom-src -o public/poomm.p8c --entry poom_0.p8`
（28 卡 284KB，含 main/plain/poom_atlas/title .lua 的 #include 展开）。
验证：无头+浏览器双路——标题屏（logo/骷髅/菜单）完美、Z 键 select→levels→skills→
launch、`load("poom_e1.p8",nil,"2,1")` 换卡成功（stat(6)="2,1"）、引擎 3D 画面
（走廊透视/霰弹枪/HUD）正确、90 帧无错、fps 60。

### 7.5 新增已知差距：z8lua 不支持 0.2.4+ `if cond do` 语法

backrooms 关卡卡（version 43）用 `if o==k_floor or o==k_wall do ... end`，
z8lua 编译报 `'end' expected (to close 'do' ...)`——与 dead_east-0（§3）同类。
主卡 pico_backrooms 正常（public/pico_backrooms.p8c）；5 张关卡卡转换失败，
需给 p8luac 打 if-do 方言补丁（或转换期源码改写为 `then`）后再 merge
（各关卡卡 `load("br_journal_06.p8")`，需与 journal 两卡合并）。

## 5. 已修复（2026-10-22，sweep 89→97）

- **poke 值语义**（api.ts:119-130）：原来拿 fix32 **位型** `luaNum(v) & 0xff` 写入 —— 任何整数 poke 都写 0（`17<<16 & 0xff = 0`）。改为 `cint(v) & 0xff`（fake-08 `uint8_t val = lua_tonumber`，picoluaapi.cpp:1120-1129 的值语义）。**连带效应**：所有依赖 poke 的卡（POOM unpack_gfx、`poke(0x5f2d,…)` 等）此前全部静默写 0。
- **字符集转换双编码**（p8.ts:201 / include.ts:22 / pngcart.ts:63 → `fileBytesToPico8`）：原调用把 latin1 字节串直接喂 `utf8ToPico8`（内部 `Buffer.from(str,"utf8")` 二次编码高位字节）→ 字节表全 miss、每个高位字节膨胀成 2 个。改为字节级匹配（charset.ts `bytesToPico8`）。**POOM 标题屏黑屏的根因之一**（title_gfx.bytes 字符串膨胀 19240→30186 字节、内容错位）。
- **POOM 合卡验收 4/4**（tests/poom-merge.test.ts）：28 卡合并 284KB、标题 120 帧渲染 7146 非零像素、title→engine `load("poom_e1.p8",…,"2,1")` 跳转后引擎 90 帧无错、cartdata 跨卡保持。注意**难度参数必须 1..4**：main.lua:2080 `flags & (0x10 << (_skill-1))` 用 skill 过滤 thing，skill=0 时掩码错位把包括玩家在内的所有 thing 滤光 → `_plyr` nil 崩溃（测试原传 "0,1,0" 是错的）。
- **nested_env `(for state)`**：fake-08 的 z8lua 在 `OP_GETTABUP` 有**沙盒 fallback**（其 lvm.c 注释点名 Ex-Terra 的 `draw_gbullets_old`——`_ENV` 局部覆盖后 API 名仍从 `registry["__PICO8_SANDBOX"]` 解析）。移植时**只启用 GETTABUP 侧**；GETTABLE 侧若启用会污染普通表字段的 nil 探测（pigments 的 `if e.pcol then` 捞到同名全局 → 死循环，实测），故撤回——记为与 fake-08 的有意差异。
- **ord(nil) / split()**：对齐 fake-08 的宽容版（`libs/z8lua/lpico8lib.c:289/320`）——ord 首参 none/nil/不可转 → 返回 nil；split 无参 → 无结果。上游 z8lua 是 checklstring 抛错。
- **无循环卡 tick 返回 -1**：bios 对"协程干净跑完（dead）"与"错误（先 printh）"都回 -1。现在只有 printh 消息才算失败；干净 -1 视为正常跑完（PICO-8 语义=停在末帧）。
- **浏览器竞态**：web 壳未载卡不 tick（防 bios 未就绪时的假死冻结）；`__p8js.loadP8cBytes` 返回 `{loaded,msg}` 明确成败。

## 4. 明确不做（PLAN §9 沿用）

splore/BBS 联网、v0.2.2+ 新特性（fill patterns/自定义字体/控制码的官方扩展面）、shell 命令（save/export/mkdir/dir）、eris 状态序列化、浏览器内编译 .p8（WASM 化 z8lua 列为未来项）、音频高保真（reverb/noise 以 fake-08 为上限）。
