/*
 * Collection view: pick a save folder, parse it in the browser, cross-reference
 * the full unique/set catalogue, and render what you own and what you're missing.
 *
 * The save folder is opened read-only. Nothing is ever written back to disk.
 */

const CAT = new Catalog(CATALOG);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SLOTS = ['头盔', '盔甲', '盾牌', '副手', '手套', '鞋子', '腰带', '项链', '戒指', '武器', '护身符', '珠宝', '盔甲类', '其他'];

let report = null;
let dirHandle = null;
let backupSet = [];   // raw bytes of the files last read, for the backup zip
let state = { mode: 'gear', tab: 'sets', q: '', slot: null, only: 'all', sort: 'progress', target: null, qty: 1 };
// target/qty: the one rune the cube page is solving for, and how many of it.

/* ------------------------------------------------------------------ */
/* Horadric cube: rune and gem upgrade recipes                         */
/* ------------------------------------------------------------------ */
// Runes in order; the index+1 is the number players use ("28 号符文" = Lo).
const RUNES = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08', 'r09', 'r10', 'r11',
  'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20', 'r21', 'r22',
  'r23', 'r24', 'r25', 'r26', 'r27', 'r28', 'r29', 'r30', 'r31', 'r32', 'r33'];

// Gem codes by type, chipped -> perfect. Amethyst is the odd one out: its
// flawless code is "gzv", not "glv".
const GEMS = {
  紫: ['gcv', 'gfv', 'gsv', 'gzv', 'gpv'],
  黄: ['gcy', 'gfy', 'gsy', 'gly', 'gpy'],
  蓝: ['gcb', 'gfb', 'gsb', 'glb', 'gpb'],
  绿: ['gcg', 'gfg', 'gsg', 'glg', 'gpg'],
  红: ['gcr', 'gfr', 'gsr', 'glr', 'gpr'],
  白: ['gcw', 'gfw', 'gsw', 'glw', 'gpw'],
  骷: ['skc', 'skf', 'sku', 'skl', 'skz'],
};

/*
 * Rune upgrades. Below Amn it is 3 of the previous rune; from Amn to Pul it is
 * 3 plus a gem; from Um upward it is 2 plus a gem of rising quality.
 */
const RECIPES = {};
{
  const ladder = [
    // [target, count of previous rune, gem code or null]
    ['r02', 3, null], ['r03', 3, null], ['r04', 3, null], ['r05', 3, null],
    ['r06', 3, null], ['r07', 3, null], ['r08', 3, null], ['r09', 3, null],
    ['r10', 3, null],
    ['r11', 3, 'gcy'], ['r12', 3, 'gcv'], ['r13', 3, 'gcb'], ['r14', 3, 'gcr'],
    ['r15', 3, 'gcg'], ['r16', 3, 'gcw'], ['r17', 3, 'gfy'], ['r18', 3, 'gfv'],
    ['r19', 3, 'gfb'], ['r20', 3, 'gfr'], ['r21', 3, 'gfg'],
    ['r22', 2, 'gfw'], ['r23', 2, 'gsy'], ['r24', 2, 'gsv'], ['r25', 2, 'gsb'],
    ['r26', 2, 'gsr'], ['r27', 2, 'gsg'], ['r28', 2, 'gsw'], ['r29', 2, 'gly'],
    ['r30', 2, 'gzv'], ['r31', 2, 'glb'], ['r32', 2, 'glr'], ['r33', 2, 'glg'],
  ];
  for (const [target, n, gem] of ladder) {
    const prev = RUNES[RUNES.indexOf(target) - 1];
    RECIPES[target] = [{ code: prev, n }].concat(gem ? [{ code: gem, n: 1 }] : []);
  }
  // Three gems of one type and quality make one of the next quality up.
  for (const codes of Object.values(GEMS)) {
    for (let i = 1; i < codes.length; i++) RECIPES[codes[i]] = [{ code: codes[i - 1], n: 3 }];
  }
}

const GEM_CODES = Object.values(GEMS).flat();
const MATERIALS = new Set([...RUNES, ...GEM_CODES]);
const runeNo = code => RUNES.indexOf(code) + 1;
const matZh = code => (CATALOG.bases[code] ? CATALOG.bases[code][1] || CATALOG.bases[code][0] : code);
const matEn = code => (CATALOG.bases[code] ? CATALOG.bases[code][0] : code);

/*
 * Work out what it takes to build `qty` of `code` out of `pool`, spending what
 * is already owned first and cubing the rest. `pool` is mutated, so the same
 * gem is never counted twice across two branches of the tree.
 */
function plan(code, qty, pool, useStock = true) {
  // The thing you asked to *make* is never satisfied out of stock: clicking
  // "24 号" means cube one, not hand me the one already in the stash.
  const have = useStock ? Math.min(pool[code] || 0, qty) : 0;
  pool[code] = (pool[code] || 0) - have;
  const node = { code, qty, have, children: [], missing: 0 };
  const short = qty - have;
  if (short > 0) {
    const recipe = RECIPES[code];
    if (!recipe) node.missing = short;           // El runes and chipped gems: nothing makes them
    else node.children = recipe.map(ing => plan(ing.code, ing.n * short, pool));
  }
  // Can this branch actually be completed? Owning one of every rune still does
  // not make a Um, and saying "you are short 17 亿个 El 符文" helps nobody —
  // the useful answer is the shallowest step that fails: "还差 1 个普尔".
  node.ok = node.have >= node.qty ||
    (node.children.length > 0 && node.children.every(c => c.ok));
  return node;
}

function planTotals(node, consumed = {}, missing = {}) {
  if (node.have) consumed[node.code] = (consumed[node.code] || 0) + node.have;
  if (node.ok) {
    node.children.forEach(c => planTotals(c, consumed, missing));
  } else if (!node.children.length) {
    missing[node.code] = (missing[node.code] || 0) + (node.qty - node.have);
  } else {
    // Only report the children that break; the ones that work still cost you.
    for (const c of node.children) {
      if (c.ok) planTotals(c, consumed, missing);
      else missing[c.code] = (missing[c.code] || 0) + (c.qty - c.have);
    }
  }
  return { consumed, missing };
}

