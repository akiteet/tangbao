'use strict';
// Markdown 渲染安全面回归（v1.2.0 批次 2：vm 沙箱加载 markdown.js，无 marked/DOMPurify 时走降级路径）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'src/renderer/components/markdown.js'), 'utf8');

/** 无第三方库（marked/DOMPurify/hljs）的沙箱：验证降级与纯函数安全面 */
function load() {
  const context = { window: {}, console };
  context.window = context;
  vm.runInNewContext(src, context, { filename: 'markdown.js' });
  return context.window.App;
}

test('escapeHtml 覆盖全部危险字符（文本/属性两用）', () => {
  const App = load();
  assert.equal(App.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(App.escapeHtml("it's a & b<c>"), 'it&#39;s a &amp; b&lt;c&gt;');
  assert.equal(App.escapeHtml(null), 'null', 'null 按 String(null) 处理不抛错');
});

test('safeUrl 白名单：常规协议放行，javascript:/data:text/html/控制字符/超长拒绝', () => {
  const App = load();
  assert.equal(App.safeUrl('https://a.com/x'), 'https://a.com/x');
  assert.equal(App.safeUrl('http://a.com'), 'http://a.com');
  assert.equal(App.safeUrl('tangbao-file://f/1'), 'tangbao-file://f/1');
  assert.equal(App.safeUrl('blob:abc'), 'blob:abc');
  assert.equal(App.safeUrl('data:image/png;base64,iVBOR'), 'data:image/png;base64,iVBOR');
  assert.equal(App.safeUrl('javascript:alert(1)'), null);
  assert.equal(App.safeUrl('JAVASCRIPT:x'), null, '大小写变体不得绕过');
  assert.equal(App.safeUrl('data:text/html,<script>1</script>'), null);
  assert.equal(App.safeUrl('ht\u0000tp://x'), null, '控制字符拒绝');
  assert.equal(App.safeUrl('https://' + 'a'.repeat(2100)), null, '超长拒绝');
  assert.equal(App.safeUrl(42), null);
});

test('renderMarkdown 无 marked 时降级为全转义：脚本注入被中和', () => {
  const App = load();
  const out = App.renderMarkdown('# 标题\n<script>alert(1)</script>');
  assert.ok(!/<script>/i.test(out), '输出不得包含未转义 script 标签');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('highlightCode 无 hljs 时降级为纯转义', () => {
  const App = load();
  const out = App.highlightCode('<b>code</b>', 'js');
  assert.equal(out, '&lt;b&gt;code&lt;/b&gt;');
});
