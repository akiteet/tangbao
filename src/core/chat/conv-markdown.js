'use strict';
/*
 * conv-markdown —— 会话导出 Markdown 构建（v1.2.0 批次 7 第一刀，自 ui.js 抽出的纯函数）。
 * UMD 双环境：测试 require；渲染层挂 window.App.chatMarkdown。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined' && root.window) {
    root.window.App = root.window.App || {};
    root.window.App.chatMarkdown = mod;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.App = globalThis.App || {};
    globalThis.App.chatMarkdown = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** 会话 → Markdown：一级标题为会话名，逐条 **User/Assistant:** 段落 */
  function buildConversationMarkdown(conv) {
    const c = conv && typeof conv === 'object' ? conv : {};
    let md = '# ' + (c.title || '新对话') + '\n\n';
    const messages = Array.isArray(c.messages) ? c.messages : [];
    for (const m of messages) {
      md += (m && m.role === 'user' ? '**User:**\n' : '**Assistant:**\n')
        + String((m && m.content) == null ? '' : m.content) + '\n\n';
    }
    return md;
  }

  return { buildConversationMarkdown };
});
