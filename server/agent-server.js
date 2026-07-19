'use strict';
/*
 * 糖包「糖码」本地后端（纯 Node，无第三方依赖）
 * - 与前端通过 SSE 通信，运行类 Claude Code 的 agentic 循环
 * - 仅在指定的工作目录(cwd)内执行命令 / 文件操作（根目录 confinement）
 * - 命令默认「每步确认」：发 require_approval 事件并暂停，等前端 POST /api/agent/approve
 *
 * 运行：node server/agent-server.js   （可用 PORT 环境变量改端口，默认 3000）
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const MAX_STEPS = 24;
const MAX_OUTPUT = 12000;     // 单条工具结果截断长度
const APPROVE_TIMEOUT = 5 * 60 * 1000;
const CMD_TIMEOUT = 120000;

// callId -> { resolve, timer }  等待前端审批
const approvals = new Map();
// jobId -> { child, logs, desc }  后台命令
const jobs = new Map();

const TOOLS = [
  { type: 'function', function: {
    name: 'run_command',
    description: '在限定的工作目录内执行一条 shell 命令，返回 stdout/stderr。长任务可设 run_in_background:true 后台运行，立即返回 jobId 并稍后读取其输出。',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' }, description: { type: 'string', description: '该命令的用途简述（便于后台任务展示）' }, run_in_background: { type: 'boolean', description: 'true=后台运行，立即返回 jobId 不阻塞' } }, required: ['command'] },
  } },
  { type: 'function', function: {
    name: 'read_file',
    description: '读取文件文本内容。支持只读片段：offset 为起始行号(从 1 起)，limit 为读取行数；输出每行带行号便于定位。大文件务必用 offset/limit。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对于工作目录的路径' }, offset: { type: 'number', description: '起始行号(从 1 起)，默认 1' }, limit: { type: 'number', description: '读取行数，默认读到末尾' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'write_file',
    description: '写入或覆盖一个文件（会创建不存在的目录）。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  } },
  { type: 'function', function: {
    name: 'edit_file',
    description: '把文件中 first 出现的 old_str 替换为 new_str；找不到则报错。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] },
  } },
  { type: 'function', function: {
    name: 'list_dir',
    description: '列出目录内容（默认工作目录），标注是否为目录。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，默认工作目录' } } },
  } },
  { type: 'function', function: {
    name: 'glob',
    description: '按通配符查找文件，支持 * 与 **，返回匹配的文件列表（最多 200 条）。',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: '如 src/**/*.js 或 *.md' } }, required: ['pattern'] },
  } },
  { type: 'function', function: {
    name: 'web_search',
    description: '联网搜索最新资料（用于获取工作目录之外的外部信息、文档、报错解决方案等）。返回标题/链接/摘要。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'git_command',
    description: '在工作目录内执行一条 git 子命令（自动补全前缀 git，无需再写 git）。如 status、log --oneline -5、diff、add .、commit -m "msg"。',
    parameters: { type: 'object', properties: { args: { type: 'string', description: 'git 之后的参数，如 status 或 commit -m "fix"' } }, required: ['args'] },
  } },
  { type: 'function', function: {
    name: 'todo_write',
    description: '管理当前任务清单。传完整 todos 数组以整体替换：每项 {content:描述, status:"pending"|"in_progress"|"completed", activeForm?:进行中的动作短语}。开始某项前把它标 in_progress，完成后标 completed；多步任务务必使用，便于用户跟踪进度。',
    parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status'] } } }, required: ['todos'] },
  } },
  { type: 'function', function: {
    name: 'grep',
    description: '在指定目录内递归搜索文件内容（正则）。用于「某函数在哪定义/某字符串出现在哪些文件」。path 为相对目录（默认工作目录），glob 限定文件类型（如 "*.js"），pattern 为正则，-i 忽略大小写，-n 显示行号（默认开），-C 显示上下文行数。',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '相对目录，默认工作目录' },
      glob: { type: 'string', description: '文件名通配，如 "*.js"、"**/*.ts"' },
      i: { type: 'boolean', description: '忽略大小写' },
      n: { type: 'boolean', description: '显示行号（默认 true）' },
      C: { type: 'number', description: '上下文行数（默认 0）' },
    }, required: ['pattern'] },
  } },
];

