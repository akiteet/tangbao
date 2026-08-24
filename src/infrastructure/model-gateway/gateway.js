'use strict';
/*
 * 糖包 模型网关（主进程独占）
 *
 * 取代 1.0.6 之前的通用反向代理 /api-proxy。
 *
 * 老的做法：渲染进程用 x-target-url 头指定「转发到哪」，再用 x-auth 头把明文 API Key
 * 一起递过来。等于本机开了一个「谁拿到端口谁就能拿它当跳板」的开放代理，
 * 而且密钥必然要在渲染层出现一次。
 *
 * 现在的做法：渲染进程只发 { ref, kind, payload }：
 *   ref     —— 密钥引用（acc:xxx / custom:chat / …），不是地址
 *   kind    —— 请求种类（chat / images / embeddings / models），映射到固定路径白名单
 *   payload —— 请求体
 * 目标地址由主进程从自己维护的 endpoints 表里查，密钥由主进程从 safeStorage 里取。
 * 渲染进程既指定不了转发目标，也拿不到密钥。
 */

const crypto = require('crypto');
const { classify } = require('../../core/errors');
const { detectAdapter, buildRequest, parseNonStream, normalizeUsage, mergeUsage, parseSSE } = require('./adapters'); // v2（P2-7）
const { normalizeModelUsage } = require('../../core/agent-runtime/model-telemetry');
const { beginModelCall, finishModelCall } = require('../../core/agent-runtime/model-call-recorder');
const { calculateCost } = require('../../core/agent-runtime/cost-ledger');
const TokenEstimator = require('../../core/models/tokenizer');
const ImageCapabilities = require('../../core/models/image-capabilities');
const capabilities = require('../../core/models/capabilities');

const KIND = {
  chat:       { path: '/chat/completions',  method: 'POST' },
  images:     { path: '/images/generations', method: 'POST' },
  embeddings: { path: '/embeddings',        method: 'POST' },
  models:     { path: '/models',            method: 'GET'  },
};

// Module ids are UI concepts. Accept them only as a compatibility alias at
// the boundary and normalize them before endpoint validation and telemetry.
const KIND_ALIASES = Object.freeze({
  tavern: 'chat',
  tangguan: 'chat', // v1.1.8 改名前的旧模块 id，兼容旧遥测数据/旧调用方
  create: 'chat',
  workflow: 'chat',
  'tavern/chat': 'chat',
  'create/chat': 'chat',
});

const MAX_BODY = 32 * 1024 * 1024; // 32MB：图生图会把参考图 base64 塞进 payload

const MAX_ASSET_BODY = 16 * 1024 * 1024;

let endpoints = new Map();      // ref -> apiBase
let getSecret = () => '';
let recordModelCallMetric = null;

function configure(opts) {
  if (opts && typeof opts.getSecret === 'function') getSecret = opts.getSecret;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'recordModelCallMetric')) {
    recordModelCallMetric = typeof opts.recordModelCallMetric === 'function' ? opts.recordModelCallMetric : null;
  }
}

/** 渲染进程在启动/改设置时同步过来的「密钥引用 → API Base」映射表。
 *  B2（P1）：复用 checkTarget 拦云元数据/链路本地地址（防 XSS 后借网关把密钥外带），并加数量上限防膨胀。 */
function setEndpoints(list) {
  const next = new Map();
  const MAX_ENDPOINTS = 64; // B2（P1）：目标表数量上限
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || next.size >= MAX_ENDPOINTS) continue;
    const ref = String(it.ref || '').trim();
    const base = String(it.apiBase || '').trim();
    if (!ref || !base) continue;
    if (!/^https?:\/\//i.test(base)) continue; // 只接受 http/https，挡掉 file:/data: 之类
    try {
      const u = new URL(base);
      if (checkTarget(u)) continue; // 云元数据/链路本地地址直接丢弃
    } catch (_) { continue; }
    next.set(ref, base);
  }
  endpoints = next;
  return next.size;
}

function getEndpoint(ref) {
  return endpoints.get(String(ref || '')) || '';
}

