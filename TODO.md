# p8js TODO

## 1. 转换期合卡:多卡带游戏 → 单个 `.p8c`(优先级:Phase 3.5,依赖 API 层 `load/reload(fn)`)

> 背景与机制实证见 `docs/POOM多卡带实战分析.md`、`docs/多卡带与外部Lua支持调研.md`。

### 目标

多卡带游戏(POOM:28 张卡 = 1 标题 + 2 引擎 + 25 数据)在**离线转换时合并成一个文件**,浏览器端始终只加载单文件,无需实现虚拟文件系统或多文件拖放。官方多卡语义(`load` 换卡、`reload(fn)` 换数据、`cartdata` 跨卡共享)在单文件内完整保留。

设计动机:字节码化是为了**浏览器端只实现 VM 就能运行**(不引入 Lua 解析器),合卡是为了**运行与管理方便**(单文件加载/拖放/分发)。**体积不是设计目标**——不做整包压缩与去重;压缩只做**按子卡分块**(见格式),格式保持简单。

### 非目标

- 不做浏览器端多 `.p8c` 文件卡组加载(合并后无必要);
- 不做 `cstore(fn)` 持久化写回(POOM 未用;fake-08 也是 noop);
- 不做源码级重写/引擎去重(各卡字节码原样各存一份,与官方行为同构);
- 不做**整包**压缩、不做字节码内容寻址去重(e1/e2 引擎代码相同就存两份);压缩仅按语义分块(子卡 rom 一块、字节码一块),store 直存兜底。

### 格式:`.p8c` v2(magic `P8C2`,加载器向后兼容 `P8C1`)

```
P8C1 头字段不变(pico-8 version/flags/rom_len…)
+ 入口卡 rom + 入口卡字节码                  ← 现有 v1 内容,同样按块封装
+ N × 子卡记录:
    name_len + name          // 原文件名,如 "poom_6.p8"(保留原拼写)
    BLOCK: rom(0x4300)       // 块 = raw_len + comp_len + method + 数据
    BLOCK: 字节码 dump       // 无 __lua__ 段则省略
```

**分块说明**:压缩粒度 = 语义访问单元——子卡 rom 只被 `reload(fn)` 整段引用(解压到 scratch 后按地址任意拷),字节码只被 `load(fn)`/undump 整体装载,块内永不需要随机访问,分块压缩零功能代价。method:0=store 直存,1=deflate-raw;转换器对收益为负的小块自动回退 store。实测 POOM 31 块共 270KB,不劣于整包压缩(272KB);卡内再按 gfx/map/sfx 细分仅多省 1%,且 reload 全段拷贝时需拼段,不做。

### 转换器(tools/convert.ts 扩展)

1. 输入从单文件扩展为**目录**(或入口卡 + `--merge dir`):目录内每个 `.p8`/`.p8.png` 各自走现有解析→include 展开→p8luac 编译流水线;
2. **不做静态引用分析,全量打包**——POOM 的文件名是运行期拼出来的(`cart.."_"..cart_id..".p8"`,`plain.lua:9`;`_maps_group[id]..".p8"`,`title.lua:424`),静态扫描必然漏卡;
3. 名字规范化:存储原文件名(含扩展名);运行期匹配时按 zepto8 规则兜底(缺扩展名补 `.p8`,`vm.cpp:571-582`);
4. 入口卡选择:目录中带 `__label__` 或用户指定 `--entry`,默认按"被 load 最多的返回目标"启发式(POOM 即 `poom_0.p8`);
5. 警告但不失败:目录中疑似无关的 `.p8`(可 `--strict` 改为报错)。

### 运行时(src/core/api.ts + host)

- **分块解压**:载入时逐块解压(method=0 直拷;method=1 用原生 `DecompressionStream('deflate-raw')`,加载器本就是异步);子卡 rom 解压到 scratch 池(17KB × 28)供 `reload(fn)` 按地址拷贝,全量解压 <10ms,不做懒加载;

- **`load(name, msg, param)`**:name 查内嵌子卡表命中 →
  1. 重置 Lua 全局环境并装载该卡字节码,`stat(6)` 返回 param 串(下次 load 前持续可读);
  2. RAM 数据区重置为该卡 rom 镜像(等效官方换卡时的整卡 reload),绘制状态寄存器复位;
  3. **cartdata 不清**(跨卡进度的官方通道,POOM 全靠它传解锁/键位);
  4. menuitem 表清空(各卡自注册;官方还会自动加"返回上一卡"菜单项——记入差距清单,首版可不做);