const SYSTEM_PROMPT = `你是一个运行在用户本地工作目录中的糖码，类似 Claude Code。
规则：
1. 只通过提供的工具完成任务，不要编造文件内容或命令结果。
2. 先观察（list_dir / glob / read_file）再修改；改动前尽量读懂上下文。
3. 命令仅在当前工作目录内执行；不要尝试访问工作目录之外的路径。
4. 每一步尽量聚焦、可验证；完成后用中文给出简洁的总结与下一步建议。
5. 需要外部/最新信息（报错解决方案、库用法、文档）时用 web_search 联网检索，不要凭空猜测。
6. 版本管理相关操作优先用 git_command（如查看状态、提交），参数只写 git 之后的部分。
7. 若任务完成，直接给出最终回答（中文），不要再调用工具。
8. 所有输出不要使用 emoji 表情符号，用纯文本替代。`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 把相对/绝对路径约束在工作目录内；越界返回 null
function safePath(p, cwd) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function truncate(s) {
  s = String(s == null ? '' : s);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…（输出已截断，共 ${s.length} 字）` : s;
}

// ===== 联网搜索（纯 Node，无第三方依赖）=====
// 统一返回：{ ok:true, results:[{title,url,snippet}], engine } | { ok:false, error }
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

// 从 Li 块里取第一个 href 与文本
function firstAttr(html, tag, attr, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
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

// 发出审批请求并等待前端响应；返回 true=批准 / false=拒绝或超时
function waitApproval(emit, runId, command) {
  const callId = 'ap_' + Math.random().toString(36).slice(2, 9);
  emit('require_approval', { runId, callId, command });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { approvals.delete(callId); resolve(false); }, APPROVE_TIMEOUT);
    approvals.set(callId, { resolve, timer });
  });
}

// 在 cwd 内执行一条 shell 命令，返回合并后的输出（已截断）
function execShell(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: CMD_TIMEOUT }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n[stderr]\n' : '') + stderr;
      if (err && !out) out = String(err.message || err);
      resolve(truncate(out || '(无输出)'));
    });
  });
}

// 判断某工具执行是否需要用户审批
// 1. 命令白名单匹配（仅 run_command / git_command）→ 免审批
// 2. 工具级强制审批（approveTools，即使 auto=true 也审批）
// 3. 非 auto 时，命令类工具需审批
// 4. 其余不审批
function needsApproval(toolName, command, auto, approveTools, cmdWhitelist) {
  if ((toolName === 'run_command' || toolName === 'git_command') && Array.isArray(cmdWhitelist) && cmdWhitelist.length) {
    const cmdLower = String(command || '').toLowerCase().trim();
    for (const pattern of cmdWhitelist) {
      const p = String(pattern).toLowerCase().trim();
      if (p && (cmdLower === p || cmdLower.startsWith(p + ' '))) return false;
    }
  }
  if (Array.isArray(approveTools) && approveTools.includes(toolName)) return true;
  if (!auto && (toolName === 'run_command' || toolName === 'git_command')) return true;
  return false;
}

async function runTool(name, args, cwd, emit, runId, auto, aborted, opts) {
  opts = opts || {};
  const approveTools = opts.approveTools || [];
  const cmdWhitelist = opts.cmdWhitelist || [];
  // Plan 模式：只读探索，禁止任何会修改文件或执行命令的工具
  if (opts.planMode && (name === 'write_file' || name === 'edit_file' || name === 'run_command' || name === 'git_command')) {
    return 'Plan 模式：当前为只读模式，已禁止修改文件与执行命令。请关闭 Plan 模式后再执行此操作。';
  }
  try {
    if (name === 'run_command') {
      const command = String(args.command || '').trim();
      if (!command) return '命令为空';
      if (needsApproval('run_command', command, auto, approveTools, cmdWhitelist)) {
        const ok = await waitApproval(emit, runId, command);
        if (aborted()) return '已取消（用户离开/中断）';
        if (!ok) return '用户拒绝了该命令：' + command;
      }
      if (args.run_in_background) {
        const jobId = 'job_' + Math.random().toString(36).slice(2, 9);
        const { spawn } = require('child_process');
        const isWin = process.platform === 'win32';
        const child = spawn(isWin ? 'cmd' : 'sh', [isWin ? '/c' : '-c', command], { cwd, windowsHide: true });
        const job = { child, logs: '', desc: String(args.description || command) };
        jobs.set(jobId, job);
        const push = (chunk) => {
          const s = chunk.toString();
          job.logs += s;
          emit('job_log', { jobId, chunk: s });
        };
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        child.on('error', (e) => emit('job_log', { jobId, chunk: '\n[启动失败] ' + (e && e.message ? e.message : String(e)) }));
        child.on('close', (code) => {
          emit('job_done', { jobId, code: code == null ? -1 : code });
          jobs.delete(jobId);
        });
        return '已在后台启动（jobId=' + jobId + '）：' + command;
      }
      return await execShell(command, cwd);
    }
    if (name === 'git_command') {
      let ga = String(args.args || '').trim();
      if (!ga) return 'git 参数为空';
      if (/^git\s+/i.test(ga)) ga = ga.replace(/^git\s+/i, ''); // 容错：去掉重复的 git 前缀
      const command = 'git ' + ga;
      if (needsApproval('git_command', command, auto, approveTools, cmdWhitelist)) {
        const ok = await waitApproval(emit, runId, command);
        if (aborted()) return '已取消（用户离开/中断）';
        if (!ok) return '用户拒绝了该命令：' + command;
      }
      return await execShell(command, cwd);
    }
    if (name === 'web_search') {
      const query = String(args.query || '').trim();
      if (!query) return '搜索关键词为空';
      const data = await doSearch(query, opts.searchApiKey || '');
      if (!data.ok) return '搜索失败：' + (data.error || '未知错误');
      const lines = (data.results || []).map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ''}`.trim());
      return truncate(lines.length ? `[来源：${data.engine}]\n` + lines.join('\n\n') : '无搜索结果');
    }
    if (name === 'read_file') {
      const fp = safePath(args.path, cwd);
      if (!fp) return '拒绝：路径越界工作目录';
      let txt;
      try { txt = await fsp.readFile(fp, 'utf8'); }
      catch (e) { return '读取失败：' + (e && e.message ? e.message : String(e)); }
      const lines = txt.split('\n');
      let offset = Number(args.offset) || 0;
      if (offset < 0) offset = 0;
      const limit = args.limit != null ? Number(args.limit) : (lines.length - offset);
      const slice = lines.slice(offset, offset + (limit > 0 ? limit : lines.length - offset));
      const out = slice.map((ln, i) => `${(offset + i + 1).toString().padStart(String(offset + slice.length).length, ' ')} | ${ln}`).join('\n');
      return truncate(out + `\n（共 ${lines.length} 行，已显示第 ${offset + 1}-${offset + slice.length} 行）`);
    }
    if (name === 'todo_write') {
      const arr = Array.isArray(args.todos) ? args.todos : [];
      const cleaned = arr.map((t, i) => ({
        content: String((t && t.content) || '').slice(0, 200),
        status: ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending',
        activeForm: String((t && t.activeForm) || '').slice(0, 80),
        index: i + 1,
      }));
      if (opts.todos) opts.todos.length = 0;
      if (opts.todos) cleaned.forEach(t => opts.todos.push(t));
      emit('todo_update', { todos: cleaned });
      const done = cleaned.filter(t => t.status === 'completed').length;
      return `已更新任务清单（${cleaned.length} 项，完成 ${done} 项）`;
    }
    if (name === 'grep') {
      const pattern = String(args.pattern || '');
      if (!pattern) return '搜索模式为空';
      let re;
      try { re = new RegExp(pattern, args.i ? 'i' : ''); }
      catch (e) { return '正则无效：' + (e && e.message ? e.message : String(e)); }
      const dir = args.path ? safePath(args.path, cwd) : cwd;
      if (!dir) return '拒绝：路径越界工作目录';
      const globPat = args.glob ? globToRegExp(args.glob) : null;
      const showN = args.n !== false;
      const ctx = Number(args.C) || 0;
      const matches = [];
      await walk(dir, async (fp) => {
        if (matches.length >= 200) return;
        if (globPat) {
          const rel = path.relative(cwd, fp).split(path.sep).join('/');
          if (!globPat.test(rel)) return;
        }
        // 跳过明显的二进制文件
        let head;
        try { const buf = Buffer.alloc(512); const fd = await fsp.open(fp, 'r'); const { bytesRead } = await fd.read(buf, 0, 512, 0); await fd.close(); head = buf.slice(0, bytesRead); }
        catch (e) { return; }
        if (head.includes(0)) return; // 含 NUL → 视为二进制
        let content;
        try { content = await fsp.readFile(fp, 'utf8'); } catch (e) { return; }
        const fileLines = content.split('\n');
        const rel = path.relative(cwd, fp);
        for (let li = 0; li < fileLines.length; li++) {
          if (re.test(fileLines[li])) {
            if (showN) matches.push(`${rel}:${li + 1}: ${fileLines[li]}`);
            else matches.push(`${rel}: ${fileLines[li]}`);
            for (let c = 1; c <= ctx; c++) {
              if (li - c >= 0) matches.push(`${rel}:${li - c + 1}-: ${fileLines[li - c]}`);
              if (li + c < fileLines.length) matches.push(`${rel}:${li + c + 1}+: ${fileLines[li + c]}`);
            }
          }
        }
      }, 400);
      return matches.length ? truncate(matches.join('\n')) : '无匹配';
    }
    if (name === 'write_file') {
      const fp = safePath(args.path, cwd);
      if (!fp) return '拒绝：路径越界工作目录';
      if (needsApproval('write_file', null, auto, approveTools, cmdWhitelist)) {
        const ok = await waitApproval(emit, runId, 'write_file ' + path.relative(cwd, fp));
        if (aborted()) return '已取消（用户离开/中断）';
        if (!ok) return '用户拒绝了写文件操作';
      }
      let before = '';
      try { before = await fsp.readFile(fp, 'utf8'); } catch (e) { before = ''; }
      await fsp.mkdir(path.dirname(fp), { recursive: true });
      await fsp.writeFile(fp, String(args.content || ''), 'utf8');
      if (opts.callId) emit('tool_diff', { id: opts.callId, path: path.relative(cwd, fp), diff: lineDiff(before, String(args.content || '')) });
      return '已写入 ' + path.relative(cwd, fp) + '（' + String(args.content || '').length + ' 字）';
    }
    if (name === 'edit_file') {
      const fp = safePath(args.path, cwd);
      if (!fp) return '拒绝：路径越界工作目录';
      if (needsApproval('edit_file', null, auto, approveTools, cmdWhitelist)) {
        const ok = await waitApproval(emit, runId, 'edit_file ' + path.relative(cwd, fp));
        if (aborted()) return '已取消（用户离开/中断）';
        if (!ok) return '用户拒绝了编辑文件操作';
      }
      const oldStr = String(args.old_str || '');
      const newStr = String(args.new_str || '');
      const cur = await fsp.readFile(fp, 'utf8');
      const idx = cur.indexOf(oldStr);
      if (idx < 0) return '未找到要替换的文本';
      const updated = cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length);
      await fsp.writeFile(fp, updated, 'utf8');
      if (opts.callId) emit('tool_diff', { id: opts.callId, path: path.relative(cwd, fp), diff: lineDiff(cur, updated) });
      return '已编辑 ' + path.relative(cwd, fp);
    }
    if (name === 'list_dir') {
      const target = args.path ? safePath(args.path, cwd) : cwd;
      if (!target) return '拒绝：路径越界工作目录';
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const lines = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? '[dir]  ' : '[file] ') + e.name);
      return lines.length ? lines.join('\n') : '(空目录)';
    }
    if (name === 'glob') {
      const pat = String(args.pattern || '').trim();
      if (!pat) return '模式为空';
      const re = globToRegExp(pat);
      const files = [];
      await walk(cwd, (fp) => {
        const rel = path.relative(cwd, fp).split(path.sep).join('/');
        if (re.test(rel)) files.push(rel);
      }, 200);
      return files.length ? files.join('\n') : '无匹配文件';
    }
    return '未知工具：' + name;
  } catch (e) {
    return '工具执行出错：' + (e && e.message ? e.message : String(e));
  }
}