function telemetryMeta(body, kind, adapter) {
  const input = body && body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : {};
  const clean = (value, fallback) => {
    const text = String(value || fallback || '').slice(0, 80);
    return /^[A-Za-z0-9_.:-]*$/.test(text) ? text : String(fallback || '');
  };
  return {
    scope: clean(input.scope, kind === 'images' ? 'image' : 'chat') || 'chat',
    callType: clean(input.callType, kind === 'images' ? 'image' : kind) || kind,
    runId: String(input.runId || '').slice(0, 160),
    rootRunId: String(input.rootRunId || '').slice(0, 160),
    requestId: String(input.requestId || '').slice(0, 160),
    provider: clean(input.provider, adapter),
    accountRef: clean(input.accountRef || input.ref, ''),
    projectId: String(input.projectId || '').slice(0, 160),
  };
}

function recordGatewayMetric(meta) {
  if (!recordModelCallMetric || !meta || meta.kind === 'models') return;
  finishModelCall({
    requestId: meta.requestId || meta.localRequestId,
    runId: meta.runId,
    rootRunId: meta.rootRunId || meta.runId,
    scope: meta.scope,
    callType: meta.callType,
    modelId: meta.model,
    provider: meta.provider,
    accountRef: meta.accountRef,
    projectId: meta.projectId,
    module: meta.scope,
    startedAt: meta.startedAt,
  }, {
    usage: meta.usage || null,
    cache: meta.cache || null,
    costUsd: meta.costUsd,
    cost: meta.cost || null,
    costSource: meta.costSource || '',
    status: meta.status || 'completed',
    errorType: meta.errorType || '',
    error: meta.error || null,
    finishedAt: meta.finishedAt,
    queueWaitMs: meta.queueWaitMs,
  }, recordModelCallMetric);
}

