'use strict';
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);

  const STYLES = {
    default: { label: '默认', suffix: '' },
    watercolor: { label: '水彩', suffix: '，水彩风格' },
    cyberpunk: { label: '赛博朋克', suffix: '，赛博朋克风格' },
    anime: { label: '动漫', suffix: '，动漫风格' },
    realistic: { label: '写实', suffix: '，写实照片风格' },
    oil: { label: '油画', suffix: '，油画风格' },
  };

  const SIZES = [
    { label: '1:1', value: '1024x1024', ratio: 'r11' },
    { label: '16:9', value: '1792x1024', ratio: 'r169' },
    { label: '9:16', value: '1024x1792', ratio: 'r916' },
  ];
  const SIZE_LABEL = {}; SIZES.forEach(s => SIZE_LABEL[s.value] = s.label);

  const EXAMPLES = [
    '一只宇航员猫在月球上弹吉他',
    '赛博朋克风格的未来城市夜景',
    '水彩风格的春日山谷与溪流',
    '宫崎骏动画风的空中浮岛',
    '极简主义咖啡馆室内设计',
  ];

  const HISTORY_CAP = 30;

  App.image = {
    results: [],
    lastPrompt: '',
    rawPrompt: '',
    sel: { style: 'default', size: '1024x1024', n: '1' },
    pending: false,
    lbImages: [], lbPrompt: '', lbIdx: 0,
    refImage: null,   // 参考图片 base64 data URL（用于图片编辑）

    onShow() {
      App.image.render();
      const t = document.getElementById('chatTitle');
      if (t) t.textContent = '糖绘';
    },

    render() {
      const wrap = $('imageView');
      if (!wrap) return;

      // 图像模型选择器：读当前图像账户模型列表
      const imgProv = App.getProvider('image');
      const imgModels = (imgProv.models && imgProv.models.length) ? imgProv.models : (imgProv.model ? [imgProv.model] : []);
      const imgSel = imgProv.model || imgModels[0] || '';
      const modelOpts = imgModels.length
        ? imgModels.map(m => `<option value="${App.escapeHtml(m)}"${m === imgSel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置图像模型，请到设置填写</option>';

      wrap.innerHTML = `
        <div class="module-header">
          <h2>糖绘</h2>
          <p>输入描述，糖包帮你生成图片</p>
        </div>
        <div class="image-panel" id="imgPanel">
          <div class="image-input-wrap">
            <textarea id="imgPrompt" rows="3" placeholder="描述你想要的画面，例如：一只宇航员猫在月球上弹吉他"></textarea>
            <div class="img-ref-area" id="imgRefArea">
              <div class="img-ref-chip" id="imgRefChip" style="display:none">
                <img id="imgRefThumb" src="" alt="参考图">
                <span id="imgRefName"></span>
                <button type="button" id="imgRefRemove" title="移除参考图">×</button>
              </div>
              <button type="button" class="btn-ghost mini" id="imgRefBtn">📷 上传参考图</button>
              <input type="file" id="imgRefInput" accept="image/*" hidden />
            </div>
            <div class="img-examples" id="imgExamples">
              ${EXAMPLES.map(ex => `<button type="button" class="example-chip" data-ex="${App.escapeHtml(ex)}">${App.escapeHtml(ex)}</button>`).join('')}
            </div>
          </div>
          <div class="image-options" id="imgOptions">
            <div class="opt-group">
              <span class="opt-label">风格</span>
              <div class="chip-row" data-group="style">
                ${Object.entries(STYLES).map(([k, v]) => `<button type="button" class="chip" data-group="style" data-val="${k}">${v.label}</button>`).join('')}
              </div>
            </div>
            <div class="opt-group">
              <span class="opt-label">尺寸</span>
              <div class="chip-row" data-group="size">
                ${SIZES.map(s => `<button type="button" class="chip" data-group="size" data-val="${s.value}"><span class="size-ico ${s.ratio}"></span>${s.label}</button>`).join('')}
              </div>
            </div>
            <div class="opt-group">
              <span class="opt-label">数量</span>
              <div class="chip-row" data-group="n">
                ${['1', '2', '3', '4'].map(v => `<button type="button" class="chip" data-group="n" data-val="${v}">${v}</button>`).join('')}
              </div>
            </div>
            <div class="opt-group">
              <span class="opt-label">模型</span>
              <select class="img-model-pick" id="imgModel">${modelOpts}</select>
            </div>
          </div>
          <button class="gen-btn" id="imgGenBtn">✨ 生成图片</button>
          <div class="image-status" id="imgStatus"></div>
          <div class="image-grid" id="imgGrid"></div>
          <div class="history-section" id="imgHistory"></div>
        </div>`;

      App.image.syncChips();
      App.image.bind();

      // 初始画廊：优先内存结果，否则回填最近一次历史，否则空状态
      const hist = App.state.settings.imageHistory || [];
      if (App.image.results.length) {
        App.image.renderGrid(App.image.results, App.image.lastPrompt);
      } else if (hist.length) {
        const last = hist[0];
        const p = last.prompt + (STYLES[last.style] ? STYLES[last.style].suffix : '');
        App.image.renderGrid(last.images, p);
      } else {
        App.image.renderGrid([], '');
      }
      App.image.renderHistory();
    },

    bind() {
      const btn = $('imgGenBtn');
      if (btn) btn.addEventListener('click', () => App.image.generate());

      // 参考图片上传
      {
        const refInput = $('imgRefInput');
        const refBtn = $('imgRefBtn');
        const refRemove = $('imgRefRemove');
        const refChip = $('imgRefChip');
        const refThumb = $('imgRefThumb');
        const refName = $('imgRefName');
        const genBtn = $('imgGenBtn');

        const showRef = (dataUrl, name) => {
          App.image.refImage = dataUrl;
          if (refChip) refChip.style.display = 'flex';
          if (refThumb) refThumb.src = dataUrl;
          if (refName) refName.textContent = name || '参考图';
          if (genBtn) genBtn.textContent = '🎨 编辑图片';
        };
        const hideRef = () => {
          App.image.refImage = null;
          if (refChip) refChip.style.display = 'none';
          if (genBtn) genBtn.textContent = '✨ 生成图片';
        };

        const processRefImage = async (file) => {
          if (!file || !file.type.startsWith('image/')) return;
          try {
            const dataUrl = await compressImage(file);
            showRef(dataUrl, file.name);
          } catch (e) { App.ui.toast('图片处理失败：' + (e.message || '未知')); }
        };

        if (refBtn && refInput) {
          refBtn.addEventListener('click', () => refInput.click());
          refInput.addEventListener('change', () => {
            const files = refInput.files ? Array.from(refInput.files) : [];
            files.forEach(f => processRefImage(f));
            refInput.value = '';
          });
        }
        if (refRemove) refRemove.addEventListener('click', hideRef);

        // 粘贴参考图
        const ta = $('imgPrompt');
        if (ta) ta.addEventListener('paste', (e) => {
          const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
          items.forEach(item => {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) { e.preventDefault(); processRefImage(file); }
            }
          });
        });

        // 拖拽参考图
        const panel = $('imgPanel');
        if (panel) {
          panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drag-over'); });
          panel.addEventListener('dragleave', () => panel.classList.remove('drag-over'));
          panel.addEventListener('drop', (e) => {
            e.preventDefault();
            panel.classList.remove('drag-over');
            const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
            files.forEach(f => processRefImage(f));
          });
        }
      }

      const opts = $('imgOptions');
      if (opts) opts.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        App.image.sel[chip.dataset.group] = chip.dataset.val;
        App.image.syncChips();
      });

      const ex = $('imgExamples');
      if (ex) ex.addEventListener('click', (e) => {
        const c = e.target.closest('.example-chip');
        if (!c) return;
        const ta = $('imgPrompt');
        if (ta) { ta.value = c.dataset.ex; ta.focus(); }
      });

      // 内联图像模型选择：直接写 providers.image.model
      const msel = $('imgModel');
      if (msel) msel.addEventListener('change', () => {
        const val = msel.value;
        if (!val) return;
        const prov = App.state.settings.providers.image || (App.state.settings.providers.image = { accountId: '__default__' });
        prov.model = val;
        App.persist();
        App.ui.toast('已切换图像模型：' + val);
      });
    },

    syncChips() {
      document.querySelectorAll('#imgOptions .chip').forEach(chip => {
        const active = App.image.sel[chip.dataset.group] === chip.dataset.val;
        chip.classList.toggle('active', active);
      });
    },

    async generate() {
      const ta = $('imgPrompt');
      const prompt = ta ? ta.value.trim() : '';
      if (!prompt) { App.ui.toast('请输入画面描述'); return; }
      const p = App.getProvider('image');
      const status = $('imgStatus');
      if (!p.apiBase || !p.apiKey || !p.model) {
        if (status) status.innerHTML = '<span class="warn">尚未配置图像 API。请点击左下角齿轮 → 在"图像"标签或"默认"标签填写信息。</span>';
        return;
      }
      const styleKey = App.image.sel.style;
      const sizeObj = SIZES.find(s => s.value === App.image.sel.size) || SIZES[0];
      const refImg = App.image.refImage;
      let finalPrompt = prompt
        + (STYLES[styleKey] ? STYLES[styleKey].suffix : '')
        + '，比例 ' + sizeObj.label;
      if (refImg) finalPrompt = '请根据以下描述编辑这张图片：' + finalPrompt;
      const size = App.image.sel.size;
      const n = Number(App.image.sel.n) || 1;

      App.image.pending = true;
      const btn = $('imgGenBtn');
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
      if (status) status.textContent = '正在生成…';
      App.image.renderSkeleton(n);

      try {
        const apiFetch = (window.electron && window.electron.fetch) || fetch;
        let res, data;
        if (refImg) {
          // 图片编辑：用 chat completions vision 格式
          const url = p.apiBase.replace(/\/+$/, '') + '/chat/completions';
          const content = [{ type: 'text', text: finalPrompt }, { type: 'image_url', image_url: { url: refImg } }];
          res = await apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.apiKey },
            body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content }], stream: false }),
          });
        } else {
          // 文生图：标准 images/generations
          const url = p.apiBase.replace(/\/+$/, '') + '/images/generations';
          res = await apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.apiKey },
            body: JSON.stringify({ model: p.model, prompt: finalPrompt, n, size, response_format: 'b64_json' }),
          });
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          if (status) status.innerHTML = `<span class="error">请求失败（${res.status}）：${App.escapeHtml(txt.slice(0, 200))}</span>`;
          App.image.renderGrid(App.image.results, App.image.lastPrompt);
          return;
        }
        data = await res.json();
        let arr;
        if (refImg) {
          // chat completions 返回：尝试从 choices[0].message.content 提取 base64
          const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
          const text = msg.content || '';
          const b64Match = text.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
          arr = b64Match ? [b64Match[1]] : [];
          if (!arr.length) arr = text ? [text] : [];
        } else {
          arr = (data.data || []).map(it => it.b64_json || '').filter(Boolean);
        }
        if (!arr.length) {
          if (status) status.textContent = '未返回图片。';
          App.image.renderGrid(App.image.results, App.image.lastPrompt);
          return;
        }
        App.image.results = arr;
        App.image.rawPrompt = prompt;
        App.image.lastPrompt = finalPrompt;
        App.image.renderGrid(arr, finalPrompt);
        App.image.pushHistory({ prompt, style: styleKey, size, n, images: arr });
        if (status) status.textContent = `已生成 ${arr.length} 张图片`;
      } catch (err) {
        if (status) status.innerHTML = `<span class="error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</span>`;
        App.image.renderGrid(App.image.results, App.image.lastPrompt);
      } finally {
        App.image.pending = false;
        if (btn) { btn.disabled = false; btn.textContent = refImg ? '🎨 编辑图片' : '✨ 生成图片'; }
      }
    },

    renderSkeleton(n) {
      const grid = $('imgGrid');
      if (!grid) return;
      const cnt = Math.max(1, Math.min(n || 1, 4));
      grid.innerHTML = Array.from({ length: cnt }).map(() =>
        `<div class="img-card img-skeleton"><div class="sk-img"></div></div>`).join('');
    },

    renderGrid(images, prompt) {
      const grid = $('imgGrid');
      if (!grid) return;
      if (!images || !images.length) {
        grid.innerHTML = `
          <div class="img-empty">
            <div class="img-empty-ico">🖼️</div>
            <div class="img-empty-text">还没有生成图片</div>
            <div class="img-empty-sub">描述一下你想画的画面，点「生成图片」试试</div>
          </div>`;
        return;
      }
      grid.innerHTML = images.map((b, i) => `
        <div class="img-card" data-i="${i}">
          <img src="data:image/png;base64,${b}" alt="生成结果 ${i + 1}">
          <div class="img-card-mask">
            <button type="button" class="card-act copy-prompt" data-i="${i}">复制提示词</button>
            <button type="button" class="card-act download-btn" data-i="${i}">下载</button>
          </div>
        </div>`).join('');
      grid.querySelectorAll('.img-card').forEach(c => c.addEventListener('click', () => App.image.openLightbox(images, +c.dataset.i, prompt)));
      grid.querySelectorAll('.download-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); App.image.download(b64Of(images, +b.dataset.i), +b.dataset.i); }));
      grid.querySelectorAll('.copy-prompt').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); App.image.copyPrompt(prompt); }));
    },

    pushHistory(entry) {
      const hist = App.state.settings.imageHistory || (App.state.settings.imageHistory = []);
      hist.unshift(Object.assign({ id: App.uid(), createdAt: Date.now() }, entry));
      while (hist.length > HISTORY_CAP) hist.pop();
      App.persist();
      App.image.renderHistory();
    },

    renderHistory() {
      const box = $('imgHistory');
      if (!box) return;
      const hist = App.state.settings.imageHistory || [];
      if (!hist.length) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <div class="history-head">历史记录<span class="history-count">最近 ${hist.length} 次</span></div>
        ${hist.map((e, ei) => `
          <div class="history-item">
            <div class="history-meta">
              <div class="history-prompt">${App.escapeHtml(e.prompt)}</div>
              <div class="history-sub">${SIZE_LABEL[e.size] || e.size} · ${e.n} 张 · ${timeAgo(e.createdAt)}</div>
            </div>
            <div class="history-thumbs">
              ${e.images.slice(0, 4).map((b, j) => `<button type="button" class="history-thumb" data-ei="${ei}" data-j="${j}"><img src="data:image/png;base64,${b}" alt=""></button>`).join('')}
            </div>
          </div>`).join('')}`;
      box.querySelectorAll('.history-thumb').forEach(t => t.addEventListener('click', () => {
        const e = hist[+t.dataset.ei];
        if (e) App.image.openLightbox(e.images, +t.dataset.j, e.prompt + (STYLES[e.style] ? STYLES[e.style].suffix : ''));
      }));
    },

    openLightbox(images, idx, prompt) {
      App.image.lbImages = images;
      App.image.lbPrompt = prompt || '';
      App.image.lbIdx = idx;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'imgLightboxMask';
      mask.innerHTML = `
        <div class="modal agent-modal img-lightbox" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span>图片预览</span>
            <button class="icon-btn" id="lbClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body lb-body">
            <div class="lb-stage">
              <button class="lb-nav lb-prev" id="lbPrev" aria-label="上一张">‹</button>
              <img id="lbImg" src="" alt="预览">
              <button class="lb-nav lb-next" id="lbNext" aria-label="下一张">›</button>
            </div>
            <div class="lb-prompt" id="lbPrompt"></div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="lbRegen">重新生成</button>
            <button class="btn-ghost" id="lbCopy">复制提示词</button>
            <button class="btn-primary" id="lbDownload">下载</button>
          </div>
        </div>`;
      $('imageView').appendChild(mask);
      const close = () => mask.remove();
      const render = () => {
        const i = App.image.lbIdx;
        const im = $('lbImg'); if (im) im.src = 'data:image/png;base64,' + App.image.lbImages[i];
        const pr = $('lbPrompt'); if (pr) pr.textContent = App.image.lbPrompt;
        const prev = $('lbPrev'), next = $('lbNext');
        const multi = App.image.lbImages.length > 1;
        if (prev) prev.style.display = multi ? '' : 'none';
        if (next) next.style.display = multi ? '' : 'none';
      };
      render();
      mask.querySelector('#lbClose').addEventListener('click', close);
      mask.querySelector('#lbCopy').addEventListener('click', () => App.image.copyPrompt(App.image.lbPrompt));
      mask.querySelector('#lbDownload').addEventListener('click', () => App.image.download(App.image.lbImages[App.image.lbIdx], App.image.lbIdx));
      mask.querySelector('#lbRegen').addEventListener('click', () => { close(); App.image.regenerate(); });
      mask.querySelector('#lbPrev').addEventListener('click', () => {
        App.image.lbIdx = (App.image.lbIdx - 1 + App.image.lbImages.length) % App.image.lbImages.length;
        render();
      });
      mask.querySelector('#lbNext').addEventListener('click', () => {
        App.image.lbIdx = (App.image.lbIdx + 1) % App.image.lbImages.length;
        render();
      });
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    },

    regenerate() {
      const ta = $('imgPrompt');
      if (ta && App.image.rawPrompt) ta.value = App.image.rawPrompt;
      App.image.generate();
    },

    download(b64, idx) {
      if (!b64) return;
      const a = document.createElement('a');
      a.href = 'data:image/png;base64,' + b64;
      a.download = `tangbao-${Date.now()}-${(idx || 0) + 1}.png`;
      a.click();
    },

    copyPrompt(text) {
      const t = text || '';
      if (!t) { App.ui.toast('没有可复制的提示词'); return; }
      const done = () => App.ui.toast('已复制提示词');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
      } else {
        fallbackCopy(t, done);
      }
    },
  };

  function b64Of(images, i) { return images && images[i] ? images[i] : ''; }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      if (done) done();
    } catch (e) { App.ui.toast('复制失败'); }
  }

  function timeAgo(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function compressImage(file) {
    const MAX_EDGE = 4096;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          const max = Math.max(w, h);
          if (max > MAX_EDGE) { const s = MAX_EDGE / max; w = Math.round(w * s); h = Math.round(h * s); }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.92));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }
})();
