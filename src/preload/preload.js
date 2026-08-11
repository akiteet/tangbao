'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // 本地服务端口（系统随机分配，仅绑定 127.0.0.1）；渲染进程启动时取一次
  serverPorts: () => ipcRenderer.invoke('app:ports'),
  // 密钥库：只有「写 / 删 / 问存不存在」，故意没有 getSecret —— 渲染进程永远拿不回明文。
  // 真正用密钥的地方（模型网关、糖码后端）都在主进程内直接读。
  setSecret: (ref, value) => ipcRenderer.invoke('secrets:set', ref, value),
  deleteSecret: (ref) => ipcRenderer.invoke('secrets:delete', ref),
  deleteSecretsByPrefix: (prefix) => ipcRenderer.invoke('secrets:deletePrefix', prefix),
  listSecrets: () => ipcRenderer.invoke('secrets:list'),
  diagnoseSecrets: () => ipcRenderer.invoke('secrets:diagnose'),
  recoverLegacySecrets: () => ipcRenderer.invoke('secrets:recoverLegacy'),
  resetSecretStore: () => ipcRenderer.invoke('secrets:reset'),
  // 同步「密钥引用 → API Base」映射表给模型网关（渲染进程只能指定 ref，指定不了转发目标）
  setGatewayEndpoints: (list) => ipcRenderer.invoke('gateway:setEndpoints', list),
  probeCache: (input) => ipcRenderer.invoke('cache:probe', input || {}),
  modelHealth: (input) => ipcRenderer.invoke('model:health', input || {}),
  modelMetrics: (input) => ipcRenderer.invoke('model:metrics', input || {}),
  searchQuery: (input) => ipcRenderer.invoke('search:query', input || {}),
  // M5：把本地文件绝对路径交给主进程，换回不透明 fileId（只回 id，不回路径/内容）
  registerLocalFile: (absPath) => ipcRenderer.invoke('app:registerLocalFile', absPath),
  // M7（#253）：把工作目录绝对路径交给主进程校验+登记，换回不透明 workspaceId（只回 id，不回路径）
  registerWorkspace: (absPath, name) => ipcRenderer.invoke('app:registerWorkspace', absPath, name),
  getWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:get', workspaceId),
  checkWorkspaceHealth: (workspaceId) => ipcRenderer.invoke('workspace:health', workspaceId),
  addWorkspaceRoot: (workspaceId) => ipcRenderer.invoke('workspace:addRoot', workspaceId),
  removeWorkspaceRoot: (workspaceId, rootId) => ipcRenderer.invoke('workspace:removeRoot', workspaceId, rootId),
  renameWorkspaceRoot: (workspaceId, rootId, name) => ipcRenderer.invoke('workspace:renameRoot', workspaceId, rootId, name),
  setPrimaryWorkspaceRoot: (workspaceId, rootId) => ipcRenderer.invoke('workspace:setPrimary', workspaceId, rootId),
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 本地文件（如用户设置的本地模块）用系统关联程序打开：仅允许绝对路径，且主进程拒绝可执行后缀
  openPath: (absPath) => ipcRenderer.invoke('shell:openPath', absPath),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
  getStorageInfo: () => ipcRenderer.invoke('storage:info'),
  chooseStorageLocation: () => ipcRenderer.invoke('storage:chooseLocation'),
  verifyStorageMigration: () => ipcRenderer.invoke('storage:verifyMigration'),
  cleanupPreview: () => ipcRenderer.invoke('storage:cleanupPreview'),
  cleanupLegacy: (input) => ipcRenderer.invoke('storage:cleanupLegacy', input || {}),
  backupStorage: (input) => ipcRenderer.invoke('storage:backup', input || {}),
  exportStorageDiagnostics: () => ipcRenderer.invoke('storage:diagnostics'),
  restoreStorage: (input) => ipcRenderer.invoke('storage:restore', input || {}),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  saveStateJSON: (jsonStr, revision) => ipcRenderer.invoke('fs:writeState', jsonStr, revision),
  // 读取磁盘 state.json（与端口无关，用于随机端口下稳定恢复数据）
  loadStateJSON: () => ipcRenderer.invoke('fs:readState'),
  // M3 存储层：把归一化后的 App.state 灌入 SQLite（better-sqlite3 不可用则主进程返回 {ok:false}）
  migrateStorage: (json) => ipcRenderer.invoke('storage:migrate', json),
  // M4 写穿：整库替换进 SQLite（主数据源）
  syncStorage: (json, revision) => ipcRenderer.invoke('storage:syncState', json, revision),
  // 聊天修复：关闭前同步落盘（sendSync 阻塞等待主进程写完成，杜绝 fire-and-forget 竞态丢数据）
  flushStorageSync: (json, revision) => ipcRenderer.sendSync('storage:flushSync', json, revision),
  // M4 读源：从 SQLite 重建 App.state（空/不可用 → {ok:false}）
  loadStorage: () => ipcRenderer.invoke('storage:loadState'),
  // M6 导入导出：完整数据备份（经系统文件对话框）
  exportState: () => ipcRenderer.invoke('storage:exportState'),
  importState: () => ipcRenderer.invoke('storage:importState'),
  // M7（v1.0.8）：工作流运行历史
  saveWorkflowRun: (run) => ipcRenderer.invoke('storage:saveRun', run),
  listWorkflowRuns: (workflowId, limit) => ipcRenderer.invoke('storage:listRuns', workflowId, limit),
  // v1.1.0（M1）：糖码 Agent Run 历史（运行列表 / 事件轨迹 / 上下文摘要）
  listAgentRuns: (threadId, limit, offset) => ipcRenderer.invoke('agent:listRuns', threadId, limit, offset),
  listAgentEvents: (runId) => ipcRenderer.invoke('agent:runEvents', runId),
  getAgentRunTree: (rootRunId) => ipcRenderer.invoke('agent:runTree', rootRunId),
  tracePage: (input) => ipcRenderer.invoke('agent:tracePage', input || {}),
  getAgentRunMetrics: (rootRunId) => ipcRenderer.invoke('agent:runMetrics', rootRunId),
  exportAgentRun: (runId) => ipcRenderer.invoke('agent:exportRun', runId),
  exportAgentTrace: (input) => ipcRenderer.invoke('agent:exportTrace', input || {}),
  listAgentEvalTasks: () => ipcRenderer.invoke('agent:evalTasks'),
  runAgentEval: (payload) => ipcRenderer.invoke('agent:runEval', payload),
  getAgentSummary: (threadId) => ipcRenderer.invoke('agent:summary', threadId),
  // v2（P1-C）：压缩后摘要落库
  saveAgentSummary: (s) => ipcRenderer.invoke('agent:saveSummary', s),
  // v4（技能面板）：列表走主进程，导入 / 启停也走主进程文件操作
  skillsList: (workspaceId) => ipcRenderer.invoke('skills:list', workspaceId || ''),
  skillsImport: (payload) => ipcRenderer.invoke('skills:import', payload),
  skillsDetails: (payload) => ipcRenderer.invoke('skills:details', payload),
  skillsEdit: (payload) => ipcRenderer.invoke('skills:edit', payload),
  skillsReveal: (payload) => ipcRenderer.invoke('skills:reveal', payload),
  skillsExport: (payload) => ipcRenderer.invoke('skills:export', payload),
  skillsUninstall: (payload) => ipcRenderer.invoke('skills:uninstall', payload),
  skillsTrust: (payload) => ipcRenderer.invoke('skills:trust', payload),
  skillsAutoTrigger: (payload) => ipcRenderer.invoke('skills:autoTrigger', payload),
  skillsMove: (payload) => ipcRenderer.invoke('skills:move', payload),
  skillsImportExternal: (payload) => ipcRenderer.invoke('skills:importExternal', payload),
  skillsQuarantine: () => ipcRenderer.invoke('skills:quarantine'),
  skillsRestore: (payload) => ipcRenderer.invoke('skills:restore', payload),
  skillsPurge: (payload) => ipcRenderer.invoke('skills:purge', payload),
  skillsToggle: (payload) => ipcRenderer.invoke('skills:toggle', payload),
  onSkillsChanged: (cb) => ipcRenderer.on('skills:changed', (e, raw) => cb(raw)),
  // 浮窗（系统级独立置顶小窗）
  openFloat: () => ipcRenderer.invoke('float:open'),
  closeFloat: () => ipcRenderer.invoke('float:close'),
  floatSync: (s) => ipcRenderer.send('float:sync', s),
  pushFloatState: (s) => ipcRenderer.send('float:pushState', s),
  floatRefresh: () => ipcRenderer.invoke('float:refresh'),
  onFloatInit: (cb) => ipcRenderer.on('float:init', (e, raw) => cb(raw)),
  onFloatState: (cb) => ipcRenderer.on('float:state', (e, payload) => cb(payload)),
  onFloatApply: (cb) => ipcRenderer.on('float:apply', (e, s) => cb(s)),
  onFloatRefresh: (cb) => ipcRenderer.on('float:refresh', () => cb()),
  // 浮窗透明度：setOpacity 立即生效，getOpacity 读取当前值
  setOpacity: (v) => ipcRenderer.invoke('float:setOpacity', v),
  getOpacity: () => ipcRenderer.invoke('float:getOpacity'),
  // 浮窗置顶开关 + 双击最大化
  setAlwaysOnTop: (on) => ipcRenderer.invoke('float:setAlwaysOnTop', on),
  toggleMaximize: () => ipcRenderer.invoke('float:toggleMaximize'),
});
