'use strict';
/*
 * approval-decision —— 审批决策链纯模块：工具风险分类（TOOL_RISK/classifyRisk）、只读白名单
 * （SAFE_CMD/READONLY_GIT_TOOLS）、权限规则匹配（matchRule/globMatch）、沙箱档拦截（sandboxBlocked）
 * 与 11 步审批决策链（needsApproval）。无 IO、无自身可变状态。
 * v1.2.0 批次 7 第六刀自 agent-runtime-engine.js 抽出；决策逻辑与原实现逐字一致。
 * 唯一非纯点：needsApproval 第 3 步在未迁移 runAuth 时读调用方的模块级兜底授权态
 * （原引擎 approvedRun 布尔与 run-registry 的 approvedFiles 集合），经 deps 访问器注入——
 * 缺省视为「无兜底授权」，所有权与重置/写入时机仍归调用方。
 */

function createApprovalDecision(deps) {
  deps = deps || {};
  const getFallbackRunApproved = deps.getFallbackRunApproved || function () { return false; };
  const getFallbackApprovedFiles = deps.getFallbackApprovedFiles || function () { return new Set(); };

  // 判断某工具执行是否需要用户审批
  // 1. 命令白名单匹配（仅 run_command / git_command）→ 免审批
  // 2. 工具级强制审批（approveTools，即使 auto=true 也审批）
  // 3. 非 auto 时，命令类工具需审批
  // 4. 其余不审批
  // v2（补全 6）：工具风险分类——风险枚举 + 命令模式细分（auto 模式下 destructive/network_access 强制审批，只增不减）
  const TOOL_RISK = {
    read_only: ['read_file', 'read_files', 'get_file_outline', 'list_dir', 'glob', 'grep', 'get_repo_map', 'detect_verification', 'skip_verification', 'read_command_output', 'find_symbol', 'find_references', 'report_blocker', 'request_user_decision', 'list_skills', 'use_skill', 'list_skill_resources', 'read_skill_resource'], // v2（P2-5）
    workspace_write: ['write_file', 'create_file', 'delete_file', 'move_file', 'edit_file', 'apply_patch', 'restore_changeset', 'revert_changes', 'copy_skill_asset'],
    process_execution: ['run_command', 'run_tests', 'run_lint', 'run_typecheck', 'run_build', 'run_skill_script'],
    network_access: [],   // 由命令模式细分
    destructive: [],      // 由命令模式细分
    git: ['git_command'],
  };
  function classifyRisk(toolName, command) {
    const cmd = String(command || '').toLowerCase().trim();
    // 危险命令模式：删除/清库/强推/重置/权限/防火墙等不可逆操作
    if (/^\s*(rm\s+-[rf]|del\s+\/|rd\s+\/|drop\s+database|format\s+|fdisk|git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+clean\s+-[fd]|chmod\s+777|net\s+user|reg\s+delete|taskkill|shutdown)/.test(cmd)) return 'destructive';
    if (/^\s*(pip\s+install|npm\s+install|pnpm\s+(install|add)|yarn\s+add|go\s+get|composer\s+install|cargo\s+install|brew\s+install|apt(-get)?\s+install|docker\s+(pull|run|build)|git\s+clone|curl\s+-.*https?:\/\/|wget\s+https?:\/\/|npx\s+)/.test(cmd)) return 'network_access';
    if (toolName === 'run_command' || toolName === 'run_tests' || toolName === 'run_lint' || toolName === 'run_typecheck' || toolName === 'run_build' || toolName === 'run_skill_script') return 'process_execution';
    if (toolName === 'git_command') return 'git';
    if (TOOL_RISK.workspace_write.includes(toolName)) return 'workspace_write';
    return 'read_only';
  }

  // v2（权限大改）：只读命令自动放行（default/acceptEdits 模式免审批（只读命令））
  const SAFE_CMD = [
    { re: /^(ls|dir|pwd|echo|type|cat|head|tail|where|which|find|grep|node\s+-v|npm\s+-v|python\s+-v|git\s+status|git\s+diff|git\s+log|git\s+branch|git\s+show|git\s+remote|git\s+ls-files|git\s+rev-parse|git\s+tag|git\s+describe|git\s+config)\b/ },
  ];
  // 只读 git 结构化工具（任何非 plan 模式免审批，修混乱点⑧）
  const READONLY_GIT_TOOLS = ['git_changed_files', 'git_status', 'git_diff', 'git_log'];

  // v2（权限大改）：规则匹配——tool 与 pattern（命令前缀/glob）/ path 都命中才成立。
  // G17（B2）：额外支持时间衰减（expiresAt，epoch ms）与 model 级规则（scope:'model' + model）；count<=0 视为失效。
  function matchRule(rule, toolName, command, filePath, model) {
    if (!rule) return false;
    if (rule.expiresAt && Date.now() >= Number(rule.expiresAt)) return false;
    if (rule.count != null && Number(rule.count) <= 0) return false;
    if (rule.scope === 'model' && rule.model) {
      if (!model || String(rule.model) !== String(model)) return false;
    }
    const toolMatch = !rule.tool || rule.tool === '*' || rule.tool === toolName;
    if (!toolMatch) return false;
    if (rule.path && filePath) {
      const fp = String(filePath).replace(/\\/g, '/');
      const p = String(rule.path).replace(/\\/g, '/');
      if (fp !== p && !(p.endsWith('/') ? fp.startsWith(p) : fp.startsWith(p + '/')) && !globMatch(fp, p)) return false;
    }
    if (rule.pattern) {
      const cmd = String(command || '').toLowerCase().trim();
      const pat = String(rule.pattern).toLowerCase().trim();
      if (pat.includes('*')) {
        if (!globMatch(String(command || ''), String(rule.pattern))) return false;
      } else if (cmd !== pat && !cmd.startsWith(pat + ' ')) {
        return false;
      }
    }
    return true;
  }
  function globMatch(input, pattern) {
    try {
      const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(input);
    } catch (e) { return false; }
  }

  // v2（P2-6）：sandbox 档命令拦截——网络命令与明显越界路径命令；命中返回原因文案，未命中返回 null。
  // G17（B3）：越界路径是沙箱硬边界（任何例外不可放行）；网络命令可被沙箱例外规则（allow:true && sandbox:true 精确命中）放行。
  function sandboxBlocked(command, permCtx) {
    const cmd = String(command || '').toLowerCase().trim();
    // 越界路径：../、绝对路径、盘符路径（盘符需位于行首/空白/引号后，避免误判 https:// 的 s://）
    if (/(\.\.\/|^\/[^/]|(?:^|[\s"'`])[a-z]:[\\/])/.test(cmd)) return '越界路径命令';
    if (permCtx) {
      for (const r of permCtx.projectRules || []) {
        if (r.allow === true && r.sandbox === true && matchRule(r, 'run_command', command, null, permCtx.model)) return null;
      }
    }
    if (classifyRisk('run_command', cmd) === 'network_access') return '网络命令';
    return null;
  }

  // v2（权限大改）：needsApproval 决策链 11 步（permCtx 缺省 null 回退旧逻辑）
  function needsApproval(toolName, command, auto, approveTools, cmdWhitelist, filePath, permCtx) {
    // 1. bypass 全放行
    if (permCtx && permCtx.mode === 'bypass') return false;
    // 2. plan 只读模式：写类 + 命令类 + 子代理 → 拒绝
    if (permCtx && permCtx.mode === 'plan') {
      if (TOOL_RISK.workspace_write.includes(toolName) || TOOL_RISK.process_execution.includes(toolName)
        || toolName === 'git_command' || toolName === 'run_subagent' || toolName === 'web_search') return true;
      return false;
    }
    // 3. 会话级授权（allow_run / allow_file）优先放行（v2 P1-4：优先读 run 级 runAuth，未迁移时回退模块级）
    const auth = (permCtx && permCtx.runAuth) ? permCtx.runAuth : null;
    if (auth ? auth.approvedRun : getFallbackRunApproved()) return false;
    if (filePath && (auth ? auth.approvedFiles.has(filePath) : getFallbackApprovedFiles().has(filePath))) return false;
    // 3.5 会话级工具授权（v1.2.1 批次 6：MCP「本会话不再询问」按 run 隔离；键 = toolName|command）
    if (auth && auth.approvedTools && auth.approvedTools.has(toolName + '|' + String(command || ''))) return false;
    // 4. reject 规则（项目→全局）命中 → 审批/拒绝（G17 B2：过期/model 级规则由 matchRule 内部判定）
    if (permCtx) {
      const allRules = (permCtx.projectRules || []).concat(permCtx.globalRules || []);
      for (const r of allRules) {
        if (r.allow === false && matchRule(r, toolName, command, filePath, permCtx.model)) return true;
      }
    }
    // 5. 风险强制（destructive/network_access）——allow 规则 force:true 例外；白名单不再短路（修混乱点④）
    const risk = classifyRisk(toolName, command);
    if (risk === 'destructive' || risk === 'network_access') {
      let forcedAllow = false;
      if (permCtx) {
        for (const r of (permCtx.projectRules || []).concat(permCtx.globalRules || [])) {
          if (r.allow === true && r.force === true && matchRule(r, toolName, command, filePath, permCtx.model)) { forcedAllow = true; break; }
        }
      }
      if (!forcedAllow) return true;
    }
    // 6/7. allow 规则（项目 > 全局）
    if (permCtx) {
      for (const r of permCtx.projectRules || []) { if (r.allow === true && matchRule(r, toolName, command, filePath, permCtx.model)) return false; }
      for (const r of permCtx.globalRules || []) { if (r.allow === true && matchRule(r, toolName, command, filePath, permCtx.model)) return false; }
    }
    // v1.2.1 批次 13：旧「总是允许」规则形状兼容——批次 6 之前写入的 {tool:'mcp__server__tool'}
    // 与 needsApproval 传参 tool='mcp' 永远匹配不上，老用户已授权的工具会静默失效、每次重新弹审批。
    if (toolName === 'mcp' && permCtx) {
      const cmdStr = String(command || '');
      const slash = cmdStr.indexOf('/');
      if (slash > 0) {
        const legacyId = 'mcp__' + cmdStr.slice(0, slash) + '__' + cmdStr.slice(slash + 1);
        const legacyAllow = (permCtx.projectRules || []).concat(permCtx.globalRules || []).some((r) => r && r.allow === true && r.tool === legacyId);
        if (legacyAllow) return false;
      }
    }
    // 旧 cmdWhitelist 兼容（未迁移时的旧字段）
    if ((toolName === 'run_command' || toolName === 'git_command') && Array.isArray(cmdWhitelist) && cmdWhitelist.length) {
      const cmdLower = String(command || '').toLowerCase().trim();
      for (const pattern of cmdWhitelist) {
        const p = String(pattern).toLowerCase().trim();
        if (p && (cmdLower === p || cmdLower.startsWith(p + ' '))) return false;
      }
    }
    // 8. 只读命令自动放行（default/acceptEdits）+ 只读 git 工具
    if (READONLY_GIT_TOOLS.includes(toolName)) return false;
    if (permCtx && (permCtx.mode === 'default' || permCtx.mode === 'acceptEdits')) {
      const cmd = String(command || '').toLowerCase().trim();
      if (SAFE_CMD.some((x) => x.re.test(cmd))) return false;
    }
    // 9. 模式默认
    const mode = permCtx ? permCtx.mode : (auto ? 'auto' : 'default');
    if (mode === 'acceptEdits') {
      if (TOOL_RISK.workspace_write.includes(toolName)) return false; // 编辑自动
      if (toolName === 'run_command' || toolName === 'git_command' || toolName === 'run_tests' || toolName === 'run_lint' || toolName === 'run_typecheck' || toolName === 'run_build' || toolName === 'run_skill_script') return true;
      // v1.2.1 批次 6：MCP 外部工具默认需审批（此前 classifyRisk 把它归 read_only，审批从不触发）
      if (toolName === 'mcp') return true;
      return false;
    }
    if (mode === 'auto') {
      // 完全自主：不审批（auto 为全自主语义，MCP 同放行）
    } else if (mode === 'sandbox') {
      if (toolName === 'mcp') return true; // 沙箱内 MCP 外部调用默认需审批
    } else if (mode === 'default') {
      if (TOOL_RISK.workspace_write.includes(toolName) || TOOL_RISK.process_execution.includes(toolName)
        || toolName === 'git_command' || toolName === 'run_subagent' || toolName === 'mcp') return true;
    }
    // 10. approveTools 兼容（旧字段强制审批）
    if (Array.isArray(approveTools) && approveTools.includes(toolName)) return true;
    // 11. 兜底放行
    return false;
  }

  return { TOOL_RISK, classifyRisk, SAFE_CMD, READONLY_GIT_TOOLS, matchRule, globMatch, sandboxBlocked, needsApproval };
}

module.exports = { createApprovalDecision };
