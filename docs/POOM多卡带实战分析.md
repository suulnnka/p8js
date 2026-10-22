# POOM 多卡带实战分析——load/reload 换卡机制的完整样例

状态:**已完成** · 日期:2026-10-21
材料:`poom_1.9_standalone.zip`(itch 独立版)与 `poom-sdk-release_2.0.zip`(GitHub SDK 版),已解压至 `poom_study/`。
本文是《多卡带与外部Lua支持调研.md》的实战补充:POOM(@freds72 + @gamecactus)是目前能拿到的最好的多卡带机制完整样例,一次覆盖 `load(fn,param)` / `reload(fn)` / `stat(6)` / `cartdata` 跨卡共享 / `menuitem` 回调 / `@` peek 操作符。所有结论带 `file:line`(相对 `poom_study/standalone/`,另注者除外)。

---

## 1. 结论速览

1. POOM = **28 张卡**:1 张标题中枢卡(`poom_0`)+ 2 张引擎卡(`poom_e1/e2`)+ 25 张纯数据卡(`poom_1~25`)。
2. **换卡走"中枢↔引擎"往返**:`poom_0` 当调度中心;`load(卡名, nil, 参数串)` 跳转,接收方用 `split(stat(6))` 解参数——`stat(6)` 就是 `load()` 第 3 参的官方接收通道。
3. **引擎代码在每个引擎卡里各存一份**(main.lua 63KB × 2)——多卡带不共享代码,代码区(≥0x4300)受保护,每张卡必须自带全部逻辑。
4. **数据侧是本作最精彩的设计**:`reload(0,0,0x4300,"poom_N.p8")` 整段换入资源区,`mpeek()` 逐字节读、**读到 0x42ff 自动 reload 下一张卡**——反序列化器完全无感地跨卡流式读取,单个关卡的数据可以连续铺在好几张卡里。
5. **跨卡进度靠 `cartdata("poom")`**:cartdata 按 id 而非按卡持久化,标题卡写的解锁进度、键位设置,引擎卡直接 dget 读。

## 2. 发行形态:同一游戏的三种分发方式

| 渠道 | 形态 | include 状态 |
|---|---|---|
| itch(`poom_1.9_standalone.zip`) | 32 个文件:28 张 `.p8` + 4 个伴生 `.lua`(main/title/poom_atlas/plain) | **未 flatten**——PICO-8 加载 `.p8` 时从同目录现场展开 `#include` |
| GitHub(SDK 2.0) | 源码形态:`carts/` 只有 4 个 `.lua`(多一个 `lzs.lua` 压缩加载器) | 纯源码,供二次开发 |
| BBS | 每张卡各自导出 `.p8.png`(如已下载的 `carts/poom_0-9.p8.png` 即标题卡的 png 版) | **已 flatten**(png 容器必须烘焙) |

背景约束(回答"多卡/大代码为什么还能导出 png"):8192 是 **token 数**(编译期,任何格式绕不过,flatten 后合并计算);png 另有限制 = 压缩后代码 ≤ **15,616 字节**(0x4300–0x7FFF 数据区)。pxa 压缩对 Lua 源码约 40–60%,两个限制量级咬合,单卡游戏通常同时满足或退回 `.p8` 文本分发(引擎字符串 `(saving .p8 anyway)`,见前份调研附录 A)。POOM 的规模(main.lua 2113 行/63KB)已顶到单卡边缘,**多卡是它的硬需求而非风格选择**。

## 3. 卡的角色分工