function globToRegExp(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// 行级 LCS 差异：返回 [{type:' '|'+'|'-', text}]，用于前端渲染 +/- 差异
function lineDiff(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = (a[i] === b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', text: a[i] }); i++; }
    else { out.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: '-', text: a[i] }); i++; }
  while (j < m) { out.push({ type: '+', text: b[j] }); j++; }
  return out;
}

async function walk(dir, cb, limit) {
  let count = 0;
  async function rec(d) {
    if (count >= limit) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (count >= limit) return;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { await rec(fp); }
      else { count++; await cb(fp); }
    }
  }
  await rec(dir);
}

// 调用 LLM（OpenAI 兼容，流式），返回 { content, toolCalls: [{id,name,arguments}] }
async function callLLMStream({ apiBase, apiKey, model, messages }) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  const payload = { model, stream: true, messages, tools: TOOLS, tool_choice: 'auto' };
  const controller = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败（${res.status}）：${txt.slice(0, 240)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = []; // {index,id,name,arguments}
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
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch (e) { continue; }
      const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
      if (delta.content) content += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index != null ? tc.index : (toolCalls.length ? toolCalls.length - 1 : 0);
          if (!toolCalls[i]) toolCalls[i] = { index: i, id: '', name: '', arguments: '' };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function && tc.function.name) toolCalls[i].name = tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
        }
      }
    }
  }
  const clean = toolCalls.filter(Boolean).map((t) => ({ id: t.id || ('call_' + t.index), name: t.name, arguments: t.arguments }));
  return { content, toolCalls: clean };
}

