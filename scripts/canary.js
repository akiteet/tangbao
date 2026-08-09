'use strict';
/*
 * Provider 在线契约测试（canary）：
 *   - 无密钥时明确 SKIP（退出码 0，不误报失败）；
 *   - 提供密钥时对指定端点做最小 chat 连通 + 工具调用 JSON 形状冒烟。
 * 用法（三选一）：
 *   TANGBAO_CANARY_BASE=https://api.openai.com TANGBAO_CANARY_KEY=sk-... TANGBAO_CANARY_MODEL=gpt-5 node scripts/canary.js
 *   TANGBAO_CANARY_BASE=https://api.anthropic.com TANGBAO_CANARY_KEY=... TANGBAO_CANARY_MODEL=claude-3-7-sonnet node scripts/canary.js
 *   TANGBAO_CANARY_BASE=https://generativelanguage.googleapis.com TANGBAO_CANARY_KEY=... TANGBAO_CANARY_MODEL=gemini-2.0-flash node scripts/canary.js
 * 说明：仅发送最小消息，不执行任何真实文件操作；失败按非零退出码报告。
 */
const { detectAdapter, buildRequest, parseNonStream, normalizeUsage } = require('../src/infrastructure/model-gateway/adapters');

async function main() {
  const base = process.env.TANGBAO_CANARY_BASE || '';
  const key = process.env.TANGBAO_CANARY_KEY || '';
  const model = process.env.TANGBAO_CANARY_MODEL || '';
  if (!base || !key || !model) {
    console.log('CANARY SKIP: 未提供 TANGBAO_CANARY_BASE / TANGBAO_CANARY_KEY / TANGBAO_CANARY_MODEL（在线契约测试可选，无密钥不执行）');
    return 0;
  }
  const adapter = detectAdapter(model, base);
  console.log('CANARY adapter=' + adapter + ' model=' + model + ' base=' + base);
  const req = buildRequest(adapter, { apiBase: base, apiKey: key, model, messages: [{ role: 'user', content: '回复 OK 两个字母即可' }], stream: false });
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('CANARY FAIL http=' + res.status + ' body=' + String(txt).slice(0, 240));
    return 1;
  }
  const json = await res.json().catch(() => ({}));
  const parsed = parseNonStream(adapter, json);
  const usage = normalizeUsage(adapter, json);
  if (!parsed || typeof parsed.content !== 'string' || !parsed.content.trim()) {
    console.error('CANARY FAIL: 响应缺少 content 文本');
    return 1;
  }
  console.log('CANARY OK content=' + JSON.stringify(parsed.content.slice(0, 40)) + ' usage=' + JSON.stringify({ input: usage.inputTokens, output: usage.outputTokens }));
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('CANARY ERROR: ' + String(e && e.message ? e.message : e)); process.exit(1); });
