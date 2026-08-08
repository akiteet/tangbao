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

const { classify } = require('../../core/errors');
const { detectAdapter, buildRequest, parseNonStream, normalizeUsage, parseSSE } = require('./adapters'); // v2（P2-7）

const KIND = {
  chat:       { path: '/chat/completions',  method: 'POST' },
  images:     { path: '/images/generations', method: 'POST' },
  embeddings: { path: '/embeddings',        method: 'POST' },
  models:     { path: '/models',            method: 'GET'  },
};

const MAX_BODY = 32 * 1024 * 1024; // 32MB：图生图会把参考图 base64 塞进 payload

let endpoints = new Map();      // ref -> apiBase
let getSecret = () => '';

function configure(opts) {
  if (opts && typeof opts.getSecret === 'function') getSecret = opts.getSecret;
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
  const kind = String(body.kind || 'chat').trim();
  if (!KIND[kind]) { fail(res, 400, '不支持的请求种类：' + kind); return; }
  if (!ref) { fail(res, 400, '缺少密钥引用'); return; }

  const base = getEndpoint(ref);
  if (!base) { fail(res, 400, '未找到该来源的接口地址，请到设置里重新保存账户'); return; }
  const key = getSecret(ref);
  if (!key) { fail(res, 401, '该来源尚未配置 API Key，请到设置里填写'); return; }

  let target;
  try { target = new URL(buildUrl(base, kind)); }
  catch (e) { fail(res, 400, '接口地址无效：' + base); return; }
  const bad = checkTarget(target);
  if (bad) { fail(res, 403, bad); return; }

  // 渲染进程取消（用户点停止 / 关闭页面）时同步掐断上游连接，别让请求继续烧 token
  const ctrl = new AbortController();
  let clientGone = false;
  const onClose = () => { clientGone = true; try { ctrl.abort(); } catch (_) {} };
  res.on('close', onClose);

  try {
    // v4：非 OpenAI Chat 适配器走供应商原生流式，并在主进程转换为既有 OpenAI SSE 形状。
    const adapter = detectAdapter((body.payload && body.payload.model) || '', base);
    if (kind === 'chat' && adapter !== 'openai') {
      const payload = body.payload || {};
      const req = buildRequest(adapter, { apiBase: base, apiKey: key, model: payload.model, messages: payload.messages || [], tools: payload.tools || [], stream: !!payload.stream });
      const upA = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
      if (clientGone) return;
      if (!upA.ok) {
        const raw = await upA.text().catch(() => '');
        let upstreamMsg = '';
        try { const j = JSON.parse(raw); upstreamMsg = (j && j.error && (j.error.message || j.error)) || raw; } catch (_) { upstreamMsg = raw; }
        const err = classify(upA.status, upstreamMsg);
        res.writeHead(upA.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { type: err.type, message: err.message, status: err.status } }));
        return;
      }
      if (!payload.stream) {
        const json = await upA.json().catch(() => ({}));
        const parsed = parseNonStream(adapter, json);
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
        'Accept': body.payload && body.payload.stream ? 'text/event-stream' : 'application/json',
      },
      signal: ctrl.signal,
    };
    if (spec.method !== 'GET') init.body = JSON.stringify(body.payload || {});

    const up = await fetch(target.href, init);
    if (clientGone) return;

    // 上游返回非 2xx：归类后统一成 { error: { type, message, status } } 信封回传前端。
    // 前端 gatewayError 已读取 error.message，新增的 type 用于后续精细化提示，向后兼容。
    if (!up.ok) {
      const raw = await up.text().catch(() => '');
      let upstreamMsg = '';
      try {
        const j = JSON.parse(raw);
        upstreamMsg = (j && j.error && (j.error.message || j.error)) || raw;
      } catch (_) { upstreamMsg = raw; }
      const err = classify(up.status, upstreamMsg);
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { type: err.type, message: err.message, status: err.status } }));
      return;
    }

    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache, no-transform',
    });
    if (up.body) {
      const reader = up.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientGone) { try { await reader.cancel(); } catch (_) {} break; }
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    if (clientGone || (e && e.name === 'AbortError')) { try { res.end(); } catch (_) {} return; }
    // 错误信息里绝不能带上 Authorization / key
    const msg = (e && e.cause && e.cause.code) ? (e.cause.code + ': ' + e.cause.message)
      : (e && e.message) ? e.message : String(e);
    fail(res, 502, '连接模型服务失败：' + msg);
  } finally {
    res.off('close', onClose);
  }
}

module.exports = { configure, setEndpoints, getEndpoint, handleGateway, checkTarget, buildUrl, KIND };
