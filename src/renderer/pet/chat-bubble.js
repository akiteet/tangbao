'use strict';
/* v1.2.1 批次 12：聊天气泡——DOM 叠加在宠物上方，带打字机效果。 */
export class ChatBubble {
  constructor(rootEl) {
    this.root = rootEl;
    this.el = null;
    this._timer = null;
    this._typing = null;
  }

  _ensure() {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'pet-bubble';
      this.root.appendChild(this.el);
    }
    return this.el;
  }

  show(text, { duration = 3600 } = {}) {
    const el = this._ensure();
    el.textContent = '';
    el.classList.add('show');
    if (this._typing) clearInterval(this._typing);
    const full = String(text || '');
    let i = 0;
    this._typing = setInterval(() => {
      i += 1;
      el.textContent = full.slice(0, i);
      if (i >= full.length) {
        clearInterval(this._typing);
        this._typing = null;
      }
    }, 24);
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.hide(), duration);
  }

  hide() {
    if (this._typing) { clearInterval(this._typing); this._typing = null; }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.el) this.el.classList.remove('show');
  }

  destroy() {
    this.hide();
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}
