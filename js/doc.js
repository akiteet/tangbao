'use strict';
(function () {
  window.App = window.App || {};

  const MAX_DOC_CHARS = 200000;   // 单文件读取上限
  const DOC_STORE_CAP = 40000;    // 持久化时单文档截断长度
  const MAX_DOCS = 8;
  const CHUNK_SIZE = 1800;
  const TOP_K = 6;
  const PREVIEW_CAP = 20000;      // 预览显示上限
  const FULLTEXT_THRESHOLD = 9000;

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
        <div class="doc-model-row">
          <span class="opt-label">模型</span>
          <select class="img-model-pick" id="docModel">${docModelOpts}</select>
        </div>
        <div class="doc-panel">
          <div class="doc-toolbar">
            <div class="dropzone compact" id="docDropzone">
              <input type="file" id="docFile" accept=".txt,.md,.csv,.json,.jsonl,.log,.pdf,text/*" multiple>
              <span class="dz-text-sm">＋ 上传文件（可多选，支持 PDF）</span>
            </div>
            <button class="btn-ghost mini" id="docPasteBtn">粘贴文本</button>
          </div>
          <div class="doc-list" id="docList">${docChips || '<span class="doc-list-empty">暂无文档</span>'}</div>
          <div class="doc-analysis-bar" id="docAnalysisBar" style="display:${App.doc.activeDoc() ? 'flex' : 'none'}">
            <button data-act="summary">摘要</button>
            <button data-act="points">要点</button>
            <button data-act="translate">翻译</button>
            <button data-act="outline">拆解</button>
          </div>
          <div class="doc-split">
            <div class="doc-outline" id="docOutline"></div>
            <div class="doc-stage">
              <div class="doc-preview" id="docPreview" style="display:none"></div>
              <div class="doc-chat-area" id="docChatArea" style="display:none">
                <div class="doc-messages" id="docMessages"></div>
                <div class="doc-composer">
                  <textarea id="docInput" rows="1" placeholder="基于文档提问…"></textarea>
                  <button id="docSendBtn" disabled>➤</button>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      App.doc.bind();
      App.doc.renderOutline();
      const d = App.doc.activeDoc();
      if (d) App.doc.showDoc(d);
    },

    bind() {
      const dz = document.getElementById('docDropzone');
      const input = document.getElementById('docFile');
      dz.addEventListener('click', () => input.click());
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
      if (App.doc.activeId === id) App.doc.activeId = list[0] ? list[0].id : null;
      App.persist();
      App.doc.render();
    },

    switchDoc(id) {
      App.doc.activeId = id;
      App.persist();
      App.doc.render();
    },

    showDoc(d) {
      document.getElementById('docAnalysisBar').style.display = 'flex';
      const preview = document.getElementById('docPreview');
      preview.style.display = 'block';
      App.doc.previewText = d.text.slice(0, PREVIEW_CAP);
      preview.textContent = App.doc.previewText + (d.text.length > PREVIEW_CAP ? '\n…（预览已截断）' : '');
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
        el.addEventListener('click', () => App.doc.scrollToPos(Number(el.dataset.pos)));
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

    chunks(text) {
      const out = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) out.push(text.slice(i, i + CHUNK_SIZE));
      return out;
    },

    buildContext(question) {
      const d = App.doc.activeDoc();
      if (!d) return { context: '', refs: [] };
      if (d.text.length <= FULLTEXT_THRESHOLD) {
        return { context: d.text, refs: [], full: true };
      }
      const words = question.split(/\s+/).filter(w => w.length > 1);
      const chs = App.doc.chunks(d.text);
      const scored = chs.map((ch, i) => {
        let s = 0; for (const w of words) if (ch.includes(w)) s += 1;
        return { ch, i, s };
      }).sort((a, b) => b.s - a.s).slice(0, TOP_K);
      const picked = scored.sort((a, b) => a.i - b.i);
      const context = picked.map((p, k) => `[${k + 1}] ${p.ch}`).join('\n---\n');
      return { context, refs: picked.map(p => p.ch), full: false };
    },

    async send(custom) {
      const input = document.getElementById('docInput');
      const text = (custom != null) ? custom : (input ? input.value.trim() : '');
      if (!text || App.doc.streaming) return;
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return; }

      const area = document.getElementById('docMessages');
      const userNode = document.createElement('div');
      userNode.className = 'doc-msg user';
      userNode.textContent = text;
      area.appendChild(userNode);
      if (input) { input.value = ''; document.getElementById('docSendBtn').disabled = true; }
      area.scrollTop = area.scrollHeight;

      const p = App.getProvider('doc');
      if (!p.apiBase || !p.apiKey || !p.model) {
        App.doc.appendError('尚未配置文档 API。请先在设置里填写“文档”或“默认”的 API 信息。');
        return;
      }
      const ctx = App.doc.buildContext(text);
      let sysExtra = ctx.full
        ? '请仅依据以下完整资料回答用户问题。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context
        : '请仅依据以下带编号的资料片段回答（引用请用 [1]..[n] 格式标注来源）。如果资料中没有答案，请明确说明。\n\n资料：\n' + ctx.context;

      const payload = {
        model: p.model, stream: true,
        messages: [{ role: 'system', content: sysExtra }, { role: 'user', content: text }],
      };
      App.doc.streaming = true;
      const ai = document.createElement('div');
      ai.className = 'doc-msg assistant';
      ai.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      area.appendChild(ai);
      let acc = '', started = false;
      try {
        const url = p.apiBase.replace(/\/+$/, '') + '/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.apiKey },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          ai.innerHTML = `<span class="error">请求失败（${res.status}）：${App.escapeHtml(txt.slice(0, 200))}</span>`;
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
              if (!started) { ai.innerHTML = ''; started = true; }
              acc += delta.content;
              ai.innerHTML = App.renderMarkdown(acc);
              area.scrollTop = area.scrollHeight;
            }
          }
        }
        // 引用溯源
        if (!ctx.full && ctx.refs.length) App.doc.renderCites(ai, acc, ctx.refs);
      } catch (err) {
        ai.innerHTML = `<span class="error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</span>`;
      }
      App.doc.streaming = false;
    },

    analyze(act) {
      const pr = App.state.settings.prompts;
      const custom = pr && pr.doc && pr.doc[act];
      const prompt = (custom && String(custom).trim()) ? String(custom).trim() : AnalysisPrompts[act];
      const d = App.doc.activeDoc();
      if (!d) { App.ui.toast('请先上传或粘贴文档'); return; }
      const full = d.text.length <= FULLTEXT_THRESHOLD ? d.text : d.text.slice(0, CHUNK_SIZE * TOP_K);
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
        const idx = n - 1;
        const snip = (refs[idx] || '').slice(0, 160).replace(/\n/g, ' ');
        return `<button class="doc-cite" data-n="${n}">[${n}] ${App.escapeHtml(snip)}</button>`;
      }).join('');
      footer.querySelectorAll('.doc-cite').forEach(b => {
        b.addEventListener('click', () => App.doc.locateCite(Number(b.dataset.n), refs));
      });
      aiNode.appendChild(footer);
    },

    locateCite(n, refs) {
      const snip = refs[n - 1];
      if (!snip) return;
      const preview = document.getElementById('docPreview');
      if (!preview || !App.doc.previewText) return;
      const idx = App.doc.previewText.indexOf(snip.slice(0, 60));
      if (idx >= 0) {
        const ratio = Math.min(1, idx / App.doc.previewText.length);
        preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      }
      preview.classList.add('flash');
      setTimeout(() => preview.classList.remove('flash'), 700);
    },

    appendError(msg) {
      const area = document.getElementById('docMessages');
      const e = document.createElement('div');
      e.className = 'doc-msg assistant';
      e.innerHTML = `<span class="error">${msg}</span>`;
      area.appendChild(e);
    },
  };
})();
