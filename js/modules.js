'use strict';
(function () {
  window.App = window.App || {};

  // 内置模块注册表：新增模块只需在此追加一项，无需改 index.html / router。
  const BUILTIN_MODULES = [
    { id: 'chat', label: '糖包', icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 5h16v11H8l-4 4V5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' },
    { id: 'image', label: '糖绘', icon: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M5 18l5-5 4 4 3-3 2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' },
    { id: 'doc', label: '糖读', icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 3h8l4 4v14H6V3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' },
    { id: 'create', label: '糖创', icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3l2.4 5.2L20 9l-4 4 1 6-5-2.8L7 19l1-6-4-4 5.6-.8L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' },
    { id: 'agent', label: '糖码', icon: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 9l3 3-3 3M13 15h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  ];
  const DEFAULT_ICON = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  // 把用户填写的「网址」归一化为可加载的 URL。
  // 关键点：本地文件最容易被填成 Windows 绝对路径（C:\...）或 Unix 路径（/...），
  // 若不处理，iframe/webview 会把它当成相对地址 http://localhost:4280/C:\... 而加载失败（显示不全/拒绝连接）。
  function normalizeUrl(raw) {
    if (!raw) return raw;
    let s = String(raw).trim();
    if (!s) return s;
    if (/^(https?:|file:)/i.test(s)) return s;           // 已是标准协议，原样返回
    if (/^[A-Za-z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/'); // C:\a 或 C:/a
    if (/^\//.test(s)) return 'file://' + s.replace(/\\/g, '/');              // /a/b 绝对路径
    // 其余（./x.html、相对片段）：尽力当成本地文件
    return 'file:///' + s.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  // 把 file:// 绝对路径转成「经本地 HTTP 服务提供的同源 URL」，规避 file:// 的 CORS 限制。
  // 例如 file:///C:/a/b.html -> http://localhost:4280/__local/C%3A%2Fa%2Fb.html
  // 这样本地 HTML 内的 ES Module(type=module) / fetch / 相对资源都能在同源 http 下正常加载，整屏渲染。
  // 注意：file:/// 有「三」个斜杠（file: + // + /C:），必须用 URL API 取 pathname 再去掉前导斜杠，
  // 不能简单 replace(/^file:\/\//)（那只去两个斜杠，会残留前导 "/" 导致路径错乱 → 404）。
  function fileUrlToLocalHttp(fileUrl) {
    const u = new URL(String(fileUrl || ''));
    let p = u.pathname || ''; // file:///C:/a/b.html -> /C:/a/b.html
    if (p.startsWith('/')) p = p.slice(1); // 去掉前导斜杠 -> C:/a/b.html（避免 /C: 被当成根路径）
    // 关键：按「路径段」逐段编码，保留 / 作为分隔符。
    // 若整体 encodeURIComponent，/ 会变成 %2F 被浏览器当成单一段，
    // 导致页面内相对资源 style.css 解析成 /__local/style.css（丢失 C:/a/ 部分）而 400 → CSS/JS 没加载 →
    // 本地页无样式、全屏 .overlay 覆盖层盖住正文（"下面被挡"）。
    // 逐段编码后：C:/a/b.html -> C%3A/a/b.html，相对 style.css -> C%3A/a/style.css，服务端可正确还原。
    const seg = p.split('/').map(s => encodeURIComponent(s)).join('/');
    const origin = (window.location && window.location.origin) || 'http://localhost:4280';
    return origin + '/__local/' + seg;
  }

  // 自定义模块 iframe/webview 缓存：按模块 id 复用同一 DOM 节点，切换时只切换显示，避免每次重载整页
  const customFrames = new Map(); // id -> <iframe> | <webview>
  let activeFrame = null;         // 当前显示的模块节点（用于 window resize 重算尺寸）
  let activeSizeTo = null;        // 当前模块的 sizeTo 函数
  function onWindowResize() { if (activeSizeTo) try { activeSizeTo(); } catch (_) {} }
  if (window.addEventListener) window.addEventListener('resize', onWindowResize);

  function customList() {
    return (App.state.settings.customModules || []).map(c => ({ id: c.id, label: c.label, type: 'custom', url: normalizeUrl(c.url), forceEmbed: !!c.forceEmbed, hidden: !!c.hidden, icon: DEFAULT_ICON }));
  }

  App.BUILTIN_MODULES = BUILTIN_MODULES;

  App.modules = {
    normalizeUrl,
    builtins() { return BUILTIN_MODULES; },
    all() {
      // 按 enabledModules 的用户自定义顺序排列内置模块，再拼接自定义模块
      const en = App.state.settings.enabledModules || [];
      const builtins = en.map(id => BUILTIN_MODULES.find(m => m.id === id)).filter(Boolean);
      return builtins.concat(customList());
    },

    isEnabled(id) {
      const b = BUILTIN_MODULES.find(m => m.id === id);
      if (b) return (App.state.settings.enabledModules || []).includes(id);
      const cm = (App.state.settings.customModules || []).find(m => m.id === id);
      return cm ? !cm.hidden : false;
    },

    firstEnabled() {
      const en = App.state.settings.enabledModules || [];
      return en[0] || BUILTIN_MODULES[0].id;
    },

    getById(id) {
      const b = BUILTIN_MODULES.find(m => m.id === id);
      if (b) return b;
      const c = (App.state.settings.customModules || []).find(m => m.id === id);
      if (c) return { id: c.id, label: c.label, type: 'custom', url: normalizeUrl(c.url), forceEmbed: !!c.forceEmbed, icon: DEFAULT_ICON };
      return null;
    },

    label(id) {
      const m = App.modules.getById(id);
      return m ? m.label : '';
    },

    renderNav() {
      const nav = document.getElementById('mainNav');
      if (!nav) return;
      const items = App.modules.all().filter(m => App.modules.isEnabled(m.id));
      nav.innerHTML = items.map(m => `
        <div class="nav-item${App.state.view === m.id ? ' active' : ''}" data-module="${App.escapeHtml(m.id)}">
          ${m.icon || DEFAULT_ICON}
          <span>${App.escapeHtml(m.label)}</span>
        </div>`).join('');
    },

    renderCustom(id) {
      const m = App.modules.getById(id);
      const wrap = document.getElementById('customView');
      if (!wrap || !m) return;
      // 诊断条：直接把 webview 尺寸/加载状态/错误显示在模块里，免去开 DevTools
      let status = wrap.querySelector('.cv-status');
      if (!status) { status = document.createElement('div'); status.className = 'cv-status'; wrap.appendChild(status); }
      status.style.display = 'none';
      // 本地文件（file://）经同源 /__local/ 用 iframe 渲染（自动正确定高）。
      // 远程「强制嵌入」：用糖包子窗口打开（webview 视口锁死 + iframe subpage 404，嵌入均不完整，
      //   子窗口是唯一同时保证视口正确 + 导航可用的方案；主视图显示提示）。
      // 注：webview 创建段保留为死代码备查。
      const isFile = /^file:/i.test(m.url || '');
      const useWebview = false;
      let src, isExternalChild = false;
      if (isFile) src = fileUrlToLocalHttp(m.url);                           // 本地文件：同源 /__local/
      else if (m.forceEmbed) {
        // 在糖包子窗口打开（完整功能：全视口 + 原生导航 + 登录态）
        if (window.electron && window.electron.openChildWindow) {
          window.electron.openChildWindow({ id, url: m.url, label: m.label });
          isExternalChild = true;
        }
        src = 'about:blank'; // placeholder（不会被真正导航，实际内容在子窗口）
      } else src = m.url;                                                     // 远程普通：直接 iframe

      let frame = customFrames.get(id);
      const isNew = !frame;
      if (!frame) {
        if (useWebview) {
          // 远程「强制嵌入」：用 <webview> 取代 <iframe>。
          // webview 是独立浏览器实例，不受对方 X-Frame-Options / CSP:frame-ancestors 限制，
          // cookie 与 JS 原生运行、弹窗可控，比服务端 /proxy 更适合广告/JS 重度站（如影视站）。
          // （本地文件已改走同源 /__local/ 的 iframe，无需 webview。）
          const wv = document.createElement('webview');
          wv.className = 'cv-webview';
          wv.style.top = '0px'; // webview 始终贴顶、整屏（诊断条已改底部角标，不预留空间）
          wv.setAttribute('allowpopups', '');
          // 本地 file:// 走默认 partition：自定义 persist: partition 在部分 Electron 版本会限制 file 访问；
          // 远程站才用独立持久 partition 以保持会话 cookie。
          if (!/^file:/i.test(m.url || '')) wv.setAttribute('partition', 'persist:module_' + id);
          // 关键：先不设 src。Electron webview 的访客视口在 did-attach（加载）时按当时元素尺寸锁定，
          // 若创建时 #customView 尚未布局（高度≈小值）会锁成小视口且运行时无法撬动（已验证：setAttribute/resize 均无效）。
          // 故轮询等待 #customView 真正有非零尺寸后再设 src，访客一上手就是正确视口，从根上避免锁死。
          const loadWebviewWhenReady = () => {
            const r = wrap.getBoundingClientRect();
            if (r.width > 10 && r.height > 10) {
              if (typeof sizeTo === 'function') sizeTo();   // 此时尺寸正确
              wv.setAttribute('src', src);                   // 再加载，访客锁正确视口
            } else {
              requestAnimationFrame(loadWebviewWhenReady);  // 未布局好则下一帧再试
            }
          };
          requestAnimationFrame(loadWebviewWhenReady);
          wv.addEventListener('dom-ready', () => {
            if (typeof sizeTo === 'function') sizeTo();
            // 关键修复：Electron webview 的访客视口（window.innerHeight / vh）不会像 iframe 那样自动跟随元素尺寸，
            // 会在 did-attach 时按当时（布局未完成）的小尺寸锁定 → 内容堆顶部、下方空白、sticky bottom 跳到顶部。
            // 可靠做法：显式设置元素 width/height（style + 属性）并派发 resize，强制访客按真实尺寸重排。
            // 注：wv.setSize() 在 Electron 31 并非稳定公开 API，被 try/catch 静默吞掉、等于没做——这是上一轮「完全没变化」的根因。
            const gw = Math.max(1, Math.floor(wv.getBoundingClientRect().width));
            const gh = Math.max(1, Math.floor(wv.getBoundingClientRect().height));
            wv.style.width = gw + 'px';
            wv.style.height = gh + 'px';
            wv.setAttribute('width', gw);
            wv.setAttribute('height', gh);
            // 兜底：WebContents.setSize 直接改原生视图尺寸（区别于无效的 WebviewTag.setSize），
            // 能在运行时撬动已锁定的访客视口，作为双 rAF 延迟加载之外的双保险。
            try {
              const wc = (typeof wv.getWebContents === 'function') && wv.getWebContents();
              if (wc && typeof wc.setSize === 'function') wc.setSize({ width: gw, height: gh });
            } catch (_) {}
            try { wv.executeJavaScript('window.dispatchEvent(new Event("resize"))'); } catch (_) {}
            // 布局可能尚未完成，延迟再同步几次，捕获被锁定的小视口
            requestAnimationFrame(() => { if (typeof sizeTo === 'function') sizeTo(); });
            setTimeout(() => { if (typeof sizeTo === 'function') sizeTo(); }, 120);
            setTimeout(() => { if (typeof sizeTo === 'function') sizeTo(); }, 400);
            // 读取访客真实视口高度，一眼验证修复是否生效（应与元素高度一致）
            try {
              wv.executeJavaScript('window.innerHeight').then(v => {
                status.textContent = `webview 访客视口 ${v}px / 元素 ${gh}px`;
              }).catch(() => { status.textContent = `webview 就绪 ${gw}×${gh}`; });
            } catch (_) { status.textContent = `webview 就绪 ${gw}×${gh}`; }
            // 加载成功：保留 ~2.5s 便于核对，再自动收起诊断条
            setTimeout(() => { status.style.display = 'none'; }, 2500);
          });
          wv.addEventListener('did-finish-load', () => {
            if (typeof sizeTo === 'function') sizeTo();
            // SPA / 客户端路由站：内容在 dom-ready 之后才撑开，再同步一次访客视口
            setTimeout(() => { if (typeof sizeTo === 'function') sizeTo(); }, 200);
          });
          wv.addEventListener('did-navigate', (e) => { status.textContent = `已导航 → ${e.url || wv.src}`; if (typeof sizeTo === 'function') sizeTo(); });
          wv.addEventListener('did-fail-load', (e) => {
            status.textContent = `加载失败 ${e.errorCode} ${e.errorDescription} ${e.validatedURL}`;
            console.error('[webview] did-fail-load', e.errorCode, e.errorDescription, e.validatedURL);
          });
          wv.addEventListener('crashed', () => { status.textContent = 'webview 崩溃'; console.error('[webview] crashed'); });
          // 捕获 webview 内页面的控制台错误/警告，直接显示在诊断条，用于定位「只显头部」根因
          wv.addEventListener('console-message', (e) => {
            const lvl = e.level;
            const isErr = lvl === 3 || lvl === 2 || (typeof e.message === 'string' && /error|failed|denied|refused|is not (a |defined)|cannot read|cloudflare|challenge|403|blocked/i.test(e.message));
            if (isErr) status.textContent = `[页面${lvl === 3 ? '错误' : '警告'}] ${e.message}`;
          });
          wv.addEventListener('new-window', (e) => {
            // 弹窗（多为广告）在 webview 内部打开，避免跳到外部浏览器；如需彻底屏蔽弹窗可移除 allowpopups
            e.preventDefault();
            try { wv.src = e.url; } catch (_) {}
          });
          frame = wv;
        } else {
          frame = document.createElement('iframe');
          frame.className = 'cv-iframe';
          frame.title = m.label;
          if (isExternalChild) {
            frame.srcdoc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;color:#888;background:#f5f5f5}</style></head><body><div style="text-align:center"><p style="font-size:18px;margin:0 0 8px">已在糖包子窗口打开</p><p style="font-size:13px;margin:0">请留意糖包子窗口</p></div></body></html>';
          } else {
            frame.src = src;
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-presentation');
          }
        }
        customFrames.set(id, frame);
        wrap.appendChild(frame);
      }

      // 尺寸：按容器像素尺寸显式设置，最稳的撑满方式（不依赖 CSS 百分比）。
      // 关键：每次进入该模块都重算（首建 + 切回已建），避免残留旧尺寸导致「顶部一小块」。
      // 诊断条已改为底部非遮挡角标、且加载后自动收起，不再预留顶部空间；
      // webview/iframe 始终贴顶、整屏填充。
      const top = 0;
      const sizeTo = () => {
        const r = wrap.getBoundingClientRect();
        const w = Math.max(0, Math.floor(r.width));
        const h = Math.max(0, Math.floor(r.height - top));
        frame.style.width = w + 'px';
        frame.style.height = h + 'px';
        // 对 webview：元素尺寸必须显式同步给访客视口（style + width/height 属性）。
        // 仅设 style 不够——访客视口跟随 width/height 属性；且不可用 frame.setSize()（Electron 31 非稳定 API，会静默失败）。
        if (frame && frame.tagName && frame.tagName.toLowerCase() === 'webview') {
          try {
            frame.setAttribute('width', w);
            frame.setAttribute('height', h);
            frame.executeJavaScript('window.dispatchEvent(new Event("resize"))');
          } catch (_) {}
        }
      };
      activeFrame = frame;
      activeSizeTo = sizeTo;
      sizeTo(); // 进入即重算
      if (isNew && window.ResizeObserver) { try { new ResizeObserver(sizeTo).observe(wrap); } catch (_) {} }

      customFrames.forEach((f, fid) => { f.style.display = (fid === id) ? 'block' : 'none'; });
      status.style.display = useWebview ? 'block' : 'none';
    },

    dropCustomFrame(id) {
      const f = customFrames.get(id);
      if (f && f.parentNode) f.parentNode.removeChild(f);
      customFrames.delete(id);
    },
  };
})();
