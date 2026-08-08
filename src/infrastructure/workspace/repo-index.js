'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA_VERSION = 1;
const memory = new Map();
const SOURCE_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|c|cpp|h|hpp|cs|vue)$/i;
const SKIP_RE = /(^|\/)(?:node_modules|\.git|dist|build|coverage|__pycache__)(\/|$)/;
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalize(rel) { return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function cacheFile(root, cacheDir) { const dir = cacheDir || path.join(os.tmpdir(), 'tangbao-repo-index'); return path.join(dir, sha(path.resolve(root)).slice(0, 24) + '.json'); }
function listFiles(root) {
  let files = [];
  try { files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); } catch (_) {}
  if (files.length) return Array.from(new Set(files.map(normalize))).filter((f) => !SKIP_RE.test(f));
  const walk = (dir, depth) => { if (depth > 8) return; let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch (_) { return; } for (const entry of entries) { const full=path.join(dir,entry.name); const rel=normalize(path.relative(root,full)); if(SKIP_RE.test(rel))continue; if(entry.isDirectory())walk(full,depth+1); else files.push(rel); } };
  walk(root,0); return files;
}
function fileRecord(root, rel, previous) {
  const file=path.join(root,rel); let stat; try { stat=fs.statSync(file); } catch (_) { return null; }
  if(previous && previous.size===stat.size && previous.mtimeMs===stat.mtimeMs) return Object.assign({},previous,{reused:true});
  let buffer; try { buffer=fs.readFileSync(file); } catch (_) { return null; }
  const record={path:rel,size:stat.size,mtimeMs:stat.mtimeMs,hash:sha(buffer),ext:path.extname(rel).toLowerCase()||'(none)',lines:buffer.length?buffer.toString('utf8').split('\n').length:0,symbols:[],imports:[],reused:false};
  if(SOURCE_RE.test(rel) && buffer.length<=2*1024*1024) {
    const text=buffer.toString('utf8'), lines=text.split('\n');
    const symbol=/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
    const imp=/(?:from\s+|require\s*\(|import\s*\()['"]([^'"]+)['"]/g;
    for(let i=0;i<Math.min(lines.length,5000);i++){const m=symbol.exec(lines[i]);if(m)record.symbols.push({name:m[1]||m[2]||m[3],line:i+1,kind:m[1]?'function':(m[2]?'class':'variable')});}
    let match; while((match=imp.exec(text)) && record.imports.length<200) record.imports.push(match[1]);
  }
  return record;
}
function readCache(file) { try { const value=JSON.parse(fs.readFileSync(file,'utf8')); return value&&value.schemaVersion===SCHEMA_VERSION?value:null; } catch (_) { return null; } }
function writeCache(file,value){try{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);return true;}catch(_){return false;}}
function packageInfo(root){let scripts={};try{scripts=(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts)||{};}catch(_){} const managers=[]; if(fs.existsSync(path.join(root,'pnpm-lock.yaml')))managers.push('pnpm'); else if(fs.existsSync(path.join(root,'yarn.lock')))managers.push('yarn'); else if(fs.existsSync(path.join(root,'package-lock.json')))managers.push('npm'); return {scripts,packageManagers:managers};}
function build(root,options){
  const abs=path.resolve(root), opts=options||{}, file=cacheFile(abs,opts.cacheDir), disk=readCache(file), previous=new Map(((disk&&disk.files)||[]).map((x)=>[x.path,x]));
  const names=listFiles(abs), records=[]; let reused=0, rebuilt=0;
  for(const rel of names){const rec=fileRecord(abs,rel,previous.get(rel));if(!rec)continue;if(rec.reused)reused++;else rebuilt++;delete rec.reused;records.push(rec);}
  records.sort((a,b)=>a.path.localeCompare(b.path));
  const fingerprint=sha(records.map((x)=>x.path+':'+x.hash).join('\n'));
  const cached=memory.get(abs); if(cached&&cached.repositoryHash===fingerprint)return Object.assign({},cached,{metrics:Object.assign({},cached.metrics,{memoryHit:true})});
  const languages={}; for(const rec of records){if(!languages[rec.ext])languages[rec.ext]={ext:rec.ext,count:0,size:0};languages[rec.ext].count++;languages[rec.ext].size+=rec.size;}
  const symbols=[]; for(const rec of records)for(const sym of rec.symbols)symbols.push({name:sym.name,line:sym.line,kind:sym.kind,path:rec.path,file:rec.path});
  const pkg=packageInfo(abs); const value={schemaVersion:SCHEMA_VERSION,root:abs,repositoryHash:fingerprint,generatedAt:Date.now(),files:records,languages:Object.values(languages).sort((a,b)=>b.count-a.count),importantFiles:records.slice().sort((a,b)=>b.lines-a.lines).slice(0,50).map((x)=>({path:x.path,lines:x.lines})),scripts:pkg.scripts,packageManagers:pkg.packageManagers,symbols:symbols.slice(0,5000),imports:records.filter((x)=>x.imports.length).map((x)=>({path:x.path,imports:x.imports})),dirtyFiles:[],metrics:{files:records.length,reused,rebuilt,removed:Math.max(0,previous.size-records.length),diskHit:!!disk,memoryHit:false,cacheFile:file}};
  writeCache(file,value); memory.set(abs,value); return value;
}
function symbolMap(index){const out=new Map();for(const sym of (index&&index.symbols)||[]){if(!out.has(sym.name))out.set(sym.name,[]);out.get(sym.name).push({path:sym.path,line:sym.line,kind:sym.kind});}return out;}
function invalidate(root,paths){const abs=path.resolve(root);memory.delete(abs);if(!paths||!paths.length)return;const file=cacheFile(abs);const disk=readCache(file);if(!disk)return;const targets=new Set(paths.map(normalize));disk.files=(disk.files||[]).filter((x)=>!targets.has(x.path));writeCache(file,disk);}
function createReadCache(){const entries=new Map();return{check(fileHash,start,end,reason){const key=fileHash+'|'+String(reason||'');const ranges=entries.get(key)||[];return ranges.some((r)=>r.start<=start&&r.end>=end);},record(fileHash,start,end,reason){const key=fileHash+'|'+String(reason||'');const ranges=entries.get(key)||[];ranges.push({start,end});ranges.sort((a,b)=>a.start-b.start);entries.set(key,ranges);},snapshot(){return Array.from(entries.entries());}};}
function resetMemory(){memory.clear();}
module.exports={SCHEMA_VERSION,build,symbolMap,invalidate,createReadCache,resetMemory,cacheFile};
