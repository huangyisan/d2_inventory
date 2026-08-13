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

/* --- cube planner ---------------------------------------------------- */
{
  vm.runInContext(`
    globalThis.__cube = function (rep) {
      report = rep;
      const out = { views: 0, inv: {}, plans: {} };
      // No target picked yet: it must render its own prompt, not blow up.
      state.tab = 'cube'; state.target = null;
      renderView();
      if (!($('#view').innerHTML || '').length) throw new Error('empty basket view');
      for (const code of RUNES) {
        state.tab = 'cube'; state.target = code; state.qty = 1;
        if (!renderView() && !($("#view").innerHTML || "").length) throw new Error('empty ' + code);
        out.views++;
        const pool = {}; for (const c of MATERIALS) pool[c] = (report.materials[c] || []).length;
        const t = plan(code, 1, pool, false);
        out.plans[code] = { short: t.ok ? 0 : 1, ...planTotals(t) };
      }
      for (const c of MATERIALS) {
        const n = (report.materials[c] || []).reduce((t, x) => t + (x.n || 1), 0);
        if (n) out.inv[matZh(c)] = n;
      }
      out.counts = { runes: report.summary.runeCount, gems: report.summary.gemCount,
                     pul: (report.materials.r21 || []).reduce((t, x) => t + (x.n || 1), 0) };
      // Asking for more than the material allows must clamp, not explode.
      state.target = 'r22'; state.qty = 99;
      renderView();
      out.basketLen = ($('#view').innerHTML || '').length;
      out.clamped = ($('#view').innerHTML || '').includes('可以合 3 个');
      // At the ceiling "+" must be off and the material that runs out marked red.
      out.plusOffAtMax = /data-plus="1"\\s+disabled/.test($('#view').innerHTML || '');
      out.redAtMax = ($('#view').innerHTML || '').includes('srow zero short') ||
                     ($('#view').innerHTML || '').includes('short">差');
      state.target = 'r22'; state.qty = 1; renderView();
      const one = $('#view').innerHTML || '';
      out.plusOnBelowMax = /data-plus="1"\\s+title/.test(one);
      // One Um spends two of the six Pul: blue "−2" and a remaining count of 4.
      out.spendShown = one.includes('−2</span><span class="scnt use">4</span>');
      state.target = null; state.qty = 1;
      return out;
    };
  `, ctx);
  const cube = ctx.__cube(report);
  if (!cube.basketLen) { console.error('✗ 目标视图渲染为空'); ok = false; }
  if (!cube.clamped) { console.error('✗ 数量没有被材料上限夹住（乌姆应为 3 个）'); ok = false; }
  if (!cube.plusOffAtMax) { console.error('✗ 到上限时「+」没有禁用'); ok = false; }
  if (!cube.redAtMax) { console.error('✗ 到上限时缺的材料没有标红'); ok = false; }
  if (!cube.plusOnBelowMax) { console.error('✗ 未到上限时「+」被误禁用'); ok = false; }
  if (!cube.spendShown) { console.error('✗ 消耗后的剩余数量没有显示（普尔 6 −2 → 4）'); ok = false; }
  console.log('✓ 扣减显示与「+」上限：普尔 6 −2 → 4，到顶禁用并标红');
  console.log(`✓ 合成视图：${cube.views} 个符文目标全部渲染 + 求解无异常`);
  console.log(`  当前材料：符文 ${cube.counts.runes} 个 · 宝石 ${cube.counts.gems} 颗`);
  // The auto-sorting stash tabs stack: one entry can be six runes. Counting
  // entries instead of stack sizes used to report a single Pul here.
  if (cube.counts.pul !== 6) { console.error(`✗ 普尔应为 6 个（堆叠），实际 ${cube.counts.pul}`); ok = false; }
  if (cube.counts.runes !== 513 || cube.counts.gems !== 1064) {
    console.error(`✗ 符文/宝石总数不符: ${cube.counts.runes}/${cube.counts.gems}`); ok = false;
  }

  // Asking to make a rune must never be answered with "here, take the one you
  // already own" — the target is always cubed from its ingredients.
  for (const [code, p] of Object.entries(cube.plans)) {
    if (p.consumed[code]) { console.error(`✗ ${code}: 目标符文自己被当成材料消耗了`); ok = false; }
  }
  // El is the bottom of the ladder: 3 El make an Eld, so needing one Eld with an
  // empty pool must report exactly 3 missing El.
  const empty = ctx.plan('r02', 1, {}, false);
  const em = ctx.planTotals(empty).missing;
  if (em.r01 !== 3 || Object.keys(em).length !== 1) { console.error(`✗ 空库存合成 Eld 的缺口不对: ${JSON.stringify(em)}`); ok = false; }
  // Lo (28) with nothing at all: dead branches collapse, so the answer is the
  // direct recipe (2 Ohm + 1 diamond), not billions of El runes.
  const lo = ctx.planTotals(ctx.plan('r28', 1, {}, false)).missing;
  if (lo.r27 !== 2 || lo.gsw !== 1 || Object.keys(lo).length !== 2) {
    console.error(`✗ 空库存合成 Lo 的缺口不对: ${JSON.stringify(lo)}`); ok = false;
  }
  console.log(`  空库存造 28 号（罗）直接缺：欧姆 ×${lo.r27}、钻石 ×${lo.gsw}`);

  // Feeding a plan exactly what it asked for must make it succeed...
  const fed = ctx.planTotals(ctx.plan('r28', 1, { ...lo }, false));
  if (Object.keys(fed.missing).length) { console.error('✗ 按缺口补齐材料后仍然合成不了 Lo'); ok = false; }
  // ...and one item short must still report a gap.
  const short = ctx.planTotals(ctx.plan('r28', 1, { ...lo, r27: 1 }, false)).missing;
  if (!Object.keys(short).length) { console.error('✗ 少一个欧姆时没有报缺'); ok = false; }
  console.log('✓ 合成求解自洽：按缺口补齐即可成，少一件即报缺');

  // "最多能凑出几个" must agree with plan(): N works, N+1 does not.
  vm.runInContext(`
    globalThis.__max = function (code) {
      const pool = {};
      for (const c of MATERIALS) pool[c] = (report.materials[c] || []).reduce((t, x) => t + (x.n || 1), 0);
      const max = maxMakeable(code, pool);
      return { max, atMax: plan(code, max, { ...pool }, false).ok,
               over: plan(code, max + 1, { ...pool }, false).ok };
    };
  `, ctx);
  for (const code of ['r22', 'r25', 'r21', 'r30']) {
    const m = ctx.__max(code);
    if (!m.atMax || m.over) { console.error(`✗ ${code} 的上限不自洽: ${JSON.stringify(m)}`); ok = false; }
  }
  const g = ctx.__max('r25');
  if (g.max !== 1) { console.error(`✗ 古尔最多应为 1 个，实际 ${g.max}`); ok = false; }
  // Owning two Ist must not be mistaken for "two Ist are already made".
  const ist = ctx.__max('r24');
  if (ist.max !== 1) { console.error(`✗ 伊司特最多应为 1 个（不算仓库现货），实际 ${ist.max}`); ok = false; }
  console.log(`✓ 上限自洽：古尔最多 ${g.max} 个、乌姆最多 ${ctx.__max('r22').max} 个（多一个即不成立）`);
}

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