/*
 * 目标地址校验。
 *
 * 这里刻意「不」一刀切禁掉内网地址：本地跑 Ollama(127.0.0.1:11434) / LM Studio /
 * vLLM，或者公司内网的中转站，都是这个网关的正常用法，而且目标地址来自用户自己
 * 在设置里填的 Base URL，不是请求里传来的任意 URL —— SSRF 的前提（攻击者可控目标）
 * 已经被 endpoints 表消掉了。
 *
 * 仍然明确拦掉的是云厂商元数据地址：169.254.169.254 / metadata.google.internal 之类，
 * 这些没有任何作为模型服务地址的正当理由，是典型的凭据窃取目标。
 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function checkTarget(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https';
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // B7（P3）：IPv4-mapped IPv6 提取内嵌 IPv4 再判定，防绕过云元数据黑名单。
  // Node 的 URL 会把 ::ffff:169.254.169.254 规范化为十六进制段 ::ffff:a9fe:a9fe，两种形态都要解。
  const v4mappedDecimal = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  const v4mappedHex = /^::ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(host);
  if (v4mappedDecimal) host = v4mappedDecimal[1];
  else if (v4mappedHex) {
    const b = (h) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 0xff];
    host = b(v4mappedHex[1]).concat(b(v4mappedHex[2])).join('.');
  }
  if (METADATA_HOSTS.has(host)) return '拒绝访问云元数据地址';
  if (/^169\.254\./.test(host)) return '拒绝访问链路本地地址';
  return '';
}

function buildUrl(base, kind) {
  const spec = KIND[kind];
  const b = String(base || '').replace(/\/+$/, '');
  // 用户可能已经把完整路径写进了 Base URL，避免拼成 /chat/completions/chat/completions
  const tail = spec.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(tail + '$', 'i').test(b)) return b;
  return b + spec.path;
}

function normalizeKind(value) {
  const source = value && typeof value === 'object'
    ? (value.kind || value.type || value.requestType)
    : value;
  const requested = String(source || 'chat').trim().toLowerCase();
  return KIND_ALIASES[requested] || requested || 'chat';
}

const RENDERER_POLICY_FIELDS = new Set([
  'web',
  'allowWeb',
  'allowAttachments',
  'allowTools',
  'providerModule',
  'requestKind',
  'imageProtocol',
  'imageSizeStrategy',
  'imageSizeFormat',
  'imageSizes',
]);

function sanitizeProviderPayload(value) {
  // Module policy belongs to the renderer/runtime. Strip it recursively so a
  // legacy caller cannot smuggle `web` (or another policy flag) through an
  // extension object or nested provider options.
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderPayload(item));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (RENDERER_POLICY_FIELDS.has(key)) continue;
    output[key] = sanitizeProviderPayload(item);
  }
  return output;
}

function adaptImagePayload(apiBase, rawPayload, payload) {
  const source = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const model = String((payload && payload.model) || source.model || '').trim();
  const config = {
    imageProtocol: source.imageProtocol,
    imageSizeStrategy: source.imageSizeStrategy,
    imageSizeFormat: source.imageSizeFormat,
    imageSizes: source.imageSizes,
  };
  const capability = ImageCapabilities.resolve(apiBase, model, { config });
  return { payload: ImageCapabilities.adaptPayload(payload, capability), capability };
}

function upstreamMessage(raw) {
  const text = String(raw || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error === 'object') {
      return String(parsed.error.message || parsed.error.code || text);
    }
    if (parsed && (parsed.message || parsed.code)) return String(parsed.message || parsed.code);
  } catch (_) {}
  return text;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res, code, msg, type) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  // 未显式指定 type 时按状态码归类（保持与上游统一错误一致）
  const t = type || classify(code, msg).type;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { type: t, message: msg, status: code } }));
}

async function handleGateway(req, res) {
  if (req.method !== 'POST') { fail(res, 405, '只支持 POST'); return; }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch (e) {
    fail(res, 400, '请求体不是合法 JSON：' + (e.message || e));
    return;
  }
  const ref = String(body.ref || '').trim();
  const kind = normalizeKind(body);
  const rawPayload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload : {};
  let providerPayload = sanitizeProviderPayload(rawPayload);
  if (!KIND[kind]) { fail(res, 400, '不支持的请求种类：' + kind); return; }
  if (!ref) { fail(res, 400, '缺少密钥引用'); return; }

  const base = getEndpoint(ref);
  if (kind === 'images') providerPayload = adaptImagePayload(base, rawPayload, providerPayload).payload;
  if (!base) { fail(res, 400, '未找到该来源的接口地址，请到设置里重新保存账户'); return; }
  const key = getSecret(ref);
  if (!key) { fail(res, 401, '该来源尚未配置 API Key，请到设置里填写'); return; }

  let target;
  try { target = new URL(buildUrl(base, kind)); }
  catch (e) { fail(res, 400, '接口地址无效：' + base); return; }
  const bad = checkTarget(target);
  if (bad) { fail(res, 403, bad); return; }

  const adapter = detectAdapter(providerPayload.model || '', base);
  const call = beginModelCall(Object.assign(telemetryMeta(body, kind, adapter), {
    modelId: String(providerPayload.model || ''),
  }));
  const telemetry = Object.assign(telemetryMeta(body, kind, adapter), {
    kind,
    model: String(providerPayload.model || ''),
    // Keep a local request id even when the provider returns its own id. The
    // historic requestId field remains provider-compatible for existing traces.
    localRequestId: call.requestId,
    requestId: String(body.telemetry && body.telemetry.requestId || ''),
    startedAt: call.startedAt,
    status: 'completed',
    usage: null,
  });

  // 渲染进程取消（用户点停止 / 关闭页面）时同步掐断上游连接，别让请求继续烧 token
  const ctrl = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    telemetry.status = 'cancelled';
    telemetry.errorType = 'cancelled';
    try { ctrl.abort(); } catch (_) {}
  };
  res.on('close', onClose);

  try {
    // v4：非 OpenAI Chat 适配器走供应商原生流式，并在主进程转换为既有 OpenAI SSE 形状。
    if (kind === 'chat' && adapter !== 'openai') {
      const payload = providerPayload;
      // v1.1.5（F1）：聊天路径与糖码 engine 的 callLLMStream 对齐——缓存注入前先过能力判定，
      // reasoning 类（promptCachingMode === 'off'）不再携带 cache_control；渲染层仍可用 promptCaching:false 强制关闭。
      const cachingMode = capabilities.promptCachingMode ? capabilities.promptCachingMode(payload.model, base) : 'auto';
      const useCaching = payload.promptCaching !== false && cachingMode !== 'off';
      const req = buildRequest(adapter, {
        apiBase: base,
        apiKey: key,
        model: payload.model,
        messages: payload.messages || [],
        tools: payload.tools || [],
        stream: !!payload.stream,
        maxOutputTokens: payload.maxOutputTokens || payload.max_tokens,
        promptCaching: useCaching,
        cachedContentName: payload.cachedContentName || payload.cachedContent,
      });
      const upA = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
      if (clientGone) return;
       if (!upA.ok) {
         telemetry.status = 'failed';
         telemetry.errorType = classify(upA.status, '').type;
        const raw = await upA.text().catch(() => '');
        let upstreamMsg = '';
        upstreamMsg = upstreamMessage(raw);
        const err = classify(upA.status, upstreamMsg);
        res.writeHead(upA.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { type: err.type, message: err.message, status: err.status } }));
        return;
      }
      if (!payload.stream) {
        const json = await upA.json().catch(() => ({}));
         const parsed = parseNonStream(adapter, json);
         telemetry.usage = normalizeUsage(adapter, json);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: parsed.content, reasoning_content: parsed.reasoning, tool_calls: parsed.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }, finish_reason: parsed.toolCalls.length ? 'tool_calls' : 'stop' }], usage: normalizeUsage(adapter, json) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
      const enc = (data) => 'data: ' + JSON.stringify(data) + '\n\n';
      const reader = upA.body.getReader(), decoder = new TextDecoder(), state = {};
      let buffer = '', toolIndex = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim().startsWith('data:')) continue;
           const event = parseSSE(adapter, line, state); if (!event) continue;
            if (event.usage) telemetry.usage = mergeUsage(telemetry.usage, event.usage);
          if (event.reasoning) res.write(enc({ choices: [{ delta: { reasoning_content: event.reasoning } }] }));
          if (event.content) res.write(enc({ choices: [{ delta: { content: event.content } }] }));
          for (const call of event.toolCalls || (event.toolCall ? [event.toolCall] : [])) res.write(enc({ choices: [{ delta: { tool_calls: [{ index: toolIndex++, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } }] }));
        }
      }
      res.write(enc({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    const spec = KIND[kind];
    const init = {
      method: spec.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Accept': providerPayload.stream ? 'text/event-stream' : 'application/json',
      },
      signal: ctrl.signal,
    };
    if (spec.method !== 'GET') {
      const outboundPayload = providerPayload;
      // OpenAI-compatible providers only send stream usage when explicitly asked.
      if (kind === 'chat' && adapter === 'openai' && outboundPayload.stream) {
        outboundPayload.stream_options = Object.assign({}, outboundPayload.stream_options || {}, { include_usage: true });
      }
      init.body = JSON.stringify(outboundPayload);
    }

    const up = await fetch(target.href, init);
    if (clientGone) return;

    // 上游返回非 2xx：归类后统一成 { error: { type, message, status } } 信封回传前端。
    // 前端 gatewayError 已读取 error.message，新增的 type 用于后续精细化提示，向后兼容。
    if (!up.ok) {
      telemetry.status = 'failed';
      telemetry.errorType = classify(up.status, '').type;
      const raw = await up.text().catch(() => '');
      let upstreamMsg = '';
      upstreamMsg = upstreamMessage(raw);
      const err = classify(up.status, upstreamMsg);
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8' });
      const imageCapabilities = kind === 'images'
        ? ImageCapabilities.learnFromError(base, telemetry.model, raw)
        : null;
      const errorPayload = { type: err.type, message: err.message, status: err.status };
      if (imageCapabilities && imageCapabilities.source === 'learned') errorPayload.details = { imageCapabilities };
      res.end(JSON.stringify({ error: errorPayload }));
      return;
    }

    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache, no-transform',
    });
    telemetry.requestId = telemetry.requestId || String(up.headers.get('x-request-id') || '');
    if (up.body && !providerPayload.stream) {
      const raw = await up.text();
      try { telemetry.usage = normalizeUsage(adapter, JSON.parse(raw)); } catch (_) {}
      if (!clientGone) res.end(raw);
      return;
    }
    if (up.body) {
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const observe = (line) => {
        const text = String(line || '').trim();
        if (!text.startsWith('data:')) return;
        const raw = text.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        try {
          const json = JSON.parse(raw);
          if (json.usage || json.usageMetadata || (json.response && json.response.usage)) telemetry.usage = mergeUsage(telemetry.usage, normalizeUsage(adapter, json.response || json));
        } catch (_) {}
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientGone) { try { await reader.cancel(); } catch (_) {} break; }
        const chunk = Buffer.from(value);
        res.write(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(observe);
      }
      observe(buffer);
    }
    res.end();
  } catch (e) {
    if (clientGone || (e && e.name === 'AbortError')) {
      telemetry.status = 'cancelled';
      telemetry.errorType = 'cancelled';
      try { res.end(); } catch (_) {}
      return;
    }
    telemetry.status = 'failed';
    telemetry.errorType = e && e.type || 'infrastructure_failure';
    // 错误信息里绝不能带上 Authorization / key
    const msg = (e && e.cause && e.cause.code) ? (e.cause.code + ': ' + e.cause.message)
      : (e && e.message) ? e.message : String(e);
    fail(res, 502, '连接模型服务失败：' + msg);
  } finally {
    telemetry.finishedAt = Date.now();
    recordGatewayMetric(telemetry);
    res.off('close', onClose);
  }
}

function jsonError(status, message, type) {
  const error = new Error(String(message || '请求失败'));
  error.status = Number(status) || 500;
  error.type = String(type || 'infrastructure_failure');
  return error;
}

function probeMessages() {
  return [
    { role: 'system', content: 'You are a cache measurement probe. Reply with the single word OK.' },
    { role: 'user', content: 'Reply with OK.' },
  ];
}

function cacheSample(adapter, json, eligibleTokens, mode, prefix) {
  const usage = normalizeUsage(adapter, json || {});
  const reported = usage.cacheReported === true;
  const cacheReadTokens = reported ? usage.cacheReadTokens : null;
  const hitRate = eligibleTokens != null && eligibleTokens > 0 && cacheReadTokens != null ? Math.min(1, cacheReadTokens / eligibleTokens) : null;
  return {
    mode,
    eligibleTokens: reported ? eligibleTokens : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: reported ? usage.cacheWriteTokens : null,
    hitRate,
    savedTokens: cacheReadTokens,
    source: reported ? 'provider' : 'unknown',
    dataOrigin: reported ? 'provider_usage' : 'unknown',
    unknownReason: reported ? (cacheReadTokens == null ? 'provider_did_not_report_cache_read' : null) : 'provider_did_not_report_cache_usage',
    prefixFingerprint: prefix,
  };
}

async function probeCache(ref, model, options) {
  const base = getEndpoint(ref);
  const key = getSecret(ref);
  const targetModel = String(model || '').trim();
  if (!base) throw jsonError(400, '未找到该来源的接口地址', 'model_failure');
  if (!key) throw jsonError(401, '该来源尚未配置 API Key', 'permission_failure');
  if (!targetModel) throw jsonError(400, '缺少模型名称', 'invalid_result');
  const adapter = detectAdapter(targetModel, base);
  const messages = probeMessages();
  const eligibleTokens = TokenEstimator.estimateTokens(messages.map((item) => item.content).join('\n'));
  const prefix = crypto.createHash('sha256').update(JSON.stringify({ adapter, model: targetModel, messages })).digest('hex');
  const samples = [];
  const calls = [];
  const invoke = async (mode, request) => {
    const startedAt = Date.now();
    const call = beginModelCall({ scope: 'cache', callType: 'cache_probe', modelId: targetModel, provider: adapter, accountRef: ref, module: 'cache' });
    let status = 'completed';
    let json = {};
    let errorType = '';
    try {
      const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
      const raw = await response.text();
      try { json = JSON.parse(raw || '{}'); } catch (_) { json = {}; }
      if (!response.ok) throw jsonError(response.status, 'Provider 返回 ' + response.status, 'model_failure');
      const providerUsage = normalizeUsage(adapter, json);
      const cache = cacheSample(adapter, json, eligibleTokens, mode, prefix);
      const cost = calculateCost({ provider: adapter, model: targetModel, usage: providerUsage, cache });
      const measured = Object.assign({}, cache, { estimatedCostUsd: cost.totalUsd, estimatedSavedCostUsd: cost.savedUsd });
      samples.push(measured);
      return json;
    } catch (error) {
      status = 'failed';
      errorType = error && error.type || 'infrastructure_failure';
      throw error;
    } finally {
      calls.push(finishModelCall(call, {
        usage: json && Object.keys(json).length ? normalizeUsage(adapter, json) : null,
        cache: samples[samples.length - 1] && samples[samples.length - 1].mode === mode ? samples[samples.length - 1] : { mode, source: 'unknown', unknownReason: 'probe_request_failed', dataOrigin: 'unknown', prefixFingerprint: prefix },
        cost: samples[samples.length - 1] && samples[samples.length - 1].mode === mode ? calculateCost({ provider: adapter, model: targetModel, usage: normalizeUsage(adapter, json), cache: samples[samples.length - 1] }) : null,
        status,
        errorType,
        finishedAt: Date.now(),
        costUsd: null,
        queueWaitMs: Math.max(0, startedAt - call.startedAt),
      }, recordModelCallMetric));
    }
  };

  let cachedContentName = '';
  const createGeminiCache = async () => {
    const cacheBase = String(base).replace(/\/v1beta\/?$/i, '').replace(/\/+$/, '');
    const createUrl = cacheBase + '/v1beta/cachedContents';
    const cacheResponse = await fetch(createUrl, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'models/' + targetModel, ttl: '300s', systemInstruction: { parts: [{ text: messages[0].content }] }, contents: [{ role: 'user', parts: [{ text: messages[1].content }] }] }),
    });
    const cacheJson = await cacheResponse.json().catch(() => ({}));
    if (!cacheResponse.ok || !cacheJson.name) throw jsonError(cacheResponse.status, 'Gemini cachedContent 创建失败', 'model_failure');
    return cacheJson.name;
  };

  for (let i = 0; i < 2; i++) {
    // Gemini 的第一轮必须是真正的冷请求；只有在冷请求完成后创建
    // cachedContent，第二轮才携带资源并读取 provider 返回的命中 Usage。
    if (adapter === 'gemini' && i === 1 && !cachedContentName) cachedContentName = await createGeminiCache();
    const request = buildRequest(adapter, {
      apiBase: base,
      apiKey: key,
      model: targetModel,
      messages,
      tools: [],
      stream: false,
      promptCaching: true,
      cachedContentName: i === 1 ? cachedContentName || undefined : undefined,
      maxOutputTokens: 16,
    });
    await invoke(i === 0 ? 'cold' : 'warm', request);
  }
  const warm = samples[1] || {};
  const cold = samples[0] || {};
  const hit = warm.cacheReadTokens == null ? null : warm.cacheReadTokens;
  const result = {
    ok: true,
    adapter,
    model: targetModel,
    requestCount: 2,
    cold,
    warm,
    cache: Object.assign({}, warm, {
      eligibleTokens: cold.eligibleTokens != null ? cold.eligibleTokens : warm.eligibleTokens,
      savedTokens: hit,
      hitRate: hit != null && (warm.eligibleTokens || eligibleTokens) > 0 ? hit / (warm.eligibleTokens || eligibleTokens) : null,
      estimatedCostUsd: null,
      estimatedSavedCostUsd: null,
      unknownReason: hit == null ? (warm.unknownReason || 'provider_did_not_report_cache_usage') : null,
    }),
    calls,
    notice: '已执行两次真实请求；Provider 可能计费。未返回 Usage 的字段保持未知。',
  };
  return result;
}

async function healthCheck(ref, model, kind) {
  const base = getEndpoint(ref);
  const key = getSecret(ref);
  const targetModel = String(model || '').trim();
  const result = {
    ok: true,
    ref: String(ref || ''),
    model: targetModel,
    apiReachable: false,
    keyConfigured: !!key,
    modelExists: null,
    capabilities: {},
    latencyMs: null,
    firstByteLatencyMs: null,
    responseLatencyMs: null,
    usageSupport: null,
    cacheSupport: null,
    error: null,
  };
  if (!base) return Object.assign(result, { ok: false, error: { type: 'model_failure', code: 'endpoint_missing', message: '未找到接口地址' } });
  if (!key) return Object.assign(result, { ok: false, error: { type: 'permission_failure', code: 'api_key_missing', message: 'API Key 未配置' } });
  const startedAt = Date.now();
  const adapter = detectAdapter(targetModel, base);
  const call = beginModelCall({ scope: 'provider', callType: 'health_check', modelId: targetModel, provider: adapter });
  let status = 'completed';
  let errorType = '';
  try {
    const target = new URL(buildUrl(base, 'models'));
    const blocked = checkTarget(target);
    if (blocked) throw jsonError(403, blocked, 'permission_failure');
    const response = await fetch(target.href, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
    const responseStartedAt = Date.now();
    let firstByteAt = null;
    let raw = '';
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (firstByteAt == null && part.value && part.value.byteLength) firstByteAt = Date.now();
        if (part.value) {
          const chunk = Buffer.from(part.value);
          chunks.push(chunk);
          total += chunk.length;
        }
      }
      raw = Buffer.concat(chunks, total).toString('utf8');
    } else {
      raw = await response.text();
      if (raw) firstByteAt = Date.now();
    }
    result.firstByteLatencyMs = firstByteAt == null ? null : Math.max(0, firstByteAt - startedAt);
    result.responseLatencyMs = Math.max(0, Date.now() - startedAt);
    result.latencyMs = result.responseLatencyMs;
    result.apiReachable = response.ok || response.status === 401 || response.status === 403;
    let json = {};
    try { json = JSON.parse(raw || '{}'); } catch (_) {}
    if (!response.ok) throw jsonError(response.status, 'Provider 返回 ' + response.status, response.status === 401 || response.status === 403 ? 'permission_failure' : 'model_failure');
    const ids = Array.isArray(json.data) ? json.data.map((item) => String(item.id || '')) : [];
    result.modelExists = targetModel ? ids.includes(targetModel) || !ids.length : null;
    result.cacheSupport = { supported: adapterCacheSupport(targetModel, base), adapter, usage: adapter === 'openai' || adapter === 'openai-responses' || adapter === 'anthropic' || adapter === 'gemini' ? 'provider_or_unknown' : 'unknown' };
    result.usageSupport = { tokens: adapter !== 'unknown', cache: result.cacheSupport.usage };
    result.capabilities = {
      chat: true,
      tool: true,
      vision: /vision|vl|4o|gemini|claude-3/i.test(targetModel),
      image: String(kind || '') === 'images',
      cache: result.cacheSupport,
    };
    return result;
  } catch (error) {
    status = 'failed';
    errorType = error.type || 'infrastructure_failure';
    result.ok = false;
    result.error = { type: error.type || 'infrastructure_failure', code: error.code || 'health_check_failed', message: error.message || String(error) };
    return result;
  } finally {
    finishModelCall(call, {
      status,
      errorType,
      finishedAt: Date.now(),
      usage: null,
      cache: null,
      costUsd: null,
      queueWaitMs: Math.max(0, startedAt - call.startedAt),
    }, recordModelCallMetric);
  }
}

function adapterCacheSupport(model, base) {
  const adapter = detectAdapter(model, base);
  return { openai: true, 'openai-responses': true, anthropic: true, gemini: true }[adapter] === true;
}

async function createEmbeddings(ref, model, texts, options) {
  const base = getEndpoint(ref);
  const key = getSecret(ref);
  const targetModel = String(model || '').trim();
  const inputs = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item == null ? '' : item).slice(0, 12000)).filter(Boolean).slice(0, 128);
  if (!base) throw jsonError(400, '未找到该来源的接口地址', 'model_failure');
  if (!key) throw jsonError(401, '该来源尚未配置 API Key', 'permission_failure');
  if (!targetModel || !inputs.length) throw jsonError(400, '缺少 Embedding 模型或输入', 'invalid_result');
  const adapter = detectAdapter(targetModel, base);
  const call = beginModelCall({ scope: 'tavern', callType: options && options.callType || 'embedding_index', modelId: targetModel, provider: adapter, accountRef: ref, module: 'tavern' });
  const startedAt = Date.now();
  let status = 'completed';
  let errorType = '';
  let usage = null;
  const cache = {
    mode: 'not_eligible',
    source: 'unknown',
    dataOrigin: 'not_applicable',
    unknownReason: 'not_cache_eligible',
    prefixFingerprint: '',
  };
  try {
    let url = buildUrl(base, 'embeddings');
    let headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    let body = { model: targetModel, input: inputs.length === 1 ? inputs[0] : inputs };
    if (adapter === 'gemini') {
      const root = String(base).replace(/\/v1beta\/?$/i, '').replace(/\/+$/, '');
      url = root + '/v1beta/models/' + encodeURIComponent(targetModel.replace(/^models\//, '')) + ':batchEmbedContents?key=' + encodeURIComponent(key);
      headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      body = { requests: inputs.map((text) => ({ model: 'models/' + targetModel.replace(/^models\//, ''), content: { parts: [{ text }] } })) };
    } else {
      headers.Authorization = 'Bearer ' + key;
    }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw jsonError(response.status, 'Embedding Provider 返回 ' + response.status, 'model_failure');
    usage = normalizeUsage(adapter, json);
    const vectors = adapter === 'gemini'
      ? (Array.isArray(json.embeddings) ? json.embeddings.map((item) => item && item.values || []) : [])
      : (Array.isArray(json.data) ? json.data.sort((a, b) => Number(a.index || 0) - Number(b.index || 0)).map((item) => item && item.embedding || []) : []);
    if (vectors.length !== inputs.length || vectors.some((vector) => !Array.isArray(vector) || !vector.length)) throw jsonError(502, 'Embedding Provider 未返回完整向量', 'invalid_result');
    return { ok: true, vectors, usage, provider: adapter, model: targetModel, requestId: call.requestId, latencyMs: Date.now() - startedAt, dataOrigin: 'provider' };
  } catch (error) {
    status = 'failed';
    errorType = error && error.type || 'infrastructure_failure';
    throw error;
  } finally {
    finishModelCall(call, { usage, cache, status, errorType, finishedAt: Date.now(), queueWaitMs: Math.max(0, startedAt - call.startedAt) }, recordModelCallMetric);
  }
}

function validateImageAssetUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'asset_url_protocol' };
    const blocked = checkTarget(url);
    if (blocked) return { ok: false, code: 'asset_url_blocked', error: blocked };
    return { ok: true, url: url.href };
  } catch (_) {
    return { ok: false, code: 'asset_url_invalid' };
  }
}

async function readImageAsset(value, options) {
  const checked = validateImageAssetUrl(value);
  if (!checked.ok) throw jsonError(400, checked.error || checked.code, 'permission_failure');
  const opts = options && typeof options === 'object' ? options : {};
  const maxBytes = Math.min(Math.max(Number(opts.maxBytes) || MAX_ASSET_BODY, 1024), MAX_ASSET_BODY);
  const response = await fetch(checked.url, { redirect: 'error', signal: opts.signal });
  if (!response.ok) throw jsonError(response.status, 'image asset request failed', 'model_failure');
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith('image/')) throw jsonError(415, 'image asset content type is not an image', 'invalid_result');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw jsonError(413, 'image asset is too large', 'invalid_result');
  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value || []);
      total += chunk.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} throw jsonError(413, 'image asset is too large', 'invalid_result'); }
      chunks.push(chunk);
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw jsonError(413, 'image asset is too large', 'invalid_result');
    chunks.push(buffer);
    total = buffer.length;
  }
  const buffer = Buffer.concat(chunks, total);
  const type = contentType || 'application/octet-stream';
  return { ok: true, url: checked.url, contentType: type, bytes: buffer.length, buffer, dataUrl: 'data:' + type + ';base64,' + buffer.toString('base64') };
}

module.exports = { configure, setEndpoints, getEndpoint, handleGateway, probeCache, healthCheck, createEmbeddings, checkTarget, buildUrl, normalizeKind, sanitizeProviderPayload, adaptImagePayload, validateImageAssetUrl, readImageAsset, KIND };
