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
 *     - 非令牌 border-radius 字面值、组件层硬编码 hex、间距 px 字面值的行数
 *
 *   v1.2.0 批次 1：--glass* / --modal-bg 重映射别名全部退役，引用并入死令牌 FAIL 规则。
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
  let globalScrollbarLines = 0;

  lines.forEach((line, i) => {
    const no = i + 1;
    // 1. backdrop-filter：允许 `none`/`unset` 中和写法
    if (/backdrop-filter\s*:/i.test(line) && !/backdrop-filter\s*:\s*(none|unset)/i.test(line)) {
      failures.push(`L${no} backdrop-filter 非法使用：${line.trim().slice(0, 100)}`);
    }
    // 2. 已删除令牌引用（v1.2.0 起含玻璃系别名 --glass* 与 --modal-bg）
    if (/var\(--sheen\)|var\(--shadow\)|var\(--glass[-a-z]*\)|var\(--modal-bg\)/.test(line)) {
      failures.push(`L${no} 引用已删除令牌（--sheen/--shadow/--glass*/--modal-bg）：${line.trim().slice(0, 100)}`);
    }
    // 3. 已删除装饰 keyframes
    if (/@keyframes\s+(shine|jello-press|glow-breathe)\b/.test(line)) {
      failures.push(`L${no} 已删除装饰 keyframes 复活：${line.trim().slice(0, 100)}`);
    }
    // 4. 滚动条：只允许全局块（行首直接以 ::-webkit-scrollbar 开头的规则行）
    if (/scrollbar-hide-allowed/.test(line)) { /* 豁免：功能性隐藏滚动条 */ }
    else if (/::-webkit-scrollbar/.test(line)) {
      if (/^\s*::-webkit-scrollbar/.test(line)) globalScrollbarLines++;
      else failures.push(`L${no} 滚动条局部覆写（滚动条只有全局一套规格）：${line.trim().slice(0, 100)}`);
    }
    // 5. 字号阶梯：禁止 px 直值
    if (/font-size\s*:\s*\d+(\.\d+)?px/i.test(line)) {
      failures.push(`L${no} font-size px 字面值（必须走 --fs-* 阶梯）：${line.trim().slice(0, 100)}`);
    }
    // 6. 胶囊圆角不得用于按钮类选择器（仅状态点/计数徽章可用 pill）
    if (/border-radius\s*:\s*var\(--radius-pill\)/.test(line) && /(^|\s|,)(\.btn|button)[^a-z-]/i.test(line.replace(/\{.*/, ''))) {
      failures.push(`L${no} 按钮使用胶囊圆角（操作按钮一律常规圆角）：${line.trim().slice(0, 100)}`);
    }
  });

  if (globalScrollbarLines !== 4 && globalScrollbarLines !== 5) {
    failures.push(`全局滚动条规格行数异常（${globalScrollbarLines}，应为 4-5）——可能被改动`);
  }

  // 7. 括号平衡 + 暗色块存在性（三轮教训：:root 提前闭合会让整个 dark 变量块被解析器静默丢弃）
  {
    let depth = 0;
    const src = lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const ch of src) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth !== 0) failures.push(`CSS 括号不平衡（深度 ${depth}）——规则可能被解析器整块丢弃`);
    if (!/\[data-theme="dark"\]\s*\{[^}]*--bg:/s.test(src)) failures.push('暗色主题变量块缺失或损坏');
  }

  // WARN 基线：非令牌圆角字面值行数（border-radius: <n>px 且不含 var(--radius）
  const radiusDebt = lines.filter((l) => /border-radius\s*:\s*\d/.test(l) && !/var\(--radius/.test(l)).length;
  if (radiusDebt > 0) warns.push(`非令牌 border-radius 字面值行数：${radiusDebt}（目标随模块迁移归零）`);

  // WARN 基线（v1.2.0 批次 1）：组件层硬编码 hex——剔除 :root 与 [data-theme="dark"] 两个令牌定义块后统计
  {
    const noComments = lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const componentLayer = noComments
      .replace(/(^|\n):root\s*\{[\s\S]*?\n\}/g, '$1')
      .replace(/(^|\n)\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/g, '$1');
    const hexLines = componentLayer.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l));
    if (hexLines.length > 0) warns.push(`组件层硬编码 hex 行数：${hexLines.length}（应改用语义令牌，随模块迁移归零）`);
    // WARN 基线：padding/margin/gap 的 px 字面值（未走 --sp-* 阶梯）
    const spaceDebt = componentLayer.split('\n')
      .filter((l) => /\b(padding|margin|gap)\s*:[^;]*/.test(l) && /\d+px/.test(l) && !/var\(--sp/.test(l))
      .length;
    if (spaceDebt > 0) warns.push(`间距 px 字面值行数：${spaceDebt}（应走 --sp-* 阶梯，随模块迁移归零）`);
  }

  if (failures.length) {
    console.error('[check:ui-consistency] 违例 ' + failures.length + ' 项：');
    for (const f of failures.slice(0, 20)) console.error('  ✖ ' + f);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, rules: ['no-backdrop-filter', 'no-dead-tokens', 'no-dead-keyframes', 'single-scrollbar-spec', 'font-scale-only', 'no-pill-buttons','css-brace-balance','dark-block-present'], warnBaselines: warns }, null, 2));
}

if (require.main === module) main();
module.exports = { };