- **`reload(dest, src, len, fn)`**:fn 命中子卡 → 从其 rom 拷贝,**源侧钳制 < 0x4300**(官方代码区保护,比 fake-08 更严,按引擎帮助原文实现);
- 未命中名字 → 报错并提示缺哪张卡(对齐 fake-08 整卡失败的语义,别学 zepto8 静默跳过)。

### 前置依赖(先在普通单卡上落地)

`load` + `stat(6)` + `reload(fn)` + `menuitem` 回调 + `cartdata/dget/dset` 会话级生命周期——即《POOM多卡带实战分析.md》§7 第 2 条的 API 面;`@ % $` peek 操作符 VM 侧已有规划(OP_PEEK)。

### 验收

1. POOM 28 卡目录 → 单个 `poomm.p8c`(实测参考:store 直存约 715 KB;按子卡分块 deflate 后约 270 KB/31 块;仅记录,不构成体积要求);
2. 全流程可玩:标题→选难度→episode→关卡→过关结算→下一关→gameover/retry→暂停菜单返回标题;
3. 同一会话内 cartdata 进度跨换卡保持(标题卡解锁第 2 关后引擎卡可见);
4. `mpeek` 跨卡流式读取场景(连续 reload poom_6→7→8…)在合并文件中逐字节等价;
5. 单卡游戏走原 `P8C1` 路径回归不受影响。

### 开放问题

- 官方 `load()` 是否重置 0x5f00 绘制状态/音乐状态?(POOM 跳转前手动 `sfx(-1,i)` 清声道、延迟一帧防调色板重置——`title.lua:420-425` 的注释暗示**官方 load 时调色板会被重置**;首版按"全复位"实现,列进真机验证清单);
- `.p8.png` 卡与 `.p8` 卡混装目录的文件名冲突(png 版导出名可能带版本后缀,如 BBS 的 `poom_0-9.p8.png` ≠ 代码引用的 `poom_0.p8`)——转换器需要 `--rename from:to` 映射参数。

## 2. 运行时已知问题(2026-10-22 用户浏览器实测 → **当日已修**)

> 取证、根因与修复记录见 `docs/KNOWN-GAPS.md` §6。核心/VM 层无回归,修复全部落在
> web 壳与宿主输入层;验证 = 无头驱动 + 页面内 `__p8js.tick` 确定性驱动 + 截图对照。

- [x] **浏览器丢按键边沿**(POOM"进不去地图"根因 A):宿主锁存 `kDown`/`kbDown` 直到 `_update_buttons` 消费,采样后清边沿。回归测试 `tests/host-input.test.ts`(双相位,旧实现可复现失败)。
- [x] **合并卡子卡表被丢**(POOM"进不去地图"根因 B,验证时发现):web 壳 `loadP8cFile`/`loadP8cBytes` 只传 `{bytecode,rom}`,P8C2 `subs` 没进 `Emulator.loadCart` → 浏览器里 `load()` 找不到子卡。已改为全量透传。
- [x] **鼠标支持**:canvas pointer 事件 + 128×128 坐标折算喂 `sampleInput()`(核心 stat(32-34) 原本就绪,仍受 devkitMode 门控)。
- [x] **动态画面平滑度**(蔚蓝反馈):逻辑步进从 rAF 挂钩改为独立 60Hz 墙钟定时器,速度不再绑定显示刷新率;rAF 只做 present/音频。实测页面前台 fps 62(此前 ~50)。

## 3. 待查问题(2026-10-22 用户真实浏览器复测 → **2026-10-24 已全部定位修复**,详见 docs/KNOWN-GAPS.md §7)

- [x] **渲染表现不对**:双层根因——①主循环 setTimeout 链被浏览器节流(复现 fps 5),已改 rAF + 真实增量累积;②v41+ .p8 文本压缩段解码错误导致 gfx/map 花块,转换已改为优先孪生 .p8.png(文本格式信息有损,详见 KNOWN-GAPS §7.2)。
- [x] **鼠标仍然无法使用**:stat(35-39)(官方 0.2.4 devkit 鼠标协议)未实现——POOM 菜单靠 stat(38/39) 逐帧位移。已实现 + 0x5f2d 位域门控 + host 增量锁存(tests/mouse-protocol.test.ts)。
- [x] **POOM 移动时表现不对**:7.1/7.2 的叠加 → 已用官方 standalone 包(28 张子卡源,SDK 旧格式段无歧义)重融 public/poomm.p8c,标题/菜单/换卡/引擎 3D 全流程验证通过(KNOWN-GAPS §7.4)。
- [ ] **backrooms 关卡卡**:`if cond do` 0.2.4+ 语法 z8lua 不支持(同 dead_east-0),需 p8luac 方言补丁后 merge(level+journal 两卡,见 KNOWN-GAPS §7.5);主卡 pico_backrooms 已入库 public/。
