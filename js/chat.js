'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);
  const SYSTEM_PROMPT = App.DEFAULT_PROMPTS.chat;

  const SUGGESTIONS = [
    { title: '写一份周报', desc: '工作总结 / 计划', prompt: '帮我写一份本周工作周报，包含完成事项、进行中和下周计划。', icon: '📅' },
    { title: '解释概念', desc: '用通俗语言讲清楚', prompt: '用通俗易懂的语言解释“量子纠缠”是什么。', icon: '💡' },
    { title: '翻译助手', desc: '中英文互译', prompt: '把下面这段话翻译成英文，保持语气自然：今天天气真好，我们去郊游吧。', icon: '🌐' },
    { title: '绘图提示词', desc: '生成图像描述', prompt: '生成一张赛博朋克风格的城市夜景图，霓虹灯光，4K 高清。', icon: '🎨' },
    { title: '健身计划', desc: '一周训练安排', prompt: '帮我制定一份适合上班族的一周健身计划。', icon: '💪' },
    { title: '代码助手', desc: 'Python 小技巧', prompt: '用 Python 读取一个 CSV 文件并输出前 5 行，给出示例代码。', icon: '💻' },
  ];

  const QUICK_ACTIONS = [
    { label: '帮我写', prompt: '帮我写一份本周工作周报，包含完成事项、进行中和下周计划。' },
    { label: '糖绘', prompt: '生成一张赛博朋克风格的城市夜景图，霓虹灯光，4K 高清。' },
    { label: '翻译', prompt: '把下面这段话翻译成英文，保持语气自然：' },
    { label: '总结', prompt: '请对以下文本进行总结，提取核心要点：' },
  ];

  let streaming = false;
  let recognition = null;   // 语音听写实例
  let listening = false;    // 语音听写状态
  let pendingAttachments = []; // 待发送附件 [{id,name,type,text,size}]

  App.chat = {
    pendingAttachments,

    activeConv() { return App.state.conversations.find(c => c.id === App.state.activeId) || null; },

    // 判断当前聊天模型是否支持视觉输入
    isVisionModel() {
      const s = App.getProvider('chat');
      const model = (App.chat.activeConv() && App.chat.activeConv().model) || s.model || '';
      return App.isVisionModel(model);
    },

    // 同步图片按钮可用状态
    syncImgBtn() {
      const btn = $('imgBtn');
      if (!btn) return;
      const s = App.getProvider('chat');
      const model = (App.chat.activeConv() && App.chat.activeConv().model) || s.model || '';
      const ok = App.isVisionModel(model);
      btn.disabled = !ok;
      btn.classList.toggle('img-disabled', !ok);
      btn.title = ok ? '图片' : ('当前模型 ' + (model || '未配置') + ' 不支持图片输入，可在设置→API→视觉模型中添加');
    },

    // 读取并压缩图片，返回 base64 data URL
    async processImage(file) {
      const MAX_EDGE = 4096;
      const MAX_SIZE = 5 * 1024 * 1024; // 5MB
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            let w = img.naturalWidth, h = img.naturalHeight;
            const max = Math.max(w, h);
            if (max > MAX_EDGE) {
              const scale = MAX_EDGE / max;
              w = Math.round(w * scale); h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            let quality = 0.92;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            // 如果仍超过 5MB，降低质量
            while (dataUrl.length > MAX_SIZE && quality > 0.3) {
              quality -= 0.1;
              dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            resolve(dataUrl);
          };
          img.onerror = () => reject(new Error('图片解析失败'));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
    },

    // 处理图片文件：压缩后加入 pendingAttachments
    async handleImageFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      if (!App.chat.isVisionModel()) { App.ui.toast('当前模型不支持图片输入'); return; }
      try {
        const data = await App.chat.processImage(file);
        pendingAttachments.push({ id: App.uid(), name: file.name, type: 'image', data, size: file.size });
        App.chat.pendingAttachments = pendingAttachments;
        App.chat.renderAttachChips();
        App.chat.updateSendEnabled();
        App.ui.toast('已添加图片 ' + file.name);
      } catch (e) { App.ui.toast('图片处理失败：' + (e.message || '未知错误')); }
    },

    // 渲染输入框上方的附件小卡片（chips）
    renderAttachChips() {
      const box = $('attachChips');
      if (!box) return;
      if (!pendingAttachments.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = 'flex';
      box.innerHTML = pendingAttachments.map(a => {
        if (a.type === 'image') {
          return `<span class="img-chip" data-id="${a.id}">
            <img src="${a.data}" alt="">
            <span class="attach-name">${App.escapeHtml(a.name)}</span>
            <button class="attach-chip-remove" data-remove="${a.id}" title="移除">×</button>
          </span>`;
        }
        return `<span class="attach-chip" data-id="${a.id}">
           <span class="attach-ico">📄</span>
           <span class="attach-name">${App.escapeHtml(a.name)}</span>
           <button class="attach-chip-remove" data-remove="${a.id}" title="移除">×</button>
         </span>`;
      }).join('');
    },

    removeAttachment(id) {
      pendingAttachments = pendingAttachments.filter(a => a.id !== id);
      App.chat.pendingAttachments = pendingAttachments;
      App.chat.renderAttachChips();
      App.chat.updateSendEnabled();
    },

    clearAttachments() {
      pendingAttachments = [];
      App.chat.pendingAttachments = pendingAttachments;
      App.chat.renderAttachChips();
    },

    updateSendEnabled() {
      $('sendBtn').disabled = streaming || (!$('input').value.trim() && !pendingAttachments.length);
    },

    // 把消息正文与附件拼成最终发给模型的 content
    // 纯文本返回字符串；含图片时返回 OpenAI vision 数组格式
    buildContent(m) {
      const textParts = [m.content || ''];
      const textAttachments = [];
      const images = [];
      if (m.attachments && m.attachments.length) {
        m.attachments.forEach(a => {
          if (a.type === 'image') images.push(a.data);
          else textAttachments.push(`【附件：${a.name}】\n${a.text || ''}`);
        });
      }
      if (textAttachments.length) textParts.push(textAttachments.join('\n\n'));
      const textContent = textParts.join('\n\n').trim();
      if (!images.length) return textContent;
      const arr = [];
      if (textContent) arr.push({ type: 'text', text: textContent });
      images.forEach(url => arr.push({ type: 'image_url', image_url: { url } }));
      return arr;
    },

    newConversation(agent) {
      const conv = { id: App.uid(), title: '新对话', messages: [], updatedAt: Date.now() };
      if (agent) {
        conv.title = agent.name;
        conv.agentId = agent.id;
        conv.systemPrompt = agent.systemPrompt;
        // 对话级模型/参数优先（智能体指定），否则回退聊天默认
        if (agent.model) conv.model = agent.model;
        if (typeof agent.temperature === 'number') conv.temperature = agent.temperature;
        if (typeof agent.topP === 'number') conv.topP = agent.topP;
        if (typeof agent.web === 'boolean') conv.web = agent.web;
        if (Array.isArray(agent.starters) && agent.starters.length) conv.starters = agent.starters.slice();
        // 计入智能体使用次数
        if (agent.id && App.create && App.create.trackUsage) App.create.trackUsage(agent.id);
      }
      App.state.conversations.unshift(conv);
      App.state.activeId = conv.id;
      App.chat.clearAttachments();
      App.persist();
      App.router.go('chat');
      App.ui.renderSidebar();
      App.chat.showWelcome();
      App.ui.renderTopbarTitle();
      return conv;
    },

    // 用智能体的某条引导问题开聊：新建对话并把问题预填到输入框（用户一键发送）
    startWithStarter(agent, starter) {
      App.chat.newConversation(agent);
      const input = document.getElementById('input');
      if (input) { input.value = starter || ''; input.focus(); }
    },

    activate(id) {
      App.state.activeId = id;
      App.chat.clearAttachments();
      App.persist();
      App.router.go('chat');
      App.ui.renderSidebar();
      App.chat.renderMessages();
      App.ui.renderTopbarTitle();
    },

    deleteConversation(id) {
      App.state.conversations = App.state.conversations.filter(c => c.id !== id);
      if (App.state.activeId === id) {
        App.state.activeId = App.state.conversations[0] ? App.state.conversations[0].id : null;
        App.chat.renderMessages();
      }
      App.persist();
      App.ui.renderSidebar();
      App.ui.renderTopbarTitle();
    },

    rename() {
      const conv = App.chat.activeConv();
      if (!conv) { App.ui.toast('没有可重命名的对话'); return; }
      const name = prompt('重命名对话', conv.title || '新对话');
      if (name === null) return;
      conv.title = name.trim() || conv.title;
      App.persist();
      App.ui.renderTopbarTitle();
      App.ui.renderSidebar();
    },

    clear() {
      const conv = App.chat.activeConv();
      if (!conv) { App.ui.toast('没有可清空的对话'); return; }
      conv.messages = [];
      App.persist();
      App.chat.renderMessages();
      App.ui.toast('已清空对话');
    },

    startWithAgent(agent) {
      App.chat.newConversation(agent);
      $('input').focus();
    },

    showWelcome() {
      const welcome = $('welcome');
      const composer = $('composer');
      const messages = $('messages');
      welcome.style.display = 'flex';
      messages.style.display = 'none';
      composer.style.display = 'block';
      composer.classList.add('centered');
      welcome.appendChild(composer); // 把输入框移入欢迎区，居中显示
      $('chatTitle').textContent = '糖包';
      messages.innerHTML = '';
    },

    showChat() {
      const welcome = $('welcome');
      const composer = $('composer');
      const messages = $('messages');
      const view = document.querySelector('.view[data-view="chat"]');
      welcome.style.display = 'none';
      messages.style.display = 'flex';
      composer.style.display = 'block';
      composer.classList.remove('centered');
      view.appendChild(composer); // 把输入框移回视图底部
    },

    renderSuggestions() {
      $('suggestions').innerHTML = SUGGESTIONS.map((s, i) =>
        `<button class="suggestion" data-i="${i}">
           <span class="s-icon">${s.icon}</span>
           <span class="s-title">${App.escapeHtml(s.title)}</span>
           <span class="s-desc">${App.escapeHtml(s.desc)}</span>
         </button>`).join('');
    },

    renderQuickActions() {
      $('quickActions').innerHTML = QUICK_ACTIONS.map(a =>
        `<button class="quick-chip" data-prompt="${App.escapeHtml(a.prompt)}">${App.escapeHtml(a.label)}</button>`).join('');
    },

    messageNode(m, index) {
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + m.role;
      wrap.dataset.index = index;
      if (m.role === 'assistant') {
        const thinkHtml = m.think
          ? `<div class="think-block" style="display:${App.state.think ? 'block' : 'none'}">
               <div class="think-head"><span class="think-toggle">▾</span>深度思考</div>
               <div class="think-body">${App.escapeHtml(m.think)}</div>
             </div>`
          : '';
        const webLabel = m.webSources ? (m.webSources + ' 个') : '多个';
        const webHtml = (m.webSources || (App.state.web && m.role === 'assistant'))
          ? '<div class="web-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>基于 ' + webLabel + '搜索来源</div>'
          : '';
        wrap.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
          <div class="msg-body">
            <div class="msg-card">
              ${webHtml}
              ${thinkHtml}
              <div class="bubble"></div>
              <div class="msg-actions" data-msg="${index}">
                <button data-action="copy">复制</button>
                <button data-action="copy-md">复制 Markdown</button>
                <button data-action="regen">重新生成</button>
              </div>
            </div>
          </div>`;
        wrap.querySelector('.bubble').innerHTML = App.renderMarkdown(m.content || '');
      } else {
        const imgHtml = (m.attachments && m.attachments.length)
          ? m.attachments.filter(a => a.type === 'image').map(a =>
              `<img class="chat-img" src="${a.data}" alt="${App.escapeHtml(a.name)}" title="${App.escapeHtml(a.name)}">`).join('')
          : '';
        const attHtml = (m.attachments && m.attachments.length)
          ? `<div class="attach-cards">` + m.attachments.filter(a => a.type !== 'image').map(a =>
              `<div class="attach-card"><span class="attach-ico">📄</span><span class="attach-name">${App.escapeHtml(a.name)}</span></div>`
            ).join('') + `</div>`
          : '';
        wrap.innerHTML = `<div class="msg-body">
            ${imgHtml}
            ${attHtml}
            <div class="bubble user-bubble"></div>
            <div class="msg-actions user-actions"><button data-action="copy-user">复制</button></div>
          </div>`;
        const bubble = wrap.querySelector('.user-bubble');
        bubble.textContent = m.content || '';
        if (!m.content && !imgHtml && attHtml) bubble.style.display = 'none';
      }
      return wrap;
    },

    renderMessages() {
      const conv = App.chat.activeConv();
      if (!conv || !conv.messages.length) { App.chat.showWelcome(); return; }
      App.chat.showChat();
      $('messages').innerHTML = '';
      conv.messages.forEach((m, i) => $('messages').appendChild(App.chat.messageNode(m, i)));
      App.chat.scrollBottom();
      App.ui.renderTopbarTitle();
    },

    scrollBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; },

    appendAssistant() {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      wrap.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
        <div class="msg-body">
          <div class="msg-card">
            ${App.state.web ? `<div class="web-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>基于多个搜索来源</div>` : ''}
            <div class="think-block" style="display:none"><div class="think-head"><span class="think-toggle">▾</span>深度思考</div><div class="think-body"></div></div>
            <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>
            <div class="msg-actions" style="display:none">
              <button data-action="copy">复制</button>
              <button data-action="copy-md">复制 Markdown</button>
              <button data-action="regen">重新生成</button>
            </div>
          </div>
        </div>`;
      $('messages').appendChild(wrap);
      return {
        bubble: wrap.querySelector('.bubble'),
        thinkBlock: wrap.querySelector('.think-block'),
        thinkBody: wrap.querySelector('.think-body'),
        actions: wrap.querySelector('.msg-actions'),
      };
    },

    async streamChat(conv, ui) {
      const s = App.getProvider('chat');
      if (!s.apiBase || !s.apiKey || !s.model) {
        ui.bubble.innerHTML = '<div class="msg-error">尚未配置聊天 API。请点击左下角齿轮图标，在“默认”或“聊天”标签填入 API Base URL、Key 和 Model。</div>';
        ui.actions.style.display = 'flex';
        return;
      }
      const base = s.apiBase.replace(/\/+$/, '');
      // 兼容：用户可能已写全路径，避免拼出 /chat/completions/chat/completions
      const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
      const systemContent = conv.systemPrompt || (App.state.settings.prompts && App.state.settings.prompts.chat) || SYSTEM_PROMPT;
      // 对话级模型优先（智能体指定），否则用聊天默认模型；联网同理
      const model = (conv.model && s.models.includes(conv.model)) ? conv.model : s.model;
      const web = (conv.web != null) ? conv.web : App.state.web;
      const AGENT_BASE = 'http://localhost:3000';
      const payload = {
        model,
        stream: true,
        messages: [{ role: 'system', content: systemContent }]
          .concat(conv.messages.map(m => ({ role: m.role, content: App.chat.buildContent(m) }))),
      };
      if (typeof conv.temperature === 'number') payload.temperature = conv.temperature;
      if (typeof conv.topP === 'number') payload.top_p = conv.topP;
      // 深度思考：按模型自适应注入真实 API 参数
      Object.assign(payload, App.buildThinkParam(model, App.state.think));
      // 联网搜索：原生支持的模型直接发原生参数；不支持的（deepseek/kimi/claude 等）
      // 由本地后端(/api/search)先做真实检索，把结果注入 system 上下文，从而真正能联网。
      let webSourcesCount = 0;
      if (web) {
        const native = App.nativeWebModel(model);
        if (native) {
          Object.assign(payload, App.buildWebParam(model, true));
        } else {
          const lastUserMsg = conv.messages.filter(m => m.role === 'user').pop();
          const lastUserText = lastUserMsg
            ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ((lastUserMsg.content && lastUserMsg.content.text) || ''))
            : '';
          const sk = (App.state.settings.search && App.state.settings.search.apiKey) || '';
          let searched = null;
          try {
            const r = await fetch(AGENT_BASE + '/api/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: lastUserText, apiKey: sk }),
            });
            const d = await r.json().catch(() => ({ ok: false }));
            if (d && d.ok && Array.isArray(d.results) && d.results.length) searched = d.results;
          } catch (e) { /* 本地后端不可用，走普通对话 */ }
          if (searched) {
            const ctx = '【联网搜索结果】\n' + searched.map((x, i) =>
              `${i + 1}. ${x.title || ''}\n${x.url || ''}\n${x.snippet || ''}`).join('\n\n');
            payload.messages[0].content += '\n\n' + ctx;
            webSourcesCount = searched.length;
          } else {
            App.ui.toast('联网搜索暂不可用（未能获取搜索结果），将按普通对话发送');
          }
        }
      }
      let acc = '', thinkAcc = '', started = false;
      const wantThink = App.state.think;
      const appendDelta = (text) => {
        if (!started) { ui.bubble.innerHTML = ''; started = true; }
        acc += text;
        ui.bubble.innerHTML = App.renderMarkdown(acc);
        App.chat.scrollBottom();
      };
      try {
        // 走本地代理转发，规避浏览器 CORS
        const proxyUrl = 'http://localhost:' + (location.port || 4280) + '/api-proxy';
        const res = await fetch(proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-target-url': url,
            'x-auth': 'Bearer ' + s.apiKey,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          ui.bubble.innerHTML = `<div class="msg-error">请求失败（${res.status}）：${App.escapeHtml(txt.slice(0, 240))}</div>`;
          ui.actions.style.display = 'flex';
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
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
            if (data === '[DONE]') break;
            let json;
            try { json = JSON.parse(data); } catch (e) { continue; }
            const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
            if (delta.reasoning_content) {
              thinkAcc += delta.reasoning_content;
              if (wantThink) { ui.thinkBlock.style.display = 'block'; ui.thinkBody.innerHTML = App.renderMarkdown(thinkAcc); }
              started = true;
            }
            if (delta.content) appendDelta(delta.content);
          }
        }
        // 兼容中转站：流未以换行结尾，或根本不返回 SSE（单条 JSON）
        if (buf.trim()) {
          const t = buf.trim();
          if (t.startsWith('data:')) {
            const data = t.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                const d = (json.choices && json.choices[0] && json.choices[0].delta) || {};
                if (d.reasoning_content) { thinkAcc += d.reasoning_content; if (wantThink) { ui.thinkBlock.style.display = 'block'; ui.thinkBody.innerHTML = App.renderMarkdown(thinkAcc); } started = true; }
                if (d.content) appendDelta(d.content);
              } catch (e) {}
            }
          } else {
            // 非流式：整段即一个 JSON 对象（部分中转站会忽略 stream:true）
            try {
              const json = JSON.parse(t);
              const ch = (json.choices && json.choices[0]) || {};
              if (ch.message && ch.message.reasoning_content) { thinkAcc += ch.message.reasoning_content; if (wantThink) { ui.thinkBlock.style.display = 'block'; ui.thinkBody.innerHTML = App.renderMarkdown(thinkAcc); } started = true; }
              if (ch.message && ch.message.content) appendDelta(ch.message.content);
              else if (ch.delta && ch.delta.content) appendDelta(ch.delta.content);
            } catch (e) {}
          }
        }
      } catch (err) {
        ui.bubble.innerHTML = `<div class="msg-error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</div>`;
        ui.actions.style.display = 'flex';
        return;
      }
      if (!acc && !thinkAcc) ui.bubble.innerHTML = '<div class="msg-error">模型未返回内容。请确认中转站地址和模型名正确。</div>';
      conv.messages.push({ role: 'assistant', content: acc, think: thinkAcc, webSources: webSourcesCount });
      conv.updatedAt = Date.now();
      ui.actions.style.display = 'flex';
    },

    async send() {
      const text = $('input').value.trim();
      const atts = pendingAttachments.slice();
      if ((!text && !atts.length) || streaming) return;
      let conv = App.chat.activeConv();
      if (!conv) conv = App.chat.newConversation();
      const userMsg = { role: 'user', content: text };
      if (atts.length) userMsg.attachments = atts;
      conv.messages.push(userMsg);
      if (conv.messages.length === 1) conv.title = (text || (atts[0] && atts[0].name) || '新对话').slice(0, 20);
      conv.updatedAt = Date.now();
      $('input').value = ''; App.chat.autoSize();
      App.chat.clearAttachments();
      App.persist(); App.ui.renderSidebar();
      App.chat.showChat(); App.ui.renderTopbarTitle();
      $('messages').appendChild(App.chat.messageNode(userMsg, 0));
      const ui = App.chat.appendAssistant();
      App.chat.scrollBottom();
      streaming = true; App.chat.setSending(true);
      await App.chat.streamChat(conv, ui);
      streaming = false; App.chat.setSending(false);
      App.persist(); App.ui.renderSidebar(); App.chat.renderMessages();
    },

    async regen(index) {
      const conv = App.chat.activeConv();
      if (!conv || index < 1 || conv.messages[index].role !== 'assistant') return;
      // remove assistant and all subsequent
      conv.messages = conv.messages.slice(0, index);
      App.persist();
      App.chat.renderMessages();
      // re-stream
      const ui = App.chat.appendAssistant();
      streaming = true; App.chat.setSending(true);
      await App.chat.streamChat(conv, ui);
      streaming = false; App.chat.setSending(false);
      App.persist(); App.ui.renderSidebar();
    },

    setSending(on) {
      $('sendBtn').disabled = on || (!$('input').value.trim() && !pendingAttachments.length);
      $('input').disabled = on;
    },

    autoSize() {
      const el = $('input');
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    },

    // 语音听写：使用浏览器原生 SpeechRecognition（Chrome/Edge 支持）
    toggleVoice() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { App.ui.toast('当前浏览器不支持语音输入（建议用 Chrome/Edge）'); return; }
      if (listening) { if (recognition) recognition.stop(); return; }
      recognition = new SR();
      recognition.lang = 'zh-CN';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onstart = () => {
        listening = true;
        const b = $('micBtn'); if (b) b.classList.add('listening');
        App.ui.toast('正在聆听…说完点一下麦克风停止');
      };
      recognition.onresult = (e) => {
        let txt = '';
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        const cur = $('input').value;
        const prefix = cur && !cur.endsWith('\n') ? cur + ' ' : cur;
        $('input').value = prefix + txt;
        App.chat.autoSize();
        App.chat.updateSendEnabled();
        $('input').focus();
      };
      recognition.onend = () => {
        listening = false;
        const b = $('micBtn'); if (b) b.classList.remove('listening');
      };
      recognition.onerror = (e) => {
        listening = false;
        const b = $('micBtn'); if (b) b.classList.remove('listening');
        if (e && e.error === 'no-speech') return;
        App.ui.toast('语音识别出错：' + ((e && e.error) || '未知'));
      };
      try { recognition.start(); } catch (err) {
        listening = false;
        const b = $('micBtn'); if (b) b.classList.remove('listening');
      }
    },

    onShow() {
      App.chat.renderMessages();
      App.ui.renderTopbarTitle();
      App.ui.syncModelSelect();
      App.ui.syncThink(App.state.think);
      App.ui.syncWeb(App.state.web);
      App.chat.syncImgBtn();
    },

    init() {
      App.chat.renderSuggestions();
      App.chat.renderQuickActions();
      App.chat.syncImgBtn();

      $('input').addEventListener('input', () => { App.chat.autoSize(); App.chat.updateSendEnabled(); });
      $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.chat.send(); } });
      $('sendBtn').addEventListener('click', () => App.chat.send());
      // 附件：读取文本文件为独立卡片（发送时作为上下文注入，不写入输入框）
      const attachInput = $('attachInput');
      $('attachBtn').addEventListener('click', () => { if (attachInput) attachInput.click(); });
      if (attachInput) {
        attachInput.addEventListener('change', () => {
          const files = attachInput.files ? Array.from(attachInput.files) : [];
          if (!files.length) return;
          files.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
              let text = String(reader.result || '');
              const MAX = 20000;
              if (text.length > MAX) text = text.slice(0, MAX) + '\n…（附件过长已截断）';
              pendingAttachments.push({ id: App.uid(), name: file.name, type: file.type || '', text, size: file.size });
              App.chat.pendingAttachments = pendingAttachments;
              App.chat.renderAttachChips();
              App.chat.updateSendEnabled();
              App.ui.toast('已附加 ' + file.name);
            };
            reader.onerror = () => App.ui.toast('读取文件失败：' + file.name);
            reader.readAsText(file);
          });
          attachInput.value = '';
        });
      }
      // 附件卡片：点击 × 移除
      const attachChips = $('attachChips');
      if (attachChips) {
        attachChips.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove]');
          if (btn) App.chat.removeAttachment(btn.dataset.remove);
        });
      }
      // 图片：读取图片文件并压缩为 base64
      const imgInput = $('imgInput');
      const imgBtn = $('imgBtn');
      if (imgBtn && imgInput) {
        imgBtn.addEventListener('click', () => {
          if (!App.chat.isVisionModel()) { App.ui.toast('当前模型不支持图片输入'); return; }
          imgInput.click();
        });
        imgInput.addEventListener('change', () => {
          const files = imgInput.files ? Array.from(imgInput.files) : [];
          files.forEach(f => App.chat.handleImageFile(f));
          imgInput.value = '';
        });
      }
      // 粘贴图片
      $('input').addEventListener('paste', (e) => {
        if (!App.chat.isVisionModel()) return;
        const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
        let hasImg = false;
        items.forEach(item => {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) { hasImg = true; App.chat.handleImageFile(file); }
          }
        });
        if (hasImg) e.preventDefault();
      });
      // 拖拽图片到聊天区（绑在 composer 上，欢迎页和对话视图都可见）
      const composer = $('composer');
      if (composer) {
        composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drag-over'); });
        composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
        composer.addEventListener('drop', (e) => {
          e.preventDefault();
          composer.classList.remove('drag-over');
          if (!App.chat.isVisionModel()) { App.ui.toast('当前模型不支持图片输入'); return; }
          const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
          files.forEach(f => App.chat.handleImageFile(f));
        });
      }

      // 深度思考 / 联网搜索开关在 ui.js init 中统一绑定，避免重复监听导致的双切换

      $('quickActions').addEventListener('click', (e) => {
        const b = e.target.closest('[data-prompt]');
        if (!b) return;
        $('input').value = b.dataset.prompt; App.chat.autoSize(); $('input').focus();
        App.chat.updateSendEnabled();
      });
      $('suggestions').addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b) return;
        const s = SUGGESTIONS[+b.dataset.i];
        $('input').value = s.prompt; App.chat.autoSize(); $('input').focus();
        App.chat.updateSendEnabled();
      });

      // message actions
      $('messages').addEventListener('click', (e) => {
        const thinkHead = e.target.closest('.think-head');
        if (thinkHead) { thinkHead.closest('.think-block').classList.toggle('collapsed'); return; }
        const msgEl = e.target.closest('.msg');
        const idx = msgEl ? +msgEl.dataset.index : null;
        const conv = App.chat.activeConv();

        const copy = e.target.closest('[data-action="copy"]');
        if (copy) {
          const card = copy.closest('.msg-card') || copy.closest('.msg-body');
          const text = card.querySelector('.bubble').innerText;
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const copyMd = e.target.closest('[data-action="copy-md"]');
        if (copyMd) {
          const text = (conv && idx != null && conv.messages[idx]) ? (conv.messages[idx].content || '') : '';
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制 Markdown')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const copyUser = e.target.closest('[data-action="copy-user"]');
        if (copyUser) {
          const text = (conv && idx != null && conv.messages[idx]) ? (conv.messages[idx].content || '') : '';
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const regen = e.target.closest('[data-action="regen"]');
        if (regen) { App.chat.regen(idx); return; }
      });

      // code copy —— 委托到 document，覆盖所有模块（聊天/糖码/糖读）内的代码块复制按钮
      if (!App.__codeCopyBound) {
        App.__codeCopyBound = true;
        document.addEventListener('click', (e) => {
          const btn = e.target.closest('.copy-btn');
          if (!btn) return;
          const pre = btn.closest('pre');
          const code = pre && pre.querySelector('code');
          if (!code) return;
          navigator.clipboard.writeText(code.innerText).then(() => {
            btn.textContent = '已复制';
            setTimeout(() => btn.textContent = '复制', 1500);
          }).catch(() => btn.textContent = '复制失败');
        });
      }
    },
  };
})();
