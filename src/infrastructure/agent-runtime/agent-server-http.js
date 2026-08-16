'use strict';
/*
 * 糖码后端 HTTP 传输层（v1.1.5 批次 D1，自 agent-runtime-engine.js 抽出）。
 *
 * 只承载「服务器创建 + 入口守卫链 + CORS + JSON/SSE 发送助手 + 请求体读取」；
 * 业务路由表与处理函数留在 engine（它们与运行态注册表、工具、密钥注入深度耦合）。
 *
 * 守卫顺序与抽出前逐字一致：回环 Host + 允许的 Origin → OPTIONS 预检 →
 * Bearer 启动令牌，三道全过才进入 onRoute；任何路由异常统一 400。
 * getAllowOrigin 以 getter 注入，保留运行时可变的 ALLOW_ORIGIN 语义。
 */
const http = require('http');
const { isLoopbackHost } = require('../http/request-auth');

// 精确回显允许的源，不再使用 '*'；带 Authorization 会触发预检，故要放行该请求头
function cors(res, getAllowOrigin) {
  const allow = getAllowOrigin ? String(getAllowOrigin() || '') : '';
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJSON(res, code, obj, getAllowOrigin) {
  cors(res, getAllowOrigin);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// SSE 流式响应头（Agent Run 的事件流）
function sseHead(res, getAllowOrigin) {
  cors(res, getAllowOrigin);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createAgentHttpServer(deps) {
  const originAllowed = deps.originAllowed;
  const checkToken = deps.checkToken;
  const onRoute = deps.onRoute;
  return http.createServer(async (req, res) => {
    // 入口守卫：回环 Host + 允许的 Origin + 启动令牌，三道都过才进业务路由
    if (!isLoopbackHost(req) || !originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    if (req.method === 'OPTIONS') { cors(res, deps.getAllowOrigin); res.writeHead(204); res.end(); return; }
    if (!checkToken(req)) {
      cors(res, deps.getAllowOrigin);
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '未授权：缺少或错误的本地启动令牌' }));
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      await onRoute(req, res, url);
    } catch (e) {
      sendJSON(res, 400, { error: String(e && e.message ? e.message : e) }, deps.getAllowOrigin);
    }
  });
}

module.exports = { cors, sendJSON, sseHead, readBody, createAgentHttpServer };
