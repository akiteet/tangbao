'use strict';
/* v1.2.1 批次 12：糖码引擎 SSE 事件 → 宠物状态 + 气泡文案的映射（纯函数）。
 * 事件类型见 agent-runtime-engine.js 的 emit()：require_approval / tool_result /
 * done / error / phase / thinking / todo_update / tool_diff / user_decision_requested 等。 */
import { STATE_ROWS } from './atlas.js';

const ATLAS_STATES = new Set(STATE_ROWS);

function brief(x, len) {
  const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const n = len || 60;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function mapAgentEvent(ev) {
  if (!ev || typeof ev !== 'object' || !ev.type) return null;
  const type = ev.type;
  switch (type) {
    case 'require_approval':
      return { state: 'waving', text: '需要你批准一下～' };
    case 'user_decision_requested':
      return { state: 'waving', text: '想问你一个问题～' };
    case 'tool_result': {
      // result 为 ToolResult（ok / error / summary）
      const r = ev.result;
      if (r && (r.error || r.ok === false)) {
        const msg = (r.error && (r.error.message || r.error)) || (r.summary || '出错了');
        return { state: 'failed', text: brief(msg, 48) };
      }
      const name = ev.name || '';
      return { state: 'review', text: name ? ('「' + name + '」搞定！') : '搞定！' };
    }
    case 'tool_diff':
      return { state: 'running', text: '正在改文件…' };
    case 'todo_update':
      return { state: 'waiting', text: '按计划推进中…' };
    case 'thinking':
      return { state: 'waiting', text: '思考中…' };
    case 'phase': {
      const p = String(ev.phase || '');
      if (/implement|execut|act/i.test(p)) return { state: 'running', text: '动手干活啦！' };
      if (/plan|read/i.test(p)) return { state: 'waiting', text: '让我先看看…' };
      return { state: 'idle', text: '' };
    }
    case 'done':
      return { state: 'review', text: '任务完成啦！' };
    case 'error':
      return { state: 'failed', text: brief(ev.error || ev.message || '出错了', 48) };
    case 'blocked':
    case 'gate_blocked':
      return { state: 'failed', text: '被拦住了…' };
    case 'segment_started':
    case 'job_done':
      return { state: 'review', text: '' };
    default:
      // 高频事件（message/meta/thinking 流）不打扰
      return null;
  }
}

// 状态名是否落在 Atlas 已知行（防御非法状态）
export function safeState(name) {
  return ATLAS_STATES.has(name) ? name : 'idle';
}
