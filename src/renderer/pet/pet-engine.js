'use strict';
/* v1.2.1 批次 12：宠物精灵——基于 PixiJS 的帧动画容器（PetBrain 状态机）。
 * 持有 Sprite（锚点底部居中，支持朝向翻转）与影子；update(dtMs) 按状态播放帧。
 * playOnce 播完一整轮后自动回到前一个状态/idle。 */
import { Container, Sprite, Graphics } from '../../../vendor/pixi.min.mjs';

export class PetSprite extends Container {
  constructor(atlas, opts) {
    super();
    this.atlas = atlas || {};
    this.scaleValue = (opts && typeof opts.scale === 'number') ? opts.scale : 1;
    this.speed = (opts && typeof opts.speed === 'number') ? opts.speed : 7; // 帧/秒
    this.cellW = (opts && opts.cellW) || 192; // 第十轮：格子尺寸可由 meta.json 声明
    this.cellH = (opts && opts.cellH) || 208;
    this.direction = 1; // 1=右 -1=左
    this.state = 'idle';
    this.frame = 0;
    this._acc = 0;
    this._playOnce = null;

    const first = (atlas && atlas.idle && atlas.idle[0]) || null;
    this.sprite = new Sprite(first);
    this.sprite.anchor.set(0.5, 1); // 底部居中，站立点
    this.addChild(this.sprite);

    this.shadow = new Graphics();
    this.addChild(this.shadow);
    this.setScale(this.scaleValue);
  }

  setScale(s) {
    const v = Math.min(2.5, Math.max(0.4, Number.isFinite(s) ? s : 1));
    this.scaleValue = v;
    this.sprite.scale.set(v * this.direction, v);
    this.shadow.clear();
    const w = 56 * v;
    this.shadow.beginFill(0x000000, 0.18);
    this.shadow.drawEllipse(0, 2, w / 2, w / 5);
    this.shadow.endFill();
  }

  setState(name) {
    const frames = this.atlas[name];
    if (!frames || !frames.length) return;
    if (this.state === name) { this.frame = 0; this._acc = 0; return; }
    this.state = name;
    this.frame = 0;
    this._acc = 0;
  }

  setDirection(dir) {
    const d = dir >= 0 ? 1 : -1;
    if (d === this.direction) return;
    this.direction = d;
    this.sprite.scale.x = this.scaleValue * d;
  }

  // 强制按当前朝向应用翻转（专用方向行切回通用行时调用，setDirection 同值会早退）
  faceDirection() {
    this.sprite.scale.x = this.scaleValue * this.direction;
  }

  // 第十轮：方向性专用行优先——atlas 同时含 '<base>-right'/'<base>-left' 时直接用对应行。
  // 【素材本身带朝向，绝不能再按方向镜像】——否则左拖时左向行被翻成朝右（第十轮用户实测 bug）。
  // atlas 缺专用行时才回退 '<base>' 行 + 按方向翻转。同目标状态不重置动画帧。
  playDirectional(base, dir) {
    const d = dir >= 0 ? 1 : -1;
    this.direction = d;
    const rightRow = this.atlas[base + '-right'];
    const leftRow = this.atlas[base + '-left'];
    if (rightRow && rightRow.length && leftRow && leftRow.length) {
      this.sprite.scale.x = this.scaleValue; // 不翻转：朝向由专用行素材自己表达
      const target = d > 0 ? base + '-right' : base + '-left';
      if (this.state !== target) this.setState(target);
      return;
    }
    this.faceDirection();
    if (this.state !== base) this.setState(base);
  }

  // 播放一次性状态（如 jumping/waving），播完一整轮后回到 prev 或 idle
  playOnce(name, { onDone } = {}) {
    const frames = this.atlas[name];
    if (!frames || !frames.length) { if (onDone) { try { onDone(); } catch (_) {} } return; }
    this._playOnce = { name, prev: this.state, shown: 0, total: frames.length, onDone };
    this.setState(name);
  }

  update(dtMs) {
    const frames = this.atlas[this.state] || [];
    if (!frames.length) return false;
    const step = 1000 / this.speed;
    this._acc += dtMs;
    let advanced = false;
    while (this._acc >= step) {
      this._acc -= step;
      this.frame = (this.frame + 1) % frames.length;
      advanced = true;
    }
    if (advanced && this.sprite.texture !== frames[this.frame]) this.sprite.texture = frames[this.frame];

    const po = this._playOnce;
    if (po && this.state === po.name) {
      if (advanced) po.shown++;
      if (po.shown >= po.total) {
        this._playOnce = null;
        this.setState(this.atlas[po.prev] && po.prev !== po.name ? po.prev : 'idle');
        if (po.onDone) { try { po.onDone(); } catch (_) {} }
      }
    }
    return advanced; // 换帧 dirty 标志（渲染按需化：未换帧无需重绘）
  }

  // 命中包围盒（交互/点击穿透判定；本地原点 = 底部中心）。margin>0 时四边内缩（防 hover 边界反复切换）
  hitTest(localX, localY, margin) {
    const m = Number.isFinite(margin) && margin > 0 ? margin : 0;
    const v = this.scaleValue;
    const w = this.cellW * v;
    const h = this.cellH * v;
    return Math.abs(localX) <= w / 2 - m && localY <= -m && localY >= -(h - m);
  }
}
