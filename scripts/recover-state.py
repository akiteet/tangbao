#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
糖包 v1.1.6+ 数据恢复脚本 v2（state.json + SQLite 双写，治愈"state.json 被覆盖成不完整"事故）

v2 相对 v1 的增强：
  1. 同时写回 SQLite（kv_meta.customModules / image_files 引用），让 SQLite fallback 完整——
     即使 state.json 再次被覆盖，loadState 的恢复机制也能从 SQLite 自动治愈（不再自锁）。
  2. 糖绘历史 files 引用修复：坏状态覆盖会清掉 ih 记录的 files 字段（图片文件仍在
     tangbao-data/images/），本脚本按映射恢复引用，并把文件复制到 files/images/ 供 SQLite readState 回读。

用法（Windows，Python 走 py 启动器）：
    py -V:Astral/CPython3.12.13 scripts/recover-state.py

写入前会把 state.json 备份为 state.json.pre-recovery-<ts>.json。
注意：执行前必须确保糖包应用已完全退出（否则应用内存旧快照会在关闭时覆盖恢复结果）。
"""
import sqlite3
import json
import os
import shutil
import datetime
import time

DATA = 'D:/tangbao_web/tangbao-data'
LIVE = DATA + '/state.json'
BACKUP = 'C:/Users/18860/AppData/Roaming/tangbao-web/tangbao-data.backup/state.json'
DB = DATA + '/tangbao.db'
IMG_DIR = DATA + '/images'
FILES_IMG = DATA + '/files/images'

# 糖绘 files 引用恢复映射（historyId -> 资产文件名；文件已在 tangbao-data/images/）
FILES_MAP = {
    'cmt19o0uwsamq': 'img-mt19o0vt-953d6abe.png',
    'cmt19nn7gtfy3': 'img-mt19nn85-e2e69636.png',
    'cmszyormqnu3f': 'img-mszyorn4-930ccf90.png',
    'cmszi39zim7l9': 'img-mszi3a12-5be5ce8b.png',
    'cmsxcuguwa2be': 'img-msxcugw6-cade1a33.png',
    'cmsxct5p9n3el': 'img-msxct5pz-1c2997f3.png',
    'cmsxcr79i0fff': 'img-msxcr7aa-559adabb.png',
    # 水彩 4 条引用未丢，仅补 SQLite image_files 供 fallback
    'cmstrj5lrdxce': 'img-mt1b8nq7-ba81177e.png',
    'cmst1p7oykska': 'img-mt1b8pac-aa06e2bc.png',
    'cmsmgw2pjri7u': 'img-mt1b8pba-5b1d8018.png',
    'cmslr4592btkj': 'img-mt1b8pob-bf558fe5.png',
}


def merge_arrays(live_arr, backup_arr):
    """按 id 去重合并数组：live 优先，backup 补充。"""
    seen = set()
    out = []
    for item in (live_arr or []) + (backup_arr or []):
        if not item or not item.get('id'):
            continue
        if item['id'] not in seen:
            seen.add(item['id'])
            out.append(item)
    return out


def main():
    with open(LIVE, encoding='utf-8') as f:
        live = json.load(f)
    with open(BACKUP, encoding='utf-8') as f:
        backup = json.load(f)

    # 1) customModules：从 backup 恢复（当前被覆盖成空）
    live['settings']['customModules'] = backup.get('settings', {}).get('customModules') or []

    # 2) projects：当前（默认项目）+ backup 3 真实（按 id 去重；空默认项目不在 backup）
    live['projects'] = merge_arrays(live.get('projects'), backup.get('projects'))

    # 3) 糖绘历史 files 引用恢复（坏状态覆盖清掉了引用，文件仍在 images/）
    restored_refs = 0
    for h in live.get('settings', {}).get('imageHistory', []) or []:
        hid = h.get('id')
        if hid in FILES_MAP and not (h.get('files') and len(h.get('files'))):
            h['files'] = [FILES_MAP[hid]]
            restored_refs += 1

    # 4) settings 补齐 backup 独有键（外观/折叠等）
    bs = backup.get('settings') or {}
    for k in ['docSidebarCollapsed', 'agentThinkLevel']:
        if k in bs and k not in live['settings']:
            live['settings'][k] = bs[k]

    # 5) 备份 + 写 state.json
    ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')
    bak_path = LIVE + '.pre-recovery-' + ts + '.json'
    shutil.copy2(LIVE, bak_path)
    print('backed up to:', bak_path)
    with open(LIVE, 'w', encoding='utf-8') as f:
        json.dump(live, f, ensure_ascii=False, indent=2)

    # 6) SQLite 双写：kv_meta.customModules + image_files 引用 + 复制资产文件到 files/images/
    try:
        db = sqlite3.connect(DB, timeout=10)
        cur = db.cursor()
        cur.execute(
            "INSERT OR REPLACE INTO kv_meta (key,value) VALUES ('customModules',?)",
            (json.dumps(live['settings'].get('customModules') or [], ensure_ascii=False),),
        )
        now = int(time.time() * 1000)
        copied = 0
        for hid, fname in FILES_MAP.items():
            cur.execute(
                'INSERT OR REPLACE INTO image_files (id,history_id,seq,data,created_at) VALUES (?,?,?,?,?)',
                ('img_' + hid + '_0', hid, 0, fname, now),
            )
            src = os.path.join(IMG_DIR, fname)
            dst = os.path.join(FILES_IMG, fname)
            if os.path.exists(src) and not os.path.exists(dst):
                os.makedirs(FILES_IMG, exist_ok=True)
                shutil.copy2(src, dst)
                copied += 1
        db.commit()
        db.close()
        print('sqlite updated: customModules +', len(FILES_MAP), 'image_files refs, copied', copied, 'files')
    except Exception as e:
        print('sqlite update FAILED (state.json 已恢复，SQLite 未写):', e)

    print('written state.json: conv {} threads {} projects {} customModules {} imageHistory {} docs {} docChat {}'.format(
        len(live.get('conversations') or []), len(live.get('agentThreads') or []), len(live.get('projects') or []),
        len(live['settings'].get('customModules') or []), len(live['settings'].get('imageHistory') or []),
        len(live['settings'].get('docs') or []), 'yes' if live['settings'].get('docChat') else 'no'))
    print('restored ih files refs:', restored_refs)


if __name__ == '__main__':
    main()
