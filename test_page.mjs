/*
 * Load the bundled HTML the way a browser would and check it actually runs:
 * the module-stripped parser must still work, and the in-page aggregation must
 * reproduce the Python reference numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, '暗黑2收藏台账.html'), 'utf8');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 3) throw new Error(`expected 3 inline scripts, got ${scripts.length}`);

/* --- minimal DOM stub ------------------------------------------------ */
const listeners = [];
const el = () => new Proxy({
  addEventListener: (t, f) => listeners.push([t, f]),
  innerHTML: '', textContent: '', hidden: false, disabled: false, value: '',
  classList: { add() {}, remove() {} }, click() {}, dataset: {},
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => (t[k] = v, true) });

const selectors = new Map();
const document = {
  querySelector(s) {
    if (!selectors.has(s)) selectors.set(s, el());
    return selectors.get(s);
  },
  addEventListener: (t, f) => listeners.push([t, f]),
  createElement: () => el(),
  documentElement: {},
  body: { appendChild() {} },
};
const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, innerWidth: 1200, innerHeight: 900 },  // no showDirectoryPicker -> fallback branch
  indexedDB: { open: () => ({ }) },
  navigator: { userAgent: 'node' },
  console,
  Blob, TextEncoder, URL,
  Date, Math, JSON, Map, Set, Proxy, Intl, Object, Array,
  setTimeout, clearTimeout,
});

for (const src of scripts) vm.runInContext(src, ctx);
// Top-level `const` lives in the script-global lexical scope, not on the
// context object, so surface what the test needs explicitly.
vm.runInContext('globalThis.__CAT = CAT; globalThis.__buildReport = buildReport;', ctx);
console.log('✓ 三段脚本均加载无异常（含模块语法剥离后的解析器）');

/* --- run the real parser + the page's own aggregation ---------------- */
const SAVE_DIR = path.join(HERE, 'Diablo_2_Resurrected');
const sources = [];
for (const fn of fs.readdirSync(SAVE_DIR).sort()) {
  if (!/\.(d2s|d2i)$/i.test(fn)) continue;
  const data = new Uint8Array(fs.readFileSync(path.join(SAVE_DIR, fn)));
  const parse = /\.d2s$/i.test(fn) ? ctx.parseCharacter : ctx.parseStash;
  sources.push(parse(data, fn, ctx.__CAT));
}
const report = ctx.__buildReport(sources);
const s = report.summary;

console.log(`✓ 解析 ${s.files} 个存档 · ${s.totalItems} 件物品`);
console.log(`  暗金 ${s.uniqueOwned}/${s.uniqueTotal} (另有特殊 ${s.uniqueExtra})`);
console.log(`  绿装单件 ${s.setOwned}/${s.setTotal} · 集齐套装 ${s.setComplete}/${s.setGroups}`);
console.log(`  重复 ${s.dupeKinds} 种 / ${s.dupeCopies} 件多余`);

let ok = true;
const expected = { files: 15, totalItems: 920, uniqueOwned: 103, uniqueTotal: 396, setOwned: 45, setTotal: 140 };
for (const [k, v] of Object.entries(expected)) {
  if (s[k] !== v) { console.error(`✗ ${k}: 期望 ${v}, 实际 ${s[k]}`); ok = false; }
}

/* --- exercise every view so template errors surface here, not in the browser --- */
vm.runInContext(`
  globalThis.__renderAll = function (rep) {
    report = rep;
    const out = {};
    for (const [tab] of TABS()) {
      state.tab = tab;
      for (const q of ['', '塔拉夏', 'ring', '套装']) {
        state.q = q;
        for (const only of ['all', 'missing', 'have', 'incomplete', 'complete', 'none']) {
          state.only = only;
          for (const slot of [null, '头盔', '戒指']) {
            state.slot = slot;
            for (const srt of ['progress', 'name', 'missing']) { state.sort = srt; renderFilters(); renderView(); }
            renderFilters();
            renderView();
            out[tab] = ($('#view').innerHTML || '').length;
          }
        }
      }
    }
    state.q = ''; state.only = 'all'; state.slot = null;
    renderTop(); renderTabs();
    return out;
  };
`, ctx);

const sizes = ctx.__renderAll(report);
for (const [tab, len] of Object.entries(sizes)) {
  if (!len) { console.error(`✗ 视图 ${tab} 渲染为空`); ok = false; }
}
console.log(`✓ ${Object.keys(sizes).length} 个视图 (${Object.keys(sizes).join('/')}) × 搜索/筛选组合渲染均无异常`);

/* --- the backup zip must be a real, extractable archive -------------- */
{
  const entries = [];
  for (const fn of fs.readdirSync(SAVE_DIR).sort()) {
    if (!/\.(d2s|d2i)$/i.test(fn)) continue;
    entries.push({ name: `备份/${fn}`, data: new Uint8Array(fs.readFileSync(path.join(SAVE_DIR, fn))) });
  }
  const blob = ctx.makeZip(entries, new Date());
  const zipPath = path.join(HERE, '.backup-test.zip');
  fs.writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));
  const { execFileSync } = await import('node:child_process');
  try {
    // Python's zipfile honours the UTF-8 name flag; macOS Info-ZIP does not,
    // and these archives carry Chinese character names.
    const py = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad,
                  "files": {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', py, zipPath], { encoding: 'utf8' }));
    if (out.bad) { console.error(`✗ 备份 zip CRC 校验失败: ${out.bad}`); ok = false; }
    const { createHash } = await import('node:crypto');
    for (const e of entries) {
      const want = createHash('sha256').update(Buffer.from(e.data)).digest('hex');
      if (out.files[e.name] !== want) { console.error(`✗ 备份内容不一致: ${e.name}`); ok = false; }
    }
    if (Object.keys(out.files).length !== entries.length) { console.error('✗ 备份文件数量不符'); ok = false; }
    console.log(`✓ 备份 zip 校验通过：${entries.length} 个文件，CRC 与内容逐字节一致`);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

const warned = report.sources.filter(x => x.error || x.warnings.length);
if (warned.length) {
  ok = false;
  warned.forEach(w => console.error(`✗ ${w.name}: ${w.error || w.warnings.join('；')}`));
}

console.log(ok ? '\n*** 打包页面校验通过：与 Python 参考实现数字一致，无解析告警 ***'
               : '\n!!! 校验未通过');
process.exit(ok ? 0 : 1);
