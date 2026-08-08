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
  const LOW_SCORE_THRESHOLD = 0.05; // BM25 top1 得分低于此值 → 低相关提示

  // M7：文档分块缓存（外部 Map，避免 _chunks 字段污染 doc 对象被 persist 序列化）
  const chunkCache = new Map(); // docId -> { key: text, chunks: [...] }

  const AnalysisPrompts = App.DEFAULT_PROMPTS.doc;

  App.doc = {
    activeId: null,
    streaming: false,
    previewText: '',

    onShow() { App.doc.render(); },

    docs() { return App.state.settings.docs || (App.state.settings.docs = []); },
    activeDoc() {
      const list = App.doc.docs();
      if (App.doc.activeId) {
        const d = list.find(x => x.id === App.doc.activeId);
        if (d) return d;
      }
      return list[0] || null;
    },

    render() {
      const wrap = document.getElementById('docView');
      if (!wrap) return;
      const docProv = App.getProvider('doc');
      const docModels = (docProv.models && docProv.models.length) ? docProv.models : (docProv.model ? [docProv.model] : []);
      const docSel = docProv.model || docModels[0] || '';
      const docModelOpts = docModels.length
        ? docModels.map(m => `<option value="${App.escapeHtml(m)}"${m === docSel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置文档模型，请到设置填写</option>';

      const list = App.doc.docs();
      const docChips = list.map(d => `
        <div class="doc-chip${d.id === (App.doc.activeDoc() && App.doc.activeDoc().id) ? ' active' : ''}" data-doc="${d.id}">
          <span class="doc-chip-name">${App.escapeHtml(d.name)}</span>
          <button class="doc-chip-del" data-del="${d.id}" title="删除">✕</button>
        </div>`).join('');

      wrap.innerHTML = `
        <div class="module-header">
          <h2>糖读</h2>
          <p>上传文本 / PDF，向糖包提问；支持多文档、引用溯源与一键分析</p>
        </div>
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
                    <input type="file" id="docFile" accept=".txt,.md,.csv,.json,.jsonl,.log,.pdf,text/*" multiple>
                    <span class="dz-text-sm">＋ 上传文件（可多选，支持 PDF）</span>
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
                  <button data-act="translate">翻译</button>
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
                <div class="doc-empty-sub">支持 TXT / Markdown / PDF，上传后可提问、摘要、引用溯源</div>
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

      const paste = document.getElementById('docPasteBtn');
      if (paste) paste.addEventListener('click', () => App.doc.pasteText());

      const list = document.getElementById('docList');
      if (list) list.addEventListener('click', (e) => {
        const del = e.target.closest('.doc-chip-del');
        if (del) { e.stopPropagation(); App.doc.removeDoc(del.dataset.del); return; }
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
        const dz = document.getElementById('docDropzone');
        const inp = document.getElementById('docFile');
        if (inp) inp.click();
      });
      const drawerClose = document.getElementById('docDrawerClose');
      if (drawerClose) drawerClose.addEventListener('click', () => App.doc.closeDrawer());
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
    },

    closeDrawer() {
      const drawer = document.getElementById('docDrawer');
      if (drawer) drawer.classList.remove('open');
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

    async readFile(file) {
      if (!file) return;
      let text = '';
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      try {
        if (isPdf) {
          text = await App.doc.extractPdf(file);
        } else {
          text = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(new Error('读取失败'));
            r.readAsText(file);
          });
        }
      } catch (e) {
        App.ui.toast('读取失败：' + (e.message || e) + '（PDF 需后端或联网，请尝试粘贴文本）');
        return;
      }
      if (file.size > MAX_DOC_CHARS) App.ui.toast('文档较大，已截断处理');
      text = text.slice(0, MAX_DOC_CHARS);
      App.doc.addDoc({ name: file.name, text, size: file.size });
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
            <textarea id="docPasteArea" rows="8" placeholder="把文档文本粘贴到这里…" style="width:100%;min-height:160px;resize:vertical;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:14px;outline:none;"></textarea>
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
      while (list.length > MAX_DOCS) list.pop();
      App.doc.activeId = doc.id;
      App.persist();
      App.ui.toast('已添加：' + name);
      App.doc.render();
    },

    removeDoc(id) {
      const list = App.doc.docs();
      const idx = list.findIndex(x => x.id === id);
      if (idx >= 0) list.splice(idx, 1);
      chunkCache.delete(id);
      if (App.doc.activeId === id) App.doc.activeId = list[0] ? list[0].id : null;
      App.persist();
      App.doc.render();
    },

    switchDoc(id) {
      App.doc.activeId = id;
      App.persist();
      App.doc.openDrawer();
      App.doc.render();
    },

    showDoc(d) {
      document.getElementById('docAnalysisBar').style.display = 'flex';
      // M10：预览移入右侧抽屉（#docPreview 在抽屉内），这里只更新内容，显示由抽屉控制
      const preview = document.getElementById('docPreview');
      App.doc.previewText = d.text.slice(0, PREVIEW_CAP);
      if (preview) preview.textContent = App.doc.previewText + (d.text.length > PREVIEW_CAP ? '\n…（预览已截断）' : '');
      const empty = document.getElementById('docEmpty');
      if (empty) empty.style.display = 'none';
      document.getElementById('docChatArea').style.display = 'flex';
      App.doc.renderOutline();
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

    async send(custom) {
      const input = document.getElementById('docInput');
      const text = (custom != null) ? custom : (input ? input.value.trim() : '');
      if (!text || App.doc.streaming) return;
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return; }

      const area = document.getElementById('docMessages');
      // M10：复用聊天模块视觉（.msg.user 反向布局 + user-bubble）
      const userNode = document.createElement('div');
      userNode.className = 'doc-msg msg user';
      userNode.innerHTML = '<div class="msg-body"><div class="bubble user-bubble"></div></div>';
      userNode.querySelector('.bubble').textContent = text;
      area.appendChild(userNode);
      if (input) { input.value = ''; document.getElementById('docSendBtn').disabled = true; }
      area.scrollTop = area.scrollHeight;

      const p = App.getProvider('doc');
      if (!p.ref || !p.hasKey || !p.model) {
        App.doc.appendError('尚未配置文档 API。请先在设置里填写“文档”或“默认”的 API 信息。');
        return;
      }
      const ctx = App.doc.buildContext(text, App.state.settings.docScope === 'all' ? 'all' : 'current');
      let sysExtra;
      if (ctx.full) {
        sysExtra = '请仅依据以下完整资料回答用户问题。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context;
      } else {
        sysExtra = '请仅依据以下带编号的资料片段回答（引用请用 [1]..[n] 格式标注来源）。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context;
        if (ctx.lowConf) sysExtra = '⚠️ 检索到的资料片段与问题相关性较低，资料中很可能没有答案。请如实告知用户，不要编造。\n\n' + sysExtra;
      }

      const payload = {
        model: p.model, stream: true,
        messages: [{ role: 'system', content: sysExtra }, { role: 'user', content: text }],
      };
      App.doc.streaming = true;
      // M10：复用聊天视觉（头像 + 卡片气泡 + 复制按钮）
      const ai = document.createElement('div');
      ai.className = 'doc-msg msg assistant';
      ai.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
        <div class="msg-body"><div class="msg-card">
          <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>
          <div class="msg-actions" style="display:none"><button data-doc-copy="1">复制</button></div>
        </div></div>`;
      area.appendChild(ai);
      const aiBubble = ai.querySelector('.bubble');
      let acc = '', started = false;
      try {
        // 走主进程模型网关（原来是渲染进程直连，既暴露密钥又受 CORS 限制）
        const res = await App.rt.gatewayFetch({ ref: p.ref, kind: 'chat', payload });
        if (!res.ok) {
          const txt = await App.rt.gatewayError(res);
          aiBubble.innerHTML = `<span class="error">请求失败（${res.status}）：${App.escapeHtml(String(txt).slice(0, 200))}</span>`;
          App.doc.streaming = false; return;
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
        // 引用溯源
        if (!ctx.full && ctx.refs.length) App.doc.renderCites(ai, acc, ctx.refs);
        // 完成：显示复制按钮
        const actions = ai.querySelector('.msg-actions');
        if (actions) actions.style.display = 'flex';
        const copyBtn = ai.querySelector('[data-doc-copy]');
        if (copyBtn) copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(acc || '').then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
        });
      } catch (err) {
        aiBubble.innerHTML = `<span class="error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</span>`;
      }
      App.doc.streaming = false;
    },

    analyze(act) {
      const pr = App.state.settings.prompts;
      const custom = pr && pr.doc && pr.doc[act];
      const prompt = (custom && String(custom).trim()) ? String(custom).trim() : AnalysisPrompts[act];
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return; }
      const full = d.text.length <= FULLTEXT_THRESHOLD ? d.text : d.text.slice(0, CHUNK_TARGET * TOP_K);
      App.doc.send(prompt + '\n\n资料：\n' + full);
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