function handleAgent(req, res, body) {
  const cwd = String(body.cwd || process.cwd());
  const auto = !!body.auto;
  const runId = 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const apiBase = String(body.apiBase || '');
  const apiKey = String(body.apiKey || '');
  const model = String(body.model || '');
  const customSystem = (typeof body.systemPrompt === 'string' && body.systemPrompt.trim())
    ? body.systemPrompt.trim() : '';
  const searchApiKey = String(body.searchApiKey || '');
  const approveTools = Array.isArray(body.approveTools) ? body.approveTools.filter(x => typeof x === 'string') : [];
  const cmdWhitelist = Array.isArray(body.cmdWhitelist) ? body.cmdWhitelist.filter(x => typeof x === 'string') : [];
  const planMode = !!body.planMode;

  if (!apiBase || !apiKey || !model) {
    sendJSON(res, 400, { error: '缺少 API 配置（apiBase/apiKey/model）' });
    return;
  }

  let aborted = false;
  req.on('close', () => { aborted = true; });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = (type, data) => {
    try { res.write('data: ' + JSON.stringify(Object.assign({ type }, data || {})) + '\n\n'); } catch (e) {}
  };

  emit('meta', { runId, cwd, auto, planMode });

  (async () => {
    // 项目记忆文件：读取 cwd/糖码记忆.md（兼容 CLAUDE.md），注入 system prompt
    let systemContent = customSystem || SYSTEM_PROMPT;
    const memCandidates = ['糖码记忆.md', 'CLAUDE.md'];
    for (const mf of memCandidates) {
      const mfp = safePath(mf, cwd);
      if (mfp) {
        try {
          const mem = await fsp.readFile(mfp, 'utf8');
          if (mem && mem.trim()) {
            systemContent += `\n\n# 项目记忆（来自 ${mf}）\n${mem.trim()}`;
            break;
          }
        } catch (e) { /* 文件不存在则跳过 */ }
      }
    }
    if (planMode) systemContent += '\n\n[当前处于 Plan 模式：你只能探索，不得修改文件或执行命令。]';
    const todos = []; // 本次运行的任务清单（todo_write 维护）
    const messages = [{ role: 'system', content: systemContent }];
    if (Array.isArray(body.history)) {
      for (const h of body.history) {
        if (h && h.role && h.content != null) messages.push({ role: h.role, content: String(h.content) });
      }
    }
    messages.push({ role: 'user', content: String(body.prompt || '') });

    for (let step = 0; step < MAX_STEPS; step++) {
      if (aborted) { emit('error', { message: '连接已断开' }); break; }
      let r;
      try {
        r = await callLLMStream({ apiBase, apiKey, model, messages });
      } catch (e) {
        emit('error', { message: String(e.message || e) });
        break;
      }
      if (aborted) { emit('error', { message: '连接已断开' }); break; }

      if (r.toolCalls && r.toolCalls.length) {
        if (r.content) emit('thinking', { text: r.content });
        // 记录 assistant（含 tool_calls）供下一轮
        const asstMsg = { role: 'assistant', content: r.content || null, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) };
        messages.push(asstMsg);
        for (const tc of r.toolCalls) {
          if (aborted) { emit('error', { message: '连接已断开' }); return; }
          let args = {};
          try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch (e) { args = {}; }
          emit('tool_call', { id: tc.id, name: tc.name, args });
          const result = await runTool(tc.name, args, cwd, emit, runId, auto, () => aborted, { searchApiKey, approveTools, cmdWhitelist, callId: tc.id, todos, planMode });
          emit('tool_result', { id: tc.id, name: tc.name, result });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // 最终回答
      const text = r.content || '(无内容)';
      // 按自然边界模拟流式：按行分割（保留换行），长行再按 60 字符拆分，比固定 80 字符块更平滑
      const naturalChunks = [];
      const lines = text.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.length <= 120) {
          naturalChunks.push(li < lines.length - 1 ? line + '\n' : line);
        } else {
          const subChunks = line.match(/[\s\S]{1,60}/g) || [line];
          for (let si = 0; si < subChunks.length; si++) {
            const isLast = si === subChunks.length - 1;
            naturalChunks.push(isLast && li < lines.length - 1 ? subChunks[si] + '\n' : subChunks[si]);
          }
        }
      }
      const chunks = naturalChunks.length ? naturalChunks : [text];
      for (const ch of chunks) emit('message', { text: ch });
      emit('done', {});
      break;
    }
    if (!aborted) emit('done', {});
  })().catch((e) => { emit('error', { message: String(e && e.message ? e.message : e) }); })
    .finally(() => { try { res.end(); } catch (e) {} });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJSON(res, 200, { ok: true, cwd: process.cwd() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent') {
      const body = await readBody(req);
      handleAgent(req, res, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/approve') {
      const body = await readBody(req);
      const callId = body.callId;
      const pending = callId && approvals.get(callId);
      if (pending) {
        clearTimeout(pending.timer);
        approvals.delete(callId);
        pending.resolve(!!body.approved);
        sendJSON(res, 200, { ok: true, approved: !!body.approved });
      } else {
        sendJSON(res, 404, { ok: false, error: '未找到待审批项（可能已过期）' });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const body = await readBody(req);
      const data = await doSearch(body && body.query ? String(body.query) : '', body && body.apiKey ? String(body.apiKey) : '');
      sendJSON(res, data.ok ? 200 : 502, data);
      return;
    }
    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJSON(res, 400, { error: String(e && e.message ? e.message : e) });
  }
});

function startAgentServer(port) {
  const p = Number(port) || PORT;
  server.listen(p, () => {
    console.log(`[糖包·糖码] 后端已启动：http://localhost:${p}  （工作目录默认 ${process.cwd()}）`);
    console.log('前端需配置聊天 API（糖码复用聊天账户密钥）。桌面版已自动拉起。');
  });
}

module.exports = { startAgentServer };

if (require.main === module) {
  startAgentServer(Number(process.env.PORT) || 3000);
}
