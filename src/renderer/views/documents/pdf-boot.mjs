// PDF.js 引导脚本（从 index.html 内联脚本外提，以满足 CSP 的 script-src 'self'）
// 相对本文件（js/）定位 vendor 中的 PDF.js ESM 构建
import * as pdfjsLib from '../../../../vendor/pdfjs/pdf.min.mjs';
window.pdfjsLib = pdfjsLib;
window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../../../../vendor/pdfjs/pdf.worker.min.mjs';