/*
 * The most of `code` this pool can yield. plan() is monotone in qty — asking
 * for more never turns a failure into a success — so a binary search over the
 * feasible range is exact under the same greedy rules.
 */
function maxMakeable(code, pool, cap = 512) {
  const can = q => plan(code, q, { ...pool }, false).ok;
  if (!can(1)) return 0;
  let lo = 1, hi = 2;
  while (hi <= cap && can(hi)) { lo = hi; hi *= 2; }
  hi = Math.min(hi, cap);
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (can(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* Remember the chosen folder between visits (handle only, never data) */
/* ------------------------------------------------------------------ */
const DB = 'd2inv', STORE = 'handles';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && out.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveHandle = h => idb('readwrite', s => s.put(h, 'dir')).catch(() => {});
const loadHandle = () => idb('readonly', s => s.get('dir')).catch(() => null);

/* ------------------------------------------------------------------ */
/* Reading the folder                                                  */
/* ------------------------------------------------------------------ */
const isSave = n => /\.(d2s|d2i)$/i.test(n);

async function filesFromDirectory(handle) {
  const out = [];
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && isSave(entry.name)) {
      out.push({ name: entry.name, getFile: () => entry.getFile() });
    }
  }
  return out;
}

async function parseFiles(files) {
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const sources = [];
  backupSet = [];
  for (const f of files) {
    let data;
    try {
      data = new Uint8Array(await (await f.getFile()).arrayBuffer());
      // Keep the raw bytes around so "备份存档" can repackage exactly what was
      // read, without touching the folder again.
      backupSet.push({ name: f.name, data });
    } catch (err) {
      sources.push({ source: f.name, sourceType: 'error', error: `无法读取: ${err.message}`, items: [], warnings: [] });
      continue;
    }
    try {
      sources.push(/\.d2s$/i.test(f.name)
        ? parseCharacter(data, f.name, CAT)
        : parseStash(data, f.name, CAT));
    } catch (err) {
      sources.push({ source: f.name.replace(/\.(d2s|d2i)$/i, ''), sourceType: 'error', error: err.message, items: [], warnings: [] });
    }
  }
  return sources;
}

/* ------------------------------------------------------------------ */
/* Cross-reference against the catalogue                               */
/* ------------------------------------------------------------------ */
// Total pieces in a material's copy list, counting each stack in full.
const tally = list => (list || []).reduce((n, c) => n + (c.n || 1), 0);

function buildReport(sources) {
  const uniques = CATALOG.uniques.map(u => ({ ...u, copies: [], count: 0, owned: false }));
  const sets = CATALOG.sets.map(g => ({
    ...g,
    pieces: g.pieces.map(p => ({ ...p, copies: [], count: 0, owned: false })),
  }));

  // The chronicle is the game's own log of everything ever found, so anything
  // in it that is not in your stash right now is something you lost.
  const everUnique = new Set(), everSet = new Set(), everRuneword = new Set();
  for (const src of sources) {
    const ch = src.chronicle;
    if (!ch) continue;
    ch.uniques.forEach(e => everUnique.add(e.id));
    ch.sets.forEach(e => everSet.add(e.id));
    ch.runewords.forEach(e => everRuneword.add(e.id));
  }
  const hasChronicle = everUnique.size + everSet.size > 0;

  const runewords = {};
  const sourceRows = [];
  // Loose runes and gems, for the cube planner. Anything already socketed into
  // an item is listed separately: you cannot get it back out.
  const materials = {};
  const socketed = {};
  for (const src of sources) {
    let notable = 0;
    for (const it of (src.items || [])) {
      const copy = {
        source: src.source,
        sourceType: src.sourceType,
        where: locationLabel(it),
        ethereal: !!it.ethereal,
        sockets: it.sockets || 0,
        ilvl: it.itemLevel,
      };
      if (MATERIALS.has(it.code)) {
        // One entry in the auto-sorting stash tabs can be a stack of many.
        const n = it.stackCount || 1;
        if (it.socketedIn) socketed[it.code] = (socketed[it.code] || 0) + n;
        else (materials[it.code] = materials[it.code] || []).push({ ...copy, n });
      }
      if (it.runeword && CATALOG.runewords[it.runewordId]) {
        const [en, zh] = CATALOG.runewords[it.runewordId];
        (runewords[it.runewordId] = runewords[it.runewordId] ||
          { id: it.runewordId, name: en, zh, slot: it.slot, base: it.baseName,
            base_zh: it.baseZh, copies: [] }).copies.push({ ...copy, base_zh: it.baseZh });
        notable++;
      }
      if (it.uniqueId !== null && CAT.uniqueById.has(it.uniqueId)) {
        uniques[CAT.uniqueById.get(it.uniqueId)].copies.push(copy);
        notable++;
      } else if (it.setId !== null && CAT.setById.has(it.setId)) {
        const [gi, pi] = CAT.setById.get(it.setId);
        sets[gi].pieces[pi].copies.push(copy);
        notable++;
      }
    }
    sourceRows.push({
      name: src.source, type: src.sourceType, cls: src.cls || '',
      level: src.level || 0, items: (src.items || []).length, notable,
      warnings: src.warnings || [], error: src.error || null,
    });
  }

  for (const u of uniques) {
    u.count = u.copies.length;
    u.owned = u.count > 0;
    u.everFound = u.ids.some(id => everUnique.has(id));
    u.lost = u.everFound && !u.owned;
  }
  uniques.sort((a, b) => (SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)) ||
    (a.lvlreq - b.lvlreq) || a.name.localeCompare(b.name));

  for (const g of sets) {
    for (const p of g.pieces) {
      p.count = p.copies.length;
      p.owned = p.count > 0;
      p.everFound = everSet.has(p.id);
      p.lost = p.everFound && !p.owned;
    }
    g.pieces.sort((a, b) => (SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)) || a.name.localeCompare(b.name));
    g.total = g.pieces.length;
    g.ownedCount = g.pieces.filter(p => p.owned).length;
    g.lostCount = g.pieces.filter(p => p.lost).length;
    g.complete = g.ownedCount === g.total && g.total > 0;
  }

  const standard = uniques.filter(u => u.standard);
  const pieces = sets.flatMap(g => g.pieces);

  return {
    scannedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    sources: sourceRows, uniques, sets, hasChronicle, materials, socketed,
    runewords: Object.values(runewords).sort((a, b) => a.zh.localeCompare(b.zh, 'zh')),
    summary: {
      runewordKinds: Object.keys(runewords).length,
      runewordItems: Object.values(runewords).reduce((n, r) => n + r.copies.length, 0),
      lostUniques: uniques.filter(u => u.lost).length,
      lostSets: pieces.filter(p => p.lost).length,
      uniqueOwned: standard.filter(u => u.owned).length,
      uniqueTotal: standard.length,
      uniqueExtra: uniques.filter(u => u.owned && !u.standard).length,
      setOwned: pieces.filter(p => p.owned).length,
      setTotal: pieces.length,
      setComplete: sets.filter(g => g.complete).length,
      setGroups: sets.length,
      dupeKinds: uniques.filter(u => u.count > 1).length + pieces.filter(p => p.count > 1).length,
      dupeCopies: uniques.reduce((n, u) => n + Math.max(0, u.count - 1), 0) +
                  pieces.reduce((n, p) => n + Math.max(0, p.count - 1), 0),
      runeCount: RUNES.reduce((n, c) => n + tally(materials[c]), 0),
      runeKinds: RUNES.filter(c => tally(materials[c])).length,
      gemCount: GEM_CODES.reduce((n, c) => n + tally(materials[c]), 0),
      topRune: RUNES.filter(c => tally(materials[c])).pop() || null,
      files: sourceRows.filter(s => s.type !== 'error').length,
      totalItems: sourceRows.reduce((n, s) => n + s.items, 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Loading flow                                                        */
/* ------------------------------------------------------------------ */
function setStatus(msg, busy) {
  $('#status').innerHTML = msg;
  $('#reload').disabled = !dirHandle || !!busy;
  $('#backup').disabled = !backupSet.length || !!busy;
}

/* ------------------------------------------------------------------ */
/* Backup: repackage the files just read into a zip and download it     */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/*
 * Minimal store-only (uncompressed) zip writer. Save files are tiny and this
 * keeps the page dependency-free; store-only archives open everywhere.
 */
function makeZip(entries, when) {
  const enc = new TextEncoder();
  // DOS date/time, the only timestamp format a zip local header carries.
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xFFFF;

  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const head = Uint8Array.from([
      ...u32(0x04034B50), ...u16(20), ...u16(0x0800),  // 0x0800: name is UTF-8
      ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ]);
    central.push(Uint8Array.from([
      ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0x0800),
      ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    parts.push(head, nameBytes, data);
    offset += head.length + nameBytes.length + data.length;
  }

  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054B50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(dirSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupNow() {
  if (!backupSet.length) return;
  const when = new Date();
  const folder = `d2r-存档备份-${stamp(when)}`;
  const blob = makeZip(backupSet.map(f => ({ name: `${folder}/${f.name}`, data: f.data })), when);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${folder}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const kb = Math.round(blob.size / 1024);
  setStatus(`已导出备份：${esc(folder)}.zip（${backupSet.length} 个文件，约 ${kb} KB）。`);
}

async function loadFromHandle(handle, { prompt = false } = {}) {
  try {
    // Read-only permission. The page never requests write access.
    if (handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted' && prompt && handle.requestPermission) {
        perm = await handle.requestPermission({ mode: 'read' });
      }
      if (perm !== 'granted') {
        setStatus('需要授权读取该文件夹，请点击「选择存档文件夹」重新授权。');
        return false;
      }
    }
    setStatus('正在读取…', true);
    const files = await filesFromDirectory(handle);
    if (!files.length) {
      setStatus('这个文件夹里没有找到 .d2s 或 .d2i 存档文件。');
      return false;
    }
    dirHandle = handle;
    report = buildReport(await parseFiles(files));
    render();
    return true;
  } catch (err) {
    setStatus(`读取失败：${esc(err.message)}`);
    return false;
  }
}

async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    $('#fallback').click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read', id: 'd2saves' });
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`打开失败：${esc(err.message)}`);
    return;
  }
  if (await loadFromHandle(handle, { prompt: true })) saveHandle(handle);
}

async function reload() {
  if (dirHandle) {
    await loadFromHandle(dirHandle, { prompt: true });
  } else {
    $('#fallback').click();
  }
}

/* Fallback for browsers without the File System Access API (e.g. Safari). */
$('#fallback').addEventListener('change', async e => {
  const files = [...e.target.files].filter(f => isSave(f.name))
    .map(f => ({ name: f.name, getFile: async () => f }));
  if (!files.length) { setStatus('没有选到 .d2s / .d2i 存档文件。'); return; }
  setStatus('正在读取…', true);
  dirHandle = null;
  report = buildReport(await parseFiles(files));
  render();
  $('#reload').disabled = false;
  $('#backup').disabled = !backupSet.length;
  $('#reload').textContent = '重新选择文件夹刷新';
});

$('#pick').addEventListener('click', pickDirectory);
$('#reload').addEventListener('click', reload);
$('#backup').addEventListener('click', backupNow);

/* Drag a folder onto the page. */
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
document.addEventListener('dragleave', e => { if (e.target === document.documentElement) document.body.classList.remove('drag'); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
  if (item && item.getAsFileSystemHandle) {
    const handle = await item.getAsFileSystemHandle();
    if (handle.kind === 'directory' && await loadFromHandle(handle, { prompt: true })) saveHandle(handle);
  }
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
// Two things this tool does, kept apart: collecting gear, and cubing runes.
const MODES = [['gear', '装备收藏'], ['runes', '符文合成']];
const GEAR_TABS = [['sets', '套装收集'], ['uniques', '暗金收集'], ['lost', '找回清单'],
  ['dupes', '重复清理']];
// The chronicle tab only exists in D2R saves that have one.
const TABS = () => (state.mode === 'runes' ? []
  : GEAR_TABS.filter(([k]) => k !== 'lost' || report.hasChronicle));

// Search matches the item's own name only — not its base type, not the part it
// goes in, not which mule happens to hold it.
function hit(entry, q) {
  if (!q) return true;
  return [entry.zh, entry.name].join(' ').toLowerCase().includes(q);
}

/*
 * A copy always reads "who · where". Character names can look exactly like
 * location words — mules are often named after what they hold — so the name is
 * tagged and styled rather than just concatenated into the sentence.
 */
function copiesHtml(copies, { sockets = true } = {}) {
  return copies.map(c => {
    let head, tail;
    if (c.sourceType === 'stash') {
      head = '共享仓库';
      tail = [esc(c.where).replace(/^共享仓库\s*/, '')];
    } else {
      head = esc(c.source);
      tail = [esc(c.where)];
    }
    if (c.n > 1) tail.push(`${c.n} 个一摞`);
    if (c.ethereal) tail.push('虚空');
    if (sockets && c.sockets) tail.push(c.sockets + '孔');
    return `<b class="who">${head}</b>${tail.filter(Boolean).length ? ' · ' + tail.filter(Boolean).join(' · ') : ''}`;
  }).join('<br>');
}

const dupeBadge = n => n > 1 ? ` <span class="dupe">×${n}</span>` : '';

/*
 * Hover tooltips. The properties come from the game data tables, so ranges are
 * shown as ranges (+20~35%) rather than any particular copy's rolled value.
 * Entries are registered by id and looked up on hover, which keeps the markup
 * small and avoids re-rendering tooltips into every row.
 */
const TIPS = new Map();
let tipSeq = 0;

function tipFor(entry, extraTitle) {
  if (!entry.props || !entry.props.length) return '';
  const id = 't' + (++tipSeq);
  TIPS.set(id, { entry, extraTitle });
  return ` data-tip="${id}"`;
}

function tipForSet(group) {
  if (!(group.partial || []).length && !(group.full || []).length) return '';
  const id = 't' + (++tipSeq);
  TIPS.set(id, { set: group });
  return ` data-tip="${id}"`;
}

/*
 * Whole-set tooltip: the per-piece-count bonuses and the full-set bonuses,
 * with the tiers you have already reached marked as active.
 */
function renderSetTip(g) {
  const line = s => `<div class="tprop">${esc(s)}</div>`;
  const tiers = (g.partial || []).map(p => {
    const on = g.ownedCount >= p.pieces;
    return `<div class="ttier ${on ? 'on' : ''}">
        <div class="tlabel">凑齐 ${p.pieces} 件${on ? ' · 已达成' : ''}</div>
        ${p.props.map(line).join('')}
      </div>`;
  }).join('');
  const fullOn = g.complete;
  const full = (g.full || []).length ? `
    <div class="ttier ${fullOn ? 'on' : ''}">
      <div class="tlabel">全套 ${g.total} 件${fullOn ? ' · 已达成' : ''}</div>
      ${g.full.map(line).join('')}
    </div>` : '';
  return `
    <div class="thead">
      <div class="tname s">${esc(g.zh)}</div>
      <div class="tbase">${esc(g.name)} · 已有 ${g.ownedCount}/${g.total} 件</div>
    </div>
    <div class="tbody">${tiers}${full}</div>
    <div class="tfoot">套装加成，绿色为当前收藏已达成的档位</div>`;
}

function renderTip(id) {
  const rec = TIPS.get(id);
  if (!rec) return '';
  if (rec.set) return renderSetTip(rec.set);
  const e = rec.entry;
  const line = s => `<div class="tprop">${esc(s)}</div>`;
  return `
    <div class="thead">
      <div class="tname ${e.kind === 's' || e.id !== undefined ? 's' : 'u'}">${esc(e.zh)}</div>
      <div class="tbase">${esc(e.base_zh || e.base || '')}${e.lvlreq ? ` · 需求等级 ${e.lvlreq}` : ''}</div>
    </div>
    <div class="tbody">${e.props.map(line).join('')}</div>
    ${e.bonus && e.bonus.length ? `<div class="tbonus"><div class="tlabel">套装加成</div>${e.bonus.map(line).join('')}</div>` : ''}
    <div class="tfoot">数值取自游戏数据表，区间表示该属性会浮动</div>`;
}

let tipEl = null;

function showTip(target) {
  const id = target.dataset.tip;
  if (!id) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    document.body.appendChild(tipEl);
  }
  tipEl.innerHTML = renderTip(id);
  tipEl.hidden = false;

  const r = target.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 8;
  if (left + tr.width > window.innerWidth - 12) left = window.innerWidth - tr.width - 12;
  if (top + tr.height > window.innerHeight - 12) top = r.top - tr.height - 8;
  tipEl.style.left = Math.max(12, left) + 'px';
  tipEl.style.top = Math.max(12, top) + 'px';
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// e.target can be a non-element (text node, document) during pointer events.
const tipTarget = node => (node && node.closest ? node.closest('[data-tip]') : null);

document.addEventListener('mouseover', e => {
  const t = tipTarget(e.target);
  if (t) showTip(t);
  else if (!(e.target.closest && e.target.closest('.tooltip'))) hideTip();
});
document.addEventListener('mouseout', e => {
  const from = tipTarget(e.target);
  if (!from) return;
  // Moving between children of the same target must not dismiss the tooltip.
  if (tipTarget(e.relatedTarget) !== from) hideTip();
});
document.addEventListener('click', e => {
  // Tap support on touch screens.
  const t = tipTarget(e.target);
  if (t) showTip(t); else hideTip();
});
window.addEventListener('scroll', hideTip, true);

function renderModes() {
  $('#modes').innerHTML = MODES.map(([k, l]) =>
    `<button class="mode" data-mode="${k}" aria-selected="${state.mode === k}">${l}</button>`).join('');
}

function renderTop() {
  const s = report.summary;
  if (state.mode === 'runes') {
    $('#cards').innerHTML = `
      <div class="card">
        <div class="n">${s.runeCount}</div><div class="l">符文</div>
        <div class="sub">${s.runeKinds} / 33 种</div>
      </div>
      <div class="card">
        <div class="n">${s.gemCount}</div><div class="l">宝石</div>
        <div class="sub">7 色 × 5 级</div>
      </div>
      <div class="card">
        <div class="n" style="color:var(--gold)">${s.topRune ? runeNo(s.topRune) : '—'}</div>
        <div class="l">手上最高的符文</div>
        <div class="sub">${s.topRune ? esc(matZh(s.topRune)) : '一个符文都没有'}</div>
      </div>`;
    $('#warnings').innerHTML = '';
    return;
  }
  const pctU = Math.round(s.uniqueOwned / s.uniqueTotal * 100);
  const pctS = Math.round(s.setOwned / s.setTotal * 100);
  $('#cards').innerHTML = `
    <div class="card">
      <div class="n" style="color:var(--gold)">${s.uniqueOwned}<span class="of"> / ${s.uniqueTotal}</span></div>
      <div class="l">暗金装备</div><div class="bar"><i style="width:${pctU}%"></i></div>
      <div class="sub">已收集 ${pctU}%${s.uniqueExtra ? ` · 另有 ${s.uniqueExtra} 件特殊` : ''}</div>
    </div>
    <div class="card">
      <div class="n" style="color:var(--green)">${s.setOwned}<span class="of"> / ${s.setTotal}</span></div>
      <div class="l">绿色套装单件</div><div class="bar g"><i style="width:${pctS}%"></i></div>
      <div class="sub">已收集 ${pctS}%</div>
    </div>
    <div class="card">
      <div class="n">${s.setComplete}<span class="of"> / ${s.setGroups}</span></div>
      <div class="l">已集齐的套装</div>
      <div class="sub">还差 ${s.setGroups - s.setComplete} 套没凑齐</div>
    </div>
    <div class="card">
      <div class="n" style="color:var(--dupe)">${s.dupeCopies}</div>
      <div class="l">多余的重复件</div>
      <div class="sub">${s.dupeKinds} 种物品有重复</div>
    </div>
    ${report.hasChronicle ? `
    <div class="card">
      <div class="n" style="color:var(--lost)">${s.lostUniques + s.lostSets}</div>
      <div class="l">曾找到过但已丢失</div>
      <div class="sub">绿装 ${s.lostSets} · 暗金 ${s.lostUniques}</div>
    </div>` : ''}`;

  const bad = report.sources.filter(x => x.error || x.warnings.length);
  $('#warnings').innerHTML = bad.map(b =>
    `<div class="warn">${esc(b.name)}：${esc(b.error || b.warnings.join('；'))}</div>`).join('');
}

function renderTabs() {
  const tabs = TABS();
  $('#tabs').innerHTML = tabs.map(([k, l]) =>
    `<button class="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('');
  // The cube page has nothing to search or filter, so the whole bar goes away.
  $('#toolbar').hidden = !tabs.length;
}

function renderFilters() {
  if (state.mode === 'runes') { $('#filters').innerHTML = ''; return; }
  const showSlot = state.tab === 'uniques' || state.tab === 'lost';
  const showOnly = state.tab === 'uniques' || state.tab === 'sets';
  let html = '';
  if (showOnly) {
    const opts = state.tab === 'sets'
      ? [['all', '全部套装'], ['incomplete', '未集齐'], ['none', '一件都没有'], ['complete', '已集齐']]
      : [['all', '全部'], ['missing', '还没有的'], ['have', '已拥有']];
    html += opts.map(([k, l]) => `<button class="chip" data-only="${k}" aria-pressed="${state.only === k}">${l}</button>`).join('');
  }
  if (state.tab === 'sets') {
    html += '<span class="sep"></span>';
    html += [['progress', '按进度排'], ['name', '按名称排'], ['missing', '按缺得最多排']]
      .map(([k, l]) => `<button class="chip" data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join('');
  }
  if (showSlot) {
    if (html) html += '<span class="sep"></span>';
    html += `<button class="chip" data-slot="" aria-pressed="${!state.slot}">全部部位</button>` +
      SLOTS.map(s => `<button class="chip" data-slot="${s}" aria-pressed="${state.slot === s}">${s}</button>`).join('');
  }
  $('#filters').innerHTML = html;
}

function viewSets() {
  const q = state.q;
  const groups = report.sets.filter(g => {
    if (state.only === 'incomplete' && g.complete) return false;
    if (state.only === 'complete' && !g.complete) return false;
    if (state.only === 'none' && g.ownedCount > 0) return false;
    if (!q) return true;
    return (g.zh + ' ' + g.name).toLowerCase().includes(q) || g.pieces.some(p => hit(p, q));
  });
  if (!groups.length) return `<div class="empty">没有匹配的套装</div>`;

  const byName = (a, b) => a.zh.localeCompare(b.zh, 'zh');
  if (state.sort === 'name') groups.sort(byName);
  else if (state.sort === 'missing') groups.sort((a, b) => (b.total - b.ownedCount) - (a.total - a.ownedCount) || byName(a, b));
  else groups.sort((a, b) => (b.ownedCount / b.total) - (a.ownedCount / a.total) || byName(a, b));

  const empty = groups.filter(g => g.ownedCount === 0).length;
  const lost = groups.reduce((n, g) => n + g.lostCount, 0);
  const head = `<h2 class="section">${groups.length} 套 <span class="thin">— 已集齐 ${groups.filter(g => g.complete).length} · 一件都没有 ${empty}${lost ? ` · 其中 ${lost} 件曾经找到过` : ''}</span></h2>`;

  return head + `<div class="setgrid">` + groups.map(g => `
    <div class="setcard ${g.complete ? 'done' : ''}">
      <h3><span${tipForSet(g)}>${esc(g.zh)}</span>
        <span class="cnt ${g.complete ? 'ok' : ''}">${g.ownedCount}/${g.total}${g.complete ? ' ✓' : ''}</span></h3>
      <div class="en">${esc(g.name)}</div>
      <ul class="pieces">${g.pieces.map(p => `
        <li class="${p.owned ? 'have' : (p.lost ? 'lost' : 'miss')}">
          <span class="slot">${esc(p.slot)}</span>
          <span class="pname"${tipFor(p)}>${esc(p.zh)}${dupeBadge(p.count)}</span>
          <span class="loc">${p.owned ? copiesHtml(p.copies, { sockets: false })
            : (p.lost ? '<span class="lostbadge">曾找到过</span>' : '未拥有')}</span>
        </li>`).join('')}</ul>
    </div>`).join('') + `</div>`;
}

function viewUniques() {
  const rows = report.uniques.filter(u => {
    if (state.only === 'missing' && u.owned) return false;
    if (state.only === 'have' && !u.owned) return false;
    if (state.slot && u.slot !== state.slot) return false;
    return hit(u, state.q);
  });
  if (!rows.length) return `<div class="empty">没有匹配的暗金装备</div>`;
  const have = rows.filter(r => r.owned).length;
  return `<h2 class="section">共 ${rows.length} 件 · 已拥有 ${have} · 还差 ${rows.length - have}</h2>
  <div class="scroll"><table>
    <thead><tr><th>部位</th><th>名称</th><th>基础装备</th><th>等级</th><th>在哪个小号</th></tr></thead>
    <tbody>${rows.map(u => `
      <tr class="${u.owned ? '' : 'miss'}">
        <td>${esc(u.slot)}</td>
        <td class="name u"${tipFor(u)}><b>${esc(u.zh)}</b>${dupeBadge(u.count)}${u.standard ? '' : ' <span class="tag">特殊</span>'}<span class="en">${esc(u.name)}</span></td>
        <td>${esc(u.base_zh)}</td>
        <td>${u.lvlreq || '-'}</td>
        <td>${u.owned ? copiesHtml(u.copies)
          : (u.lost ? '<span class="lostbadge">曾找到过</span>' : '<span class="tag">未拥有</span>')}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

/*
 * Items the chronicle says you found at some point but that are nowhere in the
 * current saves — i.e. sold, dropped or lost. This is the "get it back" list.
 */
function viewLost() {
  const rows = [];
  report.uniques.forEach(u => { if (u.lost) rows.push({ ...u, kind: 'u', group: '暗金' }); });
  report.sets.forEach(g => g.pieces.forEach(p => { if (p.lost) rows.push({ ...p, kind: 's', group: g.zh }); }));

  const filtered = rows.filter(e => (!state.slot || e.slot === state.slot) && hit(e, state.q));
  if (!filtered.length) {
    return `<div class="empty">${rows.length ? '没有匹配的物品' : '编年史里的东西你都还留着 ✓'}</div>`;
  }
  filtered.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 's' ? -1 : 1) ||
    a.group.localeCompare(b.group, 'zh') || (SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)));

  const nSet = filtered.filter(e => e.kind === 's').length;
  return `<h2 class="section">${filtered.length} 件曾经找到过、现在不在存档里
    <span class="thin">— 绿装 ${nSet} · 暗金 ${filtered.length - nSet}</span></h2>
  <div class="hintbox">依据游戏内「编年史」记录（账号找到过的物品日志）与当前存档比对得出。
    卖掉、丢弃或换季清空的都会出现在这里。</div>
  <div class="scroll"><table>
    <thead><tr><th>部位</th><th>名称</th><th>所属</th><th>基础装备</th><th>等级</th></tr></thead>
    <tbody>${filtered.map(e => `
      <tr><td>${esc(e.slot)}</td>
        <td class="name ${e.kind}"${tipFor(e)}><b>${esc(e.zh)}</b><span class="en">${esc(e.name)}</span></td>
        <td>${esc(e.group)}</td>
        <td>${esc(e.base_zh)}</td>
        <td>${e.lvlreq || '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

function ownedEntries() {
  const out = [];
  report.uniques.forEach(u => { if (u.owned) out.push({ ...u, kind: 'u', group: '暗金' }); });
  report.sets.forEach(g => g.pieces.forEach(p => { if (p.owned) out.push({ ...p, kind: 's', group: g.zh }); }));
  return out;
}

function viewDupes() {
  const rows = ownedEntries().filter(e => e.count > 1 && hit(e, state.q));
  rows.sort((a, b) => b.count - a.count || a.zh.localeCompare(b.zh, 'zh'));
  if (!rows.length) return `<div class="empty">没有重复的物品 — 很干净 ✓</div>`;
  const extra = rows.reduce((n, e) => n + e.count - 1, 0);
  return `<h2 class="section">${rows.length} 种物品有重复，共 ${extra} 件多余（每种留 1 件即可）</h2>
  <div class="scroll"><table>
    <thead><tr><th>部位</th><th>名称</th><th>拥有</th><th>多余</th><th>分别在哪</th></tr></thead>
    <tbody>${rows.map(e => `
      <tr><td>${esc(e.slot)}</td>
        <td class="name ${e.kind}"${tipFor(e)}><b>${esc(e.zh)}</b><span class="en">${esc(e.name)}</span></td>
        <td>${e.count}</td><td><span class="dupe">+${e.count - 1}</span></td>
        <td>${copiesHtml(e.copies)}</td></tr>`).join('')}</tbody></table></div>`;
}


/* ------------------------------------------------------------------ */
/* Cube planner                                                        */
/* ------------------------------------------------------------------ */
// Stacks count as their full size, not as one entry.
function ownedOf(code) {
  return (report.materials[code] || []).reduce((n, c) => n + (c.n || 1), 0);
}

/*
 * A working branch is unrolled in full. A broken one is shown one level deep —
 * just far enough to see which step fails — and you drill in by adding that
 * rune to the list yourself.
 */
function planTree(node, canExpandBroken = true) {
  const bits = [];
  if (node.have) bits.push(`<span class="ok">用现有 ${node.have}</span>`);
  if (node.ok) {
    const made = node.qty - node.have;
    if (made) bits.push(`<span class="mk">合成 ${made}</span>`);
  } else {
    bits.push(`<span class="no2">缺 ${node.qty - node.have}</span>`);
  }
  const expand = node.children.length && (node.ok || canExpandBroken);
  const kids = expand
    ? `<div class="kids">${node.children.map(c => planTree(c, false)).join('')}</div>` : '';
  const name = RUNES.includes(node.code)
    ? `<button class="lk" data-add="${node.code}" title="加入合成清单">${esc(matZh(node.code))}</button>`
    : esc(matZh(node.code));
  return `<div class="pnode${node.ok ? '' : ' bad'}">
    <div class="prow"><b>${node.qty} ×</b> ${name} ${bits.join(' ')}</div>${kids}</div>`;
}

const matList = obj => Object.entries(obj)
  .sort((a, b) => MATERIALS_ORDER.indexOf(b[0]) - MATERIALS_ORDER.indexOf(a[0]))
  .map(([c, n]) => `${esc(matZh(c))} ×${n}`).join('、');

const GEM_QUALITY = ['碎裂', '瑕疵', '普通', '无瑕', '完美'];

/*
 * One row of the stock column. `use` is what this plan spends of it and `short`
 * what it cannot cover, so the left column doubles as a live receipt: spent
 * material counts down in blue, material that runs out turns red.
 */
/*
 * One tile of the stock grid, showing what this plan does to it: the target
 * counts up in green (+N, what you end up with), material spent counts down in
 * blue, material that runs out is flagged.
 */
function matRow(code, use, short, tight, gain) {
  const n = ownedOf(code);
  const on = state.target === code;
  let delta = '', count = n || '—', cls = '';
  if (gain) { delta = `<i class="d up">+${gain}</i>`; count = n + gain; cls = ' gain'; }
  else if (use) { delta = `<i class="d dn">−${use}</i>`; count = n - use; cls = ' use'; }
  if (short) cls += ' short';
  else if (tight) cls += ' tight';
  const why = short ? `　还差 ${short}` : tight ? `　再合一个还差 ${tight}` : use ? `　消耗 ${use}，剩 ${n - use}` : '';
  return `<button class="tile${n ? '' : ' zero'}${on ? ' on' : ''}${cls}"
    data-add="${code}" title="${runeNo(code)} 号 ${esc(matZh(code))} · ${esc(matEn(code))}${why} — 点一下算它的合成">
    <span class="tno">${runeNo(code)}</span>${delta}
    <span class="tname">${esc(matZh(code).replace(/^符文：/, ''))}</span>
    <span class="tcnt">${count}</span></button>`;
}

function gemCell(code, use, short, tight) {
  const n = ownedOf(code);
  const rest = n - use;
  const cls = short ? 'short' : tight ? 'tight' : use ? 'use' : n ? '' : 'zero';
  const label = short ? `${rest}<i>差${short}</i>` : use ? `${rest}<i>−${use}</i>` : (n || '—');
  const why = short ? ` — 还差 ${short}` : tight ? ` — 再合一个还差 ${tight}` : use ? ` — 原有 ${n}，消耗 ${use}` : '';
  return `<td class="${cls}" title="${esc(matZh(code))}${why}">${label}</td>`;
}

function viewCube() {
  const s = report.summary;
  const code = state.target;
  const qty = Math.max(1, state.qty);

  // Everything you own is the starting material.
  const owned = {};
  for (const c of MATERIALS) owned[c] = ownedOf(c);

  let tree = null, consumed = {}, missing = {}, max = 0, blocking = {}, want = qty;
  if (code) {
    max = maxMakeable(code, owned);
    // Never ask for more than the material allows; "+" stops there too.
    want = max > 0 ? Math.min(qty, max) : 1;
    // plan() drains the pool it is given, so what is left afterwards is exactly
    // what one *more* would have to be built from.
    const rest = { ...owned };
    tree = plan(code, want, rest, false);
    ({ consumed, missing } = planTotals(tree));
    // At the ceiling, show what one more would run out of — that is why "+" is off.
    if (want >= max) blocking = planTotals(plan(code, 1, rest, false)).missing;
  }
  // Two different states, and conflating them reads as "cannot make any":
  //   short  — this plan cannot be completed, the material is genuinely missing
  //   tight  — this plan works, there just is not enough left for one *more*
  const shortOf = c => missing[c] || 0;
  const tightOf = c => (missing[c] ? 0 : blocking[c] || 0);

  /* ---- left column: stock, doubling as the receipt ---- */
  const socketedTotal = Object.values(report.socketed).reduce((a, b) => a + b, 0);
  const stock = `<div class="stock">
    <div class="stitle">仓库符文 <span class="thin">${s.runeCount} 个 · ${s.runeKinds} 种</span></div>
    <div class="tiles">${RUNES.map(c =>
      matRow(c, consumed[c] || 0, shortOf(c), tightOf(c), c === code && tree && tree.ok ? want : 0)).join('')}</div>
    <div class="stitle">仓库宝石 <span class="thin">${s.gemCount} 颗</span></div>
    <table class="gemtab">
      <thead><tr><th></th>${GEM_QUALITY.map(q => `<th>${q}</th>`).join('')}</tr></thead>
      <tbody>${Object.entries(GEMS).map(([label, codes]) => `<tr><th>${label}</th>${
        codes.map(c => gemCell(c, consumed[c] || 0, shortOf(c), tightOf(c))).join('')}</tr>`).join('')}</tbody>
    </table>
    ${socketedTotal ? `<div class="hint">另有 ${socketedTotal} 个已镶在装备里，拿不出来，不计入材料。</div>` : ''}
  </div>`;

  /* ---- right column: the one target and its answer ---- */
  // El is the bottom of the ladder: nothing cubes into it, so "can you make
  // one" is not a question that has an answer. Say that instead of "还差 1 个".
  if (code && !RECIPES[code]) {
    const n = ownedOf(code);
    return `<div class="cube"><div class="cubeleft">${stock}</div>
      <div class="cuberight"><h2 class="section">我要合成 <span class="thin">— 一次只算一种符文</span></h2>
        <div class="basket">
          <span class="bitem"><b>${runeNo(code)} 号 ${esc(matZh(code).replace(/^符文：/, ''))}</b></span>
          <button class="chip" data-clear="1">换一个</button>
        </div>
        <div class="verdict">🔨 ${esc(matZh(code))}是最低一级的符文，没有合成配方
          <div class="sub">只能靠打怪掉落。它是往上合成 ${runeNo(RUNES[1])} 号${
            esc(matZh(RUNES[1]).replace(/^符文：/, ''))}及以上的起点：3 个换 1 个。</div>
          <div class="sub">仓库里有 ${n} 个。</div>
        </div>
        ${n ? `<div class="hint">现货在：${copiesHtml(report.materials[code])}</div>` : ''}
      </div></div>`;
  }

  if (!code) {
    return `<div class="cube"><div class="cubeleft">${stock}</div>
      <div class="cuberight"><h2 class="section">我要合成</h2>
        <div class="empty">点左边任意一个符文，算算你的材料够不够合出它。</div></div></div>`;
  }

  const ok = tree.ok;
  const atMax = want >= max;
  const head = `<div class="basket">
    <span class="bitem">
      <button class="bq" data-sub="1"${want <= 1 ? ' disabled' : ''} title="少一个">−</button>
      <span class="bn">${want}</span>
      <button class="bq" data-plus="1"${atMax ? ' disabled' : ''}
        title="${atMax ? '材料只够这么多了' : '多一个'}">+</button>
      <b>${runeNo(code)} 号 ${esc(matZh(code).replace(/^符文：/, ''))}</b>
    </span>
    <button class="chip" data-clear="1">换一个</button>
    <span class="hint">材料最多能合 ${max} 个${ownedOf(code) ? ` · 仓库里另有 ${ownedOf(code)} 个现货` : ''}</span>
  </div>`;

  return `<div class="cube">
    <div class="cubeleft">${stock}</div>
    <div class="cuberight">
      <h2 class="section">我要合成 <span class="thin">— 一次只算一种符文</span></h2>
      ${head}
      <div class="verdict ${ok ? 'good' : 'bad'}">
        ${ok ? `✅ 可以合 ${want} 个 · ${runeNo(code)} 号 ${ownedOf(code)} → ${ownedOf(code) + want}`
             : '❌ 材料不够'}
        <div class="sub">${ok ? `将消耗：${matList(consumed)}` : `还差：${matList(missing)}`}</div>
        <div class="sub">${ok && atMax ? `这些材料最多就是 ${max} 个，再多要补：${matList(blocking)}`
                                       : ok ? '' : `这些材料最多凑出 ${max} 个`}</div>
      </div>
      ${ownedOf(code) ? `<div class="hint">现货在：${copiesHtml(report.materials[code])}</div>` : ''}
      <div class="plan">${planTree(tree)}</div>
    </div>
  </div>`;
}

// Cheapest first, so the consumed/missing lists read high-value material last.
const MATERIALS_ORDER = [...GEM_CODES, ...RUNES];

function renderView() {
  TIPS.clear(); tipSeq = 0;
  hideTip();
  if (state.mode === 'runes') { $('#view').innerHTML = viewCube(); return; }
  const fn = { sets: viewSets, uniques: viewUniques, lost: viewLost, dupes: viewDupes };
  $('#view').innerHTML = fn[state.tab]();
}

function render() {
  $('#intro').hidden = true;
  $('#main').hidden = false;
  const s = report.summary;
  setStatus(`已读取 ${s.files} 个存档文件 · ${s.totalItems} 件物品 · ${report.scannedAt}`);
  renderModes(); renderTop(); renderTabs(); renderFilters(); renderView();
}

$('#modes').addEventListener('click', e => {
  const b = e.target.closest ? e.target.closest('button[data-mode]') : null;
  if (!b || b.dataset.mode === state.mode) return;
  state.mode = b.dataset.mode;
  renderModes(); renderTop(); renderTabs(); renderFilters(); renderView();
});

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  renderTabs(); renderFilters(); renderView();
});

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.only !== undefined) state.only = b.dataset.only;
  if (b.dataset.slot !== undefined) state.slot = b.dataset.slot || null;
  if (b.dataset.sort !== undefined) state.sort = b.dataset.sort;
  renderFilters(); renderView();
});

