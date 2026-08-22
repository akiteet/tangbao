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
    { label: '4:3', value: '1280x960', ratio: 'r43' },
    { label: '3:4', value: '960x1280', ratio: 'r34' },
  ];
  const SENSENOVA_U1_SIZES = [
    { label: '2:3', value: '1664x2496', ratio: 'r23' },
    { label: '3:2', value: '2496x1664', ratio: 'r32' },
    { label: '3:4', value: '1760x2368', ratio: 'r34' },
    { label: '4:3', value: '2368x1760', ratio: 'r43' },
    { label: '4:5', value: '1824x2272', ratio: 'r45' },
    { label: '5:4', value: '2272x1824', ratio: 'r54' },
  ];
  const SIZE_LABEL = {};
  [...SIZES, ...SENSENOVA_U1_SIZES].forEach((s) => { SIZE_LABEL[s.value] = s.label; });
  const imageSizeCache = Object.create(null);
  const IMAGE_CORE_KEYS = new Set([
    'model', 'prompt', 'messages', 'size', 'n', 'response_format',
    'imageProtocol', 'imageSizeStrategy', 'imageSizeFormat', 'imageSizes',
  ]);

  function imageCapabilityApi() {
    return (window.App && window.App.ImageCapabilities) || null;
  }

  function ratioLabel(width, height) {
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = gcd(Math.abs(width), Math.abs(height)) || 1;
    const exact = (width / divisor) + ':' + (height / divisor);
    const ratio = width / height;
    const common = [
      [1, 1, '1:1'], [16 / 9, 1, '16:9'], [9 / 16, 1, '9:16'],
      [3 / 2, 1, '3:2'], [2 / 3, 1, '2:3'], [4 / 3, 1, '4:3'],
      [3 / 4, 1, '3:4'], [5 / 4, 1, '5:4'], [4 / 5, 1, '4:5'],
      [2, 1, '2:1'], [1 / 2, 1, '1:2'], [3, 1, '3:1'], [1 / 3, 1, '1:3'],
    ];
    const closest = common.reduce((best, item) => {
      const distance = Math.abs(Math.log(ratio / item[0]));
      return !best || distance < best.distance ? { distance, label: item[2] } : best;
    }, null);
    return closest && closest.distance < 0.035 ? closest.label : exact;
  }

  function ratioClass(width, height) {
    return 'r' + ratioLabel(width, height).replace(':', '');
  }

  function normalizeSizeOptions(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    const seen = new Set();
    list.forEach((item) => {
      const raw = typeof item === 'string' ? item : item && (item.value || item.size || item.resolution);
      const valueText = String(raw || '').match(/^\s*(\d{3,5})\s*[x\u00d7*]\s*(\d{3,5})\s*$/i);
      if (!valueText) return;
      const valueKey = valueText[1] + 'x' + valueText[2];
      if (seen.has(valueKey)) return;
      seen.add(valueKey);
      const width = Number(valueText[1]);
      const height = Number(valueText[2]);
      const ratio = width === height ? '1:1' : (width / height).toFixed(2);
      out.push({
        label: (item && item.label) || SIZE_LABEL[valueKey] || ratioLabel(width, height),
        value: valueKey,
        ratio: (item && item.ratio) || ratioClass(width, height),
        width,
        height,
        ratioValue: ratio,
      });
    });
    return out;
  }

  function providerKey(provider) {
    const p = provider || {};
    return String(p.apiBase || '') + '|' + String(p.model || '');
  }

  function isSenseNovaU1(provider) {
    const p = provider || {};
    const base = String(p.apiBase || '').toLowerCase();
    const model = String(p.model || '').toLowerCase();
    const api = imageCapabilityApi();
    if (api && typeof api.isSenseNovaU1Model === 'function' && api.isSenseNovaU1Model(model)) return true;
    return (/sensenova|sensetime/.test(base) && /^sensenova[-_ ]?u1(?:[-_ ]fast)?$/.test(model))
      || /^sensenova[-_ ]?u1(?:[-_ ]fast)?$/.test(model);
  }

  function resolveImageCapabilities(provider) {
    const p = provider || {};
    const key = providerKey(p);
    const api = imageCapabilityApi();
    if (api) {
      if (typeof api.resolve === 'function') {
        try {
          const settings = window.App && window.App.state && window.App.state.settings
            ? window.App.state.settings : {};
          const result = api.resolve(p.apiBase || '', p.model || '', {
            config: p.profile || p,
            store: settings.imageCapabilities || {},
          });
          if (result && typeof result === 'object') {
            const sizes = normalizeSizeOptions(result.sizes || result.sizeOptions || result.resolutions);
            return Object.assign({}, result, {
              sizes: sizes.map((item) => item.value),
              sizeOptions: sizes,
              uiSizes: normalizeSizeOptions(result.uiSizes || (api.DEFAULT_UI_SIZES || [])),
            });
          }
        } catch (_) {}
      }
    }
    if (imageSizeCache[key] && imageSizeCache[key].length) return { sizes: imageSizeCache[key].map((item) => item.value || item) };
    return { sizes: isSenseNovaU1(p) ? SENSENOVA_U1_SIZES.slice() : SIZES.slice() };
  }

  function parseSizeOptions(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    const matches = text.match(/\b\d{3,5}\s*[x\u00d7*]\s*\d{3,5}\b/gi) || [];
    return normalizeSizeOptions(matches);
  }

  function stripImageDataUrl(value) {
    const text = String(value || '').trim();
    const match = text.match(/^data:image\/[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i);
    return match ? match[1].replace(/\s+/g, '') : text;
  }

  function isRemoteImageUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
  }

  async function imageValueToBase64(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^data:image\/[^;,]+;base64,/i.test(text)) return stripImageDataUrl(text);
    if (!isRemoteImageUrl(text)) return text;
    const gateway = App.services && App.services.gateway;
    if (!gateway || typeof gateway.fetchImageAsset !== 'function') throw new Error('图像 URL 下载服务不可用');
    const result = await gateway.fetchImageAsset({ url: text });
    if (!result || !result.ok || !result.dataUrl) throw new Error((result && (result.error || result.code)) || '图像 URL 下载失败');
    return stripImageDataUrl(result.dataUrl);
  }

  async function normalizeGeneratedImages(data) {
    const items = Array.isArray(data && data.data) ? data.data : [];
    const values = await Promise.all(items.map((item) => imageValueToBase64(
      item && (item.b64_json || item.url || item.data || item.image || item.image_url),
    )));
    return values.filter(Boolean);
  }

  const EXAMPLES = [
    '一只宇航员猫在月球上弹吉他',
    '赛博朋克风格的未来城市夜景',
    '水彩风格的春日山谷与溪流',
    '宫崎骏动画风的空中浮岛',
    '极简主义咖啡馆室内设计',
  ];

  const HISTORY_CAP = 200; // v1.1.5（批次 D1）：图片落盘后索引轻量，上限 30 → 200
  const TERMINAL_TTL = 60000; // v1.1.6：失败/取消任务卡 60 秒后自动消失（留足阅读错误与重试的时间）

  // v1.1.5（批次 D1）：文件名 → data URL 的 LRU 缓存（历史缩略图/灯箱/对比按需取图）
  const assetCache = new Map();
  const ASSET_CACHE_LIMIT = 40;
  async function cachedAssetDataUrl(name) {
    if (!name) return '';
    if (assetCache.has(name)) {
      const v = assetCache.get(name);
      assetCache.delete(name); assetCache.set(name, v);
      return v;
    }
    const svc = App.services && App.services.images;
    if (!svc || typeof svc.read !== 'function') return '';
    const result = await svc.read(name);
    const dataUrl = result && result.ok && result.dataUrl ? result.dataUrl : '';
    if (!dataUrl) return '';
    assetCache.set(name, dataUrl);
    while (assetCache.size > ASSET_CACHE_LIMIT) assetCache.delete(assetCache.keys().next().value);
    return dataUrl;
  }

  // v1.1.5（批次 C3）：base64 头嗅探真实 MIME（下载命名与展示用；存储侧以服务端嗅探为准）
  function sniffMime(b64) {
    try {
      const head = atob(String(b64 || '').slice(0, 24));
      if (head.length < 4) return 'image/png';
      const c = head.charCodeAt;
      if (c(0) === 0x89 && c(1) === 0x50 && c(2) === 0x4e && c(3) === 0x47) return 'image/png';
      if (c(0) === 0xff && c(1) === 0xd8 && c(2) === 0xff) return 'image/jpeg';
      if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'image/webp';
      if (head.slice(0, 3) === 'GIF') return 'image/gif';
    } catch (_) {}
    return 'image/png';
  }
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  function dataUrlOf(b64) { const mime = sniffMime(b64); return 'data:' + mime + ';base64,' + b64; }

  // 历史条目（新格式 files / 旧格式 images）→ data URL 数组
  async function materializeEntry(e) {
    if (!e) return [];
    if (Array.isArray(e.images) && e.images.length) return e.images.map(dataUrlOf);
    if (Array.isArray(e.files) && e.files.length) {
      const urls = await Promise.all(e.files.map(cachedAssetDataUrl));
      return urls.filter(Boolean);
    }
    return [];
  }

  App.image = {
    results: [],
    lastPrompt: '',
    rawPrompt: '',
    sel: { style: 'default', size: '1024x1024', n: '1' },
    pending: false,
    // M7：生成任务队列（串行消费，并发 1）
    queue: [],        // 排队中的任务 id（只含 queued 状态）
    tasks: {},        // id -> task { id, status, prompt, finalPrompt, style, size, n, refImg, error, _ctrl }
    currentId: null,  // 正在执行的任务 id
    lbImages: [], lbPrompt: '', lbIdx: 0,
    compareList: [],  // M7：图片对比队列（收集 2 张自动弹出对比）
    refImage: null,   // 参考图片 base64 data URL（用于图片编辑）
    // v1.1.5：A2 草稿态（切视图不丢输入）/ D2 历史管理态 / B1 队列计时器
    _draftPrompt: '', _draftRefName: '',
    _historySearch: '', _expandedHistory: new Set(), _migrating: false, _migrated: false, _historyLimit: 20,
    _queueTimer: null, _lbKeyHandler: null,

    onShow() {
      App.image.migrateLegacyHistory();
      App.image.render();
    },

    // v1.1.5（批次 D1）：旧内联 base64 历史一次性迁出到数据根 images/ 文件（先落盘后改索引，可重入）
    async migrateLegacyHistory() {
      if (App.image._migrated || App.image._migrating) return;
      const svc = App.services && App.services.images;
      if (!svc || typeof svc.available === 'function' && !svc.available()) { App.image._migrated = true; return; }
      const hist = App.state.settings.imageHistory || [];
      const legacy = hist.filter((e) => e && Array.isArray(e.images) && e.images.length && !Array.isArray(e.files));
      if (!legacy.length) { App.image._migrated = true; return; }
      App.image._migrating = true;
      let migratedCount = 0;
      try {
        for (const entry of legacy) {
          const files = [];
          let failed = false;
          for (const b64 of entry.images) {
            const saved = await svc.save(b64);
            if (saved && saved.ok && saved.name) files.push(saved.name);
            else if (saved && saved.code === 'quota') { failed = true; break; }
          }
          if (!failed && files.length === entry.images.length) {
            entry.files = files;
            delete entry.images;
            migratedCount++;
          }
        }
        if (migratedCount) {
          App.persist();
          App.image.renderHistory();
          App.ui.toast('已把 ' + migratedCount + ' 条历史图片迁移到本地文件存储');
        }
      } catch (_) {}
      App.image._migrating = false;
      App.image._migrated = true;
    },

    // v1.1.5（批次 A1/A2）：参考图 UI 方法化——灯箱「用作参考图」与视图重建后的草稿恢复共用
    showRefUI(dataUrl, name) {
      App.image.refImage = dataUrl;
      App.image._draftRefName = name || '参考图';
      const chip = $('imgRefChip'), thumb = $('imgRefThumb'), label = $('imgRefName');
      if (chip) chip.style.display = 'flex';
      if (thumb) thumb.src = dataUrl;
      if (label) label.textContent = App.image._draftRefName;
      const btn = $('imgGenBtn');
      if (btn) btn.textContent = '🎨 编辑图片';
      const hint = $('advRefHint');
      if (hint) hint.style.display = 'block';
    },
    hideRefUI() {
      App.image.refImage = null;
      App.image._draftRefName = '';
      const chip = $('imgRefChip');
      if (chip) chip.style.display = 'none';
      const btn = $('imgGenBtn');
      if (btn) btn.textContent = '✨ 生成图片';
      const hint = $('advRefHint');
      if (hint) hint.style.display = 'none';
    },

    render() {
      const wrap = $('imageView');
      if (!wrap) return;

      // v1.1.5（批次 A2）：重建前保存提示词草稿（refImage 常驻模块态），重建后回填
      const prevTa = $('imgPrompt');
      if (prevTa) App.image._draftPrompt = prevTa.value;

      // 图像模型选择器：读当前图像账户模型列表
      const imgProv = App.getProvider('image');
      const imgModels = (imgProv.models && imgProv.models.length) ? imgProv.models : (imgProv.model ? [imgProv.model] : []);
      const imgSel = imgProv.model || imgModels[0] || '';
      const modelOpts = imgModels.length
        ? imgModels.map(m => `<option value="${App.escapeHtml(m)}"${m === imgSel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置图像模型，请到设置填写</option>';

      wrap.innerHTML = `
        <div class="image-shell" id="imgPanel">
          <div class="img-sec">
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
              <div class="img-presets" id="imgPresets">
                <span class="opt-label">预设</span>
                ${(App.state.settings.imagePresets || []).map((pr, i) =>
                  `<span class="preset-chip" data-preset="${i}">${App.escapeHtml(pr.name)}<button type="button" class="preset-chip-x" data-preset-x="${i}" title="删除预设">×</button></span>`).join('')}
                <button type="button" class="btn-ghost mini" id="imgPresetSave" title="把当前提示词保存为预设">＋存为预设</button>
                <input type="text" id="imgPresetName" class="preset-name-input" maxlength="24" style="display:none" placeholder="预设名称，Enter 保存 / Esc 取消" />
              </div>
            </div>
          </div>
          <div class="img-sec">
            <div class="image-options" id="imgOptions">
              <div class="opt-group">
                <span class="opt-label">风格</span>
                <div class="chip-row" data-group="style">
                  ${Object.entries(STYLES).map(([k, v]) => `<button type="button" class="chip" data-group="style" data-val="${k}">${v.label}</button>`).join('')}
                </div>
              </div>
              <div class="opt-group">
                <span class="opt-label">尺寸</span>
                <div class="chip-row" id="imgSizeOptions" data-group="size"></div>
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
              <details class="adv-params">
                <summary>高级参数</summary>
                <div class="adv-grid">
                  <label class="adv-field"><span class="adv-label">Seed</span><input type="number" id="advSeed" placeholder="随机" /></label>
                  <label class="adv-field"><span class="adv-label">Guidance</span><input type="number" id="advGuidance" step="0.5" placeholder="自动" /></label>
                  <label class="adv-field adv-field-full"><span class="adv-label">负面提示词</span><textarea id="advNegative" rows="2" placeholder="不希望出现的内容（部分供应商支持）"></textarea></label>
                  <label class="adv-field"><span class="adv-label">输出格式</span>
                    <select id="advFmt">
                      <option value="">默认</option><option value="b64_json">b64_json</option><option value="url">url</option>
                      <option value="png">png</option><option value="jpeg">jpeg</option><option value="webp">webp</option>
                    </select>
                  </label>
                  <label class="adv-field"><span class="adv-label">质量</span>
                    <select id="advQuality">
                      <option value="">默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
                    </select>
                  </label>
                  <label class="adv-field adv-field-full"><span class="adv-label">模型专属参数 (JSON)</span><textarea id="advExtra" rows="2" placeholder='{"style":"vivid"}'></textarea></label>
                </div>
                <p class="adv-hint" id="advRefHint" style="display:none">参考图编辑走视觉模型，Seed / 质量等高级参数不生效</p>
              </details>
            </div>
          </div>
          <button class="gen-btn" id="imgGenBtn">✨ 生成图片</button>
          <div class="image-status img-queue-status" id="imgQueueStatus"></div>
          <div class="img-queue-cards" id="imgQueueCards"></div>
          <div class="image-status" id="imgStatus"></div>
          <div class="img-sec"><div class="image-grid" id="imgGrid"></div></div>
          <div class="img-sec"><div class="history-section" id="imgHistory"></div></div>
        </div>`;

      App.image.syncChips();
      App.image.bind();
      App.image.renderSizeOptions(imgProv);

      // v1.1.5（批次 A2）：回填草稿（提示词 + 参考图）
      if (App.image._draftPrompt) { const ta = $('imgPrompt'); if (ta) ta.value = App.image._draftPrompt; }
      if (App.image.refImage) App.image.showRefUI(App.image.refImage, App.image._draftRefName);

      // 初始画廊：优先内存结果，否则回填最近一次历史，否则空状态
      const hist = App.state.settings.imageHistory || [];
      if (App.image.results.length) {
        App.image.renderGrid(App.image.results, App.image.lastPrompt);
      } else if (hist.length) {
        const last = hist[0];
        const p = last.prompt + (STYLES[last.style] ? STYLES[last.style].suffix : '');
        materializeEntry(last).then((urls) => {
          // 回填期间用户可能已切走或开始新生成，仅在网格仍为空时渲染
          const grid = $('imgGrid');
          if (!App.image.results.length && grid && !grid.querySelector('.img-card')) {
            App.image.renderGrid(urls.map(stripImageDataUrl), p);
          }
        });
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

        // 参考图展示/移除走 App.image.showRefUI/hideRefUI（v1.1.5 方法化，灯箱「用作参考图」共用）
        const processRefImage = async (file) => {
          if (!file || !file.type.startsWith('image/')) return;
          try {
            const dataUrl = await compressImage(file);
            App.image.showRefUI(dataUrl, file.name);
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
        if (refRemove) refRemove.addEventListener('click', () => App.image.hideRefUI());

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

      // M7：提示词预设（点击填入 / 删除 / 存为预设）
      const presets = $('imgPresets');
      if (presets) {
        presets.addEventListener('click', (e) => {
          const x = e.target.closest('.preset-chip-x');
          if (x) {
            const idx = +x.dataset.presetX;
            const list = App.state.settings.imagePresets || [];
            if (idx >= 0 && idx < list.length) list.splice(idx, 1);
            App.persist();
            App.image.render();
            return;
          }
          const chip = e.target.closest('.preset-chip');
          if (chip) {
            const idx = +chip.dataset.preset;
            const pr = (App.state.settings.imagePresets || [])[idx];
            const ta = $('imgPrompt');
            if (pr && ta) { ta.value = pr.prompt; ta.focus(); }
          }
        });
        // v1.1.5（批次 A3）：预设命名改为内联输入（替代阻塞式 window.prompt）
        const ps = $('imgPresetSave');
        if (ps) ps.addEventListener('click', () => {
          const ta = $('imgPrompt');
          const text = ta ? ta.value.trim() : '';
          if (!text) { App.ui.toast('请先输入要保存的提示词'); return; }
          const input = $('imgPresetName');
          if (!input) return;
          input.style.display = 'inline-block';
          input.value = text.slice(0, 20);
          input.focus();
          input.select();
        });
        const nameInput = $('imgPresetName');
        if (nameInput) {
          const savePreset = () => {
            const ta = $('imgPrompt');
            const text = ta ? ta.value.trim() : '';
            const name = nameInput.value.trim();
            nameInput.style.display = 'none';
            if (!name || !text) return;
            const list = App.state.settings.imagePresets || (App.state.settings.imagePresets = []);
            if (list.some(p => p.name === name)) { App.ui.toast('已存在同名预设'); return; }
            list.push({ name, prompt: text });
            App.persist();
            App.image.render();
            App.ui.toast('已保存预设：' + name);
          };
          nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); savePreset(); }
            else if (e.key === 'Escape') { e.preventDefault(); nameInput.style.display = 'none'; }
          });
          nameInput.addEventListener('blur', () => { nameInput.style.display = 'none'; }); // 失焦取消
        }
      }

      // 内联图像模型选择：直接写 providers.image.model
      const msel = $('imgModel');
      if (msel) msel.addEventListener('change', () => {
        const val = msel.value;
        if (!val) return;
        const prov = App.state.settings.providers.image || (App.state.settings.providers.image = { accountId: '__default__' });
        prov.model = val;
        App.persist();
        App.image.renderSizeOptions(App.getProvider('image'));
        App.ui.toast('已切换图像模型：' + val);
      });
    },

    sizeOptionsForProvider(provider) {
      const caps = resolveImageCapabilities(provider || App.getProvider('image'));
      const options = normalizeSizeOptions(caps.sizes || caps.sizeOptions || caps.resolutions);
      if (options.length) return options;
      const fallback = normalizeSizeOptions(caps.uiSizes || ((imageCapabilityApi() || {}).DEFAULT_UI_SIZES || []));
      return fallback.length ? fallback : SIZES.slice();
    },

    normalizeSizeForProvider(value, provider) {
      const options = App.image.sizeOptionsForProvider(provider);
      const wanted = String(value || '');
      const exact = options.find((item) => item.value === wanted);
      if (exact) return exact;
      const api = imageCapabilityApi();
      const capability = resolveImageCapabilities(provider || App.getProvider('image'));
      const selected = api && typeof api.chooseSize === 'function'
        ? api.chooseSize(wanted, capability.sizes || []) : '';
      return options.find((item) => item.value === selected) || options[0] || SIZES[0];
    },

    rememberImageSizes(provider, sizes) {
      const options = normalizeSizeOptions(sizes);
      if (!options.length) return [];
      imageSizeCache[providerKey(provider)] = options;
      return options;
    },

    learnImageSizesFromError(provider, text) {
      const p = provider || App.getProvider('image');
      const api = imageCapabilityApi();
      let learned = [];
      if (api && typeof api.learnFromError === 'function') {
        try {
          const settings = window.App && window.App.state && window.App.state.settings
            ? window.App.state.settings : {};
          const result = api.learnFromError(p.apiBase || '', p.model || '', String(text || ''), {
            config: p.profile || p,
            store: settings.imageCapabilities || {},
          });
          learned = normalizeSizeOptions(result && (result.sizes || result.sizeOptions || result.resolutions || result));
          if (settings && typeof api.serialize === 'function') settings.imageCapabilities = api.serialize();
          if (App.persist) App.persist();
        } catch (_) {}
      }
      if (!learned.length) learned = parseSizeOptions(text);
      if (learned.length) App.image.rememberImageSizes(p, learned);
      return learned;
    },

    async remoteImageToBase64(url, signal) {
      const api = imageCapabilityApi();
      const service = App.services && (App.services.images || App.services.image);
      const candidates = [
        [api, 'fetchImageAsDataUrl'], [api, 'fetchRemoteImage'], [api, 'toDataUrl'],
        [App.rt, 'fetchImageUrl'], [App.rt, 'fetchRemoteImage'],
        [App.services && App.services.gateway, 'fetchImageAsset'],
        [service, 'fetchImageUrl'], [service, 'fetchRemoteImage'],
      ];
      for (const [owner, name] of candidates) {
        if (!owner || typeof owner[name] !== 'function') continue;
        try {
          const result = name === 'fetchImageAsset'
            ? await owner[name]({ url })
            : await owner[name](url, { signal });
          if (result && result.ok === false) continue;
          const value = result && (result.dataUrl || result.data || result.b64_json || result.base64) || result;
          const base64 = stripImageDataUrl(value);
          if (base64 && !isRemoteImageUrl(base64)) return base64;
        } catch (_) {}
      }
      throw new Error('远程图片未能转换为本地数据');
    },

    async parseImageResponse(data, task, provider, signal) {
      const values = [];
      const add = (value) => {
        if (value == null) return;
        if (Array.isArray(value)) { value.forEach(add); return; }
        if (typeof value === 'object') {
          if (value.b64_json) add(value.b64_json);
          else if (value.dataUrl) add(value.dataUrl);
          else if (value.url) add(value.url);
          else if (value.image_url) add(value.image_url);
          else if (value.data) add(value.data);
          return;
        }
        values.push(String(value));
      };
      if (task && task.refImg) {
        const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
        add(msg.content);
      } else {
        add(data && data.data);
      }
      const result = [];
      for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        if (isRemoteImageUrl(text)) result.push(await App.image.remoteImageToBase64(text, signal));
        else result.push(stripImageDataUrl(text));
      }
      return result.filter(Boolean);
    },

    renderSizeOptions(provider) {
      const row = $('imgSizeOptions');
      if (!row) return;
      const activeProvider = provider || App.getProvider('image');
      const options = App.image.sizeOptionsForProvider(activeProvider);
      const selected = App.image.normalizeSizeForProvider(App.image.sel.size, activeProvider);
      App.image.sel.size = selected.value;
      row.innerHTML = options.map((item) => {
        const [w, h] = String(item.value).split('x').map((n) => parseFloat(n) || 1);
        const k = 22 / Math.max(w, h); // v1.1.8 F5：示意框按真实比例绘制（最长边 22px），不再用写死形状
        return `<button type="button" class="chip" data-group="size" data-val="${item.value}"><span class="size-ico" style="width:${Math.max(8, Math.round(w * k))}px;height:${Math.max(8, Math.round(h * k))}px"></span>${item.label}</button>`;
      }).join('');
      App.image.syncChips();
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
      if (!p.ref || !p.hasKey || !p.model) {
        if (status) status.innerHTML = '<span class="warn">尚未配置图像 API。请点击左下角齿轮 → 在"图像"标签或"默认"标签填写信息。</span>';
        return;
      }
      const styleKey = App.image.sel.style;
      const sizeObj = App.image.normalizeSizeForProvider(App.image.sel.size, p);
      App.image.sel.size = sizeObj.value;
      const refImg = App.image.refImage;
      // M6：图片编辑走 vision chat 兜底，需当前图像模型支持视觉输入；否则给出可行动提示
      if (refImg && App.ModelCapabilities && App.ModelCapabilities.capsOfModelApp) {
        const caps = App.ModelCapabilities.capsOfModelApp(p.model);
        if (!caps.visionInput) {
          App.ui.toast('当前模型不支持图片输入，无法编辑图片。请在账户设置中为 ' + p.model + ' 选择「工具+视觉」或「仅视觉」能力，或改用支持视觉的模型');
          return;
        }
      }
      let finalPrompt = prompt
        + (STYLES[styleKey] ? STYLES[styleKey].suffix : '')
        + '，比例 ' + sizeObj.label;
      if (refImg) finalPrompt = '请根据以下描述编辑这张图片：' + finalPrompt;
      const size = sizeObj.value;
      const n = Number(App.image.sel.n) || 1;
      // M12：高级参数（折叠区）——收集 + JSON 预校验
      const adv = App.image.collectAdv();
      // M7：提交任务入队（串行执行；排队/失败可取消、重试）
      App.image.enqueue({ prompt, finalPrompt, style: styleKey, size, n, refImg, adv });
    },

    // M12：读取高级参数区（Seed/Guidance/负面词/输出格式/质量/模型专属 JSON）；JSON 非法则 toast 并忽略该项
    collectAdv() {
      const adv = {};
      const g = (id) => document.getElementById(id);
      const seed = g('advSeed');
      if (seed && seed.value.trim() !== '') { const v = Number(seed.value); if (!isNaN(v)) adv.seed = v; }
      const gui = g('advGuidance');
      if (gui && gui.value.trim() !== '') { const v = Number(gui.value); if (!isNaN(v)) adv.guidance = v; }
      const neg = g('advNegative');
      if (neg && neg.value.trim()) adv.negative = neg.value.trim();
      const fmt = g('advFmt');
      if (fmt && fmt.value) adv.format = fmt.value;
      const q = g('advQuality');
      if (q && q.value) adv.quality = q.value;
      const ex = g('advExtra');
      if (ex && ex.value.trim()) {
        try { adv.extra = JSON.parse(ex.value.trim()); }
        catch (e) { App.ui.toast('模型专属参数 JSON 无效，已忽略该参数'); adv.extra = null; }
      }
      return adv;
    },

    // M12：按供应商判定映射规则（OpenAI 兼容 / 火山 / 通义 / Stable Diffusion 系）
    detectImageSupplier(p) {
      const base = ((p && p.apiBase) || '').toLowerCase();
      const model = ((p && p.model) || '').toLowerCase();
      if (base.includes('ark') || base.includes('volcengine') || base.includes('volces') || model.includes('seedream') || model.includes('doubao')) return 'volc';
      if (base.includes('dashscope') || base.includes('aliyun') || model.includes('wanx') || model.includes('qwen-image')) return 'qwen';
      if (model.includes('flux') || model.includes('stable-diffusion') || model.includes('sdxl')) return 'sd';
      return 'openai';
    },

    // M12：文生图 payload——高级参数尽力映射（OpenAI 系传 seed/quality/response_format；火山/SD 额外 cfg_scale/negative_prompt），模型专属 JSON 透传合并
    buildImagePayload(task, p) {
      const capability = resolveImageCapabilities(p);
      const payload = { model: p.model, prompt: task.finalPrompt, n: task.n, size: task.size };
      if (capability.protocol) payload.imageProtocol = capability.protocol;
      if (capability.sizeStrategy) payload.imageSizeStrategy = capability.sizeStrategy;
      if (capability.sizeFormat) payload.imageSizeFormat = capability.sizeFormat;
      if (Array.isArray(capability.sizes) && capability.sizes.length) payload.imageSizes = capability.sizes.slice();
      const adv = task.adv || {};
      const sup = App.image.detectImageSupplier(p);
      const formats = ['b64_json', 'url'];
      const requestedFormat = formats.includes(adv.format) ? adv.format : capability.responseFormat;
      if (requestedFormat) payload.response_format = requestedFormat;
      if (adv.seed != null) payload.seed = adv.seed;
      if (adv.quality && ['low', 'medium', 'high'].includes(adv.quality) && sup === 'openai') payload.quality = adv.quality;
      if (sup === 'volc' || sup === 'sd') {
        if (adv.guidance != null) payload.cfg_scale = adv.guidance;
        if (adv.negative) payload.negative_prompt = adv.negative;
      }
      const api = imageCapabilityApi();
      if (api && typeof api.adaptPayload === 'function') {
        try {
          const adapted = api.adaptPayload(Object.assign({}, payload), capability);
          if (adapted && typeof adapted === 'object') Object.assign(payload, adapted);
        } catch (_) {}
      }
      if (adv.extra && typeof adv.extra === 'object') {
        Object.keys(adv.extra).forEach((key) => {
          if (!IMAGE_CORE_KEYS.has(key)) payload[key] = adv.extra[key];
        });
      }
      return payload;
    },

    // M7：入队一个生成任务
    enqueue(params) {
      const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const provider = App.getProvider('image');
      const size = App.image.normalizeSizeForProvider(params && params.size, provider);
      const task = Object.assign({ id, status: 'queued', error: null }, params, { size: size.value });
      App.image.tasks[id] = task;
      App.image.queue.push(id);
      App.image.renderQueue();
      App.image.pump();
      return id;
    },

    // M7：串行消费队列（并发 1）
    pump() {
      if (App.image.running) return;
      // 清理已取消/失效任务
      App.image.queue = App.image.queue.filter(id => App.image.tasks[id] && App.image.tasks[id].status === 'queued');
      if (!App.image.queue.length) {
        App.image.running = false;
        App.image.renderQueue();
        return;
      }
      const id = App.image.queue.shift();
      const task = App.image.tasks[id];
      if (!task || task.status !== 'queued') { App.image.pump(); return; }
      App.image.running = true;
      App.image.currentId = id;
      App.image.runTask(task).then(() => {
        App.image.running = false;
        App.image.pump();
      });
    },

    // M7：执行单个任务（原 generate 的请求/解析主体，带 AbortController 可取消）
    async runTask(task) {
      task.status = 'running';
      task.startedAt = Date.now();
      App.image.renderQueue();
      const p = App.getProvider('image');
      task.size = App.image.normalizeSizeForProvider(task.size, p).value;
      const status = $('imgStatus');
      const btn = $('imgGenBtn');
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
      App.image.renderSkeleton(task.n, task.size);
      const ctrl = new AbortController();
      task._ctrl = ctrl;
      try {
        let res, data;
        if (task.refImg) {
          // 图片编辑：用 chat completions vision 格式；高级参数忽略（视觉模型），仅模型专属 JSON 透传
          const content = [{ type: 'text', text: task.finalPrompt }, { type: 'image_url', image_url: { url: task.refImg } }];
          const chatPayload = { model: p.model, messages: [{ role: 'user', content }], stream: false };
          if (task.adv && task.adv.extra && typeof task.adv.extra === 'object') {
            Object.keys(task.adv.extra).forEach((key) => {
              if (!IMAGE_CORE_KEYS.has(key)) chatPayload[key] = task.adv.extra[key];
            });
          }
          res = await App.rt.gatewayFetch({ ref: p.ref, kind: 'chat', telemetry: { scope: 'image', callType: 'vision_edit' }, payload: chatPayload, signal: ctrl.signal });
        } else {
          // 文生图：标准 images/generations（M12：高级参数映射）
          res = await App.rt.gatewayFetch({
            ref: p.ref, kind: 'images', telemetry: { scope: 'image', callType: 'image_generation' },
            payload: App.image.buildImagePayload(task, p),
            signal: ctrl.signal,
          });
        }
        if (!res.ok) {
          const txt = await App.rt.gatewayError(res);
          if (Number(res.status) === 400) {
            const learned = App.image.learnImageSizesFromError(p, txt);
            if (learned.length) {
              App.image.renderSizeOptions(p);
              task.retryable = true;
            }
          }
          throw new Error('请求失败（' + res.status + '）：' + String(txt).slice(0, 200));
        }
        data = await res.json();
        const arr = await App.image.parseImageResponse(data, task, p, ctrl.signal);
        if (!arr.length) throw new Error('未返回图片。');
        App.image.results = arr;
        App.image.rawPrompt = task.prompt;
        App.image.lastPrompt = task.finalPrompt;
        App.image.renderGrid(arr, task.finalPrompt, { model: p.model, size: task.size, time: Date.now() });
        await App.image.pushHistory({ prompt: task.prompt, style: task.style, size: task.size, n: task.n, images: arr, adv: task.adv || null, model: p.model });
        task.status = 'done';
        task.endedAt = Date.now();
        if (status) status.textContent = `已生成 ${arr.length} 张图片`;
      } catch (err) {
        if (err && err.name === 'AbortError') task.status = 'canceled';
        else { task.status = 'error'; task.error = String((err && err.message) || err); }
        task.endedAt = Date.now();
        App.image.renderGrid(App.image.results, App.image.lastPrompt);
      } finally {
        task._ctrl = null;
        if (btn) { btn.disabled = false; btn.textContent = task.refImg ? '🎨 编辑图片' : '✨ 生成图片'; }
        // 最终状态文本（错误全文在任务卡 title 可查；重试操作在任务卡上）——由 runTask 直接写，不被队列收尾清空
        const st = $('imgStatus');
        if (task.status === 'error' && st) {
          st.innerHTML = `<span class="error">失败：${App.escapeHtml(String(task.error || '未知错误').slice(0, 120))}</span>`;
        } else if (task.status === 'canceled' && st) {
          st.innerHTML = '<span class="warn">已取消</span>';
        }
        App.image.currentId = null;
        App.image.renderQueueCards();
      }
    },

    // v1.1.5（批次 B1/B3）：队列状态与结果状态分区显示；任务卡可视化管理
    renderQueue() {
      const qs = $('imgQueueStatus');
      const queued = App.image.queue.length;
      const cur = App.image.currentId ? App.image.tasks[App.image.currentId] : null;
      if (qs) {
        if (cur && cur.status === 'running') {
          qs.innerHTML = `正在生成…${queued ? '（队列剩余 ' + queued + '）' : ''} <button class="mini" id="imgCancelBtn">取消</button>`;
          const cb = $('imgCancelBtn');
          if (cb) cb.addEventListener('click', () => { if (cur._ctrl) cur._ctrl.abort(); });
        } else {
          qs.innerHTML = queued ? `排队中（第 ${queued} 位）…` : '';
        }
      }
      App.image.renderQueueCards();
      // 运行中每秒刷新任务卡耗时；无运行任务时清理计时器
      if (cur && cur.status === 'running' && !App.image._queueTimer) {
        App.image._queueTimer = setInterval(() => {
          const running = App.image.currentId && App.image.tasks[App.image.currentId];
          if (running && App.image.tasks[App.image.currentId].status === 'running') App.image.renderQueueCards();
          else { clearInterval(App.image._queueTimer); App.image._queueTimer = null; }
        }, 1000);
      } else if (!cur && App.image._queueTimer) {
        clearInterval(App.image._queueTimer);
        App.image._queueTimer = null;
      }
      // v1.1.6：任务结束后若有终态卡（失败/取消），安排一次性兜底重绘，
      // 确保无人再操作时失败卡也会在 TERMINAL_TTL 后自动消失
      const hasTerminal = Object.values(App.image.tasks).some((t) => t && (t.status === 'error' || t.status === 'canceled'));
      if (hasTerminal && !App.image._queueTimer && !App.image._terminalDismissTimer) {
        App.image._terminalDismissTimer = setTimeout(() => {
          App.image._terminalDismissTimer = null;
          App.image.renderQueueCards();
        }, TERMINAL_TTL + 500);
      }
    },

    // v1.1.5（批次 B1）：任务卡列表——运行/排队可取消，失败可重试，显示已耗时
    renderQueueCards() {
      const box = $('imgQueueCards');
      if (!box) return;
      // v1.1.6：先清理过期的终态任务（error/canceled 超过 TERMINAL_TTL 自动消失），避免失败卡永久残留
      const now = Date.now();
      Object.keys(App.image.tasks).forEach((id) => {
        const t = App.image.tasks[id];
        if (!t) return;
        if ((t.status === 'error' || t.status === 'canceled') && t.endedAt && (now - t.endedAt) > TERMINAL_TTL) {
          delete App.image.tasks[id];
        }
        if (t && (t.status === 'done' || t.status === 'removed')) delete App.image.tasks[id];
      });
      const terminals = Object.values(App.image.tasks)
        .filter((t) => t && (t.status === 'error' || t.status === 'canceled'))
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 2);
      const queuePos = (id) => App.image.queue.indexOf(id) + 1;
      const cards = [];
      const cur = App.image.currentId ? App.image.tasks[App.image.currentId] : null;
      if (cur && cur.status === 'running') cards.push(cur);
      App.image.queue.forEach((id) => { const t = App.image.tasks[id]; if (t && t.status === 'queued') cards.push(t); });
      cards.push(...terminals);
      if (!cards.length) {
        box.innerHTML = '';
        // 顺带清理历史终态任务，防止 tasks 无限增长
        Object.keys(App.image.tasks).forEach((id) => {
          const t = App.image.tasks[id];
          if (t && (t.status === 'done' || t.status === 'removed')) delete App.image.tasks[id];
        });
        return;
      }
      const elapsed = (t) => {
        const ms = (t.status === 'running' ? Date.now() : (t.endedAt || t.startedAt || Date.now())) - (t.startedAt || Date.now());
        const s = Math.max(0, Math.round(ms / 1000));
        return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's';
      };
      const esc = App.escapeHtml;
      box.innerHTML = cards.map((t) => {
        const brief = esc(String(t.prompt || '').slice(0, 20));
        const meta = (SIZE_LABEL[t.size] || t.size || '') + ' × ' + (t.n || 1);
        let state = '', act = '';
        if (t.status === 'running') { state = '<span class="qc-dot qc-run"></span>生成中 ' + elapsed(t); act = '<button class="mini qc-act" data-qact="cancel" data-qid="' + t.id + '">取消</button>'; }
        else if (t.status === 'queued') { state = '<span class="qc-dot qc-wait"></span>排队第 ' + queuePos(t.id) + ' 位'; act = '<button class="mini qc-act" data-qact="remove" data-qid="' + t.id + '">移出</button>'; }
        else if (t.status === 'error') { state = '<span class="qc-dot qc-err"></span>失败 ' + elapsed(t); act = '<button class="mini qc-act" data-qact="retry" data-qid="' + t.id + '">重试</button><button class="mini qc-act" data-qact="dismiss" data-qid="' + t.id + '" title="消除此记录">✕</button>'; }
        else if (t.status === 'canceled') { state = '<span class="qc-dot qc-cancel"></span>已取消'; act = '<button class="mini qc-act" data-qact="dismiss" data-qid="' + t.id + '" title="消除此记录">✕</button>'; }
        const err = t.status === 'error' && t.error ? '<div class="qc-error" title="' + esc(String(t.error)) + '">' + esc(String(t.error).slice(0, 60)) + '</div>' : '';
        return `<div class="queue-card st-${t.status}" data-qid="${t.id}">
          <div class="qc-main"><span class="qc-prompt">${brief}</span><span class="qc-meta">${meta}</span>${state}</div>
          ${err}${act}
        </div>`;
      }).join('');
      box.querySelectorAll('.qc-act').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.dataset.qid;
        const t = App.image.tasks[id];
        if (!t) return;
        if (b.dataset.qact === 'cancel') { if (t._ctrl) t._ctrl.abort(); }
        else if (b.dataset.qact === 'remove') {
          t.status = 'removed';
          App.image.queue = App.image.queue.filter((qid) => qid !== id);
          App.image.renderQueue();
        } else if (b.dataset.qact === 'retry') {
          App.image.enqueue({ prompt: t.prompt, finalPrompt: t.finalPrompt, style: t.style, size: t.size, n: t.n, refImg: t.refImg, adv: t.adv });
          delete App.image.tasks[id]; // 重试后清除原失败记录
          App.image.renderQueue();
        } else if (b.dataset.qact === 'dismiss') {
          delete App.image.tasks[id];
          App.image.renderQueue();
        }
      }));
    },

    renderSkeleton(n, size) {
      const grid = $('imgGrid');
      if (!grid) return;
      const cnt = Math.max(1, Math.min(n || 1, 4));
      // v1.1.5（批次 B2）：骨架屏按所选比例占位，与结果形状一致
      const m = String(size || App.image.sel.size || '').match(/^(\d+)x(\d+)$/);
      const ratio = m ? (Number(m[1]) / Number(m[2])) : 1;
      const aspect = ratio >= 1 ? ratio.toFixed(3) + '/1' : '1/' + (1 / ratio).toFixed(3);
      grid.innerHTML = Array.from({ length: cnt }).map(() =>
        `<div class="img-card img-skeleton" style="aspect-ratio:${aspect}"><div class="sk-img"></div></div>`).join('');
    },

    renderGrid(images, prompt, meta) {
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
      App.image._gridMeta = meta || App.image._gridMeta || null;
      // v1.1.5（批次 C2）：卡片按所选比例占位，图片加载后按真实宽高校正，不再固定等高裁切
      const sm = String(App.image.sel.size || '').match(/^(\d+)x(\d+)$/);
      const placeholder = sm ? (Number(sm[1]) / Number(sm[2])) : 1;
      grid.innerHTML = images.map((b, i) => `
        <div class="img-card" data-i="${i}" style="aspect-ratio:${placeholder >= 1 ? placeholder.toFixed(3) + '/1' : '1/' + (1 / placeholder).toFixed(3)}">
          <img src="${dataUrlOf(b)}" alt="生成结果 ${i + 1}">
          <div class="img-card-mask">
            <button type="button" class="card-act copy-prompt" data-i="${i}">复制提示词</button>
            <button type="button" class="card-act download-btn" data-i="${i}">下载</button>
          </div>
        </div>`).join('');
      grid.querySelectorAll('.img-card img').forEach((img) => {
        img.addEventListener('load', () => {
          if (img.naturalWidth && img.naturalHeight) {
            img.closest('.img-card').style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
          }
        });
      });
      grid.querySelectorAll('.img-card').forEach(c => c.addEventListener('click', () => App.image.openLightbox(images, +c.dataset.i, prompt, App.image._gridMeta)));
      grid.querySelectorAll('.download-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); App.image.download(b64Of(images, +b.dataset.i), +b.dataset.i); }));
      grid.querySelectorAll('.copy-prompt').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); App.image.copyPrompt(prompt); }));
    },

    // v1.1.5（批次 D1）：优先把图片落盘为数据根 images/ 文件、settings 只存轻量索引；
    // 服务不可用或配额超限时回退旧内联格式（数据绝不丢），迁移器稍后会重试迁出。
    async pushHistory(entry) {
      const hist = App.state.settings.imageHistory || (App.state.settings.imageHistory = []);
      const record = Object.assign({ id: App.uid(), createdAt: Date.now() }, entry);
      const svc = App.services && App.services.images;
      if (svc && typeof svc.available === 'function' && svc.available()) {
        const files = [];
        let quotaHit = false;
        for (const b64 of (record.images || [])) {
          try {
            const saved = await svc.save(b64);
            if (saved && saved.ok && saved.name) files.push(saved.name);
            else if (saved && saved.code === 'quota') { quotaHit = true; break; }
          } catch (_) { quotaHit = true; break; }
        }
        if (files.length === (record.images || []).length && !quotaHit) {
          record.files = files;
          delete record.images;
        } else if (quotaHit) {
          App.ui.toast('本地图片存储已达配额，新历史暂存于状态文件。可在历史中清理旧图片');
        }
      }
      hist.unshift(record);
      while (hist.length > HISTORY_CAP) {
        const dropped = hist.pop();
        // 索引被挤出时顺带清理其落盘文件（尽力而为）
        if (dropped && Array.isArray(dropped.files) && svc && typeof svc.remove === 'function') {
          dropped.files.forEach((name) => { svc.remove(name).catch(() => {}); });
        }
      }
      App.persist();
      App.image.renderHistory();
    },

    // v1.1.5（批次 D2/D3/E2）：历史管理（删除/清空/搜索/展开）+ 落盘文件按需取图 + 单张粒度对比
    renderHistory() {
      const box = $('imgHistory');
      if (!box) return;
      const all = App.state.settings.imageHistory || [];
      const q = App.image._historySearch.trim().toLowerCase();
      const hist = q ? all.filter((e) => e && String(e.prompt || '').toLowerCase().includes(q)) : all;
      const cmpN = App.image.compareList.length;
      const esc = App.escapeHtml;
      if (!all.length) { box.innerHTML = ''; return; }
      // v1.1.7：分页渲染（默认 20 条 + 加载更多），避免内联 base64 历史随记录数线性膨胀
      const limit = Math.max(1, Number(App.image._historyLimit) || 20);
      const visible = hist.slice(0, limit);
      const hasMore = hist.length > visible.length;
      box.innerHTML = `
        <div class="history-head">历史记录<span class="history-count">最近 ${all.length} 次</span>
          <input type="search" id="imgHistorySearch" class="history-search" placeholder="搜索提示词…" value="${esc(App.image._historySearch)}" />
          ${cmpN ? `<button type="button" class="mini" id="imgCmpClear">清空对比（${cmpN}/2）</button>` : ''}
          <button type="button" class="mini" id="imgHistoryClear" title="删除全部历史（含本地图片文件）">清空历史</button>
        </div>
        ${visible.length ? visible.map((e) => {
          const total = (e.files || e.images || []).length;
          const expanded = App.image._expandedHistory.has(e.id);
          const shown = expanded ? total : Math.min(total, 4);
          const thumbs = [];
          for (let j = 0; j < shown; j++) {
            if (Array.isArray(e.files)) thumbs.push(`<button type="button" class="history-thumb" data-ei="${e.id}" data-j="${j}"><img data-file="${esc(e.files[j])}" alt=""><span class="thumb-cmp" data-ei="${e.id}" data-j="${j}" title="加入对比">⊞</span></button>`);
            else thumbs.push(`<button type="button" class="history-thumb" data-ei="${e.id}" data-j="${j}"><img src="${dataUrlOf(e.images[j])}" alt=""><span class="thumb-cmp" data-ei="${e.id}" data-j="${j}" title="加入对比">⊞</span></button>`);
          }
          const more = total > 4
            ? `<button type="button" class="history-thumb history-more" data-ei="${e.id}">${expanded ? '收起' : '+' + (total - 4)}</button>`
            : '';
          return `
          <div class="history-item" data-hid="${esc(e.id)}">
            <div class="history-meta">
              <div class="history-prompt">${esc(e.prompt)}</div>
              <div class="history-sub">${SIZE_LABEL[e.size] || e.size || ''} · ${e.n} 张 · ${timeAgo(e.createdAt)}${e.model ? ' · ' + esc(e.model) : ''}</div>
              <div class="history-ops">
                <button type="button" class="btn-ghost mini" data-cmpfirst="${e.id}" title="把这条的第 1 张加入对比">对比</button>
                <button type="button" class="btn-ghost mini" data-del="${e.id}" title="删除这条历史（含图片文件）">🗑 删除</button>
              </div>
            </div>
            <div class="history-thumbs">${thumbs.join('')}${more}</div>
          </div>`;
        }).join('') : '<div class="history-empty">没有匹配的历史记录</div>'}
        ${hasMore ? `<button type="button" class="btn-ghost mini history-more-page" data-history-more>加载更早记录（${hist.length - visible.length}）</button>` : ''}`;

      // 落盘文件按需取图（LRU 缓存命中则同步返回）
      box.querySelectorAll('img[data-file]').forEach(async (img) => {
        const name = img.dataset.file;
        const url = await cachedAssetDataUrl(name);
        if (url) img.src = url;
        else { img.classList.add('thumb-missing'); img.alt = '图片文件缺失'; img.title = '图片文件缺失'; }
      });

      // 搜索（输入即时过滤，不触发整体 render 重建输入焦点）
      const search = box.querySelector('#imgHistorySearch');
      if (search) search.addEventListener('input', () => {
        App.image._historySearch = search.value;
        App.image._historyLimit = 20; // v1.1.7：搜索时回到第一页
        App.image.renderHistory();
        const next = box.querySelector('#imgHistorySearch');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });

      // v1.1.7：分页加载更早记录
      box.querySelectorAll('[data-history-more]').forEach((b) => b.addEventListener('click', () => {
        App.image._historyLimit = (Number(App.image._historyLimit) || 20) + 20;
        App.image.renderHistory();
      }));

      // 展开/收起全部缩略图（批次 D3）
      box.querySelectorAll('.history-more').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.dataset.ei;
        if (App.image._expandedHistory.has(id)) App.image._expandedHistory.delete(id);
        else App.image._expandedHistory.add(id);
        App.image.renderHistory();
      }));

      // 缩略图点击 → 灯箱（含该条元信息，批次 C3）
      box.querySelectorAll('.history-thumb:not(.history-more)').forEach((t) => t.addEventListener('click', () => {
        const entry = (App.state.settings.imageHistory || []).find((x) => x && x.id === t.dataset.ei);
        if (!entry) return;
        materializeEntry(entry).then((urls) => {
          if (!urls.length) { App.ui.toast('图片文件不可用'); return; }
          App.image.openLightbox(urls.map(stripImageDataUrl), +t.dataset.j,
            entry.prompt + (STYLES[entry.style] ? STYLES[entry.style].suffix : ''),
            { model: entry.model || '', size: entry.size, time: entry.createdAt });
        });
      }));

      // v1.1.5（批次 E2）：单张粒度加入对比（缩略图角标 ⊞）
      box.querySelectorAll('.thumb-cmp').forEach((s) => s.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = (App.state.settings.imageHistory || []).find((x) => x && x.id === s.dataset.ei);
        if (!entry) return;
        const idx = +s.dataset.j;
        materializeEntry(entry).then((urls) => {
          const url = urls[idx];
          if (!url) { App.ui.toast('图片文件不可用'); return; }
          App.image.compareList.push({
            b64: stripImageDataUrl(url),
            prompt: entry.prompt + (STYLES[entry.style] ? STYLES[entry.style].suffix : ''),
            model: entry.model || '', size: entry.size, time: entry.createdAt,
          });
          App.image.renderHistory();
          if (App.image.compareList.length >= 2) App.image.openCompare();
        });
      }));
      // 条目级「对比」快捷入口（第 1 张），保持旧习惯
      box.querySelectorAll('[data-cmpfirst]').forEach((b) => b.addEventListener('click', () => {
        const entry = (App.state.settings.imageHistory || []).find((x) => x && x.id === b.dataset.cmpFirst);
        if (!entry) return;
        materializeEntry(entry).then((urls) => {
          if (!urls.length) return;
          App.image.compareList.push({
            b64: stripImageDataUrl(urls[0]),
            prompt: entry.prompt + (STYLES[entry.style] ? STYLES[entry.style].suffix : ''),
            model: entry.model || '', size: entry.size, time: entry.createdAt,
          });
          App.image.renderHistory();
          if (App.image.compareList.length >= 2) App.image.openCompare();
        });
      }));

      // 单条删除（文件一并清理）
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const list = App.state.settings.imageHistory || [];
        const idx = list.findIndex((x) => x && x.id === b.dataset.del);
        if (idx < 0) return;
        const entry = list[idx];
        const svc = App.services && App.services.images;
        if (Array.isArray(entry.files) && svc && typeof svc.remove === 'function') {
          for (const name of entry.files) { try { await svc.remove(name); } catch (_) {} }
        }
        list.splice(idx, 1);
        App.persist();
        App.image.renderHistory();
        App.ui.toast('已删除该条历史');
      }));

      // 清空历史（确认弹窗，批次 D2；非阻塞式，替代原生 confirm）
      const clearBtn = box.querySelector('#imgHistoryClear');
      if (clearBtn) clearBtn.addEventListener('click', () => App.image.confirmClearHistory());
      const cc = box.querySelector('#imgCmpClear');
      if (cc) cc.addEventListener('click', () => { App.image.compareList = []; App.image.renderHistory(); });
    },

    // v1.1.5（批次 D2）：清空历史的非阻塞确认弹窗
    confirmClearHistory() {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'imgClearMask';
      mask.innerHTML = `
        <div class="modal agent-modal img-clear-confirm" role="dialog" aria-modal="true">
          <div class="modal-header"><span>清空图片历史？</span>
            <button class="icon-btn" id="clrClose" aria-label="关闭"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          </div>
          <div class="modal-body"><p>将删除全部 ${ (App.state.settings.imageHistory || []).length } 条历史记录及其本地图片文件，此操作不可撤销。</p></div>
          <div class="modal-footer">
            <button class="btn-ghost" id="clrCancel">取消</button>
            <button class="btn-primary" id="clrOk">清空</button>
          </div>
        </div>`;
      $('imageView').appendChild(mask);
      const close = () => mask.remove();
      mask.querySelector('#clrClose').addEventListener('click', close);
      mask.querySelector('#clrCancel').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      mask.querySelector('#clrOk').addEventListener('click', async () => {
        const svc = App.services && App.services.images;
        const list = App.state.settings.imageHistory || [];
        for (const entry of list) {
          if (Array.isArray(entry.files) && svc && typeof svc.remove === 'function') {
            for (const name of entry.files) { try { await svc.remove(name); } catch (_) {} }
          }
        }
        App.state.settings.imageHistory = [];
        App.persist();
        close();
        App.image.renderHistory();
        App.ui.toast('已清空图片历史');
      });
    },

    // M7 + v1.1.5（批次 E2）：两张并排对比 + 模型/比例/时间元信息与差异高亮
    openCompare() {
      const list = App.image.compareList.slice(0, 2);
      if (list.length < 2) return;
      const esc = App.escapeHtml;
      const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '未知');
      const rows = (it, other) => {
        const diff = (label, mine, theirs) => {
          const different = String(mine || '—') !== String(theirs || '—');
          return `<div class="cmp-meta-row${different ? ' cmp-diff' : ''}"><span>${label}</span><b>${esc(String(mine || '—'))}</b></div>`;
        };
        return diff('模型', it.model, other.model)
          + diff('比例', SIZE_LABEL[it.size] || it.size, SIZE_LABEL[other.size] || other.size)
          + diff('时间', fmtTime(it.time), fmtTime(other.time));
      };
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'imgCmpMask';
      mask.innerHTML = `
        <div class="modal agent-modal img-cmp" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span>图片对比</span>
            <button class="icon-btn" id="cmpClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body cmp-body">
            ${list.map((it, i) => `<div class="cmp-col">
              <div class="cmp-img"><img src="${dataUrlOf(it.b64)}" alt="图 ${i + 1}"></div>
              <div class="cmp-prompt">${esc(it.prompt)}</div>
              <div class="cmp-meta">${rows(it, list[1 - i])}</div>
            </div>`).join('')}
          </div>
          <div class="modal-footer"><button class="btn-ghost" id="cmpOk">关闭</button></div>
        </div>`;
      $('imageView').appendChild(mask);
      const close = () => { mask.remove(); App.image.compareList = []; App.image.renderHistory(); };
      mask.querySelector('#cmpClose').addEventListener('click', close);
      mask.querySelector('#cmpOk').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    },

    // v1.1.5：灯箱升级——键盘(Esc/←→) + 双击/滚轮缩放拖拽 + 用作参考图 + 复制图片 + 元信息
    openLightbox(images, idx, prompt, meta) {
      App.image.lbImages = images;
      App.image.lbPrompt = prompt || '';
      App.image.lbIdx = idx;
      App.image.lbMeta = meta || null;
      const esc = App.escapeHtml;
      const metaLine = App.image.lbMeta
        ? [App.image.lbMeta.model, SIZE_LABEL[App.image.lbMeta.size] || App.image.lbMeta.size,
           App.image.lbMeta.time ? new Date(App.image.lbMeta.time).toLocaleString() : '']
          .filter(Boolean).map(esc).join(' · ')
        : '';
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
              <div class="lb-zoom-wrap" id="lbZoomWrap"><img id="lbImg" src="" alt="预览" draggable="false"></div>
              <span class="lb-zoom" id="lbZoomBadge">100%</span>
              <button class="lb-nav lb-next" id="lbNext" aria-label="下一张">›</button>
            </div>
            <div class="lb-prompt" id="lbPrompt"></div>
            ${metaLine ? `<div class="lb-meta" id="lbMeta">${metaLine}</div>` : ''}
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="lbUseRef" title="把这张图作为参考图，进入编辑（以图生图）">✎ 用作参考图</button>
            <button class="btn-ghost" id="lbCopyImg" title="复制图片到剪贴板">⧉ 复制图片</button>
            <button class="btn-ghost" id="lbRegen">重新生成</button>
            <button class="btn-ghost" id="lbCopy">复制提示词</button>
            <button class="btn-primary" id="lbDownload">下载</button>
          </div>
        </div>`;
      $('imageView').appendChild(mask);
      let scale = 1, tx = 0, ty = 0;
      const img = () => mask.querySelector('#lbImg');
      const applyZoom = () => {
        const node = img();
        if (!node) return;
        if (scale <= 1) { scale = 1; tx = 0; ty = 0; node.style.transform = ''; node.classList.remove('zoomed'); }
        else node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        const badge = mask.querySelector('#lbZoomBadge');
        if (badge) badge.textContent = Math.round(scale * 100) + '%';
      };
      const resetZoom = () => { scale = 1; tx = 0; ty = 0; applyZoom(); };
      const close = () => {
        if (App.image._lbKeyHandler) { document.removeEventListener('keydown', App.image._lbKeyHandler); App.image._lbKeyHandler = null; }
        mask.remove();
      };
      const step = (dir) => {
        App.image.lbIdx = (App.image.lbIdx + dir + App.image.lbImages.length) % App.image.lbImages.length;
        resetZoom();
        render();
      };
      const render = () => {
        const i = App.image.lbIdx;
        const node = img(); if (node) node.src = dataUrlOf(App.image.lbImages[i]);
        const pr = mask.querySelector('#lbPrompt'); if (pr) pr.textContent = App.image.lbPrompt;
        const prev = mask.querySelector('#lbPrev'), next = mask.querySelector('#lbNext');
        const multi = App.image.lbImages.length > 1;
        if (prev) prev.style.display = multi ? '' : 'none';
        if (next) next.style.display = multi ? '' : 'none';
      };
      render();
      mask.querySelector('#lbClose').addEventListener('click', close);
      mask.querySelector('#lbCopy').addEventListener('click', () => App.image.copyPrompt(App.image.lbPrompt));
      mask.querySelector('#lbDownload').addEventListener('click', () => App.image.download(App.image.lbImages[App.image.lbIdx], App.image.lbIdx));
      mask.querySelector('#lbRegen').addEventListener('click', () => { close(); App.image.regenerate(); });
      // v1.1.5（批次 A1）：一键把当前图带入编辑流（以图生图闭环）
      mask.querySelector('#lbUseRef').addEventListener('click', () => {
        App.image.showRefUI(dataUrlOf(App.image.lbImages[App.image.lbIdx]), '生成结果');
        close();
        const ta = $('imgPrompt');
        if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); }
        App.ui.toast('已设为参考图，输入修改要求后点「编辑图片」');
      });
      // v1.1.5（批次 A1）：复制图片到剪贴板
      mask.querySelector('#lbCopyImg').addEventListener('click', () => {
        App.image.copyImage(App.image.lbImages[App.image.lbIdx]);
      });
      mask.querySelector('#lbPrev').addEventListener('click', () => step(-1));
      mask.querySelector('#lbNext').addEventListener('click', () => step(1));
      // v1.1.5（批次 C1）：键盘操作
      App.image._lbKeyHandler = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      };
      document.addEventListener('keydown', App.image._lbKeyHandler);
      // v1.1.5（批次 C1）：双击 1x↔2x；滚轮 0.2 步进（1–4x）；放大态拖拽平移
      const stage = mask.querySelector('#lbZoomWrap');
      if (stage) {
        stage.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2; tx = 0; ty = 0; applyZoom(); });
        stage.addEventListener('wheel', (e) => {
          e.preventDefault();
          scale = Math.min(4, Math.max(1, scale + (e.deltaY < 0 ? 0.2 : -0.2)));
          if (scale <= 1) resetZoom(); else applyZoom();
        }, { passive: false });
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        stage.addEventListener('pointerdown', (e) => {
          if (scale <= 1) return;
          dragging = true; sx = e.clientX; sy = e.clientY; ox = tx; oy = ty;
          stage.setPointerCapture(e.pointerId);
        });
        stage.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          tx = ox + (e.clientX - sx); ty = oy + (e.clientY - sy);
          applyZoom();
        });
        stage.addEventListener('pointerup', () => { dragging = false; });
        stage.addEventListener('pointercancel', () => { dragging = false; });
      }
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    },

    // v1.1.5（批次 A1）：复制图片（canvas → blob → 剪贴板；失败提示改用下载）
    async copyImage(b64) {
      try {
        const blob = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            canvas.getContext('2d').drawImage(image, 0, 0);
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob failed'))), 'image/png');
          };
          image.onerror = () => reject(new Error('图片解析失败'));
          image.src = dataUrlOf(b64);
        });
        if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          App.ui.toast('已复制图片');
        } else throw new Error('clipboard unsupported');
      } catch (_) {
        App.ui.toast('当前环境不支持复制图片，请使用下载');
      }
    },

    regenerate() {
      const ta = $('imgPrompt');
      if (ta && App.image.rawPrompt) ta.value = App.image.rawPrompt;
      App.image.generate();
    },

    download(b64, idx) {
      if (!b64) return;
      // v1.1.5（批次 C3）：按内容嗅探真实 MIME 命名，jpeg 不再存成 .png
      const mime = sniffMime(b64);
      const ext = MIME_EXT[mime] || 'png';
      const a = document.createElement('a');
      a.href = 'data:' + mime + ';base64,' + b64;
      a.download = `tangbao-${Date.now()}-${(idx || 0) + 1}.${ext}`;
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
