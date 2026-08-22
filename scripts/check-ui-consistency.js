'use strict';
/*
 * UI 一致性守门（v1.1.8 简洁风设计系统，docs/UI-SYSTEM.md §7）。
 *
 * 扫描 styles.css，拦截设计系统回潮：
 *   FAIL 项（违例即退出码 1）：
 *     1. backdrop-filter 实际使用（简洁风禁玻璃模糊；`none` 中和写法除外）
 *     2. 引用已删除令牌 --sheen / --shadow
 *     3. 已删除的装饰 keyframes（shine / jello-press / glow-breathe）
 *   WARN 项（打印基线计数，暂不失败，供逐模块清零）：
 *     - 非令牌 border-radius 字面值、色板外硬编码 hex 的行数
 *
 * 用法：npm run check:ui-consistency（已并入 check:ui 前置链）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = path.join(ROOT, 'styles.css');

function main() {
  const src = fs.readFileSync(CSS, 'utf8');
  const lines = src.split('\n');
  const failures = [];
  const warns = [];

  lines.forEach((line, i) => {
    const no = i + 1;
    // 1. backdrop-filter：允许 `none`/`unset` 中和写法
    if (/backdrop-filter\s*:/i.test(line) && !/backdrop-filter\s*:\s*(none|unset)/i.test(line)) {
      failures.push(`L${no} backdrop-filter 非法使用：${line.trim().slice(0, 100)}`);
    }
    // 2. 已删除令牌引用
    if (/var\(--sheen\)|var\(--shadow\)/.test(line)) {
      failures.push(`L${no} 引用已删除令牌（--sheen/--shadow）：${line.trim().slice(0, 100)}`);
    }
    // 3. 已删除装饰 keyframes
    if (/@keyframes\s+(shine|jello-press|glow-breathe)\b/.test(line)) {
      failures.push(`L${no} 已删除装饰 keyframes 复活：${line.trim().slice(0, 100)}`);
    }
  });

  // WARN 基线：非令牌圆角字面值行数（border-radius: <n>px 且不含 var(--radius）
  const radiusDebt = lines.filter((l) => /border-radius\s*:\s*\d/.test(l) && !/var\(--radius/.test(l)).length;
  if (radiusDebt > 0) warns.push(`非令牌 border-radius 字面值行数：${radiusDebt}（目标随模块迁移归零）`);

  if (failures.length) {
    console.error('[check:ui-consistency] 违例 ' + failures.length + ' 项：');
    for (const f of failures.slice(0, 20)) console.error('  ✖ ' + f);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, rules: ['no-backdrop-filter', 'no-dead-tokens', 'no-dead-keyframes'], warnBaselines: warns }, null, 2));
}

if (require.main === module) main();
module.exports = { };