/* The cube shopping list: add, subtract, drop, clear. */
$('#view').addEventListener('click', e => {
  const b = e.target.closest ? e.target.closest('button[data-add],button[data-sub],button[data-plus],button[data-clear]') : null;
  if (b && b.disabled) return;
  if (!b) return;
  const d = b.dataset;
  if (d.clear) { state.target = null; state.qty = 1; }
  else if (d.add) {
    // Clicking the rune already being solved for asks for one more of it.
    if (state.target === d.add) state.qty += 1; else { state.target = d.add; state.qty = 1; }
  } else if (d.plus) state.qty += 1;
  else if (d.sub) state.qty = Math.max(1, state.qty - 1);
  renderView();
});

$('#q').addEventListener('input', e => {
  state.q = e.target.value.trim().toLowerCase();
  if (report) renderView();
});

document.addEventListener('keydown', e => {
  if (e.key === 'r' && (e.metaKey || e.ctrlKey) && report) { e.preventDefault(); reload(); }
});

/* Re-open the last folder automatically when the browser still allows it. */
(async () => {
  if (!window.showDirectoryPicker) {
    $('#nofsa').hidden = false;
    return;
  }
  const handle = await loadHandle();
  if (!handle) return;
  const perm = handle.queryPermission ? await handle.queryPermission({ mode: 'read' }) : 'granted';
  if (perm === 'granted') {
    loadFromHandle(handle);
  } else {
    dirHandle = handle;
    setStatus('上次的存档文件夹已记住，点「重新读取」授权后即可载入。');
  }
})();
