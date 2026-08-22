'use strict';
/* 自 ui.js 拆分（v1.1.8 批次 C）：技能面板（renderSkillsPanel/applySkillFilter/showSkillDetails/showModal/showSkillQuarantine）。
 * 模式同 agent 批次 E：独立 IIFE + Object.assign(window.App.ui, {...})，必须在 ui.js 之后加载；
 * 闭包辅助按批次 E 先例在本文件重声明。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  Object.assign(window.App.ui, {
    // 技能面板列表直接走主进程 IPC：不依赖糖码后端、端口或本地启动令牌。
    async renderSkillsPanel() {
      const box = $('skillList');
      if (!box) return;
      // v2（UX 修复）：技能「⋯」更多菜单点击外部自动折叠——挂接一次性 document 委托（与模型/聊天下拉同模式）
      if (!App.ui._skillMoreBound) {
        App.ui._skillMoreBound = true;
        document.addEventListener('click', (e) => {
          const inside = e.target && e.target.closest ? e.target.closest('.skill-more') : null;
          document.querySelectorAll('.skill-more[open]').forEach((m) => { if (m !== inside) m.open = false; });
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.querySelectorAll('.skill-more[open]').forEach((m) => { m.open = false; });
        });
      }
      box.innerHTML = '<div class="skill-state"><span class="skill-spinner"></span><span>正在读取本机技能…</span></div>';
      const proj = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
      let wid = (proj && proj.workspaceId) || '';
      const registerProjectWorkspace = async () => {
        if (!proj || !App.services.shell || !App.services.shell.registerWorkspace) return false;
        const primary = Array.isArray(proj.roots) && proj.roots.length
          ? proj.roots.find((root) => root.rootId === proj.primaryRootId) || proj.roots[0]
          : null;
        const cwd = proj.cwd || (primary && primary.path) || '';
        if (!cwd) return false;
        try {
          const registered = await App.services.shell.registerWorkspace(cwd, proj.name);
          if (!registered || !registered.ok || !registered.workspaceId) return false;
          wid = registered.workspaceId;
          proj.workspaceId = wid;
          if (typeof registered.cwd === 'string' && registered.cwd) proj.cwd = registered.cwd;
          if (Array.isArray(registered.roots) && registered.roots.length) proj.roots = registered.roots;
          if (registered.primaryRootId) proj.primaryRootId = registered.primaryRootId;
          App.persist();
          return true;
        } catch (_) {
          return false;
        }
      };
      const isInvalidWorkspace = (value) => {
        const text = String(value && (value.code || value.error || value.message) || value || '').toLowerCase();
        return text === 'unknown_workspace' || text === 'invalid_workspace'
          || /invalid.?workspace|unknown.?workspace|无效的工作区|工作区.*(失效|无效)/i.test(text);
      };
      // v2（UX 修复）：老项目缺 workspaceId 时惰性登记，否则主进程只扫到用户级+内置，项目级技能“名存实亡”
      if (!wid && proj && proj.cwd) {
        await registerProjectWorkspace();
      }
      const listSkills = async () => (App.services.skills && App.services.skills.listSkills
        ? App.services.skills.listSkills(wid)
        : { ok: false, error: '当前环境不支持技能管理', skills: [] });
      let result;
      try {
        result = await listSkills();
      } catch (e) {
        result = { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
      }
      if ((!result || !result.ok) && isInvalidWorkspace(result)) {
        wid = '';
        if (proj) proj.workspaceId = '';
        if (await registerProjectWorkspace()) {
          try { result = await listSkills(); } catch (e) {
            result = { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
          }
        }
      }
      if (!result || !result.ok) {
        box.innerHTML = '<div class="skill-state skill-state-error"><b>技能列表读取失败</b><span>' + App.escapeHtml((result && result.error) || '未知错误') + '</span><button type="button" class="btn-ghost mini" data-skill-retry>重试</button></div>';
        const retry = box.querySelector('[data-skill-retry]');
        if (retry) retry.addEventListener('click', () => App.ui.renderSkillsPanel());
        return;
      }
      const skills = Array.isArray(result.skills) ? result.skills : [];
      App.ui._skillsPanelData = skills;
      App.ui._externalSkills = Array.isArray(result.external) ? result.external : [];
      App.ui.applySkillFilter();
    },

    applySkillFilter() {
      const box = $('skillList');
      if (!box) return;
      const all = Array.isArray(App.ui._skillsPanelData) ? App.ui._skillsPanelData : [];
      const search = String(($('skillSearch') && $('skillSearch').value) || '').trim().toLowerCase();
      // v2（F 批）：属性筛选——风险 / 信任 / 自动触发 / 冲突
      const filter = String(($('skillFilter') && $('skillFilter').value) || '');
      const skills = all.filter((s) => {
        if (search && !String(s.name || '').toLowerCase().includes(search) && !String(s.description || '').toLowerCase().includes(search)) return false;
        if (filter === 'high' && s.risk !== 'high') return false;
        if (filter === 'medium' && s.risk !== 'medium') return false;
        if (filter === 'untrusted' && s.trusted) return false;
        if (filter === 'trusted' && !s.trusted) return false;
        if (filter === 'noauto' && s.autoTrigger !== false) return false;
        if (filter === 'conflict' && !(s.triggerConflicts && s.triggerConflicts.length) && !(Number(s.duplicateCount) > 1)) return false;
        return true;
      });
      const count = $('skillCount');
      if (count) count.textContent = skills.length + ' / ' + all.length;
      if (!skills.length) {
        box.innerHTML = '<div class="skill-state"><strong>' + (all.length ? '没有匹配的技能' : '还没有安装技能') + '</strong><span>' + (all.length ? '换个关键词试试。' : '点击右上角「导入 Skill」开始安装。') + '</span></div>';
        return;
      }
      const groups = [
        { key: 'project', title: '当前项目', desc: '仅在当前项目中生效' },
        { key: 'user', title: '用户技能', desc: '对所有项目生效' },
        { key: 'builtin', title: '内置技能', desc: '糖包随附，始终可用' },
      ];
      const levelLabel = { project: '项目', user: '用户级', builtin: '内置' };
      // 同名生效关系由主进程按 Runtime 的真实根目录顺序计算；前端只展示，不自行推断另一套优先级。
      box.innerHTML = groups.map((g) => {
        const rows = skills.filter((s) => s.level === g.key);
        if (!rows.length) return '';
        return '<section class="skill-group"><div class="skill-group-head"><div><h4>' + g.title + '</h4><span>' + g.desc + '</span></div><b>' + rows.length + '</b></div>' + rows.map((s) => {
          const enabled = s.enabled !== false;
          const disabled = s.level === 'builtin';
          const payload = ' data-skill-dir="' + App.escapeHtml(s.dir || '') + '" data-skill-name="' + App.escapeHtml(s.name || '') + '" data-skill-scope="' + App.escapeHtml(s.level || '') + '"';
          const control = '<label class="skill-toggle' + (disabled ? ' is-disabled' : '') + '" title="' + (disabled ? '内置技能不可禁用' : (enabled ? '点击禁用' : '点击启用')) + '"><input type="checkbox" ' + (enabled ? 'checked ' : '') + (disabled ? 'disabled' : '') + payload + ' data-skill-enable="' + (enabled ? '0' : '1') + '"><span></span></label>';
          const riskLabel = s.risk === 'high' ? '高风险' : (s.risk === 'medium' ? '中风险' : (s.risk === 'low' ? '低风险' : '未扫描'));
          const conflicts = Array.isArray(s.triggerConflicts) ? s.triggerConflicts : [];
          const duplicate = Number(s.duplicateCount) > 1;
          const resolutionLabel = s.resolution === 'effective' && duplicate ? '当前生效'
            : s.resolution === 'covered' ? '被' + App.escapeHtml((s.coveredBy && (s.coveredBy.priorityLabel || s.coveredBy.scope)) || '同名 Skill') + '覆盖'
            : s.resolution === 'disabled' && duplicate ? '已停用 · 其他同名项生效' : '';
          const resolutionClass = s.resolution === 'effective' ? 'skill-effective' : s.resolution === 'disabled' ? 'skill-disabled-resolution' : 'skill-covered';
          const meta = '<div class="skill-meta"><span>v' + App.escapeHtml(s.version || '未标注') + '</span><span class="skill-risk skill-risk-' + App.escapeHtml(s.risk || 'unknown') + '">' + riskLabel + '</span><span class="skill-trust' + (s.trusted ? ' is-trusted' : '') + '">' + (s.trusted ? '已信任当前版本' : '未信任') + '</span>'
            + (resolutionLabel ? '<span class="' + resolutionClass + '" title="优先级：' + App.escapeHtml(s.priorityLabel || '') + '">' + resolutionLabel + '</span>' : '')
            + (duplicate ? '<span class="skill-duplicate-count">同名 ' + s.duplicateCount + ' 项</span>' : '')
            + (conflicts.length ? '<button type="button" class="skill-conflict-btn" data-skill-conflict="' + App.escapeHtml(s.name) + '" title="查看触发词冲突详情">触发词冲突</button>' : '')
            + '</div>';
          // v2（F 批）：主操作「详情」+ 更多菜单（导出 / 信任 / 自动触发 / 卸载），避免五按钮横排
          const actions = disabled ? '' : '<div class="skill-actions"><button type="button" class="mini" data-skill-act="details"' + payload + '>详情</button><details class="skill-more"><summary title="更多操作" aria-label="更多操作">⋯</summary><div class="skill-more-menu">'
            + '<button type="button" class="mini" data-skill-act="edit"' + payload + '>编辑 SKILL.md</button>'
            + '<button type="button" class="mini" data-skill-act="reveal"' + payload + '>打开所在位置</button>'
            + '<button type="button" class="mini" data-skill-act="export"' + payload + '>导出标准 ZIP</button>'
            + '<button type="button" class="mini" data-skill-act="trust" data-trusted="' + (s.trusted ? '1' : '0') + '"' + payload + '>' + (s.trusted ? '撤销信任' : '信任当前版本') + '</button>'
            + '<button type="button" class="mini" data-skill-act="trigger" data-enabled="' + (s.autoTrigger === false ? '0' : '1') + '"' + payload + '>' + (s.autoTrigger === false ? '开启自动触发' : '关闭自动触发') + '</button>'
            // v2（等级移动）：project 级 → 移到用户级；user 级 → 移到当前项目
            + (s.level === 'project' ? '<button type="button" class="mini" data-skill-act="move-user"' + payload + '>移到用户级</button>'
              : s.level === 'user' ? '<button type="button" class="mini" data-skill-act="move-project"' + payload + '>移到当前项目</button>' : '')
            + '<button type="button" class="mini danger" data-skill-act="uninstall"' + payload + '>卸载（移入隔离区）</button>'
            + '</div></details></div>';
          // v2（UX 重排）：meta 标签与操作按钮合并到同一行（.skill-foot），压缩卡片纵向高度
          const foot = '<div class="skill-foot">' + meta + actions + '</div>';
          return '<div class="skill-row' + (!enabled ? ' is-off' : '') + '"><div class="skill-icon">✦</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(s.name || '') + '<span class="skill-level skill-level-' + g.key + '">' + levelLabel[g.key] + '</span></div><div class="skill-desc">' + App.escapeHtml(s.description || '暂无说明') + '</div></div>' + foot + control + '</div>';
        }).join('') + '</section>';
      }).join('');
      const external = Array.isArray(App.ui._externalSkills) ? App.ui._externalSkills : [];
      if (external.length && !search) {
        box.insertAdjacentHTML('beforeend', '<section class="skill-group skill-external"><div class="skill-group-head"><div><h4>检测到外部 Skill</h4><span>来自 .claude / .codex 兼容目录，可选择性复制到糖码标准目录</span></div><b>' + external.length + '</b></div>' + external.map((s) => '<div class="skill-row"><div class="skill-icon">↗</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(s.name) + '<span class="skill-level">' + App.escapeHtml(s.source) + '</span></div><div class="skill-desc">' + App.escapeHtml(s.description || '暂无说明') + '</div><div class="skill-actions"><button type="button" class="mini" data-skill-external="1" data-source="' + App.escapeHtml(s.source) + '" data-name="' + App.escapeHtml(s.name) + '">导入到糖码</button></div></div></div>').join('') + '</section>');
      }
      box.querySelectorAll('.skill-toggle input[data-skill-name]').forEach((inp) => {
        inp.addEventListener('change', async () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const payload = {
            dir: inp.dataset.skillDir,
            name: inp.dataset.skillName,
            scope: inp.dataset.skillScope,
            workspaceId: (project && project.workspaceId) || '',
            enable: inp.dataset.skillEnable === '1',
          };
          inp.disabled = true;
          const r = await App.services.skills.toggleSkill(payload);
          if (r && r.ok) App.ui.toast(payload.enable ? '已启用：' + payload.name : '已禁用：' + payload.name);
          else App.ui.toast((r && r.error) || '启停失败');
          App.ui.renderSkillsPanel();
        });
      });
      box.querySelectorAll('[data-skill-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          // v2（F 批）：更多菜单项点击后自动收起
          const more = btn.closest('.skill-more');
          if (more) more.open = false;
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const payload = {
            dir: btn.dataset.skillDir,
            name: btn.dataset.skillName,
            scope: btn.dataset.skillScope,
            workspaceId: (project && project.workspaceId) || '',
          };
          const act = btn.dataset.skillAct; btn.disabled = true;
          try {
            let r;
            if (act === 'details') {
              r = await App.services.skills.details(payload);
              if (r && r.ok) App.ui.showSkillDetails(r);
              else App.ui.toast((r && r.error) || '读取详情失败');
              return;
            }
            if (act === 'edit') r = await App.services.skills.edit(payload);
            else if (act === 'reveal') r = await App.services.skills.reveal(payload);
            else if (act === 'export') r = await App.services.skills.exportSkill(payload);
            else if (act === 'uninstall') r = await App.services.skills.uninstall(payload);
            else if (act === 'trust') r = await App.services.skills.trust(Object.assign(payload, { level: btn.dataset.trusted === '1' ? 'untrusted' : 'version' }));
            else if (act === 'trigger') r = await App.services.skills.setAutoTrigger(Object.assign(payload, { enabled: btn.dataset.enabled !== '1' }));
            else if (act === 'move-user') r = await App.services.skills.moveSkill(Object.assign(payload, { toScope: 'user' }));
            else if (act === 'move-project') {
              if (!project || !project.workspaceId) { App.ui.toast('请先打开有效项目，再移动为项目级 Skill'); return; }
              r = await App.services.skills.moveSkill(Object.assign(payload, { toScope: 'project', toWorkspaceId: project.workspaceId }));
            }
            if (r && r.ok) {
              const message = act === 'export' ? 'Skill 已导出'
                : act === 'edit' ? '已用系统编辑器打开 SKILL.md'
                  : act === 'reveal' ? '已在文件管理器中定位 Skill'
                    : act === 'move-user' ? 'Skill 已移到用户级'
                      : act === 'move-project' ? 'Skill 已移到当前项目'
                        : act === 'uninstall' ? '已卸载 Skill（移入隔离区）'
                          : 'Skill 设置已更新';
              App.ui.toast(message);
              if (!['edit', 'reveal'].includes(act)) App.ui.renderSkillsPanel();
            }
            else if (!(r && r.canceled)) App.ui.toast((r && r.error) || '操作失败');
          } catch (e) {
            // v1.1.0（修复）：异常不得静默——此前只有 finally，IPC 异常会被吞掉表现为"点卸载无反应"
            App.ui.toast('操作失败：' + ((e && e.message) || e));
          } finally { btn.disabled = false; }
        });
      });
      // v2（F 批）：触发词冲突详情——列出冲突技能与触发词，帮助用户决策
      box.querySelectorAll('[data-skill-conflict]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.skillConflict || '';
          const s = all.find((x) => x.name === name) || {};
          const conflicts = Array.isArray(s.triggerConflicts) ? s.triggerConflicts : [];
          if (!conflicts.length) { App.ui.toast('暂无冲突详情'); return; }
          const lines = conflicts.map((c) => {
            const trigger = (Array.isArray(c.triggers) ? c.triggers : []).join('、') || String(c.trigger || '');
            return '<div class="skill-conflict-row"><b>' + App.escapeHtml(c.name || '?') + '</b><code>' + App.escapeHtml(trigger) + '</code></div>';
          }).join('');
          App.ui.showModal({ title: '触发词冲突：' + name, body: '<div class="skill-conflict-tip">以下技能与「' + App.escapeHtml(name) + '」存在相同触发词，关键词自动注入时按 project→user→builtin 优先级取生效版本：</div>' + lines, buttons: [{ label: '关闭', cls: 'btn-ghost' }] });
        });
      });
      box.querySelectorAll('[data-skill-external]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          if (!(project && project.workspaceId)) { App.ui.toast('请先打开有效项目'); return; }
          btn.disabled = true;
          try {
            const r = await App.services.skills.importExternal({ name: btn.dataset.name, source: btn.dataset.source, workspaceId: project.workspaceId, scope: 'project' });
            if (r && r.ok) { App.ui.toast('已导入外部 Skill：' + r.name); App.ui.renderSkillsPanel(); }
            else App.ui.toast((r && r.error) || '导入失败');
          } finally { btn.disabled = false; }
        });
      });
    },

    showSkillDetails(result) {
      const s = result.skill || {}, m = result.manifest || {}, sec = result.security || {}, comp = result.compatibility || {};
      const identity = result.identity || { name: s.name, dir: s.dir, scope: s.level, workspaceId: '' };
      const modal = document.createElement('div'); modal.className = 'modal-mask';
      const risks = (sec.risks || []).map((item) => '<li>' + App.escapeHtml(item.severity + ' · ' + item.type + ' · ' + item.path) + '</li>').join('') || '<li>未发现静态风险</li>';
      const issues = (comp.issues || []).map((item) => '<li>' + App.escapeHtml(item.message) + '</li>').join('') || '<li>当前平台兼容性检查通过</li>';
      const runtimes = (comp.requiredEnv || []).length ? '声明所需环境变量：' + App.escapeHtml(comp.requiredEnv.join('、')) : '未声明环境变量';
      // v2（H 批）：签名来源与依赖环境——本地无密钥体系，签名仅记录展示，一律按未验证处理
      const signatureRow = m.signature
        ? '已声明签名（本地无密钥体系，按未验证处理；执行仍要求审批）'
        : '未签名（仅本地包哈希信任）';
      const deps = (s.metadata && (s.metadata.dependencies || s.metadata.runtimes)) ? '声明依赖（不自动安装，需在系统或独立环境中手动准备）' : '未声明外部依赖';
      modal.innerHTML = '<div class="modal skill-detail-modal" role="dialog" aria-modal="true"><div class="modal-header"><span>Skill 详情 · ' + App.escapeHtml(s.name || '') + '</span><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="skill-detail-grid"><b>作用域</b><span>' + (identity.scope === 'project' ? '当前项目' : '用户级') + '</span><b>路径</b><code>' + App.escapeHtml(identity.dir || '') + '</code><b>版本</b><span>' + App.escapeHtml(m.version || '未标注') + '</span><b>发布者</b><span>' + App.escapeHtml(m.publisher || '未标注') + '</span><b>签名</b><span>' + App.escapeHtml(signatureRow) + '</span><b>来源</b><span>' + App.escapeHtml(m.sourceType || s.level || '') + '</span><b>包哈希</b><code>' + App.escapeHtml(sec.packageHash || m.packageHash || '') + '</code><b>能力</b><span>' + App.escapeHtml((sec.capabilities || []).join('、') || '只读说明') + '</span><b>自动触发</b><span>' + (m.autoTrigger === false ? '关闭（仍可显式调用）' : '开启') + '</span><b>依赖环境</b><span>' + App.escapeHtml(deps) + ' · ' + runtimes + '</span><b>隔离说明</b><span>脚本使用最小环境、临时目录、超时和输出限制；当前平台网络为声明但未强制阻断。</span></div><h4>风险扫描</h4><ul>' + risks + '</ul><h4>兼容性</h4><ul>' + issues + '</ul></div><div class="modal-footer skill-detail-actions"><button class="btn-ghost" data-detail-act="toggle">' + (s.enabled === false ? '启用' : '停用') + '</button><button class="btn-ghost" data-detail-act="edit">编辑 SKILL.md</button><button class="btn-ghost" data-detail-act="reveal">打开所在位置</button><button class="btn-ghost danger" data-detail-act="uninstall">卸载到隔离区</button><button class="btn-primary" data-close>关闭</button></div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.remove(); });
      modal.addEventListener('click', async (e) => {
        if (e.target === modal || e.target.closest('[data-close]')) { modal.remove(); return; }
        const btn = e.target.closest('[data-detail-act]');
        if (!btn) return;
        btn.disabled = true;
        const action = btn.dataset.detailAct;
        let response;
        try {
          if (action === 'toggle') response = await App.services.skills.toggleSkill(Object.assign({}, identity, { enable: s.enabled === false }));
          else if (action === 'edit') response = await App.services.skills.edit(identity);
          else if (action === 'reveal') response = await App.services.skills.reveal(identity);
          else if (action === 'uninstall') response = await App.services.skills.uninstall(identity);
          if (response && response.ok) {
            App.ui.toast(action === 'edit' ? '已用系统编辑器打开 SKILL.md' : action === 'reveal' ? '已在文件管理器中定位 Skill' : 'Skill 设置已更新');
            if (action === 'toggle' || action === 'uninstall') { modal.remove(); App.ui.renderSkillsPanel(); }
          } else if (!(response && response.canceled)) App.ui.toast((response && response.error) || '操作失败');
        } finally { btn.disabled = false; }
      });
      const focusable = modal.querySelector('button, input, select, a[href]');
      if (focusable) focusable.focus();
    },

    // v2（F 批）：通用确认/信息弹窗（返回 modal 元素供继续绑定）
    showModal(opts) {
      const o = opts || {};
      const modal = document.createElement('div'); modal.className = 'modal-mask';
      const buttons = (o.buttons || [{ label: '关闭', cls: 'btn-ghost' }]).map((b) => '<button type="button" class="' + (b.cls || 'btn-ghost') + '" data-modal-btn="' + App.escapeHtml(String(b.label || '关闭')) + '">' + App.escapeHtml(b.label || '关闭') + '</button>').join('');
      modal.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="modal-header"><span>' + App.escapeHtml(o.title || '') + '</span><button class="icon-btn" data-close aria-label="关闭">×</button></div><div class="modal-body">' + (o.body || '') + '</div><div class="modal-footer">' + buttons + '</div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { modal.remove(); if (o.onClose) o.onClose(); } });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) { modal.remove(); if (o.onClose) o.onClose(); return; }
        if (e.target.closest('[data-close]')) { modal.remove(); if (o.onClose) o.onClose(); return; }
        const btn = e.target.closest('[data-modal-btn]');
        if (btn) { modal.remove(); if (o.onClose) o.onClose(btn.getAttribute('data-modal-btn')); }
      });
      const focusable = modal.querySelector('button, input, select, a[href]');
      if (focusable) focusable.focus();
      return modal;
    },

    // v2（F 批 + 等级）：隔离区——列出已卸载 Skill，按范围恢复，彻底删除移入系统回收站
    async showSkillQuarantine() {
      const r = await App.services.skills.listQuarantine();
      const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
      const body = items.length
        ? '<div class="skill-quarantine-list">' + items.map((it) => '<div class="skill-row"><div class="skill-icon">🗑</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(it.name) + '<span class="skill-level">隔离区</span><span class="skill-level skill-level-' + (it.scope === 'project' ? 'project' : 'user') + '">' + (it.scope === 'project' ? '原项目级' : '原用户级') + '</span></div><div class="skill-desc">' + App.escapeHtml(it.description || '暂无说明') + '</div></div><div class="skill-actions"><button type="button" class="btn-primary mini" data-sq-restore="' + App.escapeHtml(it.quarantinePath) + '" data-scope="' + App.escapeHtml(it.scope || 'user') + '">恢复</button><button type="button" class="mini danger" data-sq-purge="' + App.escapeHtml(it.quarantinePath) + '">彻底删除</button></div></div>').join('') + '</div>'
        : '<div class="skill-state"><strong>隔离区为空</strong><span>卸载的 Skill 会移到这里，可随时恢复。</span></div>';
      const modal = App.ui.showModal({ title: 'Skill 隔离区（已卸载，可恢复）', body, buttons: [{ label: '关闭', cls: 'btn-ghost' }] });
      modal.querySelectorAll('[data-sq-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          try {
            const rr = await App.services.skills.restoreQuarantine({ quarantinePath: btn.dataset.sqRestore, scope: btn.dataset.scope, workspaceId: (project && project.workspaceId) || '' });
            if (rr && rr.ok) { App.ui.toast('已恢复 Skill：' + rr.name); modal.remove(); App.ui.renderSkillsPanel(); }
            else { btn.disabled = false; App.ui.toast((rr && rr.error) || '恢复失败'); }
          } catch (e) {
            // v1.1.0（修复）：恢复异常不得静默——IPC reject 此前会表现为"点了没反应"
            btn.disabled = false; App.ui.toast('恢复失败：' + ((e && e.message) || e));
          }
        });
      });
      modal.querySelectorAll('[data-sq-purge]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const rr = await App.services.skills.purgeQuarantine({ quarantinePath: btn.dataset.sqPurge });
          if (rr && rr.ok) { App.ui.toast('已移入系统回收站'); modal.remove(); App.ui.showSkillQuarantine(); }
          else { btn.disabled = false; App.ui.toast((rr && rr.error) || '删除失败'); }
        });
      });
    },
  });
})();
