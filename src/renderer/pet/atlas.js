'use strict';
/* v1.2.1 批次 12：精灵图契约（行序对齐常见桌宠精灵图规范）。
 * 默认规格：宽 1536px，每格 192x208，每行 8 格；行 = 动画状态（顺序固定）：
 * idle / running-right / running-left / waving / jumping / failed / waiting / running / review。
 * 第十轮放宽：格子规格与列数可由 meta.json 的 cellWidth / cellHeight / cols 声明（任意尺寸的横向排帧精灵图），
 * makeAtlasTexture(texture, grid) / trimTrailingBlankFrames(url, atlas, grid) 按 grid 切分。
 * makeAtlasTexture 从一张已加载的 webp/png Texture 切出每行每格共用的 frame Texture。 */
import { Texture, Rectangle } from '../../../vendor/pixi.min.mjs';

export const ATLAS_CELL_W = 192;
export const ATLAS_CELL_H = 208;
export const ATLAS_COLS = 8;

export const STATE_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
];

export function makeAtlasTexture(texture, grid) {
  const cellW = (grid && grid.cellW) || ATLAS_CELL_W;
  const cellH = (grid && grid.cellH) || ATLAS_CELL_H;
  const cols = (grid && grid.cols) || ATLAS_COLS;
  const texW = texture && texture.width ? texture.width : 0;
  const texH = texture && texture.height ? texture.height : 0;
  const rows = Math.floor(texH / cellH);
  const usableCols = Math.min(cols, Math.floor(texW / cellW));
  const out = {};
  for (let row = 0; row < STATE_ROWS.length; row++) {
    const frames = [];
    if (row < rows) {
      for (let col = 0; col < usableCols; col++) {
        frames.push(new Texture({
          source: texture.source,
          frame: new Rectangle(col * cellW, row * cellH, cellW, cellH),
        }));
      }
    }
    out[STATE_ROWS[row]] = frames;
  }
  return out;
}

// v1.2.1 第八轮：裁掉每行末尾的空白补位帧。每行固定列数，动画不足时尾部是空白格——
// 精灵轮播进空格 = 桌宠周期性整体消失 = 用户看到的「常驻闪烁」。
// 用 2D canvas 逐格测 alpha（同源图不污染画布）；检测失败时保持原帧数，不阻塞加载。
export async function trimTrailingBlankFrames(url, atlas, grid) {
  try {
    const cellW = (grid && grid.cellW) || ATLAS_CELL_W;
    const cellH = (grid && grid.cellH) || ATLAS_CELL_H;
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return atlas;
    const trimmed = [];
    for (const name of Object.keys(atlas)) {
      const frames = atlas[name];
      const row = STATE_ROWS.indexOf(name);
      if (row < 0 || !frames.length) continue;
      let cut = 0;
      while (frames.length > 1) {
        const col = frames.length - 1;
        ctx.clearRect(0, 0, cellW, cellH);
        ctx.drawImage(img, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
        const data = ctx.getImageData(0, 0, cellW, cellH).data;
        let opaque = false;
        for (let i = 3; i < data.length; i += 4) { if (data[i] > 8) { opaque = true; break; } }
        if (opaque) break;
        frames.pop();
        cut++;
      }
      if (cut) trimmed.push(name + ':' + (frames.length + cut) + '→' + frames.length);
    }
    if (trimmed.length) console.log('[pet] 裁剪空白补位帧', trimmed.join(', '));
  } catch (_) { /* 检测失败时保持原帧数 */ }
  return atlas;
}

// 校验精灵图是否符合 Atlas 契约（导入校验复用主进程 imageDimensions，此处为渲染层兜底）
export function validateAtlas(dim) {
  return !!(dim && dim.width === 1536 && dim.height % ATLAS_CELL_H === 0);
}
