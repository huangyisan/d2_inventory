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
const html = fs.readFileSync(path.join(HERE, '暗黑2工具箱.html'), 'utf8');

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
  // No storage here. Fail the request rather than leave it pending: every
  // caller has a .catch, and a promise that never settles would hang the test.
  indexedDB: { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } },
  navigator: { userAgent: 'node' },
  console,
  Blob, TextEncoder, URL,
  Date, Math, JSON, Map, Set, Proxy, Intl, Object, Array,
  setTimeout, clearTimeout,
  // The terror-zone page re-renders itself on a timer; never let it fire here.
  setInterval: () => 0, clearInterval() {},
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
    state.mode = 'gear';
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
    renderModes(); renderTop(); renderTabs();
    // The rune mode has its own cards and no tab bar.
    state.mode = 'runes'; renderModes(); renderTop(); renderTabs(); renderFilters();
    out.runeCards = ($('#cards').innerHTML || '').includes('手上最高的符文');
    out.noTabs = !($('#tabs').innerHTML || '').length;
    state.mode = 'gear'; renderTop(); renderTabs();
    // The magic-find box belongs to the pages that show drop chances, and
    // nowhere else — it is in the sticky toolbar, so a stale one would follow
    // you into the rune page.
    const mfShown = {};
    for (const tab of ['uniques', 'sets', 'affix', 'base']) {
      state.tab = tab; renderTabs();
      mfShown[tab] = !$('#mfwrap').hidden;
    }
    state.mode = 'runes'; renderTabs();
    mfShown.runes = !$('#mfwrap').hidden;
    state.mode = 'gear'; state.tab = 'sets'; renderTabs();
    out.mfShown = mfShown;
    return out;
  };
