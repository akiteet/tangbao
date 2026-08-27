'use strict';
// 糖馆群聊轮流调度回归（v1.2.0 批次 5；源码静态断言——chat.js/tavern.js 为 window 绑定脚本）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('群聊接管：streamChat 对多角色会话转交 runGroupTurn，成员轮次绕过', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  assert.ok(chat.includes('__groupMember'), '成员轮次标记存在（防止递归接管）');
  assert.ok(chat.includes('runGroupTurn'), '群聊分支转交调度器');
  assert.ok(chat.includes('__groupBrief'), '群聊简报注入系统提示');
});

test('调度器：轮流上限、沉默协议、署名前缀、现场恢复', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes('async runGroupTurn(conv, ui, options)'), '调度器存在于 App.tavern');
  assert.ok(/\.slice\(0, 6\)/.test(tavern), '单轮发言成员数上限 6，防失控');
  assert.ok(tavern.includes('[SILENCE]') && tavern.includes('[沉默]'), '沉默协议双标记');
  assert.ok(tavern.includes("conv.tavernCharacterId = prevId"), '结束后恢复原角色指针');
  assert.ok(tavern.includes('data-tg-new-group'), '角色库提供新建群聊入口');
  assert.ok(/startGroupSession/.test(tavern), '群聊会话创建函数存在');
  assert.ok(tavern.includes('conv.tavernCharacterIds = unique'), '会话携带成员列表');
});

test('群聊独立与提示行（2026-08-25 增强）：聚合 tab、单角色列表隐藏、沉默提示、出站过滤', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes('data-tg-library-tab="groups"'), '角色库提供「群聊」聚合 tab');
  assert.ok(tavern.includes('data-tg-group-open'), '群聊会话可从聚合列表打开');
  assert.ok(/if \(isGroupConv\(item\)\) return false;/.test(tavern), '单角色会话列表排除群聊（isValidSession）');
  assert.ok(tavern.includes('function belongsToCharacter'), '指针恢复/校正用归属判定（群聊归首位角色）');
  assert.ok(tavern.includes('「\' + memberName + \'」沉默了'), '沉默原位留提示行而非静默删除');
  assert.ok(tavern.includes("filter((m) => m && m.role !== 'system')"), '群聊简报不含 system 提示行');
  const chat = read('src/renderer/views/chat/chat.js');
  assert.ok(chat.includes("item.role !== 'system'"), '出站消息过滤 system 提示行（不发给模型）');
  assert.ok(chat.includes('msg-system-note'), '沉默提示行有居中展示分支');
  assert.ok(!chat.includes('msg-sender'), '群聊气泡不再显示头像旁名字行（2026-08-26 用户反馈）');
  assert.ok(tavern.includes("classList.toggle('is-group'"), '群聊 surface 切换专属背景 class');
});

test('群聊成员级操作与会话标注（2026-08-26 第三轮反馈）', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const chat = read('src/renderer/views/chat/chat.js');
  // 群聊「重新生成」只重跑该消息所属成员，不触发整轮轮流
  assert.ok(chat.includes('groupMemberOwner'), 'regen 识别群聊消息的所属成员');
  assert.ok(/await App\.chat\.streamChat\(conv, ui, \{ __groupMember: true, __memberId: groupMemberOwner \}\)/.test(chat), 'regen 以成员模式重跑（绕过整轮接管，占位即时归属）');
  assert.ok(tavern.includes('function applyMemberTurnResult'), '单成员轮次后处理抽为可复用函数');
  assert.ok(tavern.includes('applyMemberTurnResult,'), 'applyMemberTurnResult 已导出供 chat.js regen 调用');
  // 会话 tab 全量列出并标注所属角色
  assert.ok(tavern.includes('与「'), '会话行标注所属角色');
  assert.ok(tavern.includes("!isGroupConv(item)"), '会话 tab 只列个人会话（群聊走群聊 tab）');
  // 流式生成期间头像显示当前发言成员而非糖包 logo
  assert.ok(chat.includes('setStreamingMemberAvatar(ui, characterId)'), 'chat 提供流式头像切换助手');
  assert.ok(tavern.includes('setStreamingMemberAvatar(ui, id)'), '调度器每成员轮开始即换头像');
  assert.ok(chat.includes('__memberId'), '占位消息即时携带成员归属');
});

