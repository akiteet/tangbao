'use strict';
(function () {
  window.App = window.App || {};

  const MAX_DOC_CHARS = 200000;   // 单文件读取上限
  const DOC_STORE_CAP = 40000;    // 持久化时单文档截断长度
  const MAX_DOCS = 8;
  const CHUNK_TARGET = 1500;      // 结构化分块目标长度（原 1800 硬切 → 按标题/段落聚合）
  const TOP_K = 6;
  const PREVIEW_CAP = 20000;      // 预览显示上限
  const FULLTEXT_THRESHOLD = 9000;
  const SEGMENT_TARGET = 8000;    // v1.1.6：长文档分段分析的单段目标长度（≤ FULLTEXT_THRESHOLD 避免二次截断）
  const LOW_SCORE_THRESHOLD = 0.05; // BM25 top1 得分低于此值 → 低相关提示

  // M7：文档分块缓存（外部 Map，避免 _chunks 字段污染 doc 对象被 persist 序列化）
  const chunkCache = new Map(); // docId -> { key: text, chunks: [...] }

  const AnalysisPrompts = App.DEFAULT_PROMPTS.doc;

  // v1.1.6（糖读增强）：翻译方向预设（值 → { label, target }）
  const TRANSLATE_DIRS = {
    zh2en: { label: '中 → 英', target: '英文' },
    en2zh: { label: '英 → 中', target: '中文' },
    zh2ja: { label: '中 → 日', target: '日文' },
    ja2zh: { label: '日 → 中', target: '中文' },
    zh2ko: { label: '中 → 韩', target: '韩文' },
    ko2zh: { label: '韩 → 中', target: '中文' },
    auto: { label: '自动', target: '中文（自动检测源语言）' },
  };

  App.doc = {
    activeId: null,
    streaming: false,
    previewText: '',
    __abort: null,     // v1.1.6：当前流式请求的 AbortController（停止生成用）

    onShow() { App.doc.render(); },

    docs() { return App.state.settings.docs || (App.state.settings.docs = []); },
    activeDoc() {
      const list = App.doc.docs();
      if (!App.doc.activeId && App.state.settings.docActiveId) App.doc.activeId = App.state.settings.docActiveId; /* T6：重启回到上次文档 */
      if (App.doc.activeId) {
        const d = list.find(x => x.id === App.doc.activeId);
        if (d) return d;
      }
      return list[0] || null;
    },

    // v1.1.6（糖读增强）：按文档持久化的 Q&A 消息
    chatOf(docId) {
      const all = App.state.settings.docChat || (App.state.settings.docChat = {});
      if (!all[docId]) all[docId] = [];
      return all[docId];
    },
    clearChat(docId) {
      const all = App.state.settings.docChat;
      if (all && all[docId]) delete all[docId];
    },

    render() {
      const wrap = document.getElementById('docView');
      if (!wrap) return;
      const prevInput = document.getElementById('docInput'); /* v1.1.8 T6：切模块/重渲染前保草稿 */
      if (prevInput && prevInput.value) App.doc._draft = prevInput.value;
      const docProv = App.getProvider('doc');
      const docModels = (docProv.models && docProv.models.length) ? docProv.models : (docProv.model ? [docProv.model] : []);
      const docSel = docProv.model || docModels[0] || '';
      const docModelOpts = docModels.length
        ? docModels.map(m => `<option value="${App.escapeHtml(m)}"${m === docSel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置文档模型，请到设置填写</option>';

      // v1.1.6：翻译方向下拉选项
      const dirSel = App.state.settings.docTranslateDir || 'zh2en';
      const transDirOpts = Object.entries(TRANSLATE_DIRS)
        .map(([k, v]) => `<option value="${k}"${k === dirSel ? ' selected' : ''}>${v.label}</option>`).join('');

      const list = App.doc.docs();
      const docChips = list.map(d => `
        <div class="doc-chip${d.id === (App.doc.activeDoc() && App.doc.activeDoc().id) ? ' active' : ''}" data-doc="${d.id}">
          <span class="doc-chip-name" title="${App.escapeHtml(d.name)}">${App.escapeHtml(d.name)}</span>
          <span class="doc-chip-acts">
            <button class="doc-chip-act" data-ren="${d.id}" title="重命名">✎</button>
            <button class="doc-chip-act" data-exp="${d.id}" title="导出文本">↓</button>
            <button class="doc-chip-del" data-del="${d.id}" title="删除">✕</button>
          </span>
        </div>`).join('');

      wrap.innerHTML = `
        <div class="doc-shell${App.state.settings.docSidebarCollapsed ? ' sidebar-collapsed' : ''}">
          <div class="doc-model-row">
            <span class="opt-label">模型</span>
            <select class="img-model-pick" id="docModel">${docModelOpts}</select>
            <span class="opt-label">提问范围</span>
            <select class="img-model-pick" id="docScope">
              <option value="current"${(App.state.settings.docScope || 'current') !== 'all' ? ' selected' : ''}>当前文档</option>
              <option value="all"${App.state.settings.docScope === 'all' ? ' selected' : ''}>全部文档</option>
            </select>
          </div>
          <div class="doc-main">
            <div class="doc-sidebar">
              <div class="doc-sidebar-head">
                <span class="doc-sidebar-title">文档</span>
                <button type="button" class="icon-btn" id="docSidebarToggle" title="收起/展开边栏">
                  <svg class="ico-collapse" viewBox="0 0 24 24" width="16" height="16"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <svg class="ico-expand" viewBox="0 0 24 24" width="16" height="16" style="display:none"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
              <div class="doc-sec doc-sec-upload">
                <div class="doc-toolbar">
                  <div class="dropzone compact" id="docDropzone">
                    <input type="file" id="docFile" accept=".txt,.md,.csv,.json,.jsonl,.log,.pdf,.docx,.pptx,text/*" multiple>
                    <span class="dz-text-sm">＋ 上传文件（可多选，支持 PDF / Word / PPT / 文本）</span>
                  </div>
                  <button class="btn-ghost mini" id="docPasteBtn">粘贴文本</button>
                </div>
              </div>
              <div class="doc-sec doc-sec-files">
                <div class="doc-list" id="docList">${docChips || '<span class="doc-list-empty">暂无文档</span>'}</div>
              </div>
              <div class="doc-sec doc-sec-analysis">
                <div class="doc-analysis-bar" id="docAnalysisBar" style="display:${App.doc.activeDoc() ? 'flex' : 'none'}">
                  <button data-act="summary">摘要</button>
                  <button data-act="points">要点</button>
                  <span class="doc-trans-wrap">
                    <button data-act="translate">翻译</button>
                    <select id="docTransDir" class="doc-trans-dir" title="翻译方向">${transDirOpts}</select>
                  </span>
                  <button data-act="outline">拆解</button>
                </div>
              </div>
              <div class="doc-sec doc-sec-outline">
                <div class="doc-outline" id="docOutline"></div>
              </div>
            </div>
            <div class="doc-chat">
              <div class="doc-empty" id="docEmpty">
                <div class="doc-empty-ico">📄</div>
                <div class="doc-empty-text">上传文档开始糖读</div>
                <div class="doc-empty-sub">支持 TXT / Markdown / PDF / Word / PPT，上传后可提问、摘要、引用溯源</div>
                <button class="btn-primary" id="docEmptyBtn">选择文件</button>
              </div>
              <div class="doc-chat-area" id="docChatArea" style="display:none">
                <div class="doc-messages" id="docMessages"></div>
                <div class="doc-composer">
                  <textarea id="docInput" rows="1" placeholder="基于文档提问…"></textarea>
                  <button id="docSendBtn" disabled>➤</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="doc-drawer-mask" id="docDrawerMask" hidden></div>
        <div class="doc-drawer" id="docDrawer">
          <div class="doc-drawer-head">
            <span class="doc-drawer-title" id="docDrawerTitle">文档预览</span>
            <button type="button" class="icon-btn" id="docDrawerClose" aria-label="关闭预览">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="doc-preview" id="docPreview"></div>
        </div>`;
      App.doc.bind();
      App.doc.renderOutline();
      const d = App.doc.activeDoc();
      if (d) App.doc.showDoc(d); else App.doc.renderEmpty();
    },

    bind() {
      const dz = document.getElementById('docDropzone');
      const input = document.getElementById('docFile');
      // 原生 file input 已覆盖整个上传区；不要在父容器再次 input.click()，否则一次点击会弹出两次选择框。
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('hover'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('hover');
        const files = Array.from(e.dataTransfer.files || []);
        files.forEach(f => App.doc.readFile(f));
      });
      input.addEventListener('change', () => { Array.from(input.files || []).forEach(f => App.doc.readFile(f)); input.value = ''; });

      const dmsel = document.getElementById('docModel');
      if (dmsel) dmsel.addEventListener('change', () => {
        const val = dmsel.value; if (!val) return;
        const prov = App.state.settings.providers.doc || (App.state.settings.providers.doc = { accountId: '__default__' });
        prov.model = val; App.persist();
        App.ui.toast('已切换文档模型：' + val);
      });

      const scopeSel = document.getElementById('docScope');
      if (scopeSel) scopeSel.addEventListener('change', () => {
        App.state.settings.docScope = scopeSel.value;
        App.persist();
      });

      // v1.1.6：翻译方向选择持久化
      const dirSel = document.getElementById('docTransDir');
      if (dirSel) dirSel.addEventListener('change', () => {
        App.state.settings.docTranslateDir = dirSel.value;
        App.persist();
      });

      const paste = document.getElementById('docPasteBtn');
      if (paste) paste.addEventListener('click', () => App.doc.pasteText());

      const list = document.getElementById('docList');
      if (list) list.addEventListener('click', (e) => {
        const del = e.target.closest('.doc-chip-del');
        if (del) { e.stopPropagation(); App.doc.removeDoc(del.dataset.del); return; }
        const ren = e.target.closest('[data-ren]');
        if (ren) { e.stopPropagation(); App.doc.renameDoc(ren.dataset.ren); return; }
        const exp = e.target.closest('[data-exp]');
        if (exp) { e.stopPropagation(); App.doc.exportDoc(exp.dataset.exp); return; }
        const chip = e.target.closest('.doc-chip');
        if (chip) App.doc.switchDoc(chip.dataset.doc);
      });

      const bar = document.getElementById('docAnalysisBar');
      if (bar) bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (b) App.doc.analyze(b.dataset.act);
      });

      const docInput = document.getElementById('docInput');
      const docSend = document.getElementById('docSendBtn');
      if (docInput && App.doc._draft) { docInput.value = App.doc._draft; App.doc._draft = ''; } /* T6：草稿回填 */
      if (docInput && docSend) {
        docInput.addEventListener('input', () => { docSend.disabled = App.doc.streaming || !docInput.value.trim(); });
        docInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.doc.send(); } });
        docSend.addEventListener('click', () => App.doc.send());
      }

      // M10：边栏折叠 / 空状态选文件 / 预览抽屉关闭
      const toggle = document.getElementById('docSidebarToggle');
      if (toggle) toggle.addEventListener('click', () => App.doc.toggleSidebar());
      const emptyBtn = document.getElementById('docEmptyBtn');
      if (emptyBtn) emptyBtn.addEventListener('click', () => {
        const inp = document.getElementById('docFile');
        if (inp) inp.click();
      });
      const drawerClose = document.getElementById('docDrawerClose');
      if (drawerClose) drawerClose.addEventListener('click', () => App.doc.closeDrawer());
      const drawerMask = document.getElementById('docDrawerMask');
      if (drawerMask) drawerMask.addEventListener('click', () => App.doc.closeDrawer()); /* T4：点遮罩关闭 */
      document.addEventListener('keydown', (e) => { /* T4：ESC 关闭（仅糖读视图） */
        if (e.key === 'Escape' && App.state.view === 'doc') App.doc.closeDrawer();
      });
    },

    // M10：预览抽屉开合
    openDrawer(name) {
      const drawer = document.getElementById('docDrawer');
      if (!drawer) return;
      const title = document.getElementById('docDrawerTitle');
      if (title) {
        const d = App.doc.activeDoc();
        title.textContent = name || (d && d.name) || '文档预览';
      }
      drawer.classList.add('open');
      const mask = document.getElementById('docDrawerMask');
      if (mask) mask.hidden = false;
    },

    closeDrawer() {
      const drawer = document.getElementById('docDrawer');
      if (drawer) drawer.classList.remove('open');
      const mask = document.getElementById('docDrawerMask');
      if (mask) mask.hidden = true;
    },

    // M10：边栏折叠（状态持久化）
    toggleSidebar() {
      const shell = document.querySelector('#docView .doc-shell');
      if (!shell) return;
      const collapsed = !shell.classList.contains('sidebar-collapsed');
      shell.classList.toggle('sidebar-collapsed', collapsed);
      App.state.settings.docSidebarCollapsed = !!collapsed;
      App.persist();
    },

    // M10：空状态（无文档时主区引导卡）
    renderEmpty() {
      const empty = document.getElementById('docEmpty');
      const chat = document.getElementById('docChatArea');
      const bar = document.getElementById('docAnalysisBar');
      if (empty) empty.style.display = 'flex';
      if (chat) chat.style.display = 'none';
      if (bar) bar.style.display = 'none';
      App.doc.closeDrawer();
      App.doc.renderOutline();
    },

    // v1.1.6（糖读增强）：上传分流——PDF / Word(.docx) / PPT(.pptx) / 文本
    async readFile(file) {
      if (!file) return;
      let text = '';
      const name = file.name || '';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const isPdf = file.type === 'application/pdf' || ext === 'pdf';
      try {
        if (isPdf) {
          text = await App.doc.extractPdf(file);
        } else if (ext === 'docx') {
          text = await App.doc.extractDocx(file);
        } else if (ext === 'pptx') {
          text = await App.doc.extractPptx(file);
        } else if (ext === 'doc' || ext === 'ppt' || ext === 'xls' || ext === 'xlsx') {
          App.ui.toast('旧版 ' + ext.toUpperCase() + ' 格式暂不支持，请另存为 .docx / .pptx 或纯文本后导入');
          return;
        } else {
          text = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(new Error('读取失败'));
            r.readAsText(file);
          });
        }
      } catch (e) {
        App.ui.toast('读取失败：' + (e.message || e) + (ext === 'pdf' ? '（PDF 解析失败，可尝试粘贴文本）' : ''));
        return;
      }
      if (file.size > MAX_DOC_CHARS) App.ui.toast('文档较大，已截断处理');
      text = text.slice(0, MAX_DOC_CHARS);
      if (!text.trim()) { App.ui.toast('未能从文件中提取到文本内容'); return; }
      App.doc.addDoc({ name, text, size: file.size });
    },

    async extractPdf(file) {
      if (!window.pdfjsLib) throw new Error('PDF.js 未加载');
      try {
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(it => it.str || '').join(' ') + '\n';
        }
        return text;
      } catch (e) {
        throw new Error('PDF 解析失败：' + (e.message || e));
      }
    },

    // v1.1.6（糖读增强）：.docx → mammoth 提取正文
    async extractDocx(file) {
      if (!window.mammoth) throw new Error('Word 解析库未加载');
      try {
        const buf = await file.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
        return String(result && result.value ? result.value : '');
      } catch (e) {
        throw new Error('Word 解析失败：' + (e.message || e));
      }
    },

    // v1.1.6（糖读增强）：.pptx → jszip 解包后按 slide 顺序提取 <a:t> 文本
    async extractPptx(file) {
      if (!window.JSZip) throw new Error('PPT 解析库未加载');
      try {
        const buf = await file.arrayBuffer();
        const zip = await window.JSZip.loadAsync(buf);
        const slides = Object.keys(zip.files)
          .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
          .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
        if (!slides.length) throw new Error('未找到幻灯片内容');
        let text = '';
        for (const n of slides) {
          const xml = await zip.file(n).async('string');
          const texts = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map(m => m[1]).filter(t => t.trim());
          if (texts.length) text += texts.join(' ') + '\n';
        }
        return text;
      } catch (e) {
        throw new Error('PPT 解析失败：' + (e.message || e));
      }
    },

    pasteText() {
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'docPasteMask';
      modal.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>粘贴文档文本</span>
            <button class="icon-btn" id="docPasteClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <textarea id="docPasteArea" class="paste-area" rows="8" placeholder="把文档文本粘贴到这里…"></textarea>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="docPasteCancel">取消</button>
            <button class="btn-primary" id="docPasteOk">添加</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const area = modal.querySelector('#docPasteArea');
      const close = () => modal.remove();
      const submit = () => {
        const text = area.value.trim();
        if (!text) { App.ui.toast('请先粘贴文本'); area.focus(); return; }
        const name = '粘贴文本-' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        close();
        App.doc.addDoc({ name, text: text.slice(0, MAX_DOC_CHARS), size: text.length });
      };
      modal.querySelector('#docPasteClose').addEventListener('click', close);
      modal.querySelector('#docPasteCancel').addEventListener('click', close);
      modal.querySelector('#docPasteOk').addEventListener('click', submit);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      setTimeout(() => area.focus(), 30);
    },

    // 跨模块导入：把一段文本作为新文档加入糖读（供分析/追问）
    importText(text, name) {
      const t = String(text == null ? '' : text);
      if (!t.trim()) return;
      const title = (name && String(name).trim()) ? String(name).trim() : '导入文本';
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
      App.doc.addDoc({ name: `${title} ${stamp}`, text: t.slice(0, DOC_STORE_CAP), size: t.length });
    },

    addDoc({ name, text, size }) {
      const list = App.doc.docs();
      const doc = { id: App.uid(), name, text, size, createdAt: Date.now() };
      list.unshift(doc);
      // v1.1.6：达上限不再静默丢弃——明确提示被移除的最旧文档
      if (list.length > MAX_DOCS) {
        const evicted = list.pop();
        App.doc.clearChat(evicted && evicted.id);
        App.ui.toast('文档已达上限 ' + MAX_DOCS + ' 篇，最旧的「' + (evicted && evicted.name) + '」已移除');
      }
      App.doc.activeId = doc.id;
      App.state.settings.docActiveId = doc.id; /* T6 */
      App.persist();
      App.ui.toast('已添加：' + name);
      App.doc.render();
    },

    // v1.1.6（糖读增强）：重命名文档
    renameDoc(id) {
      const d = App.doc.docs().find(x => x.id === id);
      if (!d) return;
      const name = window.prompt('文档新名称', d.name);
      if (name == null) return;
      const t = String(name).trim();
      if (!t) { App.ui.toast('名称不能为空'); return; }
      d.name = t;
      App.persist();
      App.doc.render();
      App.ui.toast('已重命名');
    },

    // v1.1.6（糖读增强）：导出原始文本
    exportDoc(id) {
      const d = App.doc.docs().find(x => x.id === id);
      if (!d) return;
      App.doc.downloadText(d.text, (d.name || '文档').replace(/[\\/:*?"<>|]/g, '_') + '.txt');
    },

    downloadText(text, filename) {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    removeDoc(id) {
      const list = App.doc.docs();
      const idx = list.findIndex(x => x.id === id);
      if (idx >= 0) list.splice(idx, 1);
      App.doc.clearChat(id);
      chunkCache.delete(id);
      if (App.doc.activeId === id) App.doc.activeId = list[0] ? list[0].id : null;
      App.persist();
      App.doc.render();
      // v1.1.6：best-effort 清理 SQLite docs 行 + 文件仓 blob，防止删除后从 fallback 复活
      if (App.services && App.services.fs && typeof App.services.fs.deleteDoc === 'function') {
        App.services.fs.deleteDoc(id).catch(() => {});
      }
    },

    switchDoc(id) {
      const same = App.doc.activeId === id; /* T4：同文档点击不重开抽屉 */
      App.doc.activeId = id;
      App.state.settings.docActiveId = id; /* T6 */
      App.persist();
      App.doc.render();
      if (!same) App.doc.openDrawer();
    },

    showDoc(d) {
      document.getElementById('docAnalysisBar').style.display = 'flex';
      // M10：预览移入右侧抽屉（#docPreview 在抽屉内），这里只更新内容，显示由抽屉控制
      const drawerTitle = document.getElementById('docDrawerTitle');
      if (drawerTitle) drawerTitle.textContent = d.name || '文档预览';
      const preview = document.getElementById('docPreview');
      App.doc.previewText = d.text.slice(0, PREVIEW_CAP);
      if (preview) preview.textContent = App.doc.previewText + (d.text.length > PREVIEW_CAP ? '\n…（预览已截断）' : '');
      const empty = document.getElementById('docEmpty');
      if (empty) empty.style.display = 'none';
      document.getElementById('docChatArea').style.display = 'flex';
      App.doc.renderOutline();
      // v1.1.6：渲染该文档持久化的 Q&A 历史
      App.doc.renderChat();
    },

    // v1.1.6（糖读增强）：按当前文档重建 Q&A 历史消息
    renderChat() {
      const area = document.getElementById('docMessages');
      if (!area) return;
      const d = App.doc.activeDoc();
      const msgs = d ? App.doc.chatOf(d.id) : [];
      area.innerHTML = '';
      for (const m of msgs) {
        if (!m || typeof m.text !== 'string') continue;
        if (m.role === 'user') {
          const node = document.createElement('div');
          node.className = 'doc-msg msg user';
          const refCard = (m.docRefs && m.docRefs.length) ? '<div class="attach-cards">' + m.docRefs.map((r) => '<div class="attach-card"><span class="attach-ico">📄</span><span class="attach-name">' + App.escapeHtml(r.docName || '') + '</span></div>').join('') + '</div>' : '';
          node.innerHTML = '<div class="msg-body">' + refCard + '<div class="bubble user-bubble"></div></div>';
          node.querySelector('.bubble').textContent = m.text;
          area.appendChild(node);
        } else {
          const node = document.createElement('div');
          node.className = 'doc-msg msg assistant';
          node.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
            <div class="msg-body"><div class="msg-card">
              <div class="bubble"></div>
              <div class="msg-actions"><button data-doc-copy="1">复制</button><button data-doc-export="1">导出 .md</button></div>
            </div></div>`;
          node.querySelector('.bubble').innerHTML = App.renderMarkdown(m.text);
          if (m.cites && m.cites.length) App.doc.renderCites(node, m.text, m.cites);
          const copyBtn = node.querySelector('[data-doc-copy]');
          if (copyBtn) copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(m.text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
          });
          const expBtn = node.querySelector('[data-doc-export]');
          if (expBtn) expBtn.addEventListener('click', () => App.doc.exportAnswerMd(m.text, d && d.name));
          area.appendChild(node);
        }
      }
      area.scrollTop = area.scrollHeight;
    },

    // v1.1.6（糖读增强）：回答导出 Markdown
    exportAnswerMd(text, docName) {
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-');
      const safeName = (docName || '文档').replace(/[\\/:*?"<>|]/g, '_');
      App.doc.downloadText(text || '', `糖读-${safeName}-${stamp}.md`);
    },

    renderOutline() {
      const box = document.getElementById('docOutline');
      if (!box) return;
      const d = App.doc.activeDoc();
      if (!d) { box.innerHTML = ''; return; }
      const items = App.doc.buildOutline(d.text);
      box.innerHTML = '<div class="doc-outline-title">大纲</div>' + (items.length
        ? items.map((it, i) => `<div class="doc-outline-item" data-pos="${it.pos}" style="padding-left:${8 + it.level * 12}px">${App.escapeHtml(it.title)}</div>`).join('')
        : '<div class="doc-outline-empty">未识别到标题</div>');
      box.querySelectorAll('.doc-outline-item').forEach(el => {
        // M10：点击大纲 → 打开预览抽屉并定位
        el.addEventListener('click', () => {
          App.doc.openDrawer();
          App.doc.scrollToPos(Number(el.dataset.pos));
        });
      });
    },

    buildOutline(text) {
      const lines = text.split(/\n/);
      const items = [];
      let pos = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m = /^(#{1,4})\s+(.*)$/.exec(line);
        let level = 0, title = '';
        if (m) { level = m[1].length; title = m[2].trim(); }
        else { m = /^\s*(\d+(?:\.\d+)*)\.\s+(.+)$/.exec(line); if (m) { level = Math.min(m[1].split('.').length, 4); title = m[2].trim(); } }
        if (title && title.length <= 80) {
          items.push({ level, title, pos });
        }
        pos += line.length + 1;
      }
      return items.slice(0, 120);
    },

    scrollToPos(pos) {
      const preview = document.getElementById('docPreview');
      if (!preview || !App.doc.previewText) return;
      const ratio = Math.min(1, pos / App.doc.previewText.length);
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      preview.classList.add('flash');
      setTimeout(() => preview.classList.remove('flash'), 700);
    },
    // M7：结构化分块——按标题/段落聚合，保留 { heading, content, start, end }
    structuredChunks(text) {
      if (!text) return [];
      const lines = text.split('\n');
      const out = [];
      let heading = '', content = '', start = 0, pos = 0;
      const flush = (end) => {
        if (content.trim()) out.push({ heading, content: content.trim(), start, end });
        heading = ''; content = ''; start = pos;
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLast = i === lines.length - 1;
        const lineLen = line.length + (isLast ? 0 : 1);
        const t = line.trim();
        let m = /^(#{1,4})\s+(.+)$/.exec(t);
        if (!m) m = /^\s*(\d+(?:\.\d+)*)\.\s+(.+)$/.exec(t);
        if (m && m[2].trim() && m[2].trim().length <= 80) {
          flush(pos);           // 上一块在标题前结束
          heading = m[2].trim();
          start = pos;          // 新块起点指向标题行
          pos += lineLen;
          continue;
        }
        if (content && content.length + lineLen > CHUNK_TARGET) flush(pos);
        content += line + '\n';
        pos += lineLen;
      }
      flush(text.length);
      if (!out.length && text) out.push({ heading: '', content: text, start: 0, end: text.length });
      return out;
    },

    // 带缓存的分块入口（Map 缓存，不污染 doc 对象）
    chunksOf(d) {
      if (!d || !d.id) return [];
      const hit = chunkCache.get(d.id);
      if (hit && hit.key === d.text) return hit.chunks;
      const chunks = App.doc.structuredChunks(d.text);
      chunkCache.set(d.id, { key: d.text, chunks });
      return chunks;
    },

    // 分词：英文单词 + 中文 2-gram（轻量 BM25 用）
    tokenize(text) {
      const t = String(text || '').toLowerCase();
      const words = t.match(/[a-z0-9_]+/g) || [];
      const cjk = t.match(/[\u4e00-\u9fff]+/g) || [];
      for (const seg of cjk) {
        if (seg.length === 1) words.push(seg);
        else for (let i = 0; i < seg.length - 1; i++) words.push(seg.slice(i, i + 2));
      }
      return words;
    },

    // 轻量 BM25：k1=1.5, b=0.75，IDF 基于 chunk 集合；返回按原序的 top-k（附 score）
    bm25(query, chunks) {
      const N = chunks.length;
      if (!N) return [];
      const k1 = 1.5, b = 0.75;
      const docLen = chunks.map(c => App.doc.tokenize(c.content).length);
      const avgdl = docLen.reduce((a, x) => a + x, 0) / N || 1;
      const tfs = chunks.map(c => {
        const tf = {};
        for (const w of App.doc.tokenize(c.content)) tf[w] = (tf[w] || 0) + 1;
        return tf;
      });
      const df = {};
      for (const tf of tfs) for (const w of Object.keys(tf)) df[w] = (df[w] || 0) + 1;
      const qToks = App.doc.tokenize(query);
      const scored = chunks.map((c, i) => {
        let s = 0;
        const dl = docLen[i];
        for (const w of qToks) {
          const f = tfs[i][w] || 0;
          if (!f) continue;
          const n = df[w] || 0;
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
        }
        return { chunk: c, score: s, i };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, TOP_K).sort((a, b) => a.i - b.i);
    },

    // 检索上下文：scope='all' 全部文档融合；否则当前文档。返回 { context, refs, full, lowConf }
    buildContext(question, scope) {
      let docs = [];
      if (scope === 'all') docs = App.doc.docs();
      else { const d = App.doc.activeDoc(); if (d) docs = [d]; }
      if (!docs.length) return { context: '', refs: [], full: false, lowConf: false };
      // 单文档小文本 → 全文直给（不检索）
      if (docs.length === 1 && docs[0].text.length <= FULLTEXT_THRESHOLD) {
        return { context: docs[0].text, refs: [], full: true, lowConf: false };
      }
      const flat = [];
      for (const d of docs) {
        for (const c of App.doc.chunksOf(d)) flat.push({ chunk: c, doc: d });
      }
      const scored = App.doc.bm25(question, flat.map(x => x.chunk));
      const picked = scored.map(s => {
        const ref = flat[s.i];
        return { chunk: s.chunk, score: s.score, doc: ref.doc };
      });
      const topScore = picked.length ? picked[0].score : 0;
      const lowConf = picked.length > 0 && topScore < LOW_SCORE_THRESHOLD;
      const context = picked.map((p, k) => `[${k + 1}]${p.doc.name ? '（' + p.doc.name + '）' : ''}${p.chunk.heading ? '【' + p.chunk.heading + '】' : ''}\n${p.chunk.content}`).join('\n---\n');
      return {
        context,
        refs: picked.map(p => ({ content: p.chunk.content, start: p.chunk.start, docId: p.doc.id, docName: p.doc.name })),
        full: false,
        lowConf,
      };
    },

    // v1.1.6（糖读增强）：翻译方向化提示词（仅返回指令，资料由调用方拼接）
    translatePrompt(base, isCustom) {
      const dir = App.state.settings.docTranslateDir || 'zh2en';
      const meta = TRANSLATE_DIRS[dir] || TRANSLATE_DIRS.zh2en;
      if (isCustom) return `（翻译方向：${meta.label}）\n\n` + base;
      return `请把下面的资料完整翻译成${meta.target}，保留原有结构与格式，只输出译文。`;
    },

    // v1.1.6（糖读增强）：长文档 → 分段（按结构化块聚合，单段 ≤ SEGMENT_TARGET）
    segmentsOf(d) {
      if (!d || !d.text) return [];
      const chunks = App.doc.chunksOf(d);
      const segs = [];
      let cur = '';
      for (const c of chunks) {
        const block = (c.heading ? '【' + c.heading + '】\n' : '') + c.content;
        if (block.length > SEGMENT_TARGET) {
          // 单块超长：先落当前段，再把该块按字符截断成段
          if (cur) { segs.push(cur); cur = ''; }
          for (let i = 0; i < block.length; i += SEGMENT_TARGET) segs.push(block.slice(i, i + SEGMENT_TARGET));
          continue;
        }
        if (cur && (cur + '\n' + block).length > SEGMENT_TARGET) { segs.push(cur); cur = block; }
        else cur = cur ? cur + '\n' + block : block;
      }
      if (cur) segs.push(cur);
      if (!segs.length && d.text) segs.push(d.text.slice(0, FULLTEXT_THRESHOLD));
      return segs;
    },

    // v1.1.6（糖读增强）：分段分析——逐段串行请求，翻译类直接拼接，其余最后合并
    async analyzeSegments(act, prompt, d) {
      const segments = App.doc.segmentsOf(d);
      if (segments.length <= 1) {
        App.doc.send(prompt, { docRef: { docId: d.id, docName: d.name }, payload: prompt + '\n\n资料：\n' + d.text.slice(0, FULLTEXT_THRESHOLD) });
        return;
      }
      const parts = [];
      for (let i = 0; i < segments.length; i++) {
        if (App.doc.__abort) break; // 已被用户停止
        App.ui.toast(`文档较长，正在分析第 ${i + 1}/${segments.length} 段…`);
        const segText = segments[i];
        const note = `（长文档分段处理：第 ${i + 1}/${segments.length} 段）`;
        const text = prompt + '\n\n资料（' + note + '）：\n' + segText;
        const result = await App.doc.send(text, { segment: true, note, display: prompt, docRef: { docId: d.id, docName: d.name }, payload: text });
        if (result == null) break; // 发送失败或停止
        if (result.trim()) parts.push(result.trim());
      }
      if (parts.length > 1 && act !== 'translate') {
        App.ui.toast('正在综合各段结果…');
        const merged = parts.map((t, i) => `【第 ${i + 1} 段结果】\n${t}`).join('\n\n---\n\n');
        await App.doc.send(`以下是同一文档分 ${parts.length} 段分析后的各段结果。请综合各段、去重合并、连贯呈现，输出一份完整的最终结果。\n\n各段结果：\n` + merged, { merge: true });
      }
    },

    async send(custom, opts) {
      const input = document.getElementById('docInput');
      const text = (custom != null) ? custom : (input ? input.value.trim() : '');
      const o = opts && typeof opts === 'object' ? opts : {};
      if (!text || App.doc.streaming) return null;
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return null; }

      const area = document.getElementById('docMessages');
      // M10：复用聊天模块视觉（.msg.user 反向布局 + user-bubble）
      const userNode = document.createElement('div');
      userNode.className = 'doc-msg msg user';
      // v1.1.8 T5：显示层 = 文件卡片 + 指令（全文只进请求载荷）
      const refCard = o.docRef ? '<div class="attach-cards"><div class="attach-card"><span class="attach-ico">📄</span><span class="attach-name">' + App.escapeHtml(o.docRef.docName || '') + '</span></div></div>' : '';
      userNode.innerHTML = '<div class="msg-body">' + refCard + '<div class="bubble user-bubble"></div></div>';
      userNode.querySelector('.bubble').textContent = o.display || text;
      area.appendChild(userNode);
      if (input) { input.value = ''; const sendBtn = document.getElementById('docSendBtn'); if (sendBtn) sendBtn.disabled = true; }
      area.scrollTop = area.scrollHeight;

      // v1.1.6：分段/合并请求是内部消息，不写入 Q&A 历史
      if (!o.segment && !o.merge) {
        // v1.1.8 U1：历史只存纯指令（docRefs 已存引用），载荷全文不落历史
        App.doc.chatOf(d.id).push({ id: App.uid(), role: 'user', text: o.display || text, docRefs: o.docRef ? [o.docRef] : undefined, createdAt: Date.now() });
      }

      const p = App.getProvider('doc');
      if (!p.ref || !p.hasKey || !p.model) {
        App.doc.appendError('尚未配置文档 API。请先在设置里填写“文档”或“默认”的 API 信息。');
        return null;
      }
      // v1.1.6：分段/合并请求的资料已完整内联在消息里，不再走 BM25 检索
      let ctx = null;
      let sysExtra;
      if (o.segment || o.merge) {
        ctx = { full: false, refs: [] };
        sysExtra = '请根据用户消息中提供的资料完成其要求。资料已完整给出，无需检索或引用其他内容。';
      } else {
        ctx = App.doc.buildContext(text, App.state.settings.docScope === 'all' ? 'all' : 'current');
        if (ctx.full) {
          sysExtra = '请仅依据以下完整资料回答用户问题。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context;
        } else {
          sysExtra = '请仅依据以下带编号的资料片段回答（引用请用 [1]..[n] 格式标注来源）。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context;
          if (ctx.lowConf) sysExtra = '⚠️ 检索到的资料片段与问题相关性较低，资料中很可能没有答案。请如实告知用户，不要编造。\n\n' + sysExtra;
        }
      }

      const payload = {
        model: p.model, stream: true,
        messages: [{ role: 'system', content: sysExtra }, { role: 'user', content: o.payload || text }],
      };
      App.doc.streaming = true;
      // v1.1.6：流式可中断（停止生成）
      const controller = new AbortController();
      App.doc.__abort = controller;
      // M10：复用聊天视觉（头像 + 卡片气泡 + 复制按钮）
      const ai = document.createElement('div');
      ai.className = 'doc-msg msg assistant';
      ai.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
        <div class="msg-body"><div class="msg-card">
          <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>
          <div class="msg-actions" style="display:flex">
            <button data-doc-stop="1">停止</button>
            <button data-doc-copy="1" style="display:none">复制</button>
            <button data-doc-export="1" style="display:none">导出 .md</button>
          </div>
        </div></div>`;
      area.appendChild(ai);
      const aiBubble = ai.querySelector('.bubble');
      const stopBtn = ai.querySelector('[data-doc-stop]');
      const copyBtn = ai.querySelector('[data-doc-copy]');
      const exportBtn = ai.querySelector('[data-doc-export]');
      let acc = '', started = false, stopped = false;
      if (stopBtn) stopBtn.addEventListener('click', () => {
        stopped = true;
        controller.abort();
        stopBtn.disabled = true;
        stopBtn.textContent = '已停止';
      });
      try {
        // 走主进程模型网关（原来是渲染进程直连，既暴露密钥又受 CORS 限制）
        const res = await App.rt.gatewayFetch({ ref: p.ref, kind: 'chat', telemetry: { scope: 'documents', callType: 'document_qa' }, payload, signal: controller.signal });
        if (!res.ok) {
          const txt = await App.rt.gatewayError(res);
          aiBubble.innerHTML = `<span class="error">请求失败（${res.status}）：${App.escapeHtml(String(txt).slice(0, 200))}</span>`;
          App.doc.streaming = false; App.doc.__abort = null;
          return null;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop();
          for (const line of parts) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') break;
            let json; try { json = JSON.parse(data); } catch (e) { continue; }
            const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
            if (delta.content) {
              if (!started) { aiBubble.innerHTML = ''; started = true; }
              acc += delta.content;
              aiBubble.innerHTML = App.renderMarkdown(acc);
              area.scrollTop = area.scrollHeight;
            }
          }
        }
      } catch (err) {
        if (err && err.name === 'AbortError') {
          // 用户主动停止：保留已累积内容
        } else {
          aiBubble.innerHTML = `<span class="error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</span>`;
        }
      }
      App.doc.streaming = false;
      App.doc.__abort = null;
      if (!started && !acc && !stopped) {
        // 空响应（可能 [DONE] 立即到达或请求异常无内容）
        if (stopBtn) stopBtn.style.display = 'none';
        return null;
      }
      if (acc) {
        // 引用溯源（仅自由提问/非分段流程才有检索 refs）
        if (!o.segment && !o.merge && !ctx.full && ctx.refs.length) App.doc.renderCites(ai, acc, ctx.refs);
        // v1.1.6：持久化完成的消息（内部段消息不入库）
        if (!o.segment && !o.merge) {
          App.doc.chatOf(d.id).push({
            id: App.uid(), role: 'assistant', text: acc,
            cites: (!ctx.full && ctx.refs.length) ? ctx.refs : undefined,
            createdAt: Date.now(),
          });
          App.persist();
          if (area && !area.isConnected) App.doc.renderChat(); /* T6：模块切换后流式完成，重绘使回答可见 */
        }
        // 完成：显示复制/导出，隐藏停止
        if (stopBtn) stopBtn.style.display = 'none';
        if (copyBtn) { copyBtn.style.display = ''; copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(acc || '').then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
        }); }
        if (exportBtn) { exportBtn.style.display = ''; exportBtn.addEventListener('click', () => App.doc.exportAnswerMd(acc, d.name)); }
        return acc;
      }
      if (stopBtn) stopBtn.style.display = 'none';
      return null;
    },

    analyze(act) {
      const pr = App.state.settings.prompts;
      const custom = pr && pr.doc && pr.doc[act];
      let prompt = (custom && String(custom).trim()) ? String(custom).trim() : AnalysisPrompts[act];
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return; }
      if (act === 'translate') {
        prompt = App.doc.translatePrompt(prompt, !!(custom && String(custom).trim()));
      }
      // v1.1.6：长文档不再静默截断——分段分析
      if (d.text.length > FULLTEXT_THRESHOLD) {
        App.doc.analyzeSegments(act, prompt, d);
        return;
      }
      App.doc.send(prompt, { docRef: { docId: d.id, docName: d.name }, payload: prompt + '\n\n资料：\n' + d.text });
    },

    renderCites(aiNode, answer, refs) {
      const cited = new Set();
      const re = /\[(\d+)\]/g; let m;
      while ((m = re.exec(answer))) cited.add(Number(m[1]));
      if (!cited.size) return;
      const footer = document.createElement('div');
      footer.className = 'doc-cites';
      footer.innerHTML = '<div class="doc-cites-title">引用来源</div>' + Array.from(cited).sort((a, b) => a - b).map(n => {
        const ref = refs[n - 1] || {};
        const snip = (ref.content || '').slice(0, 160).replace(/\n/g, ' ');
        const docPrefix = ref.docName ? ref.docName + ' · ' : '';
        return `<button class="doc-cite" data-n="${n}">[${n}] ${App.escapeHtml(docPrefix + snip)}</button>`;
      }).join('');
      footer.querySelectorAll('.doc-cite').forEach(b => {
        b.addEventListener('click', () => App.doc.locateCite(Number(b.dataset.n), refs));
      });
      // M10：引用卡片挂在 msg-card 内（头像旁不出现）
      const card = aiNode.querySelector('.msg-card');
      (card || aiNode).appendChild(footer);
    },

    locateCite(n, refs) {
      const ref = refs[n - 1];
      if (!ref) return;
      // 多文档：引用属于非当前文档时先切换（switchDoc 会自动开抽屉）
      if (ref.docId && ref.docId !== (App.doc.activeDoc() && App.doc.activeDoc().id)) {
        const d = App.doc.docs().find(x => x.id === ref.docId);
        if (d) { App.doc.switchDoc(d.id); return; }
      }
      App.doc.openDrawer();
      const preview = document.getElementById('docPreview');
      if (!preview || !App.doc.previewText) return;
      const ratio = Math.min(1, (ref.start || 0) / (App.doc.previewText.length || 1));
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      preview.classList.add('flash');
      setTimeout(() => preview.classList.remove('flash'), 700);
    },

    appendError(msg) {
      const area = document.getElementById('docMessages');
      const e = document.createElement('div');
      e.className = 'doc-msg msg assistant';
      e.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
        <div class="msg-body"><div class="msg-card"><div class="bubble"><span class="error">${msg}</span></div></div></div>`;
      area.appendChild(e);
    },
  };
})();
