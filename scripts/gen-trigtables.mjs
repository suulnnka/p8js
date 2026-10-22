// gen-trigtables.mjs — 解析 native/build/z8lua/trigtables.h 中的数组字面量，
// 生成 src/vm/trigtables.ts。可重复执行（幂等），并内置全量验证。
//
// 用法: node scripts/gen-trigtables.mjs [--check]
//   --check  只验证（重新解析头文件 + 解析已生成的 TS 文件，逐值对比），不写文件

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HEADER_PATH = path.join(root, 'native', 'build', 'z8lua', 'trigtables.h');
const OUT_PATH = path.join(root, 'src', 'vm', 'trigtables.ts');

// ---------- 解析 C 头文件 ----------

/**
 * 解析 trigtables.h，返回 [{ name, cType, values: number[] }]
 * 值按 C 语义解释：十六进制/十进制字面量的无符号数值。
 */
function parseHeader(text) {
  // 先剥掉 // 注释，避免注释里的示例代码（如 '0x'..sub(...)）被当成数据
  const stripped = text.replace(/\/\/[^\n]*/g, '');
  const tables = [];
  const declRe = /static\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\[\s*\]\s*=\s*\{/g;
  let m;
  while ((m = declRe.exec(stripped)) !== null) {
    const cType = m[1];
    const name = m[2];
    const bodyStart = declRe.lastIndex;
    const close = stripped.indexOf('}', bodyStart);
    if (close < 0) throw new Error(`table ${name}: missing closing brace`);
    const body = stripped.slice(bodyStart, close);
    declRe.lastIndex = close + 1;

    const values = [];
    const numRe = /0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let consumed = 0;
    let nm;
    while ((nm = numRe.exec(body)) !== null) {
      // 数字之间只允许逗号/空白
      const gap = body.slice(consumed, nm.index);
      if (!/^[\s,]*$/.test(gap)) {
        throw new Error(`table ${name}: unexpected content between values: ${JSON.stringify(gap)}`);
      }
      values.push(Number(nm[0]));
      consumed = numRe.lastIndex;
    }
    const tail = body.slice(consumed);
    if (!/^[\s,]*$/.test(tail)) {
      throw new Error(`table ${name}: unexpected trailing content: ${JSON.stringify(tail)}`);
    }
    if (values.length === 0) throw new Error(`table ${name}: no values parsed`);
    tables.push({ name, cType, values });
  }
  if (tables.length === 0) throw new Error('no array tables found in header');
  return tables;
}

// ---------- 选类型：整数且在 int32 范围内 → Int32Array，否则 Float64Array ----------

function pickArrayType(values) {
  const allInt = values.every(Number.isInteger);
  const inInt32 = values.every((v) => v >= -2147483648 && v <= 2147483647);
  return allInt && inInt32 ? 'Int32Array' : 'Float64Array';
}

function formatValue(v, arrayType) {
  if (arrayType === 'Int32Array' && v >= 0) {
    // 保留头文件的十六进制定标，便于人工比对
    return '0x' + v.toString(16).padStart(4, '0');
  }
  return String(v);
}

// ---------- 生成 TS 模块 ----------

function generateModule(tables) {
  const lines = [];
  lines.push('// 由 scripts/gen-trigtables.mjs 生成，勿手改');
  lines.push('// 源文件: native/build/z8lua/trigtables.h');
  lines.push('// 重新生成: node scripts/gen-trigtables.mjs');
  lines.push('//');
  lines.push('// 索引方式与 C 版 lpico8lib.c 一致:');
  lines.push('//   sintable[a >> 2]   — a 为 PICO-8 定点角的低 14 位 (见 sin_helper)');
  lines.push('//   atantable[q >> 5]  — q = (|y|<<16)/|x| 或 (1<<32)/q >> 5 (见 pico8_atan2)');
  lines.push('');

  const exported = [];
  for (const t of tables) {
    const arrayType = pickArrayType(t.values);
    lines.push(`/** \`${t.cType} ${t.name}[]\` — ${t.values.length} entries from trigtables.h */`);
    lines.push(`export const ${t.name} = new ${arrayType}([`);
    const perLine = 8;
    for (let i = 0; i < t.values.length; i += perLine) {
      const chunk = t.values.slice(i, i + perLine)
        .map((v) => formatValue(v, arrayType))
        .join(', ');
      const comma = i + perLine < t.values.length ? ',' : '';
      lines.push(`    ${chunk}${comma}`);
    }
    lines.push(']);');
    const sentinelNote = t.name === 'sintable'
      ? ' // 4096 (trigtables.h) + [4096] sentinel 0x1b01 (frozen z8lua OOB, see main())'
      : '';
    lines.push(`export const ${t.name}Length = ${t.values.length};${sentinelNote}`);
    lines.push('');
    exported.push({ ...t, arrayType });
  }

  // 汇总表：便于运行时按名查表/长度
  lines.push('/** 按表名汇总（长度常量见各表旁的 *Length 导出） */');
  lines.push('export const trigTables = {');
  for (const t of exported) {
    lines.push(`  ${t.name},`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push(`/** 全部表的值总数 */`);
  const total = exported.reduce((n, t) => n + t.values.length, 0);
  lines.push(`export const TRIG_TABLE_TOTAL_VALUES = ${total};`);
  lines.push('');
  return lines.join('\n');
}

// ---------- 从生成的 TS 文件里把数组解析回来（用于独立验证） ----------

function parseGenerated(text) {
  const tables = [];
  const re = /export const ([A-Za-z_]\w*) = new (Int32Array|Float64Array)\(\[([\s\S]*?)\]\);/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[3];
    const values = (body.match(/0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?/g) || []).map(Number);
    tables.push({ name: m[1], arrayType: m[2], values });
  }
  if (tables.length === 0) throw new Error('no arrays found in generated file');
  return tables;
}

// ---------- 验证 ----------

function verify(headerTables, generatedTables) {
  const byName = new Map(generatedTables.map((t) => [t.name, t]));
  let total = 0;
  const problems = [];
  for (const ht of headerTables) {
    const gt = byName.get(ht.name);
    if (!gt) {
      problems.push(`missing table ${ht.name} in generated output`);
      continue;
    }
    if (gt.values.length !== ht.values.length) {
      problems.push(`${ht.name}: length mismatch header=${ht.values.length} generated=${gt.values.length}`);
      continue;
    }
    for (let i = 0; i < ht.values.length; i++) {
      if (gt.values[i] !== ht.values[i]) {
        problems.push(`${ht.name}[${i}]: header=${ht.values[i]} generated=${gt.values[i]}`);
        if (problems.length > 10) break;
      }
      total++;
    }
  }
  for (const gt of generatedTables) {
    if (!headerTables.some((ht) => ht.name === gt.name)) {
      problems.push(`extra table ${gt.name} in generated output`);
    }
  }
  return { ok: problems.length === 0, total, problems };
}

// ---------- 主流程 ----------

// sin_helper 可以取到 a>>2 == 4096（低 14 位全 1 时 +2 进位），C 头文件只有
// 4096 项 — 原生 z8lua 越界读到 .rodata 里的 0x1b01（已用 nm+ELF 直读
// native/build/z8lua/z8lua 验证：cos(0) = 0x0001.1b01）。为对拍冻结二进制
// 的既成行为，解析头文件时统一补上第 4097 项哨兵值。
function parseHeaderWithSentinel(text) {
  const tables = parseHeader(text);
  const st = tables.find((t) => t.name === 'sintable');
  if (st && st.values[st.values.length - 1] !== 0x1b01) {
    st.values.push(0x1b01);
  }
  return tables;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const headerText = fs.readFileSync(HEADER_PATH, 'utf8');
  const headerTables = parseHeaderWithSentinel(headerText);

  const headerTotal = headerTables.reduce((n, t) => n + t.values.length, 0);
  const summary = headerTables
    .map((t) => `${t.name}[${t.values.length}] (${pickArrayType(t.values)}, min=${Math.min(...t.values)}, max=${Math.max(...t.values)})`)
    .join(', ');

  if (checkOnly) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`FAIL: ${OUT_PATH} does not exist (run without --check first)`);
      process.exit(1);
    }
    const genTables = parseGenerated(fs.readFileSync(OUT_PATH, 'utf8'));
    const r = verify(headerTables, genTables);
    if (!r.ok) {
      console.error('FAIL:');
      for (const p of r.problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log(`验证通过: 全部 ${r.total} 个值一致 (${summary})`);
    return;
  }

  const output = generateModule(headerTables);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  // 验证 1: 生成文本内的值 vs 头文件解析值
  const r1 = verify(headerTables, parseGenerated(output));
  if (!r1.ok) {
    console.error('FAIL (in-memory verification):');
    for (const p of r1.problems) console.error('  ' + p);
    process.exit(1);
  }

  // 写盘（幂等：内容不变则不改 mtime 也没关系，内容本身是确定性的）
  const prev = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : null;
  fs.writeFileSync(OUT_PATH, output, 'utf8');
  const digest = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
  const idempotent = prev === null ? '(new file)' : (prev === output ? 'yes (unchanged)' : `changed (was ${digest(prev)} -> now ${digest(output)})`);

  // 验证 2: 重新解析头文件 + 重新读取落盘文件，独立逐值对比
  const headerTables2 = parseHeaderWithSentinel(fs.readFileSync(HEADER_PATH, 'utf8'));
  const genTables2 = parseGenerated(fs.readFileSync(OUT_PATH, 'utf8'));
  const r2 = verify(headerTables2, genTables2);
  if (!r2.ok) {
    console.error('FAIL (post-write verification):');
    for (const p of r2.problems) console.error('  ' + p);
    process.exit(1);
  }

  console.log(`生成: ${path.relative(root, OUT_PATH)}`);
  console.log(`表: ${headerTables.length} 张 (${summary})`);
  console.log(`幂等: ${idempotent}`);
  console.log(`验证: 全部 ${r2.total} 个值一致`);
}

main();
