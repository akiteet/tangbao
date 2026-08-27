#!/usr/bin/env node
'use strict';
/*
 * trim-icon —— 图标修边常驻工具（v1.2.0 外观优化，2026-08-26）。
 * 对圆形徽章类源图做：内容紧裁剪（留 2% 呼吸边）→ 四角不透明白时施加圆外羽化透明遮罩
 * → 双线性缩放到标准尺寸 → 输出 logo.png / app-icon.png（512）与多尺寸 app-icon.ico。
 * 用法：node scripts/trim-icon.js [源图路径]（默认 assets/logo.png）
 * 后续扁平化新素材到位后重跑本脚本即可完成整套换装。
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { imagesToIco: pngToIco } = require('png-to-ico');

const SRC = process.argv[2] || path.join('assets', 'logo.png');
const OUT_SIZE = 512;
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const MARGIN_RATIO = 0.02; // 裁剪后四周保留的呼吸边（相对短边）
const FEATHER = 10;        // 圆外遮罩的羽化像素

function isWhiteish(r, g, b, a) { return a === 255 && r > 245 && g > 245 && b > 245; }

function contentBBox(png) {
  const { width: w, height: h, data } = png;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 8 && !isWhiteish(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('源图没有可识别内容');
  return { minX, minY, maxX, maxY };
}

function crop(png, bbox) {
  const margin = Math.round(Math.min(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * MARGIN_RATIO);
  const x0 = Math.max(0, bbox.minX - margin);
  const y0 = Math.max(0, bbox.minY - margin);
  const x1 = Math.min(png.width - 1, bbox.maxX + margin);
  const y1 = Math.min(png.height - 1, bbox.maxY + margin);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x0, y0, w, h, 0, 0);
  return out;
}

function cornersOpaqueWhite(png) {
  const { width: w, height: h, data } = png;
  const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  return pts.every(([x, y]) => {
    const i = (y * w + x) * 4;
    return isWhiteish(data[i], data[i + 1], data[i + 2], data[i + 3]);
  });
}

// 圆外羽化透明：中心=裁剪区中心，半径=短边/2，边缘 FEATHER 像素线性过渡
function applyCircularFeather(png) {
  const { width: w, height: h, data } = png;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const radius = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= radius - FEATHER) continue;
      const k = Math.min(1, Math.max(0, (radius - dist) / FEATHER));
      const i = (y * w + x) * 4;
      data[i + 3] = Math.round(data[i + 3] * k);
    }
  }
}

// 双线性缩放
function resize(png, tw, th) {
  const { width: w, height: h, data } = png;
  const out = new PNG({ width: tw, height: th });
  for (let y = 0; y < th; y++) {
    const fy = (y + 0.5) * h / th - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = (x + 0.5) * w / tw - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * tw + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = data[i00 + ch] * (1 - wx) + data[i01 + ch] * wx;
        const bot = data[i10 + ch] * (1 - wx) + data[i11 + ch] * wx;
        out.data[o + ch] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}

(async () => {
  const src = PNG.sync.read(fs.readFileSync(SRC));
  console.log('[trim-icon] 源图:', src.width + 'x' + src.height);
  const bbox = contentBBox(src);
  let cropped = crop(src, bbox);
  console.log('[trim-icon] 裁剪后:', cropped.width + 'x' + cropped.height, '圆外遮罩:', cornersOpaqueWhite(cropped) ? '施加（四角不透明白）' : '跳过（已有透明）');
  if (cornersOpaqueWhite(cropped)) applyCircularFeather(cropped);
  const out512 = resize(cropped, OUT_SIZE, OUT_SIZE);
  fs.writeFileSync(path.join('assets', 'logo.png'), PNG.sync.write(out512));
  fs.writeFileSync(path.join('assets', 'app-icon.png'), PNG.sync.write(out512));
  // png-to-ico v3：imagesToIco 接收 pngjs 解码对象数组（内部直接读 width/height/data 合成 DIB）
  const icoImages = ICO_SIZES.map((size) => resize(out512, size, size));
  const ico = await pngToIco(icoImages);
  fs.writeFileSync(path.join('assets', 'app-icon.ico'), ico);
  console.log('[trim-icon] 已输出 assets/logo.png、assets/app-icon.png（512）与 assets/app-icon.ico（' + ICO_SIZES.join('/') + '）');
})().catch((e) => { console.error('[trim-icon] 失败:', e.message); process.exit(1); });
