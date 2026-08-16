'use strict';
/*
 * 网页搜索供应商（v1.1.5 批次 D3，自 agent-runtime-engine.js 原样抽出）。
 * 优先级：配置了 Tavily Key 用 Tavily；否则免费链路 Bing 优先、DuckDuckGo 回落。
 * 返回形状统一为 { ok, results: [{title,url,snippet}], engine } 或 { ok:false, error }。
 */
const SEARCH_TIMEOUT = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 带超时的 fetch（Node 18+ 内置 fetch 支持 AbortSignal.timeout）
async function fetchWithTimeout(url, opts, ms) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opts));
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function searchByTavily(query, apiKey) {
  const r = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
  }, SEARCH_TIMEOUT);
  if (!r.ok) throw new Error('Tavily 返回 ' + r.status);
  const j = await r.json().catch(() => ({}));
  const arr = Array.isArray(j.results) ? j.results : [];
  const results = arr.slice(0, 5).map((x) => ({
    title: decodeEntities(x.title || ''),
    url: x.url || '',
    snippet: decodeEntities(x.content || ''),
  })).filter((x) => x.url);
  return { ok: true, results, engine: 'tavily' };
}

function parseBing(html) {
  const results = [];
  // 主结构：<li class="b_algo"> 内 <h2><a href> + <p>摘要（部分地区为 <div class="b_algo">）
  let blocks = html.split('<li class="b_algo">').slice(1);
  if (!blocks.length) blocks = html.split('<div class="b_algo">').slice(1);
  for (const b of blocks) {
    if (results.length >= 5) break;
    const h2 = b.match(/<h2>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h2) continue;
    const url = decodeEntities(h2[1]);
    const title = decodeEntities(h2[2].replace(/<[^>]+>/g, ''));
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? decodeEntities(p[1].replace(/<[^>]+>/g, '')) : '';
    if (url && url.startsWith('http') && !/bing\.com|microsoft\.com/.test(url)) results.push({ title, url, snippet });
  }
  // 兜底：直接扫页面内所有 <h2><a href="http..."> 结果标题
  if (!results.length) {
    const hs = html.match(/<h2>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
    for (const h of hs) {
      if (results.length >= 5) break;
      const mm = h.match(/href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!mm) continue;
      const url = decodeEntities(mm[1]);
      const title = decodeEntities(mm[2].replace(/<[^>]+>/g, ''));
      if (url && url.startsWith('http') && !/bing\.com|microsoft\.com/.test(url)) results.push({ title, url, snippet: '' });
    }
  }
  return results;
}

async function searchByBing(query) {
  const r = await fetchWithTimeout('https://www.bing.com/search?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
  }, SEARCH_TIMEOUT);
  if (!r.ok) throw new Error('Bing 返回 ' + r.status);
  const html = await r.text();
  const results = parseBing(html);
  if (!results.length) throw new Error('Bing 未解析到结果');
  return { ok: true, results, engine: 'bing' };
}

async function searchByDDGOnce(query) {
  const r = await fetchWithTimeout('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  }, SEARCH_TIMEOUT);
  if (!r.ok) throw new Error('DuckDuckGo 返回 ' + r.status);
  const html = await r.text();
  const blocks = html.split('class="result__body"').slice(1);
  const results = [];
  for (const b of blocks) {
    if (results.length >= 5) break;
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    // DuckDuckGo HTML 的跳转链接需解 302
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) { try { url = decodeURIComponent(m[1]); } catch (e) {} }
    const title = decodeEntities(a[2].replace(/<[^>]+>/g, ''));
    const s = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = s ? decodeEntities(s[1].replace(/<[^>]+>/g, '')) : '';
    if (url && url.startsWith('http')) results.push({ title, url, snippet });
  }
  return results;
}

async function searchByDDG(query) {
  let lastErr = 'DuckDuckGo 未解析到结果';
  // 反爬常拦截首次请求，重试一次提升成功率
  for (let i = 0; i < 2; i++) {
    try {
      const results = await searchByDDGOnce(query);
      if (results.length) return { ok: true, results, engine: 'ddg' };
    } catch (e) { lastErr = 'DuckDuckGo 返回 ' + e.message; }
  }
  throw new Error(lastErr);
}

async function doSearch(query, apiKey) {
  if (!query || !query.trim()) return { ok: false, error: '查询为空' };
  query = query.trim();
  try {
    if (apiKey && apiKey.trim()) {
      try { return await searchByTavily(query, apiKey.trim()); }
      catch (e) { return { ok: false, error: 'Tavily 搜索失败：' + e.message }; }
    }
    // 免 key 免费搜索：Bing 优先，DuckDuckGo 回落
    try { return await searchByBing(query); }
    catch (e1) {
      try { return await searchByDDG(query); }
      catch (e2) { return { ok: false, error: '内置免费搜索暂不可用（' + e2.message + '）' }; }
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { webSearch: doSearch };
