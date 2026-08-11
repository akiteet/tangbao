'use strict';

/*
 * Render the real renderer entry in Electron and check the narrow layouts.
 * This intentionally uses BrowserWindow only; no browser automation package is
 * needed for the release gate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const CASES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'small-desktop', width: 1024, height: 768 },
  { name: 'compact', width: 720, height: 768 },
  { name: 'narrow', width: 390, height: 844 },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label, timeoutMs) {
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => { throw new Error(label + ' timed out after ' + timeoutMs + 'ms'); }),
  ]);
}

async function waitForRenderer(win) {
  for (let i = 0; i < 120; i += 1) {
    const ready = await win.webContents.executeJavaScript('document.readyState === "complete"', true);
    if (ready) return;
    await wait(50);
  }
  throw new Error('renderer did not finish loading');
}

async function inspectRealRenderer(win, testCase) {
  return win.webContents.executeJavaScript(`(() => {
    const failures = [];
    const root = document.documentElement;
    const body = document.body;
    try {
      if (window.App && App.router && App.router.go) App.router.go('agent');
    } catch (error) {
      failures.push('real agent route failed: ' + (error && error.message ? error.message : error));
    }
    const host = document.getElementById('agentView');
    const layout = host && host.querySelector('.agent-layout');
    const main = host && host.querySelector('.agent-main');
    if (!host || !layout || !main) failures.push('real agent layout is missing');
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    if (overflow > 1) failures.push('real agent introduces horizontal overflow ' + overflow);
    if (layout && layout.getBoundingClientRect().width <= 0) failures.push('real agent layout is collapsed');
    try {
      const thread = window.App && App.agent && App.agent.activeThread ? App.agent.activeThread() : null;
      if (thread && App.agent.restoreThread) {
        thread._liveAnswer = '# Recovered streaming output\\n\\nstable-output';
        thread._liveEvents = [];
        App.agent.restoreThread();
        const answer = document.querySelector('#agentThread .agent-answer');
        if (!answer || !answer.textContent.includes('Recovered streaming output')) failures.push('real renderer lost live streaming output');
      }
    } catch (error) {
      failures.push('real streaming restore check failed: ' + (error && error.message ? error.message : error));
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, failures };
  })()`, true);
}

async function installFixture(win) {
  await win.webContents.executeJavaScript(`(() => {
    const agentSection = document.querySelector('[data-view="agent"]');
    if (agentSection) agentSection.hidden = false;
    document.querySelectorAll('.view').forEach((node) => {
      if (node !== agentSection) node.hidden = true;
    });
    const host = document.getElementById('agentView');
    if (!host) throw new Error('agentView is missing');
    host.innerHTML =
      '<div class="agent-layout">' +
        '<aside class="agent-projects"><div class="agent-projects-head">项目</div></aside>' +
        '<aside class="agent-sessions"><div class="agent-sessions-head">会话</div></aside>' +
        '<main class="agent-main">' +
          '<div class="agent-top"><div class="agent-top-row">' +
            '<div class="agent-field grow"><h1 class="smoke-long-title">非常长的项目标题与工作目录用于验证窄窗口不会挤压标题和顶部控件</h1></div>' +
          '</div></div>' +
          '<div class="agent-thread">' +
            '<div class="agent-msg user"><div class="agent-message-text smoke-long-bubble">用户输入的超长路径 C:\\\\workspace\\\\project\\\\with\\\\a\\\\very\\\\long\\\\folder\\\\name\\\\that\\\\must\\\\wrap</div></div>' +
            '<div class="agent-msg assistant"><div class="agent-answer">' +
              '<h1 class="smoke-long-title">标题很长但必须保持可读并在容器内换行</h1>' +
              '<p>这是用于稳定性收尾版的真实 Markdown 渲染边界检查。</p>' +
              '<pre class="code-block"><div class="code-head"><span>very-long-file-name-that-must-not-push-the-layout.js</span></div><code>const veryLongIdentifier = "abcdefghijklmnopqrstuvwxyz0123456789";\\nconsole.log(veryLongIdentifier);</code></pre>' +
            '</div></div>' +
          '</div>' +
          '<div class="agent-composer"><div class="agent-composer-input-wrap"><textarea></textarea></div><button>发送</button></div>' +
        '</main>' +
      '</div>';
    const layout = host.querySelector('.agent-layout');
    const compact = window.innerWidth <= 900;
    layout.dataset.sidebarMode = compact ? 'compact' : 'wide';
    if (compact) {
      layout.classList.add('agent-layout-compact');
      const projectAside = layout.querySelector('.agent-projects');
      const sessionAside = layout.querySelector('.agent-sessions');
      if (projectAside) projectAside.remove();
      if (sessionAside) sessionAside.remove();
      const tabs = document.createElement('div');
      tabs.className = 'agent-tabs-row';
      tabs.id = 'agentTabsRow';
      tabs.innerHTML = '<div class="agent-expand-tab proj-tab"><span>Project</span></div><div class="agent-expand-tab sess-tab"><span>Session</span></div>';
      layout.insertBefore(tabs, layout.firstChild);
      const openDrawer = (kind) => {
        const old = layout.querySelector('.smoke-drawer');
        if (old) old.remove();
        const drawer = document.createElement('aside');
        drawer.className = kind === 'projects' ? 'agent-projects smoke-drawer' : 'agent-sessions smoke-drawer';
        const headClass = kind === 'projects' ? 'agent-projects-head' : 'agent-sessions-head';
        drawer.innerHTML = '<div class="' + headClass + '"><span>' + (kind === 'projects' ? 'Project' : 'Session') + '</span><div><button class="btn-ghost mini">+ New</button><button class="agent-collapse-btn">&lt;</button></div></div>';
        drawer.querySelector('.agent-collapse-btn').addEventListener('click', () => { drawer.remove(); delete layout.dataset.compactOpen; });
        layout.dataset.compactOpen = kind;
        layout.appendChild(drawer);
      };
      tabs.querySelector('.proj-tab').addEventListener('click', () => openDrawer('projects'));
      tabs.querySelector('.sess-tab').addEventListener('click', () => openDrawer('sessions'));
    } else {
      document.querySelectorAll('.agent-projects-head, .agent-sessions-head').forEach((head) => {
        const actions = document.createElement('div');
        actions.innerHTML = '<button class="btn-ghost mini">+ New</button><button class="agent-collapse-btn">&lt;</button>';
        head.appendChild(actions);
      });
    }
    return true;
  })()`, true);
}

async function inspect(win, testCase) {
  await wait(80);
  return win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const host = document.getElementById('agentView');
    const layout = document.querySelector('.agent-layout');
    const main = document.querySelector('.agent-main');
    const answer = document.querySelector('.agent-answer');
    const bubble = document.querySelector('.smoke-long-bubble');
    const heading = document.querySelector('.agent-answer h1');
    const code = document.querySelector('.agent-answer .code-block');
    const rect = (node) => node ? ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }) : null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    const bounds = [host, layout, main, answer, bubble, heading, code].filter(Boolean).map(rect);
    const rightmost = Math.max(...bounds.map((item) => item.right));
    const failures = [];
    if (viewport.width > ${testCase.width} + 2 || viewport.width < ${testCase.width} - 40) failures.push('window did not reach requested width');
    if (overflow > 1) failures.push('document horizontal overflow ' + overflow);
    if (rightmost > viewport.width + 1) failures.push('content exceeds viewport by ' + (rightmost - viewport.width));
    if (!heading || heading.getBoundingClientRect().height <= 20) failures.push('heading did not retain a readable box');
    if (!bubble || bubble.getBoundingClientRect().height <= 20) failures.push('bubble did not retain a readable box');
    if (!code || code.getBoundingClientRect().width <= 0) failures.push('code block is missing or collapsed');
    const compact = ${testCase.width} <= 900;
    const overflowNow = () => Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    const hostRect = host.getBoundingClientRect();
    const layoutRect = layout.getBoundingClientRect();
    const expectedGutter = ${testCase.width} <= 640 ? 12 : 16;
    if (Math.abs(layoutRect.left - hostRect.left - expectedGutter) > 1 || Math.abs(hostRect.right - layoutRect.right - expectedGutter) > 1) failures.push('agent layout gutter is not stable');
    if (compact) {
      const tabs = [...document.querySelectorAll('.agent-expand-tab')];
      if (layout.dataset.sidebarMode !== 'compact') failures.push('compact layout marker is missing');
      if (tabs.length !== 2) failures.push('compact layout does not expose exactly two bookmarks');
      if (document.querySelector('.agent-projects, .agent-sessions')) failures.push('compact layout renders a sidebar before opening');
      if (tabs.some((tab) => getComputedStyle(tab).writingMode !== 'vertical-lr')) failures.push('bookmark is not vertical');
      const projectTab = document.querySelector('.proj-tab');
      if (projectTab) projectTab.click();
      const drawer = layout.querySelector('.smoke-drawer');
      const drawerButton = drawer && drawer.querySelector('.btn-ghost.mini');
      if (!drawer) failures.push('bookmark did not open a drawer');
      if (drawerButton && (getComputedStyle(drawerButton).writingMode !== 'horizontal-tb' || getComputedStyle(drawerButton).whiteSpace !== 'nowrap')) failures.push('drawer action button is not horizontal');
      if (drawer && drawer.getBoundingClientRect().right > window.innerWidth + 1) failures.push('drawer exceeds viewport');
      if (overflowNow() > 1) failures.push('drawer introduces horizontal overflow ' + overflowNow());
      const close = drawer && drawer.querySelector('.agent-collapse-btn');
      if (close) close.click();
      if (layout.querySelector('.smoke-drawer')) failures.push('drawer did not close');
    } else {
      const headerButton = document.querySelector('.agent-projects-head .btn-ghost.mini');
      if (headerButton && (getComputedStyle(headerButton).writingMode !== 'horizontal-tb' || getComputedStyle(headerButton).whiteSpace !== 'nowrap')) failures.push('wide layout action button is not horizontal');
    }
    // Account editor regression guard: the model name must retain a usable
    // input box even when the row is wider than a narrow modal.
    if (window.App && App.ui && typeof App.ui.openAccountForm === 'function') {
      try {
        App.ui.openAccountForm('');
        const modelInput = document.querySelector('#accModels .accModelRow');
        const modelRow = document.querySelector('#accModels .model-row');
        const accountForm = document.querySelector('#accountModal .account-form');
        const accountModal = document.querySelector('#accountModal .modal');
        if (!modelInput || modelInput.getBoundingClientRect().width < 150) failures.push('account model name input collapsed');
        if (!modelRow || modelRow.getBoundingClientRect().width < 680) failures.push('account model row lost stable width');
        if (!accountForm || accountForm.scrollWidth < accountForm.clientWidth) failures.push('account model row overflow is not contained by its scroller');
        if (!accountModal || accountModal.getBoundingClientRect().width > Math.min(820, window.innerWidth * .96) + 1) failures.push('account modal exceeds viewport constraint');
        if (${testCase.width} >= 900 && (!accountModal || accountModal.getBoundingClientRect().width < 780)) failures.push('account modal is still too narrow on desktop');
        const outputHeader = document.querySelector('#accountModal .model-row-head .h-output');
        if (!outputHeader) failures.push('account model output header is missing');
        const modelHeader = document.querySelector('#accountModal .model-row-head .h-name');
        if (modelHeader && modelInput && Math.abs(modelHeader.getBoundingClientRect().left - modelInput.getBoundingClientRect().left) > 1) failures.push('account model name header is not aligned');
        const close = document.getElementById('accountModalClose');
        if (close) close.click();
      } catch (error) {
        failures.push('account editor smoke failed: ' + (error && error.message ? error.message : String(error)));
      }
    }
    return { viewport, overflow, bounds, failures };
  })()`, true);
}

async function captureFailure(win, dir, testCase) {
  const image = await win.capturePage();
  const filePath = path.join(dir, `ui-${testCase.name}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
}

async function main() {
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-ui-'));
  const failureDir = path.join(tempUserData, 'screenshots');
  fs.mkdirSync(failureDir, { recursive: true });
  app.setPath('userData', tempUserData);
  app.commandLine.appendSwitch('disable-gpu');

  let win;
  const windows = [];
  try {
    console.error('[check:ui] starting Electron');
    await withTimeout(app.whenReady(), 'Electron startup', 10000);
    const failures = [];
    for (const testCase of CASES) {
      win = new BrowserWindow({
        show: false,
        width: testCase.width,
        height: testCase.height,
        webPreferences: { contextIsolation: false, sandbox: false },
      });
      windows.push(win);
      console.error('[check:ui] loading ' + testCase.name);
      await withTimeout(win.loadFile(path.join(ROOT, 'index.html')), 'renderer load ' + testCase.name, 15000);
      await waitForRenderer(win);
      const realResult = await inspectRealRenderer(win, testCase);
      await installFixture(win);
      const result = await inspect(win, testCase);
      result.failures = (realResult.failures || []).concat(result.failures || []);
      if (result.failures.length) {
        const screenshot = await captureFailure(win, failureDir, testCase);
        failures.push({ case: testCase.name, result, screenshot });
      }
    }
    if (failures.length) throw new Error('UI smoke failed:\n' + JSON.stringify(failures, null, 2));
    console.log(JSON.stringify({ ok: true, cases: CASES.map((item) => item.name) }, null, 2));
  } finally {
    for (const candidate of windows) if (candidate && !candidate.isDestroyed()) candidate.destroy();
    if (app.isReady()) app.quit();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[check:ui] ' + (error && error.stack ? error.stack : error));
    if (app.isReady()) app.exit(1);
    else process.exitCode = 1;
  });
}

module.exports = { CASES, inspect, installFixture, main };
