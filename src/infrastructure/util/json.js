'use strict';
/*
 * JSON 文件读取共享实现（v1.1.5 批次 C2 收敛）。
 * 统一「读不到 / 解析失败 → null」的容错语义；此前四处各自实现（legacy-context、
 * tangguan-store、embedding-index、keyword-index），语义相同但写法漂移。
 * 注意：各文件的 writeAtomic/writeJsonAtomic 保持原位——它们的序列化格式
 * （缩进与否）与文件哈希校验耦合，不做合并。
 */
const fs = require('fs');

function readJson(filePath) {
  try {
    if (!filePath) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = { readJson };
