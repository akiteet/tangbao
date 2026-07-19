'use strict';
(function () {
  window.App = window.App || {};

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 代码高亮：有 highlight.js 则高亮，缺失/出错时降级为纯转义（graceful degradation）
  function highlightCode(code, lang) {
    const src = String(code == null ? '' : code);
    if (window.hljs) {
      try {
        if (lang && window.hljs.getLanguage && window.hljs.getLanguage(lang)) {
          return window.hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
        }
        return window.hljs.highlightAuto(src).value;
      } catch (e) { /* fall through */ }
    }
    return escapeHtml(src);
  }

  function inlineMd(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  function renderMarkdown(src) {
    const blocks = [];
    let text = String(src).replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
      const i = blocks.length;
      blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return `@@CODEBLOCK${i}@@`;
    });
    text = escapeHtml(text);
    const lines = text.split('\n');
    let html = '', inUl = false, inOl = false, inQuote = false, inTable = false;
    const closeLists = () => {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
      if (inQuote) { html += '</blockquote>'; inQuote = false; }
      if (inTable) { html += '</table>'; inTable = false; }
    };
    const flushTableRows = (rows) => {
      if (!rows.length) return '';
      let t = '<table>';
      rows.forEach((cols, ri) => {
        t += '<tr>';
        const tag = ri === 0 ? 'th' : 'td';
        cols.forEach(c => { t += `<${tag}>${inlineMd(c.trim())}</${tag}>`; });
        t += '</tr>';
      });
      t += '</table>';
      return t;
    };
    let tableRows = [];
    for (const raw of lines) {
      const cp = raw.match(/^@@CODEBLOCK(\d+)@@$/);
      if (cp) {
        if (tableRows.length) { html += flushTableRows(tableRows); tableRows = []; closeLists(); }
        else closeLists();
        const b = blocks[+cp[1]];
        html += `<pre class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(b.lang)}</span><button class="copy-btn">复制</button></div><code class="hljs">${highlightCode(b.code, b.lang)}</code></pre>`;
        continue;
      }
      // 表格行（跳过分隔行 ---）
      const tblRow = raw.match(/^\|(.+)\|$/);
      if (tblRow && !/^\|[-:| ]+\|$/.test(raw)) {
        if (!inTable) { closeLists(); inTable = true; }
        tableRows.push(tblRow[1].split('|'));
        continue;
      }
      if (inTable && /^\|[-:| ]+\|$/.test(raw)) continue; // 分隔行，跳过
      if (tableRows.length) { html += flushTableRows(tableRows); tableRows = []; closeLists(); }
      if (/^\s*$/.test(raw)) continue; // 空行不关闭列表
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeLists(); const lv = h[1].length; html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; continue; }
      if (/^---+$/.test(raw.trim())) { closeLists(); html += '<hr>'; continue; }
      const q = raw.match(/^>\s?(.*)$/);
      if (q) { if (!inQuote) { closeLists(); html += '<blockquote>'; inQuote = true; } html += inlineMd(q[1]) + '<br>'; continue; }
      const ul = raw.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + inlineMd(ul[1]) + '</li>'; continue; }
      const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + inlineMd(ol[1]) + '</li>'; continue; }
      closeLists();
      html += '<p>' + inlineMd(raw) + '</p>';
    }
    if (tableRows.length) html += flushTableRows(tableRows);
    closeLists();
    return html;
  }

  App.escapeHtml = escapeHtml;
  App.renderMarkdown = renderMarkdown;
  App.inlineMd = inlineMd;
  App.highlightCode = highlightCode;
})();
