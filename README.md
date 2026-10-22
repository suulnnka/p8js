# p8js — 网页版 PICO-8 模拟器

TypeScript 实现的 PICO-8 兼容虚拟机:卡带在离线阶段编译成私有格式 `.p8c`,浏览器拖入即玩。
**非官方项目**;"PICO-8" 商标归 Lexaloffle,本项目与之无关、未获其支持。

## 环境要求

- Node.js(建议 ≥ 20)
- 构建离线编译器需要一个 C++ 工具链(g++、make)
- 现代浏览器

## 1. 拉取子项目

```bash
git clone --recurse-submodules https://github.com/suulnnka/p8js.git
# 已克隆但子模块为空时:
git submodule update --init
```

## 2. 构建离线编译器

```bash
npm install
bash native/build.sh      # 编译出 native/build/p8luac(需 g++、make)
bash native/smoke.sh             # 验收工具链(可选)
```

## 3. 转换卡带

```bash
npx tsx tools/convert.ts path/to/game.p8 -o game.p8c      # 单卡(.p8 / .p8.png 都行)
npx tsx tools/merge.ts path/to/dir -o game.p8c            # 多卡带游戏合并
```

- 自己的卡带放进 `carts/`。

## 4. 跑

```bash
npm run dev          # → http://127.0.0.1:5173
```

把 `.p8c` 拖进页面即可。操作:方向键移动,**Z = ❎,X = 🅾**,Esc = 暂停菜单。

注意:必须走 dev server(或 `npm run build && npm run preview`),直接双击 `index.html` 会白屏。

## 其他

- 已知差距与问题:`docs/KNOWN-GAPS.md`(§6 已修,§7 待查)。
- 许可:MIT(`LICENSE`);上游移植的版权声明见 `THIRD-PARTY-NOTICES.md`。
- 设计与格式细节:`PLAN.md`;进行中/待查工作:`TODO.md`。
