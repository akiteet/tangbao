'use strict';
(function () {
  window.App = window.App || {};

  // 转义 HTML 特殊字符 + 引号（属性/文本两用，避免属性注入）
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 二次校验链接/资源 URL：仅允许 https:、http:、tangbao-file:、blob:、以及图片 data:（base64 附件/生成图）；
  // 禁止 javascript:/data:text/html/file:/控制字符/超长。返回 null 表示拒绝。
  function safeUrl(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.length > 2048) return null;
    if (/[\u0000-\u001F\u007F]/.test(s)) return null; // 控制字符
    if (/^https:/i.test(s)) return s;
    if (/^http:/i.test(s)) return s;
    if (/^tangbao-file:/i.test(s)) return s;
    if (/^blob:/i.test(s)) return s;
    if (/^data:image\//i.test(s)) return s; // 仅图片 data:
    return null;
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

  // 渲染流程：marked 解析 → DOMPurify 严格消毒 → 二次校验 href/src → 代码块保留复制按钮并高亮。
  // 渲染层（chat/agent/doc）把结果直接写入 .innerHTML，这里保证输出已无 XSS。
  function renderMarkdown(src) {
    const input = String(src == null ? '' : src);

    // 1) 解析：marked 默认会转义原始 HTML，从源头消除注入
    let raw;
    try {
      raw = (window.marked && typeof window.marked.parse === 'function')
        ? window.marked.parse(input, { gfm: true, breaks: true })
        : escapeHtml(input); // 库缺失时退化为纯文本
    } catch (e) {
      raw = escapeHtml(input);
    }

    // 2) 消毒：移除一切危险标签/属性/事件处理器
    let clean = raw;
    if (window.DOMPurify) {
      clean = window.DOMPurify.sanitize(raw, {
        // 显式白名单（比 USE_PROFILES 更可控）：未列出的标签一律不给，
        // 既保留 <pre>/<code>/<table> 等正常 Markdown 元素，又让 script/iframe/object 等天然不在名单。
        ALLOWED_TAGS: ['a','abbr','b','blockquote','br','code','pre','em','strong','i','u','s','del','ins','mark','p','span','h1','h2','h3','h4','h5','h6','hr','ul','ol','li','table','thead','tbody','tr','th','td','img','details','summary','figure','figcaption','sub','sup','small','kbd','cite','q','time','dl','dt','dd'],
        ALLOWED_ATTR: ['href','src','alt','title','class','id','target','rel','width','height','align','colspan','rowspan','loading','referrerpolicy'],
        // 事件处理器一律禁止（即便白名单漏了，这里也兜底拦截）
        FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover','onmouseenter','onmouseleave','onfocus','onblur','onchange','onsubmit','onpointerdown','onkeydown','onkeyup','oninput','onwheel','ondrop','ondragover','oncontextmenu'],
        // 二次校验每个 href/src：仅放行安全 scheme，否则移除该属性
        uponSanitizeAttribute: (node, data) => {
          const n = (data && data.attrName || '').toLowerCase();
          if (n === 'href' || n === 'src') {
            const ok = safeUrl(data.attrValue);
            if (!ok) { data.keepAttr = false; return data; }
            data.attrValue = ok;
          }
          // 链接强制新窗口 + 安全 rel
          if (n === 'href') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
          return data;
        },
      });
    }

    // 3) 代码块：保留复制按钮结构（兼容 chat.js 的 .copy-btn 委托），并对代码做语法高亮。
    //    在 DOMParser 内后处理，避免依赖 marked 版本特定的 renderer 签名。
    let out = clean;
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString('<body>' + clean + '</body>', 'text/html');
        doc.querySelectorAll('pre').forEach((pre) => {
          const code = pre.querySelector('code');
          if (!code) return;
          const cls = code.className || '';
          const m = /language-([\w-]+)/.exec(cls);
          const lang = m ? m[1] : '';
          const rawCode = code.textContent || '';
          const highlighted = highlightCode(rawCode, lang);
          pre.innerHTML = '<div class="code-head"><span class="code-lang">' + escapeHtml(lang) +
            '</span><button class="copy-btn" type="button">复制</button></div>' +
            '<code class="hljs">' + highlighted + '</code>';
          if (!/code-block/.test(pre.className)) pre.className = ('code-block ' + (pre.className || '')).trim();
        });
        out = doc.body.innerHTML;
      } catch (e) { out = clean; } // 解析失败则退回已消毒 HTML
    }
    return out;
  }

  // 行内 Markdown（保留给旧调用点；基于 marked 解析 + 同样消毒）
  function inlineMd(s) {
    return renderMarkdown(String(s == null ? '' : s));
  }

  App.escapeHtml = escapeHtml;
  App.renderMarkdown = renderMarkdown;
  App.inlineMd = inlineMd;
  App.highlightCode = highlightCode;
  App.safeUrl = safeUrl;
})();