`, ctx);

const sizes = ctx.__renderAll(report);
const { runeCards, noTabs, mfShown, ...tabSizes } = sizes;
for (const [tab, len] of Object.entries(tabSizes)) {
  if (!len) { console.error(`✗ 视图 ${tab} 渲染为空`); ok = false; }
}
if (!runeCards) { console.error('✗ 符文模式没有换成符文的统计卡'); ok = false; }
if (!noTabs) { console.error('✗ 符文模式不该显示装备的标签页'); ok = false; }
const mf = sizes.mfShown;
if (!mf.uniques || !mf.sets) { console.error('✗ 暗金/套装页应该有魔法寻找输入框'); ok = false; }
if (mf.affix || mf.base || mf.runes) { console.error('✗ 不显示掉率的页面不该有魔法寻找输入框'); ok = false; }
console.log(`✓ ${Object.keys(tabSizes).length} 个视图 (${Object.keys(tabSizes).join('/')}) × 搜索/筛选组合渲染均无异常`);

/* --- cube planner ---------------------------------------------------- */
{
  vm.runInContext(`
    globalThis.__cube = function (rep) {
      report = rep;
      state.mode = 'runes';
      const out = { views: 0, inv: {}, plans: {} };
      // No target picked yet: it must render its own prompt, not blow up.
      state.mode = 'runes'; state.target = null;
      renderView();
      if (!($('#view').innerHTML || '').length) throw new Error('empty basket view');
      for (const code of RUNES) {
        state.mode = 'runes'; state.target = code; state.qty = 1;
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
      state.mode = 'runes'; state.target = 'r22'; state.qty = 99;
      renderView();
      out.basketLen = ($('#view').innerHTML || '').length;
      out.clamped = ($('#view').innerHTML || '').includes('可以合 3 个');
      // At the ceiling "+" must be off and the material that runs out marked red.
      out.plusOffAtMax = /data-plus="1"\\s+disabled/.test($('#view').innerHTML || '');
      // At the ceiling the plan still succeeds, so the limiting material is
      // marked "再合一个还差 N" — not red, which would read as "cannot make any".
      out.tightAtMax = ($('#view').innerHTML || '').includes('再合一个还差')
                       && /tile[^"]*tight/.test($('#view').innerHTML || '');
      // Incremental, not from scratch: one more Um is two more Pul, full stop.
      out.tightIsIncremental = ($('#view').innerHTML || '').includes('再多要补：符文：普尔 ×2');
      out.noRedAtMax = !/tile[^"]*short/.test($('#view').innerHTML || '');
      out.okAtMax = ($('#view').innerHTML || '').includes('✅');
      state.target = 'r22'; state.qty = 1; renderView();
      const one = $('#view').innerHTML || '';
      out.plusOnBelowMax = /data-plus="1"\\s+title/.test(one);
      // One Um spends two of the six Pul: blue "−2" and a remaining count of 4.
      out.spendShown = one.includes('<i class="d dn">−2</i>') && /class="tcnt">4</.test(one);
      // ...and the rune being made counts up: 0 Um -> 1, in green.
      out.gainShown = one.includes('<i class="d up">+1</i>') && /tile[^"]*gain/.test(one);
      out.gainInVerdict = one.includes('22 号 0 → 1');
      state.target = null; state.qty = 1; state.mode = 'gear';
      return out;
    };
  `, ctx);
  const cube = ctx.__cube(report);
  if (!cube.basketLen) { console.error('✗ 目标视图渲染为空'); ok = false; }
  if (!cube.clamped) { console.error('✗ 数量没有被材料上限夹住（乌姆应为 3 个）'); ok = false; }
  if (!cube.plusOffAtMax) { console.error('✗ 到上限时「+」没有禁用'); ok = false; }
  if (!cube.tightAtMax) { console.error('✗ 到上限时没有标出「再合一个还差」'); ok = false; }
  if (!cube.tightIsIncremental) { console.error('✗ 「再多要补」不是按再合一个算的（乌姆应为普尔 ×2）'); ok = false; }
  if (!cube.noRedAtMax) { console.error('✗ 到上限时误把材料标成红色缺料'); ok = false; }
  if (!cube.okAtMax) { console.error('✗ 到上限时判定不该是失败'); ok = false; }
  if (!cube.plusOnBelowMax) { console.error('✗ 未到上限时「+」被误禁用'); ok = false; }
  if (!cube.spendShown) { console.error('✗ 消耗后的剩余数量没有显示（普尔 6 −2 → 4）'); ok = false; }
  if (!cube.gainShown || !cube.gainInVerdict) { console.error('✗ 目标符文没有显示合成后的 +N'); ok = false; }
  console.log('✓ 扣减与产出：普尔 6 −2 → 4，乌姆 0 +1 → 1，到顶禁用且判定仍为可合成');
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
  // El has no recipe at all; the page must say so rather than "还差 1 个".
  vm.runInContext(`
    globalThis.__el = function () {
      state.mode = 'runes'; state.target = 'r01'; state.qty = 1;
      renderView();
      const h = $('#view').innerHTML || '';
      state.target = null; state.mode = 'gear';
      return { saysNoRecipe: h.includes('没有合成配方'), saysShort: h.includes('材料不够') };
    };
  `, ctx);
  const elRune = ctx.__el();
  if (!elRune.saysNoRecipe || elRune.saysShort) {
    console.error(`✗ 1 号艾尔的说明不对: ${JSON.stringify(elRune)}`); ok = false;
  } else {
    console.log('✓ 1 号艾尔：说明「没有合成配方」，不再谎报材料不够');
  }

  // Owning two Ist must not be mistaken for "two Ist are already made".
  const ist = ctx.__max('r24');
  if (ist.max !== 1) { console.error(`✗ 伊司特最多应为 1 个（不算仓库现货），实际 ${ist.max}`); ok = false; }
  console.log(`✓ 上限自洽：古尔最多 ${g.max} 个、乌姆最多 ${ctx.__max('r22').max} 个（多一个即不成立）`);
}

/* --- backing up the folder copies everything, not just the saves ----- */
{
  const bk = await vm.runInContext(`(async function () {
    const written = {};
    const file = (name, bytes) => ({
      kind: 'file', name,
      // Stand in for a real File: the copy hands it straight to write().
      getFile: async () => ({
        size: bytes.length,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      }),
    });
    const dir = (name, children) => ({
      kind: 'directory', name, values: () => children[Symbol.iterator](),
    });
    // A real save folder is not only .d2s and .d2i.
    const src = dir('saves', [
      file('Yisan.d2s', [1, 2, 3, 4]),
      file('SharedStashSoftCoreV2.d2i', [9, 9, 9]),
      file('Settings.json', [123, 125]),
      file('Yisan.key', [7]),
      dir('mods', [file('deep.txt', [42, 42])]),
    ]);
    const dest = (prefix) => ({
      name: 'backups',
      isSameEntry: async () => false,
      queryPermission: async () => 'granted',
      getDirectoryHandle: async n => dest(prefix ? prefix + '/' + n : n),
      getFileHandle: async n => ({
        createWritable: async () => ({
          write: async d => {
            const bytes = new Uint8Array(d.arrayBuffer ? await d.arrayBuffer() : d);
            written[(prefix ? prefix + '/' : '') + n] = Array.from(bytes);
          },
          close: async () => {},
        }),
      }),
    });
    window.showDirectoryPicker = async () => dest('');
    dirHandle = src;
    // Changing where backups go must change only that: no files written.
    await changeBackupDest();
    const wroteOnRepick = Object.keys(written).length;
    await backupNow();
    delete window.showDirectoryPicker;
    dirHandle = null;
    // Strip the timestamped folder the backup creates at the destination root.
    const out = {};
    for (const [k, v] of Object.entries(written)) {
      const i = k.indexOf('/');
      out[k.slice(i + 1)] = v;
      out['__root'] = k.slice(0, i);
    }
    out.__wroteOnRepick = wroteOnRepick;
    return out;
  })()`, ctx);

  const want = {
    'Yisan.d2s': [1, 2, 3, 4],
    'SharedStashSoftCoreV2.d2i': [9, 9, 9],
    'Settings.json': [123, 125],
    'Yisan.key': [7],
    'mods/deep.txt': [42, 42],
  };
  for (const [name, bytes] of Object.entries(want)) {
    const got = bk[name];
    if (!got || got.join(',') !== bytes.join(',')) {
      console.error(`✗ 备份漏了或写错了：${name}`); ok = false;
    }
  }
  if (bk.__wroteOnRepick !== 0) {
    console.error('✗ 「更改备份位置」不该顺手做一次备份'); ok = false;
  }
  delete bk.__wroteOnRepick;
  if (Object.keys(bk).length !== Object.keys(want).length + 1) {
    console.error('✗ 备份的文件数量不对'); ok = false;
  }
  if (!/^d2r-存档备份-\d{8}-\d{6}$/.test(bk.__root || '')) {
    console.error(`✗ 备份目录名不带时间戳：${bk.__root}`); ok = false;
  }
  console.log(`✓ 备份整个文件夹：${Object.keys(want).length} 个文件原样复制到 ${bk.__root}/`);
  console.log(`  非存档文件（设置、key、子目录）也在内，目录结构保持不变`);
  console.log('  「更改备份位置」只改位置，没有顺手写文件');
}

/* --- charms: item level is in the save even though the game hides it ---- */
{
  vm.runInContext(`
    globalThis.__charms = function (rep) {
      report = rep;
      state.mode = 'gear'; state.tab = 'charms'; state.q = ''; state.slot = null;
      const out = {};
      state.ilvlMin = 0; state.charmSize = null; renderView();
      const all = $('#view').innerHTML || '';
      out.total = (all.match(/class="afitem"/g) || []).length;
      out.ilvls = [...all.matchAll(/class="ilvl[^"]*">ilvl (\\d+)</g)].map(m => +m[1]);
      state.ilvlMin = 90; renderView();
      out.hi = (($('#view').innerHTML || '').match(/class="afitem"/g) || []).length;
      state.charmSize = 'cm3'; renderView();
      out.hiGrand = (($('#view').innerHTML || '').match(/class="afitem"/g) || []).length;
      out.text = $('#view').innerHTML || '';
      state.ilvlMin = 0; state.charmSize = null; state.tab = 'sets';
      return out;
    };
  `, ctx);
  const c = ctx.__charms(report);
  if (c.total !== 103) { console.error(`✗ 咒符数应为 103，实际 ${c.total}`); ok = false; }
  // Sorted by item level, highest first.
  const sorted = c.ilvls.every((v, i) => i === 0 || c.ilvls[i - 1] >= v);
  if (!sorted) { console.error('✗ 咒符没有按物品等级从高到低排'); ok = false; }
  if (c.ilvls[0] !== 99) { console.error(`✗ 最高等级应为 99，实际 ${c.ilvls[0]}`); ok = false; }
  const expectHi = c.ilvls.filter(v => v >= 90).length;
  if (c.hi !== expectHi) { console.error(`✗ ilvl≥90 筛选应为 ${expectHi} 个，实际 ${c.hi}`); ok = false; }
  if (c.hi <= c.hiGrand) { console.error('✗ 叠加尺寸筛选后数量没有减少'); ok = false; }
  // Formatting traps found on real charms.
  if (/\+-/.test(c.text)) { console.error('✗ 负数词缀渲染成了 "+-"'); ok = false; }
  if (/技能技能/.test(c.text)) { console.error('✗ 技能树名字后面多了一个「技能」'); ok = false; }
  console.log(`✓ 咒符：${c.total} 个，按 ilvl 排序（最高 ${c.ilvls[0]}），≥90 有 ${c.hi} 个、其中特大 ${c.hiGrand} 个`);
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

/* --- affix filter ---------------------------------------------------- */
{
  vm.runInContext(`globalThis.__affix = function (rep) {
    report = rep;
    state.mode = 'gear'; state.tab = 'affix'; state.q = ''; state.slot = null;
    const count = () => {
      const html = viewAffix();
      const m = html.match(/符合的物品：<b>(\\d+)<\\/b>/);
      if (!m) throw new Error('affix view lost its count');
      return Number(m[1]);
    };
    const out = { gear: report.gear.length };
    state.affixes = [];
    out.all = count();
    state.affixes = ['fcr'];
    out.fcr = count();
    state.affixes = ['res'];
    out.res = count();
    // AND, not OR: adding a requirement can only ever shrink the result.
    state.affixes = ['fcr', 'res'];
    out.both = count();
    // Independently recomputed from the raw stats, no view code involved.
    const has = (g, ids) => g.stats.some(s => ids.includes(s.id) && s.value);
    out.expectBoth = report.gear.filter(g => has(g, [105]) && has(g, [39, 41, 43, 45])).length;
    // Slot narrowing has to compose with the affix requirement.
    state.slot = '戒指';
    out.rings = count();
    out.expectRings = report.gear.filter(g => g.slot === '戒指' &&
      has(g, [105]) && has(g, [39, 41, 43, 45])).length;
    state.slot = null; state.affixes = []; state.tab = 'sets';
    return out;
  };`, ctx);
  const af = ctx.__affix(report);

  if (af.both !== af.expectBoth) {
    console.error(`✗ 与逻辑不符：界面 ${af.both} 件，直接算 ${af.expectBoth} 件`); ok = false;
  }
  if (af.rings !== af.expectRings) {
    console.error(`✗ 部位+词条组合筛选不符：${af.rings} vs ${af.expectRings}`); ok = false;
  }
  if (af.both > Math.min(af.fcr, af.res)) {
    console.error('✗ 与逻辑出错：同时要求两个词条的结果比单个还多'); ok = false;
  }
  if (af.all !== af.gear) { console.error('✗ 不选词条时应列出全部有词条的物品'); ok = false; }
  console.log(`✓ 词条筛选：${af.gear} 件带词条的物品 · 施法速度 ${af.fcr} 件 · 抗性 ${af.res} 件 · ` +
    `两者同时 ${af.both} 件（与逻辑，独立复算一致）`);
  console.log(`  同时满足的戒指：${af.rings} 件`);
}

/* --- item drop rates ------------------------------------------------- */
{
  const idr = vm.runInContext(`(function () {
    const out = {};
    out.items = Object.keys(ITEM_DROPS.items).length;
    out.targets = ITEM_DROPS.targets.length;
    // Every stored row must point at a real target and carry sane numbers.
    for (const [name, rec] of Object.entries(ITEM_DROPS.items)) {
      if (!rec.rows.length) throw new Error('no rows for ' + name);
      for (const r of rec.rows) {
        if (!ITEM_DROPS.targets[r[0]]) throw new Error('bad target index in ' + name);
        if (!(r[1] > 0) || !(r[2] > 0) || !(r[3] > 0)) throw new Error('bad numbers in ' + name);
      }
    }
    // Magic find helps, with diminishing returns, and never beyond the cap.
    const soj = ITEM_DROPS.items['The Stone of Jordan'];
    const at = mf => dropChance(soj.rows[0], 'u', mf);
    out.mf0 = at(0); out.mf100 = at(100); out.mf1000 = at(1000);
    out.gain100 = out.mf100 / out.mf0;
    out.gain1000 = out.mf1000 / out.mf0;
    out.sojRivals = soj.rivals;
    // Uniques are penalised harder than sets: a bigger factor means milder
    // diminishing returns, and sets carry 500 against the uniques' 250.
    out.uEff = effectiveMF(500, 'u');
    out.sEff = effectiveMF(500, 's');
    // The tooltip renders, names the rivals, and moves with magic find.
    state.mf = 0;
    const a = dropTip('The Stone of Jordan');
    state.mf = 500;
    const b = dropTip('The Stone of Jordan');
    state.mf = 0;
    out.tipOk = a.includes('上哪掉') && a.includes('10') && a !== b;
    out.noTipForJunk = dropTip('这不是个物品') === '';
    return out;
  })()`, ctx);

  if (idr.gain100 <= 1 || idr.gain1000 <= idr.gain100) {
    console.error('✗ 魔法寻找没有单调提升掉率'); ok = false;
  }
  if (idr.gain1000 > 3.2) { console.error(`✗ MF 1000 收益 ${idr.gain1000.toFixed(2)}x，超出递减上限`); ok = false; }
  if (idr.sEff <= idr.uEff) { console.error('✗ 暗金的魔法寻找递减应比绿装更狠'); ok = false; }
  if (!idr.tipOk) { console.error('✗ 掉落提示没渲染出来或不随魔法寻找变化'); ok = false; }
  if (!idr.noTipForJunk) { console.error('✗ 不认识的物品也给了掉落提示'); ok = false; }
  console.log(`✓ 物品掉落：${idr.items} 件 × ${idr.targets} 个目标 · ` +
    `魔法寻找 100 → ${idr.gain100.toFixed(2)}x，1000 → ${idr.gain1000.toFixed(2)}x（递减正常）`);
  console.log(`  同样 500 MF：暗金只当 ${idr.uEff}%，绿装当 ${idr.sEff}%`);
  console.log(`  乔丹之石同底材有 ${idr.sojRivals} 件暗金在抢`);
}

/* --- gambling -------------------------------------------------------- */
{
  const gb = vm.runInContext(`(function () {
    const out = {};
    out.items = Object.keys(GAMBLE.items).length;
    out.rateU = GAMBLE.rate.u;
    out.rateS = GAMBLE.rate.s;
    // Every step list must be ordered by level and never rise: rivals only get
    // added as you level, so a share can only shrink.
    for (const [name, rec] of Object.entries(GAMBLE.items)) {
      if (!rec.steps.length) throw new Error('no steps for ' + name);
      let prevLvl = -1, prevShare = 2;
      for (const [lvl, share] of rec.steps) {
        if (lvl <= prevLvl) throw new Error('steps out of order in ' + name);
        if (share > prevShare) throw new Error('share grew with level in ' + name);
        if (!(share > 0) || share > 1) throw new Error('bad share in ' + name);
        prevLvl = lvl; prevShare = share;
      }
    }
    const soj = GAMBLE.items['The Stone of Jordan'];
    out.sojFloor = soj.steps[0][0];
    out.below = gambleShare(soj, out.sojFloor - 1);   // too low to roll at all
    out.atFloor = gambleShare(soj, out.sojFloor);
    out.at99 = gambleShare(soj, 99);
    out.gain = out.atFloor / out.at99;
    // The gamble block is its own section and never merges into the boss list.
    state.glv = 99;
    const tip = dropTip('The Stone of Jordan');
    out.separate = tip.includes('tgamble') && tip.includes('tdrop');
    out.saysNoMF = tip.includes('不受魔法寻找影响');
    state.glv = out.sojFloor;
    out.movesWithLevel = dropTip('The Stone of Jordan') !== tip;
    state.glv = 1;
    out.tooLow = dropTip('The Stone of Jordan').includes('赌不出');
    state.glv = 99;
    // Magic find must not touch the gamble half of the card.
    state.mf = 0; const m0 = gambleTip('The Stone of Jordan');
    state.mf = 900; const m9 = gambleTip('The Stone of Jordan');
    state.mf = 0;
    out.mfIgnored = m0 === m9;
    // Something the vendor never offers has no gamble line at all.
    out.noOrbs = !GAMBLE.items["Death's Fathom"];
    return out;
  })()`, ctx);

  if (gb.below !== 0) { console.error('✗ 等级不够时不该有赌博概率'); ok = false; }
  if (!(gb.gain > 1.5)) { console.error('✗ 乔丹的卡级窗口没算出来'); ok = false; }
  if (gb.rateS <= gb.rateU) { console.error('✗ 赌博出绿装应该比暗金容易一倍'); ok = false; }
  if (!gb.separate) { console.error('✗ 赌博概率没和刷 boss 分开显示'); ok = false; }
  if (!gb.saysNoMF || !gb.mfIgnored) { console.error('✗ 赌博不该受魔法寻找影响'); ok = false; }
  if (!gb.movesWithLevel) { console.error('✗ 赌博概率没随等级变化'); ok = false; }
  if (!gb.tooLow) { console.error('✗ 等级不够时没给出提示'); ok = false; }
  if (!gb.noOrbs) { console.error('✗ 商人不卖的底材不该能赌'); ok = false; }
  console.log(`✓ 赌博：${gb.items} 件可赌 · 出暗金 ${(gb.rateU * 100).toFixed(3)}%、` +
    `绿装 ${(gb.rateS * 100).toFixed(3)}%（与魔法寻找无关，单独成块）`);
  console.log(`  乔丹之石：${gb.sojFloor} 级占 ${(gb.atFloor * 100).toFixed(1)}%，` +
    `99 级只剩 ${(gb.at99 * 100).toFixed(1)}%，卡级快 ${gb.gain.toFixed(1)} 倍`);
}

/* --- rune drop rates ------------------------------------------------- */
{
  const dr = vm.runInContext(`(function () {
    const out = {};
    // Every target must be reachable and every rate a real number.
    for (const t of DROPS.targets) {
      if (t.rates.length !== 33) throw new Error('bad rate row ' + t.key);
      for (const r of t.rates) if (!(r >= 0)) throw new Error('bad rate in ' + t.key);
      const top = t.rates.reduce((m, r, i) => r > 0 ? i + 1 : m, 0);
      if (top !== t.top) throw new Error('top mismatch ' + t.key);
    }
    // Sorted best first, and exactly one target flagged.
    const rows = dropRows('r28');
    out.lo = rows.map(r => [r.zh, r.rate]);
    out.sorted = rows.every((r, i) => i === 0 || rows[i - 1].rate >= r.rate);
    out.loBest = rows.length ? rows[0].zh : null;
    // The ceiling is the point: Hell Countess showers runes and still tops out
    // below the high ones, so she must not be offered for a 33.
    const zod = dropRows('r33');
    out.zodTargets = zod.map(r => r.zh);
    out.countessInZod = zod.some(r => r.key === 'countess');
    const c = DROPS.targets.find(t => t.key === 'countess');
    out.countessTop = c.top;
    out.countessAny = c.any;
    // Panels render for every rune, including the ones nothing can drop.
    out.panels = 0;
    for (const code of RUNES) { if (dropPanel(code).length) out.panels++; }

    // Per hour reorders by pace, not by per-kill odds: Travincal is worse per
    // kill than Mephisto and still wins, because a run yields a dozen bodies.
    state.dropBy = 'hour'; state.pace = {};
    const byHour = dropRows('r30');
    out.hourBest = byHour[0].zh;
    out.hourSorted = byHour.every((r, i) => i === 0 || byHour[i - 1].hourly >= r.hourly);
    state.dropBy = 'kill';
    out.killBest = dropRows('r30')[0].zh;
    // Editing the pace has to change the answer, or the inputs are decoration.
    state.dropBy = 'hour';
    state.pace = { council: { secs: 3600, kills: 1 } };
    out.hobbled = dropRows('r30')[0].zh;
    state.pace = {}; state.dropBy = 'kill';
    return out;
  })()`, ctx);

  if (!dr.sorted) { console.error('✗ 掉落列表没有按概率排序'); ok = false; }
  if (dr.countessInZod) { console.error('✗ 女伯爵被列进了 33 号的掉落来源'); ok = false; }
  if (dr.panels !== 33) { console.error(`✗ 只有 ${dr.panels} 个符文有掉落面板`); ok = false; }
  if (!dr.zodTargets.length) { console.error('✗ 33 号一个掉落来源都没有'); ok = false; }
  if (!dr.hourSorted) { console.error('✗ 每小时视图没有按每小时排序'); ok = false; }
  if (dr.hourBest === dr.hobbled) { console.error('✗ 改了刷图节奏，排名却没变'); ok = false; }
  console.log(`  30 号：按每杀最佳是「${dr.killBest}」，按每小时最佳是「${dr.hourBest}」` +
    `（把议会调成一小时一只后变成「${dr.hobbled}」）`);
  console.log(`✓ 符文掉落：28 号最佳目标是「${dr.loBest}」· ` +
    `33 号只有 ${dr.zodTargets.length} 个来源（${dr.zodTargets.join('、')}）`);
  console.log(`  女伯爵每杀出 ${dr.countessAny} 个符文，但最高只到 ${dr.countessTop} 号`);
}

/* --- runeword bases -------------------------------------------------- */
{
  vm.runInContext(`globalThis.__bases = function (rep) {
    report = rep;
    state.mode = 'gear'; state.tab = 'base'; state.q = ''; state.slot = null;
    const count = () => {
      const m = viewBases().match(/符合的装备：<b>(\\d+)<\\/b>/);
      if (!m) throw new Error('base view lost its count');
      return Number(m[1]);
    };
    const wear = report.gear.filter(g => g.wearable && g.kind !== 'runeword');
    const out = { gear: report.gear.length, wearable: wear.length };
    state.bases = []; out.all = count();
    state.bases = ['normal']; out.white = count();
    state.bases = ['eth']; out.eth = count();
    // White items carry no affixes at all — the whole reason they need their
    // own tab rather than living under the affix filter.
    out.whiteNoStats = wear.filter(g => g.quality === 'normal' && g.stats.length).length;
    out.runewordsHidden = report.gear.filter(g => g.wearable && g.kind === 'runeword').length;
    // AND again: white + already socketed.
    state.bases = ['normal', 'socketed']; out.whiteSocketed = count();
    out.expectWhiteSocketed = wear.filter(g => g.quality === 'normal' && g.sockets > 0).length;
    // Contradictory picks must yield nothing, not everything.
    state.bases = ['socketed', 'empty']; out.impossible = count();
    state.bases = []; state.tab = 'sets';
    return out;
  };`, ctx);
  const bs = ctx.__bases(report);
  if (bs.all !== bs.wearable) { console.error('✗ 不选条件时应列出全部可穿戴装备'); ok = false; }
  if (bs.whiteSocketed !== bs.expectWhiteSocketed) {
    console.error(`✗ 白装+已开孔 不符：界面 ${bs.whiteSocketed}，直接算 ${bs.expectWhiteSocketed}`); ok = false;
  }
  if (bs.impossible !== 0) { console.error('✗ 已开孔+没开孔 竟然有结果'); ok = false; }
  if (bs.whiteNoStats) { console.error(`✗ 有 ${bs.whiteNoStats} 件白装带词条，判定可疑`); ok = false; }
  if (!bs.white || !bs.eth) { console.error('✗ 存档里的白装/无形没被收进来'); ok = false; }
  console.log(`✓ 底材筛选：可用底材 ${bs.wearable} 件（排除 ${bs.runewordsHidden} 件已做成符文之语的）· ` +
    `白装 ${bs.white} · 无形 ${bs.eth} · ` +
    `白装且已开孔 ${bs.whiteSocketed}（与逻辑，独立复算一致）`);
}

/* --- skill planner --------------------------------------------------- */
{
  vm.runInContext(`globalThis.__skills = function () {
    state.mode = 'skills';
    const out = { classes: CLASSES.length, perClass: {}, renders: 0 };
    for (const c of CLASSES) {
      state.skClass = c.code; state.skLevel = 99; state.skPts = {};
      out.perClass[c.code] = c.skills.length;
      // The game's grid: three pages, six rows, three columns, no two skills
      // sharing a cell.
      const cells = new Set();
      for (const k of c.skills) {
        if (k.page < 1 || k.page > 3 || k.row < 1 || k.row > 6 || k.col < 1 || k.col > 3) {
          throw new Error('bad grid position: ' + c.code + ' ' + k.en);
        }
        const cell = k.page + ':' + k.row + ':' + k.col;
        if (cells.has(cell)) throw new Error('two skills in one cell: ' + c.code + ' ' + cell);
        cells.add(cell);
      }
      if (!viewSkills().length) throw new Error('empty tree ' + c.code);
      out.renders++;
    }

    // Sorceress: Meteor needs Fire Ball and Fire Wall, each of which needs
    // Fire Bolt / Inferno below them. Walk that chain.
    state.skClass = 'sor'; state.skLevel = 99; state.skPts = {};
    const sor = CLASSES.find(c => c.code === 'sor');
    const at = n => sor.skills.find(k => k.en === n);
    const meteor = at('Meteor'), ball = at('Fire Ball'), wall = at('Fire Wall');
    out.meteorBlocked = !!skBlocked(meteor);
    skAdd(meteor.id, 1);
    out.meteorRefused = !state.skPts[meteor.id];
    for (const n of ['Fire Bolt', 'Fire Ball', 'Inferno', 'Blaze', 'Fire Wall']) skAdd(at(n).id, 1);
    out.meteorNowFree = !skBlocked(meteor);
    skAdd(meteor.id, 1);
    out.meteorTaken = state.skPts[meteor.id] === 1;
    // Its prerequisite is now load-bearing and cannot be taken back.
    out.wallLocked = skDependent(wall);
    skAdd(wall.id, -1);
    out.wallStillThere = state.skPts[wall.id] === 1;

    // Level gates: at level 1 nothing above the first row is reachable.
    state.skPts = {}; state.skLevel = 1;
    out.lowLevelBlocked = !!skBlocked(meteor);
    out.budgetAt1 = skillBudget();

    // The budget is a hard ceiling.
    state.skLevel = 2; state.skQuests = false; state.skPts = {};
    const bolt = at('Fire Bolt');
    skAdd(bolt.id, 1); skAdd(bolt.id, 1);
    out.budgetAt2 = skillBudget();
    out.spentAt2 = skSpent();

    state.skPts = {}; state.skLevel = 99; state.skQuests = true; state.skClass = 'sor';
    return out;
  };`, ctx);
  const sk = ctx.__skills();

  if (sk.classes !== 8) { console.error(`✗ 职业数 ${sk.classes}，应为 8`); ok = false; }
  for (const [c, n] of Object.entries(sk.perClass)) {
    if (n !== 30) { console.error(`✗ ${c} 有 ${n} 个技能，应为 30`); ok = false; }
  }
  if (!sk.meteorBlocked || !sk.meteorRefused) { console.error('✗ 前置没点就能点陨石'); ok = false; }
  if (!sk.meteorNowFree || !sk.meteorTaken) { console.error('✗ 前置齐了反而点不了陨石'); ok = false; }
  if (!sk.wallLocked || !sk.wallStillThere) { console.error('✗ 被依赖的前置竟然能撤点'); ok = false; }
  if (!sk.lowLevelBlocked) { console.error('✗ 1 级就能点高级技能'); ok = false; }
  if (sk.budgetAt1 !== 12) { console.error(`✗ 1 级技能点应为 12（任务奖励），实际 ${sk.budgetAt1}`); ok = false; }
  if (sk.budgetAt2 !== 1 || sk.spentAt2 !== 1) {
    console.error(`✗ 技能点上限没兜住：预算 ${sk.budgetAt2}，花掉 ${sk.spentAt2}`); ok = false;
  }
  console.log(`✓ 天赋模拟：${sk.classes} 个职业 × 30 技能，格子无重叠 · ` +
    `等级/前置/点数上限都拦得住 · 被依赖的前置撤不掉`);
}

/* --- terror zones ---------------------------------------------------- */
{
  const tz = vm.runInContext(`(function () {
    state.mode = 'tz';
    const out = { days: {} };
    // The schedule is baked in, so it must render with no save loaded at all.
    report = null;
    state.day = 0;
    out.noSave = viewTz().length;
    // Slot lookup must agree with plain arithmetic on the published start time.
    const i = tzSlot(Date.now());
    out.slot = i;
    out.zone = tzZone(i).zh;
    out.expect = TZ.zones[TZ.alphabet.indexOf(TZ.slots[i])].zh;
    out.step = TZ.step;
    out.count = TZ.slots.length;
    out.kinds = TZ.zones.length;
    out.acts = TZ.zones.filter(z => z.act >= 1 && z.act <= 5).length;
    // Every day must list a full 24 hours' worth of slots.
    for (const d of [-1, 0, 1]) {
      state.day = d;
      const html = viewTz();
      out.days[d] = (html.match(/class="tzrow/g) || []).length;
    }
    state.day = 0;
    out.now = (viewTz().match(/class="tzrow now [^"]*"/g) || []).length;
    // Following one zone: every listed time must really be that zone, and the
    // count must match a straight scan of the schedule.
    const tv = TZ.zones.findIndex(z => z.en === 'Travincal');
    out.tvIndex = tv;
    state.zone = tv;
    const html = viewTz();
    out.tvShown = (html.match(/class="tzhit/g) || []).length;
    out.tvSaid = Number((html.match(/接下来还会出现 (\\d+) 次/) || [])[1]);
    let scan = 0;
    for (let k = i; k < TZ.slots.length; k++) if (TZ.alphabet.indexOf(TZ.slots[k]) === tv) scan++;
    out.tvScan = scan;
    out.tvOnlyThatZone = !/tzrow/.test(html);
    state.zone = null;
    return out;
  })()`, ctx);

  const perDay = 86400 / tz.step;
  if (!tz.noSave) { console.error('✗ 恐怖地带在没有存档时渲染为空'); ok = false; }
  if (tz.slot < 0) { console.error('✗ 内置排期没有覆盖当前时间，需要重新运行 make_tz.py'); ok = false; }
  if (tz.zone !== tz.expect) { console.error('✗ 当前地区查表不一致'); ok = false; }
  for (const [d, n] of Object.entries(tz.days)) {
    if (n !== perDay) { console.error(`✗ 第 ${d} 天只有 ${n} 个时段，应为 ${perDay}`); ok = false; }
  }
  if (tz.now !== 1) { console.error(`✗ 今天高亮了 ${tz.now} 个时段，应为 1 个`); ok = false; }
  if (tz.tvIndex < 0) { console.error('✗ 排期里找不到崔凡克'); ok = false; }
  if (tz.tvSaid !== tz.tvScan) {
    console.error(`✗ 地区筛选场次不符：界面 ${tz.tvSaid} 次，直接扫 ${tz.tvScan} 次`); ok = false;
  }
  if (!tz.tvOnlyThatZone) { console.error('✗ 选了单个地区还在渲染整天的排期'); ok = false; }
  if (tz.acts !== tz.kinds) { console.error('✗ 有地区没有归到第几幕'); ok = false; }
  console.log(`✓ 恐怖地带：${tz.kinds} 种地区（全部标了幕）· ${tz.count} 个时段 · ` +
    `每天 ${perDay} 格 · 无存档也能看`);
  console.log(`  只看崔凡克：剩余排期里还有 ${tz.tvSaid} 次，列出最近 ${tz.tvShown} 次`);
  console.log(`  当前：${tz.zone}`);
}

const warned = report.sources.filter(x => x.error || x.warnings.length);
if (warned.length) {
  ok = false;
  warned.forEach(w => console.error(`✗ ${w.name}: ${w.error || w.warnings.join('；')}`));
}

console.log(ok ? '\n*** 打包页面校验通过：与 Python 参考实现数字一致，无解析告警 ***'
               : '\n!!! 校验未通过');
process.exit(ok ? 0 : 1);