| 卡 | version | 段结构 | 角色 |
|---|---|---|---|
| `poom_0.p8` | 29 | lua/gfx/gff/map/sfx/music/**label** | 标题·菜单·结算中枢;资源段兼作 0 号数据卡(actor 数据存这里) |
| `poom_e1.p8` / `poom_e2.p8` | 29 | lua/gfx/map/sfx/music | 引擎卡,每张 `#include poom_atlas.lua + plain.lua + main.lua`(整份引擎各存一份) |
| `poom_1~25.p8` | 41 | gfx/gff/map/sfx/music(**无任何 Lua**) | 纯数据卡:BSP 树、贴图、actor 打包数据 |

关卡→卡的映射全部集中在 `poom_atlas.lua:5-10`:

```lua
local mod_name,title_cart="poom","poom_0.p8"
local _maps_group=split"poom_e1,poom_e1,poom_e1,poom_e2,poom_e2,poom_e2"  -- 每关用哪张引擎卡
local _maps_cart=split"6,7,11,14,19,23"    -- 每关数据从哪张数据卡开始
local _maps_offset=split"11232,15551,10408,13277,4019,14557"  -- 起始偏移
```

即:6 个关卡(每 episode 3 关),数据分别从 poom_6/7/11/14/19/23 号卡开始,向后续卡连续延伸(见 §5 流式读取)。

## 4. 换卡机制(代码侧)

### 4.1 状态参数协议

`load()` 第 3 参是逗号串,接收方 `split(stat(6))` 解析:

```
skill, mapid, state[, level_time, kills, monsters, secrets, ammoused]
state: 0=正常启动  1=gameover  2=过关  3=retry  4=通关
```

### 4.2 五个跳转点(全部证据)

| 场景 | 位置 | 调用 |
|---|---|---|
| 标题→引擎卡 | `title.lua:424` | `load(_maps_group[id]..".p8", nil, skill..","..id)` |
| 游戏结束→标题 | `main.lua:1236` | `load(title_cart, nil, _skill..",".._map_id..",1")` |
| 重试→标题 | `main.lua:1239` | `load(title_cart, nil, _skill..",".._map_id..",3")` |
| 过关→标题(带战绩) | `main.lua:1490` | `load(title_cart, nil, _skill..",".._map_id..",2,"..t..",".._kills..",".._monsters..",".._secrets..",".._ammoused)` |
| 暂停菜单→标题 | `main.lua:1268` | `menuitem(1,"main menu", function() load(title_cart) end)` |

接收端:引擎卡 `main.lua:1273-1274`、标题卡 `title.lua:584-585` 都是 `local p=split(stat(6))` 后逐位 `tonum(p[i]) or 默认值`。标题卡拿 state=2 时先放结算画面再进下一关;最后一关打完 `mapid+1>#_maps_group` 则改 state=4 进通关(`title.lua:588`)。

### 4.3 跳转前的工程细节(`title.lua:420-425`)

- 先 `sfx(-1,i)` 清掉 4 个声道——防换卡瞬间的音频毛刺;
- 延迟一帧(`launch_ttl`)等 `_draw` 画完——注释原文:"prevent palette reset on load"(防 load 时调色板状态丢失)。

### 4.4 跨卡持久化

- 两边都调 `cartdata(mod_name)`(即 `"poom"`):标题卡 `title.lua:570`、引擎卡 `main.lua:1272`;
- 解锁进度 `dset(32, max_map_id)`(标题卡写,`title.lua:223-225`),键位 `dget(35~39)`(引擎卡读,`main.lua:1276`)——**cartdata 按 cartdata-id 持久化而非按卡**,这是多卡带共享存档的官方通道。

## 5. 多卡机制(数据侧):跨卡流式读取

`plain.lua` 全文 19 行,核心 4 步(`plain.lua:2-17`):

```lua
function decompress(cart,cart_id,mem,fn,...)
  reload(0,0,0x4300,cart.."_"..cart_id..".p8")   -- ① 整段资源区换入(代码区不动)
  mpeek=function()
    if mem>0x42ff then                            -- ② 读到卡尾:自动换下一张
      cart_id+=1; mem=0
      reload(0,0,0x4300,cart.."_"..cart_id..".p8")
    end
    local b=@mem; mem+=1; return b                -- ③ @ = PICO-8 peek 语法糖
  end
  return fn(...)                                  -- ④ 反序列化
end
```

要点:

1. `reload(0,0,0x4300,fn)` 换入的是整个 0x0000–0x42FF 资源区,当前引擎的代码区(≥0x4300)不受影响——正是官方"code section protected"的设计意图,POOM 严格没越界。
2. **`mpeek()` 把"数据横跨多张卡"这个事实彻底隐藏**:反序列化函数(`main.lua:1350-1505` 的 `unpack_*` 系列)只管逐字节读,跨卡时由 mpeek 透明续卡。单个关卡的大数据(BSP/贴图/actor)物理上连续铺在 poom_N、poom_N+1…里。
3. 两个变体:itch/GitHub 的 `plain.lua`(明文)与 SDK 的 `lzs.lua`(LZ+字典压缩,`poom_study/sdk/poom-sdk-release_2.0/carts/lzs.lua:1-20`,同样带跨卡续读)。
4. 实际调用:启动时 `decompress(mod_name, 0, 0, unpack_actors)`(`main.lua:1122`)——注意 actors 数据存在**标题卡 poom_0 自己的资源段**里(reload 不关心目标卡有没有代码);进关卡时 `decompress(mod_name, _maps_cart[_map_id], _maps_offset[_map_id], unpack_map)`(`main.lua:1126`)。

## 6. 对前份调研文档的修正

《多卡带与外部Lua支持调研.md》§2.2 要点 4 从引擎字符串表推断"**官方 Lua 无 `load`**"——**此结论错误**:

- 官方手册明确:`load(filename [, bread_msg] [, param_str])` 可在运行中的卡内调用,param_str 经 `stat(6)` 送达,且引擎自动添加"返回上一卡"菜单项;
- POOM 就是运行期 `load()` 的直接实证(§4.2 五处调用,均带运行期状态参数);
- 那条引擎 API 字符串串(`peek poke … reload cstore …`)应只是控制台补全之类的子集,不是完整 API 清单。

建议同步修正该文档 §2.2/§4 对照表,并把 `load` + `stat(6)` 加入 §5 真机验证清单与 p8js 的 API 实现范围。

## 7. 对 p8js 的落地建议

1. **把 POOM 加进 Phase 5 验收卡清单**——一张卡覆盖全部多卡机制,没有第二个这么全的公开样例。
2. **必须实现的 API 面**(当前 PLAN 均未列):`load(fn, param_str)`、`stat(6)`、带文件名 `reload(dest,src,len,fn)`、`cartdata/dget/dset` 跨卡共享、`menuitem` 回调(`main.lua:1268` 依赖)。`@ % $` peek 操作符 z8lua 已有(OP_PEEK),VM 侧照 `lvm.c` 移植即可。
3. **`.p8c` 需要"卡组"概念**:运行期 `load`/`reload` 的文件名参数要能解析到同目录的其他卡。建议:文件名基准 = 当前卡所在目录,缺扩展名补 `.p8c`(对齐 zepto8 `vm.cpp:571-582` 语义);浏览器端 = 拖放整组卡、按原名建虚拟目录。
4. **引擎代码每卡一份是常态**(POOM 两张引擎卡各内嵌 63KB 引擎):`.p8c` 转换时字节码同样逐卡重复,与官方行为同构,不必去重。
5. **数据卡没有 `__lua__` 段**(poom_1~25):转换器要接受无代码卡,`code_len=0` 或跳过编译。
6. **cartdata 生命周期 = 会话级**:`load()` 换卡不清 cartdata(POOM 依赖此行为传进度);VM 侧 cartdata 存储应挂在"卡组会话"上而非单卡。
7. itch 形态(未 flatten 的 `.p8` + 伴生 `.lua`)证明:**多文件目录分发是真实存在的形态**,转换器对整目录做 `#include` 展开(相对卡目录)必须可靠——p8js `tools/include.ts` 当前语义(zepto8 式)方向正确。

## 附录:证据索引

| 结论 | 证据 |
|---|---|
| 三类卡与段结构 | `poom_study/standalone/poom_{0,1,2,6,e1,e2}.p8` 头部与 `grep '^__'`(0/e1/e2 含 `__lua__`;1~25 纯资源段;仅 poom_0 有 `__label__`) |
| 关卡→卡映射 | `standalone/poom_atlas.lua:5-10` |
| 标题→引擎跳转 + 防毛刺/调色板 | `standalone/title.lua:420-432` |
| 引擎→标题三种状态 | `standalone/main.lua:1236,1239,1490` |
| stat(6) 参数接收 | `standalone/main.lua:1273-1274`、`title.lua:584-600` |
| 通关判定 state 2→4 | `standalone/title.lua:588` |
| 暂停菜单返回 | `standalone/main.lua:1268` |
| cartdata 跨卡 | `title.lua:570`、`main.lua:1272`、`title.lua:223-225`、`main.lua:1276` |
| 跨卡流式读取 | `standalone/plain.lua:2-17`、SDK `carts/lzs.lua:5-20` |
| 反序列化入口 | `standalone/main.lua:1122,1126`;unpack 系列 `:1350-1505` |
| load 存在于官方 Lua | 官方手册 `load(filename, param_str)` 条目 + 本文 §4.2 运行期实证 |
