'use strict';

// Shared image capability registry. The renderer uses the same resolver as
// the gateway, while learned entries remain scoped to one API base and model.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.ImageCapabilities = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_OPENAI_SIZES = Object.freeze(['1024x1024', '1792x1024', '1024x1792']);
  const GPT_IMAGE_SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536']);
  const DALLE_2_SIZES = Object.freeze(['256x256', '512x512', '1024x1024']);
  const WANX_V1_SIZES = Object.freeze(['1024x1024', '1280x720', '720x1280']);
  const DEFAULT_UI_SIZES = Object.freeze([
    '1024x1024', '1792x1024', '1024x1792',
    '1280x960', '960x1280', '1536x1024', '1024x1536',
    '1280x1024', '1024x1280', '2048x1024', '1024x2048',
    '3072x1024', '1024x3072',
  ]);
  const SENSENOVA_U1_SIZES = Object.freeze([
    '1664x2496', '2496x1664', '1760x2368',
    '2368x1760', '1824x2272', '2272x1824',
  ]);
  // Hosted SenseNova uses the `-fast` suffix for the broad U1 Fast contract.
  const SENSENOVA_U1_MODELS = Object.freeze(['sensenova-u1', 'sensenova-u1-fast']);
  const PROTOCOLS = new Set(['auto', 'openai-images', 'sensenova-images', 'dashscope-images']);
  const SIZE_STRATEGIES = new Set(['auto', 'allow-list', 'custom']);
  const SIZE_FORMATS = new Set(['x', '*', 'width-height']);
  const learned = new Map();

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  function normalizeApiBase(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.hash = '';
      url.search = '';
      return url.href.replace(/\/+$/, '').toLowerCase();
    } catch (_) {
      return raw.replace(/\/+$/, '').toLowerCase();
    }
  }

  function normalizeModel(value) {
    return String(value || '').trim();
  }

  function isSenseNovaU1Model(value) {
    const normalized = normalizeModel(value).toLowerCase().replace(/[\s_]+/g, '-');
    return SENSENOVA_U1_MODELS.includes(normalized);
  }

  function isSenseNovaU1FastModel(value) {
    const normalized = normalizeModel(value).toLowerCase().replace(/[\s_]+/g, '-');
    return normalized === 'sensenova-u1-fast';
  }

  function keyFor(apiBase, model) {
    return normalizeApiBase(apiBase) + '\u0000' + normalizeModel(model);
  }

  function parseSize(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const width = Number(value.width);
      const height = Number(value.height);
      if (Number.isSafeInteger(width) && Number.isSafeInteger(height)) value = width + 'x' + height;
    }
    const match = /^(\d{3,5})\s*[x\u00d7*]\s*(\d{3,5})$/i.exec(String(value || '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 256 || height < 256 || width > 16384 || height > 16384) return null;
    return { width, height, value: width + 'x' + height };
  }

  function normalizeSizes(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
    const result = [];
    const seen = new Set();
    for (const item of source) {
      const parsed = parseSize(item);
      if (!parsed || seen.has(parsed.value)) continue;
      const size = parsed.value;
      seen.add(size);
      result.push(size);
    }
    return result;
  }

  function normalizeDefinition(definition, source) {
    const value = definition && typeof definition === 'object' ? definition : {};
    const apiBase = normalizeApiBase(value.apiBase);
    const model = normalizeModel(value.model);
    if (!model) return null;
    const configuredSizes = Array.isArray(value.sizes)
      ? (value.sizes.length ? value.sizes : value.imageSizes)
      : (String(value.sizes || '').trim() ? value.sizes : value.imageSizes);
    const sizes = normalizeSizes(configuredSizes);
    const protocol = PROTOCOLS.has(String(value.protocol || value.imageProtocol || 'auto'))
      ? String(value.protocol || value.imageProtocol || 'auto') : 'auto';
    const sizeStrategy = SIZE_STRATEGIES.has(String(value.sizeStrategy || value.imageSizeStrategy || 'auto'))
      ? String(value.sizeStrategy || value.imageSizeStrategy || 'auto') : 'auto';
    const sizeFormat = SIZE_FORMATS.has(String(value.sizeFormat || value.imageSizeFormat || 'x'))
      ? String(value.sizeFormat || value.imageSizeFormat || 'x') : 'x';
    const uiSizes = normalizeSizes(value.uiSizes || DEFAULT_UI_SIZES);
    return {
      apiBase,
      model,
      key: keyFor(apiBase, model),
      protocol,
      sizeStrategy,
      sizeFormat,
      sizes,
      uiSizes,
      defaultSize: normalizeSizes([value.defaultSize || ''])[0] || sizes[0] || '',
      responseFormat: value.responseFormat === 'url' ? 'url' : 'b64_json',
      source: String(source || value.source || 'configured'),
      learnedAt: Number(value.learnedAt) || 0,
      unknownReason: value.unknownReason ? String(value.unknownReason).slice(0, 240) : '',
    };
  }

  function register(definition) {
    const normalized = normalizeDefinition(definition, definition && definition.source);
    if (!normalized) return null;
    learned.set(normalized.key, normalized);
    return clone(normalized);
  }

  function exact(apiBase, model) {
    return learned.get(keyFor(apiBase, model)) || learned.get(keyFor('*', model)) || null;
  }

  function builtinFor(apiBase, model) {
    const name = normalizeModel(model);
    if (isSenseNovaU1Model(name)) {
      const fast = isSenseNovaU1FastModel(name);
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'sensenova-images',
        // U1 Fast accepts the broad image-size surface. Keep the UI broad
        // until the provider returns an explicit allow-list error, then let
        // learnFromError persist the narrower contract for this exact model.
        sizeStrategy: fast ? 'auto' : 'allow-list',
        sizes: fast ? [] : SENSENOVA_U1_SIZES,
        defaultSize: fast ? DEFAULT_UI_SIZES[0] : SENSENOVA_U1_SIZES[0],
      }, 'builtin');
    }
    const normalizedName = name.toLowerCase().replace(/[\s_/]+/g, '-');
    if (/^gpt-image-2(?:[-.]|$)/i.test(normalizedName)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'openai-images',
        // GPT Image 2 exposes more than the legacy GPT Image 1 trio. Start
        // with the common UI sizes and learn an upstream allow-list if one is
        // returned by a compatible gateway.
        sizeStrategy: 'auto',
        sizes: [],
        defaultSize: DEFAULT_UI_SIZES[0],
      }, 'builtin');
    }
    if (/^gpt-image(?:-1)?(?:[-.]|$)/i.test(normalizedName)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'openai-images',
        sizeStrategy: 'allow-list',
        sizes: GPT_IMAGE_SIZES,
        defaultSize: GPT_IMAGE_SIZES[0],
      }, 'builtin');
    }
    if (/^dall-e-2(?:-|$)/i.test(normalizedName)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'openai-images',
        sizeStrategy: 'allow-list',
        sizes: DALLE_2_SIZES,
        defaultSize: DALLE_2_SIZES[0],
      }, 'builtin');
    }
    if (/^dall-e-3(?:-|$)/i.test(normalizedName)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'openai-images',
        sizeStrategy: 'allow-list',
        sizes: DEFAULT_OPENAI_SIZES,
        defaultSize: DEFAULT_OPENAI_SIZES[0],
      }, 'builtin');
    }
    if (/^wanx(?:-v1)?(?:-|$)/i.test(normalizedName)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'dashscope-images',
        sizeStrategy: 'allow-list',
        sizeFormat: '*',
        sizes: WANX_V1_SIZES,
        defaultSize: WANX_V1_SIZES[0],
      }, 'builtin');
    }
    const base = normalizeApiBase(apiBase);
    if (/openai/i.test(base)) {
      return normalizeDefinition({
        apiBase,
        model: name,
        protocol: 'openai-images',
        sizeStrategy: 'auto',
        sizes: [],
      }, 'unknown');
    }
    return normalizeDefinition({
      apiBase,
      model: name,
      protocol: 'auto',
      sizeStrategy: 'auto',
      sizes: [],
      unknownReason: 'model_not_registered',
    }, 'unknown');
  }

  function resolve(apiBase, model, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const name = normalizeModel(model);
    if (!name) return normalizeDefinition({ apiBase, model: 'unknown', source: 'unknown', sizes: [] }, 'unknown');
    if (opts.store) hydrate(opts.store);
    const configured = opts.config && typeof opts.config === 'object' ? opts.config : null;
    const stored = exact(apiBase, name);
    const base = stored || builtinFor(apiBase, name);
    const merged = Object.assign({}, base, { apiBase, model: name });
    if (configured) {
      for (const key of ['protocol', 'sizeStrategy', 'sizeFormat', 'sizes', 'defaultSize', 'responseFormat']) {
        if (configured[key] !== undefined && configured[key] !== null && configured[key] !== '') merged[key] = configured[key];
      }
      if (configured.imageProtocol !== undefined && configured.imageProtocol !== null && configured.imageProtocol !== '') {
        merged.protocol = configured.imageProtocol;
      }
      if (configured.imageSizeStrategy !== undefined && configured.imageSizeStrategy !== null && configured.imageSizeStrategy !== '') {
        merged.sizeStrategy = configured.imageSizeStrategy;
      }
      if (configured.imageSizeFormat !== undefined && configured.imageSizeFormat !== null && configured.imageSizeFormat !== '') {
        merged.sizeFormat = configured.imageSizeFormat;
      }
      if (configured.imageSizes !== undefined && configured.imageSizes !== null && configured.imageSizes !== '') {
        merged.sizes = configured.imageSizes;
      }
      if (Array.isArray(merged.sizes) && merged.sizes.length && merged.sizeStrategy === 'auto') {
        merged.sizeStrategy = 'allow-list';
      }
    }
    const resolved = normalizeDefinition(merged, configured ? 'configured' : base.source);
    if (resolved && !resolved.sizes.length && base.sizes.length) resolved.sizes = base.sizes.slice();
    return resolved || base;
  }

  function extractAllowedSizes(text) {
    const raw = String(text || '');
    const marker = /(?:should\s+be\s+one\s+of|must\s+be\s+one\s+of|allowed\s+(?:sizes?|values?)\s*(?:are|is)?|size\s+is\s+not\s+valid)\s*:?\s*/i.exec(raw);
    if (!marker) return [];
    const tail = raw.slice(marker.index + marker[0].length);
    return normalizeSizes(tail.match(/\b\d{3,5}\s*[x\u00d7*]\s*\d{3,5}\b/gi) || []);
  }

  function learnFromError(apiBase, model, text, options) {
    const sizes = extractAllowedSizes(text);
    if (!sizes.length) return resolve(apiBase, model, options);
    const current = resolve(apiBase, model, options);
    const next = normalizeDefinition(Object.assign({}, current, {
      apiBase,
      model: normalizeModel(model),
      sizes,
      sizeStrategy: 'allow-list',
      source: 'learned',
      learnedAt: Date.now(),
      unknownReason: '',
    }), 'learned');
    learned.set(keyFor(apiBase, model), next);
    return clone(next);
  }

  function chooseSize(requested, allowed) {
    const sizes = normalizeSizes(allowed);
    if (!sizes.length) return String(requested || '');
    if (sizes.includes(String(requested || ''))) return String(requested);
    const wanted = parseSize(requested) || { width: 1, height: 1 };
    const wantedRatio = wanted.width / wanted.height;
    const wantedArea = wanted.width * wanted.height;
    return sizes.slice().sort((left, right) => {
      const a = parseSize(left), b = parseSize(right);
      const score = (item) => Math.abs(Math.log((item.width / item.height) / wantedRatio))
        + Math.abs(Math.log((item.width * item.height) / wantedArea)) * 0.15;
      return score(a) - score(b);
    })[0];
  }

  function adaptPayload(payload, capability) {
    const output = clone(payload) || {};
    const cap = capability || {};
    if (output.size) {
      const parsed = parseSize(output.size);
      let selected = parsed ? parsed.value : String(output.size || '');
      if (Array.isArray(cap.sizes) && cap.sizes.length
        && cap.sizeStrategy !== 'auto' && !cap.sizes.includes(selected)) {
        selected = chooseSize(selected, cap.sizes);
      }
      if (cap.sizeFormat === '*') output.size = selected.replace('x', '*');
      else if (cap.sizeFormat === 'width-height') {
        const dimensions = parseSize(selected);
        if (dimensions) {
          output.width = dimensions.width;
          output.height = dimensions.height;
          delete output.size;
        }
      } else {
        output.size = selected;
      }
    }
    return output;
  }

  function normalizeStore(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const output = {};
    for (const [key, entry] of Object.entries(source)) {
      const normalized = normalizeDefinition(entry, entry && entry.source || 'learned');
      if (!normalized || normalized.key !== key) continue;
      output[key] = normalized;
    }
    return output;
  }

  function hydrate(value) {
    const normalized = normalizeStore(value);
    for (const [key, entry] of Object.entries(normalized)) learned.set(key, entry);
    return Object.keys(normalized).length;
  }

  function serialize() {
    const output = {};
    for (const [key, value] of learned.entries()) {
      if (value.source === 'builtin') continue;
      output[key] = clone(value);
    }
    return output;
  }

  return {
    DEFAULT_OPENAI_SIZES,
    GPT_IMAGE_SIZES,
    DALLE_2_SIZES,
    WANX_V1_SIZES,
    DEFAULT_UI_SIZES,
    SENSENOVA_U1_SIZES,
    SENSENOVA_U1_MODELS,
    normalizeApiBase,
    normalizeModel,
    isSenseNovaU1Model,
    isSenseNovaU1FastModel,
    keyFor,
    normalizeSizes,
    normalizeDefinition,
    register,
    resolve,
    extractAllowedSizes,
    learnFromError,
    chooseSize,
    adaptPayload,
    normalizeStore,
    hydrate,
    serialize,
  };
});