test('群聊说话人标注加固（2026-08-26）：简报精确查名 + 解析指令', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes("characterBrief(String(m.characterId || ''))"), '简报摘要按 characterId 精确标注说话人（不再靠文本猜测）');
  assert.ok(tavern.includes('标注约定：近期记录与对话历史中「名字：」开头'), '简报显式告知模型前缀即说话人');
});

test('会话归属打通与点名规则（2026-08-26 第四轮反馈）', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const fsAt = tavern.indexOf('function findSession');
  assert.ok(fsAt > 0, 'findSession 存在');
  const fsBody = tavern.slice(fsAt, fsAt + 600);
  assert.ok(/!isGroupConv\(item\)/.test(fsBody), 'findSession 按 id 全量查找个人会话（排除群聊）');
  assert.ok(!fsBody.includes('isValidSession'), 'findSession 不再绑定当前选中角色——跨角色可进、孤儿可删');
  assert.ok(tavern.includes("tg-session-row${isActive ? ' active' : ''}"), '当前会话行高亮');
  assert.ok(tavern.includes('已删除的角色'), '孤儿会话明确标注为「已删除的角色」');
  assert.ok(tavern.includes("return (addressed ? '用户→' + addressed + '：' : '用户：') + t;"), '简报标注用户消息的点名指向');
  assert.ok(tavern.includes('不要当作对你说的，也不要抢答'), '点名规则：非点名对象不接话');
  assert.ok(tavern.includes('去重规则：其他成员已经回应过的内容不要重复回应'), '已回应内容不重复回应');
});

test('群聊空消息治理（2026-08-26）：本轮产物追踪、沉默扩展、僵尸清扫、空结果可读化、三 tab 按钮', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes('const turnStart = conv.messages.length;'), '每轮发言前记录起始位置，后处理只看本轮产物');
  assert.ok(!tavern.includes("reverse().find((m) => m.role === 'assistant')"), '不再全历史倒序找 assistant（避免误伤旧消息）');
  // 报错与沉默严格区分（2026-08-26 用户裁决）：仅显式标记算沉默，错误保持失败可见
  assert.ok(!tavern.includes("|| (last && last.error === 'model_empty_result')"), 'model_empty_result 等错误结果不再混入沉默判定');
  assert.ok(tavern.includes("const explicitSilence = !!last && !last.error"), '沉默判定要求无错误且非失败态');
  assert.ok(tavern.includes("'member_no_output'"), '本轮无产物按失败呈现而非冒充沉默');
  assert.ok(tavern.includes("text.toLowerCase() === '[silence]'"), '沉默标记大小写不敏感');
  assert.ok(tavern.includes('member_turn_error: '), '成员调用失败时清扫占位并携带真实异常原因（可诊断）');
  assert.ok((tavern.match(/\$\{libraryFooter\}/g) || []).length === 3, '操作按钮 footer 在角色/会话/群聊三个 tab 统一渲染');
  const chat = read('src/renderer/views/chat/chat.js');
  assert.ok(chat.includes("'⚠️ 模型未返回内容'"), '流式双空兜底写入可读文案而非留下空气泡');
  assert.ok(chat.includes('（空回复）'), '历史空消息渲染中性提示而非空白气泡');
  const appSrc = read('src/renderer/app.js');
  assert.ok(/streamStatus === 'streaming'\) m\.streamStatus = 'failed'/.test(appSrc), '模块会话加载期复位残留 streaming 占位');
  const storage = read('src/infrastructure/storage/module-sessions.js');
  assert.ok(storage.includes("message.role !== 'system'"), '存储层放行 system 行（沉默提示跨重启保留）');
});

test('群聊头部身份块 + 调度失败可诊断（2026-08-26 用户实测反馈修复）', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(/if \(active && isGroupConv\(active\)\)/.test(tavern), '激活会话为群聊时头部渲染群聊身份块而非首位角色个人信息');
  assert.ok(tavern.includes('tg-header-avatar-stack'), '头部渲染成员头像栈');
  assert.ok(tavern.includes('轮流发言，可沉默'), '头部副标题展示成员名单与轮次规则');
  assert.ok(tavern.includes("'member_turn_error: '"), '清扫占位携带真实异常原因（可诊断，不再只有笼统标记）');
});
