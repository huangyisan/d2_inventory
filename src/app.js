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
let state = { mode: 'gear', tab: 'sets', q: '', slot: null, only: 'all', sort: 'progress',
  target: null, qty: 1, day: 0, affixes: [], bases: [], zone: null,
  skClass: 'sor', skLevel: 99, skQuests: true, skPts: {},
  dropBy: 'kill', pace: {}, mf: 0, glv: 99 };
// target/qty: the one rune the cube page is solving for, and how many of it.
// day: which day the terror-zone list is showing, 0 = today.
// affixes: the affix keys that must ALL be present, the filter's AND list.
// bases: same idea on the runeword-base tab (white / superior / ethereal / sockets).
// zone: index into the terror-zone table when following one zone, else null.
// sk*: the skill planner's class, character level, quest bonus and spent points.
// dropBy/pace: per-kill vs per-hour on the rune drop panel, and your own run pace.
// mf: your magic find, which only ever affects item drops — never runes.

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
/*
 * Skill icons are the one thing this page cannot ship: they are the game's own
 * art. So the player points it at a folder ripped from their own install and
 * the images are kept here, on their machine — never uploaded, never part of
 * the bundle. Stored as data URLs so they survive a refresh without asking for
 * folder permission again.
 */
/* Where backups go. Kept apart from the save folder handle on purpose: that
 * one is opened read-only and must stay that way. */
const saveBackupDir = h => idb('readwrite', s => s.put(h, 'backupdir')).catch(() => {});
const loadBackupDir = () => idb('readonly', s => s.get('backupdir')).catch(() => null);
const saveMF = n => idb('readwrite', s => s.put(n, 'mf')).catch(() => {});
const loadMF = () => idb('readonly', s => s.get('mf')).catch(() => null);
const saveGlv = n => idb('readwrite', s => s.put(n, 'glv')).catch(() => {});
const loadGlv = () => idb('readonly', s => s.get('glv')).catch(() => null);
const savePace = m => idb('readwrite', s => s.put(m, 'pace')).catch(() => {});
const loadPace = () => idb('readonly', s => s.get('pace')).catch(() => null);
const saveIcons = m => idb('readwrite', s => s.put(m, 'icons')).catch(() => {});
const loadIcons = () => idb('readonly', s => s.get('icons')).catch(() => null);

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

/*
 * What to call an item in the affix list. Uniques, set pieces and runewords
 * have real names in the catalogue; rares and magics do not — the save stores
 * their affixes as numbers, not as the assembled name — so those fall back to
 * the base item plus a quality word, which is what you would recognise anyway.
 */
const QUALITY_ZH = { inferior: '低劣', normal: '普通', superior: '高质量',
  magic: '魔法', set: '套装', rare: '稀有', unique: '暗金', crafted: '打造', tempered: '淬炼' };

function gearName(it) {
  if (it.runeword && CATALOG.runewords[it.runewordId]) {
    const [en, zh] = CATALOG.runewords[it.runewordId];
    return { zh, name: en, kind: 'runeword', base_zh: it.baseZh || it.baseName };
  }
  if (it.uniqueId !== null && CAT.uniqueById.has(it.uniqueId)) {
    const u = CATALOG.uniques[CAT.uniqueById.get(it.uniqueId)];
    return { zh: u.zh, name: u.name, kind: 'unique', base_zh: it.baseZh || it.baseName };
  }
  if (it.setId !== null && CAT.setById.has(it.setId)) {
    const [gi, pi] = CAT.setById.get(it.setId);
    const p = CATALOG.sets[gi].pieces[pi];
    return { zh: p.zh, name: p.name, kind: 'set', base_zh: it.baseZh || it.baseName };
  }
  const base = it.baseZh || it.baseName || it.code;
  return { zh: base, name: it.baseName || it.code, kind: it.quality, base_zh: base };
}

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
  // Every wearable you actually own, with its rolled affixes, for the affix
  // filter. Rares and magics live only here — no catalogue lists them.
  const gear = [];
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
      // Anything you could wear. Plain white armour and weapons carry no
      // affixes at all, so "has stats" would drop exactly the items that make
      // the best runeword bases — the base-item flags decide instead.
      const b = CATALOG.bases[it.code];
      // FLAG_ARMOR / FLAG_WEAPON come from the parser's own flag table.
      const wearable = !!(b && (b[2] & (FLAG_ARMOR | FLAG_WEAPON)));
      if (!it.socketedIn && (wearable || (it.stats || []).length)) {
        gear.push({ ...copy, ...gearName(it), slot: it.slot, quality: it.quality,
          code: it.code, stats: it.stats, wearable,
          sockets: it.sockets || 0, ethereal: !!it.ethereal });
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
    sources: sourceRows, uniques, sets, hasChronicle, materials, socketed, gear,
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
/* Backup: copy the whole folder somewhere safe, byte for byte          */
/* ------------------------------------------------------------------ */
/*
 * What gets backed up is the folder, not the parse. The page only reads .d2s
 * and .d2i, but the folder also holds the shared stash, the settings, and the
 * per-character control files — losing those is still losing something, and
 * deciding for you which ones matter is exactly the judgement call you should
 * not have to make. So: everything under the folder, subfolders included, at
 * the bytes it has on disk right now.
 *
 * Preferred output is plain files in a folder you pick, because restoring is
 * then a drag back rather than an unzip. The zip writer below stays as the
 * fallback for browsers with no write access (Safari, Firefox).
 */
async function walkFolder(handle, prefix = '') {
  const out = [];
  for await (const entry of handle.values()) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      out.push({ name, entry });
    } else if (entry.kind === 'directory') {
      out.push(...await walkFolder(entry, name));
    }
  }
  return out;
}


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

function downloadZip(files, when, folder) {
  const blob = makeZip(files.map(f => ({ name: `${folder}/${f.name}`, data: f.data })), when);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${folder}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return blob.size;
}

/*
 * Where backups go, remembered so the second one is a single click.
 *
 * `repick` forces the chooser open again: a remembered folder is a
 * convenience, not a commitment, and moving to a new disk should not mean
 * clearing site data.
 */
async function backupDestination({ repick = false } = {}) {
  let dest = repick ? null : await loadBackupDir();
  if (dest && dest.queryPermission) {
    let perm = await dest.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && dest.requestPermission) {
      perm = await dest.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') dest = null;
  }
  if (dest) return dest;
  dest = await window.showDirectoryPicker({ mode: 'readwrite', id: 'd2backupdest' });
  // Writing the backup inside the save folder would grow it every time and put
  // stray files where the game looks for saves.
  if (dirHandle && dest.isSameEntry && await dest.isSameEntry(dirHandle)) {
    throw new Error('备份不能放在存档文件夹本身，换一个位置');
  }
  await saveBackupDir(dest);
  return dest;
}

/* Show which folder backups land in, and offer to change it. */
async function showBackupDest() {
  const btn = $('#rebackup');
  if (!btn) return;
  const dest = window.showDirectoryPicker ? await loadBackupDir() : null;
  btn.hidden = !dest;
  if (dest) btn.textContent = `更改备份位置（现在是 ${dest.name}）`;
}

/* Change where backups go. Only that — it does not also run a backup. */
async function changeBackupDest() {
  let dest;
  try {
    dest = await backupDestination({ repick: true });
  } catch (err) {
    if (err.name === 'AbortError') { setStatus('位置没有改动。'); return; }
    setStatus(`选备份位置失败：${esc(err.message)}`);
    return;
  }
  await showBackupDest();
  setStatus(`以后备份存到 <b>${esc(dest.name)}</b>。这次没有备份，点「备份存档」才会写入。`);
}

async function backupNow() {
  const when = new Date();
  const folder = `d2r-存档备份-${stamp(when)}`;

  // No folder handle means the file-input fallback was used: all that exists
  // is the saves already in memory, and there is nothing to write with.
  if (!dirHandle) {
    if (!backupSet.length) return;
    const size = downloadZip(backupSet, when, folder);
    setStatus(`已导出 ${esc(folder)}.zip（${backupSet.length} 个存档，约 ${Math.round(size / 1024)} KB）。` +
      `这个浏览器只能读取，备份里仅有存档本身。`);
    return;
  }

  setStatus('正在备份…', true);
  let files;
  try {
    files = await walkFolder(dirHandle);
  } catch (err) {
    setStatus(`备份失败，读不了文件夹：${esc(err.message)}`);
    return;
  }
  if (!files.length) { setStatus('文件夹是空的，没有可备份的内容。'); return; }

  // Browsers with no write access get the archive instead; that path does have
  // to hold everything in memory, but a save folder is a couple of megabytes.
  if (!window.showDirectoryPicker) {
    const blobs = [];
    for (const f of files) {
      blobs.push({ name: f.name, data: new Uint8Array(await (await f.entry.getFile()).arrayBuffer()) });
    }
    const size = downloadZip(blobs, when, folder);
    setStatus(`已导出 ${esc(folder)}.zip（${blobs.length} 个文件，约 ${Math.round(size / 1024)} KB）。`);
    return;
  }

  // Ask where to put it before doing any work, so the folder chooser is not
  // sitting behind a wait the user cannot see the reason for.
  let dest;
  try {
    dest = await backupDestination();
    showBackupDest();
  } catch (err) {
    if (err.name === 'AbortError') { setStatus('已取消备份。'); return; }
    setStatus(`选备份位置失败：${esc(err.message)}`);
    return;
  }

  let done = 0;
  let bytes = 0;
  const tick = () => setStatus(`正在备份… ${done}/${files.length}`, true);
  tick();

  try {
    const root = await dest.getDirectoryHandle(folder, { create: true });

    // Subfolders are created once and shared, not re-resolved per file.
    const dirs = new Map([['', root]]);
    const dirFor = async prefix => {
      if (dirs.has(prefix)) return dirs.get(prefix);
      const cut = prefix.lastIndexOf('/');
      const parent = await dirFor(cut < 0 ? '' : prefix.slice(0, cut));
      const handle = await parent.getDirectoryHandle(prefix.slice(cut + 1), { create: true });
      dirs.set(prefix, handle);
      return handle;
    };

    const copy = async f => {
      const cut = f.name.lastIndexOf('/');
      const dir = await dirFor(cut < 0 ? '' : f.name.slice(0, cut));
      const file = await f.entry.getFile();
      const fh = await dir.getFileHandle(f.name.slice(cut + 1), { create: true });
      const w = await fh.createWritable();
      // Hand the File straight over: no arrayBuffer copy, no second pass.
      await w.write(file);
      await w.close();
      bytes += file.size;
      done++;
      tick();
    };

    /*
     * Copy several at a time.
     *
     * The cost here is not the bytes — a save folder is under 3 MB. It is that
     * every single file costs a createWritable/close round trip, and the
     * browser implements close() as an atomic swap-and-rename with a disk
     * flush. That is tens of milliseconds each, and a hundred files done
     * strictly one after another spends nearly all of its time waiting. They
     * are independent, so run a handful concurrently and the waiting overlaps.
     */
    const queue = files.slice();
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await copy(f);
    });
    await Promise.all(workers);
  } catch (err) {
    setStatus(`写入备份失败（已写 ${done}/${files.length}）：${esc(err.message)}`);
    return;
  }

  setStatus(`已备份 ${done} 个文件（约 ${Math.round(bytes / 1024)} KB）到 ` +
    `<b>${esc(dest.name)}/${esc(folder)}</b>，原样复制，存档没有改动。`);
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
$('#backup').addEventListener('click', () => backupNow());
$('#rebackup').addEventListener('click', changeBackupDest);
showBackupDest();

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
// Three things this tool does, kept apart: collecting gear, cubing runes, and
// telling you where the terror zone is. Only the first two need a save file.
const MODES = [['gear', '装备收藏'], ['runes', '符文合成'], ['tz', '恐怖地带'], ['skills', '天赋模拟']];
const GEAR_TABS = [['sets', '套装收集'], ['uniques', '暗金收集'], ['affix', '词条筛选'],
  ['base', '底材筛选'], ['lost', '找回清单'], ['dupes', '重复清理']];
// The chronicle tab only exists in D2R saves that have one.
const TABS = () => (state.mode !== 'gear' || !report ? []
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
  // An item with no listed properties can still be worth hovering if we know
  // where it drops.
  if ((!entry.props || !entry.props.length) && !ITEM_DROPS.items[entry.name]) return '';
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
    <div class="tbody">${(e.props || []).map(line).join('')}</div>
    ${e.bonus && e.bonus.length ? `<div class="tbonus"><div class="tlabel">套装加成</div>${e.bonus.map(line).join('')}</div>` : ''}
    ${dropTip(e.name)}
    <div class="tfoot">数值取自游戏数据表，区间表示该属性会浮动</div>`;
}


/* ------------------------------------------------------------------ */
/* Where an item drops                                                 */
/* ------------------------------------------------------------------ */
/*
 * Precomputed by make_itemdrops.py at zero magic find, plus the two numbers
 * needed to rescale for any magic find — because magic find is a property of
 * your character, not of the game tables.
 *
 * Magic find has diminishing returns on uniques and sets, and by different
 * amounts: the factor is 250 for uniques, 500 for sets. 1000 MF is worth about
 * 3x on a unique, not 11x.
 */
const ITEM_DROPS = DROPS_ITEMS;
const MF_FACTOR = { u: 250, s: 500 };

const effectiveMF = (mf, kind) => {
  const f = MF_FACTOR[kind] || 250;
  return mf > 0 ? Math.floor((mf * f) / (mf + f)) : 0;
};

/* Rescale the stored zero-MF answer to the magic find you actually carry. */
function dropChance(row, kind, mf) {
  const [, p0, cb, mn] = row;
  const at0 = Math.max(mn, cb);
  const atMF = Math.max(mn, Math.floor((cb * 100) / (100 + effectiveMF(mf, kind))));
  return p0 * (at0 / atMF);
}

/*
 * Gambling, kept in its own block on purpose.
 *
 * It shares no step with the boss numbers above it: no treasure class, no
 * monster, and magic find does nothing at all. The only thing that moves it is
 * your level, because every unique of the same base that your level unlocks
 * takes a slice of the same pie. Putting the two side by side under one
 * heading would invite adding them together, which is wrong.
 */
function gambleShare(rec, level) {
  let share = 0;
  for (const [min, s] of rec.steps) {
    if (level < min) break;
    share = s;
  }
  return share;
}

function gambleTip(name) {
  const rec = GAMBLE.items[name];
  if (!rec) return '';
  const level = state.glv || 99;
  const share = gambleShare(rec, level);
  const best = rec.steps[0];
  const p = GAMBLE.rate[rec.k] * share;

  // Too low to roll it at all: the pool it would come from does not exist yet.
  if (!share) {
    return `<div class="tgamble">
      <div class="tlabel">赌博 <span class="thin">不受魔法寻找影响</span></div>
      <div class="tdnote">${level} 级赌不出，物品等级要到 <b>${best[0]}</b></div>
    </div>`;
  }

  // Worth flagging only when dropping down actually buys something.
  const gain = best[1] / share;
  const window = gain > 1.05
    ? `<div class="tdnote">卡在 <b>${best[0]}</b> 级赌是
       <b>1 / ${Math.round(1 / (GAMBLE.rate[rec.k] * best[1])).toLocaleString('zh-CN')}</b>，
       快 ${gain.toFixed(1)} 倍 —— 高等级会放更多同底材暗金进来抢名额</div>`
    : `<div class="tdnote">等级高低对它没影响</div>`;

  return `<div class="tgamble">
    <div class="tlabel">赌博 <span class="thin">${level} 级 · 不受魔法寻找影响</span></div>
    <div class="tdrow"><span>每赌一件</span>
      <b>1 / ${Math.round(1 / p).toLocaleString('zh-CN')}</b></div>
    ${window}
  </div>`;
}

function dropTip(name) {
  const rec = ITEM_DROPS.items[name];
  const gamble = gambleTip(name);
  if (!rec) return gamble;
  const mf = state.mf || 0;
  const rows = rec.rows
    .map(r => ({ t: ITEM_DROPS.targets[r[0]], p: dropChance(r, rec.k, mf) }))
    .sort((a, b) => b.p - a.p);
  return `<div class="tdrop">
    <div class="tlabel">上哪掉 <span class="thin">地狱 · 魔法寻找 ${mf}</span></div>
    ${rows.map(r => `<div class="tdrow"><span>${esc(r.t.zh)}</span>
      <b>1 / ${Math.round(1 / r.p).toLocaleString('zh-CN')}</b></div>`).join('')}
    <div class="tdnote">${rec.rivals > 1
      ? `同底材还有 <b>${rec.rivals - 1}</b> 件在抢这个名额`
      : '独占这个底材，不和别的抢'}</div>
  </div>${gamble}`;
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
  // The terror-zone page stands alone: no save, so no summary cards.
  if (state.mode === 'tz' || state.mode === 'skills' || !report) {
    $('#cards').innerHTML = '';
    $('#warnings').innerHTML = '';
    return;
  }
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
  // Magic find and gamble level only mean anything where chances are shown.
  const onDropTab = report && state.mode === 'gear' &&
    ['uniques', 'sets', 'lost'].includes(state.tab);
  for (const [wrap, box, val] of [['#mfwrap', '#mf', state.mf],
                                  ['#glvwrap', '#glv', state.glv]]) {
    const w = $(wrap);
    if (!w) continue;
    w.hidden = !onDropTab;
    const b = $(box);
    if (b && String(b.value) !== String(val)) b.value = val;
  }
  $('#tabs').innerHTML = tabs.map(([k, l]) =>
    `<button class="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('');
  // The cube page has nothing to search or filter, so the whole bar goes away.
  $('#toolbar').hidden = !tabs.length;
}

function renderFilters() {
  if (state.mode !== 'gear' || !report) { $('#filters').innerHTML = ''; return; }
  const showSlot = ['uniques', 'lost', 'affix', 'base'].includes(state.tab);
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
        ${dropPanel(code)}
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
      ${dropPanel(code)}
    </div>
  </div>`;
}

// Cheapest first, so the consumed/missing lists read high-value material last.
const MATERIALS_ORDER = [...GEM_CODES, ...RUNES];


/* ------------------------------------------------------------------ */
/* Rune drop rates                                                     */
/* ------------------------------------------------------------------ */
/*
 * Where a rune actually comes from, computed by make_drops.py by walking the
 * game's treasure-class tree. The number is the expected count per kill, which
 * at these odds is the same as "chance to see one".
 *
 * The useful part is not the odds so much as the ceiling: most bosses cannot
 * roll the high runes at all, because their chain tops out at a low "Runes N".
 * Hell Countess showers you with runes and still cannot hand you a 25.
 */
const DROP_IDX = new Map(DROPS.runes.map((c, i) => [c, i]));

/*
 * Per-hour needs two numbers the game files do not have: how long a run takes
 * and how many drop-eligible kills it yields. Those are yours, not the game's,
 * so they start as estimates and stay editable — and the per-kill column is
 * always shown next to them, because that half *is* game data.
 */
const pace = t => ({ ...t, ...(state.pace[t.key] || {}) });
const perHour = t => {
  const p = pace(t);
  return p.secs > 0 ? (3600 / p.secs) * p.kills : 0;
};

const oneIn = e => e >= 1 ? `${e.toFixed(2)} 个/杀`
  : `1 / ${Math.round(1 / e).toLocaleString('zh-CN')}`;

// "一年半" beats "0.00061 个/小时" when the answer is "basically never".
function waitLabel(perHourRate) {
  if (!perHourRate) return '—';
  if (perHourRate >= 1) return `${perHourRate.toFixed(1)} 个/小时`;
  const hours = 1 / perHourRate;
  if (hours < 48) return `平均 ${hours.toFixed(1)} 小时 1 个`;
  const days = hours / 24;
  if (days < 400) return `平均 ${days.toFixed(0)} 天 1 个`;
  return `平均 ${(days / 365).toFixed(1)} 年 1 个`;
}

function dropRows(code) {
  const i = DROP_IDX.get(code);
  if (i === undefined) return [];
  const rows = DROPS.targets
    .map(t => ({ ...pace(t), rate: t.rates[i] }))
    .filter(t => t.rate > 0);
  for (const t of rows) t.hourly = t.rate * perHour(t);
  const key = state.dropBy === 'hour' ? 'hourly' : 'rate';
  return rows.sort((a, b) => b[key] - a[key]);
}

function dropPanel(code) {
  const rows = dropRows(code);
  const zh = matZh(code);
  const byHour = state.dropBy === 'hour';
  if (!rows.length) {
    const best = DROPS.targets.reduce((m, t) => Math.max(m, t.top), 0);
    return `<div class="drops">
      <h3>${runeNo(code)} 号 ${esc(zh)} 上哪掉</h3>
      <div class="empty">列表里的目标都掉不出这个符文（最高只到 ${best} 号）。
        这一档只能靠恐怖地带里的高等级怪，或者自己合成。</div>
    </div>`;
  }
  const best = byHour ? rows[0].hourly : rows[0].rate;
  return `<div class="drops">
    <h3>${runeNo(code)} 号 ${esc(zh)} 上哪掉 <span class="thin">地狱难度 · 单人</span>
      <span class="sp"></span>
      <button class="chip" data-dropby="kill" aria-pressed="${!byHour}">按每杀</button>
      <button class="chip" data-dropby="hour" aria-pressed="${byHour}">按每小时</button>
    </h3>
    <div class="droplist">${rows.map(t => {
      const v = byHour ? t.hourly : t.rate;
      return `<div class="droprow${v === best ? ' best' : ''}">
        <span class="a">第${'一二三四五'[t.act - 1]}幕</span>
        <span class="n">${esc(t.zh)}</span>
        ${byHour ? `<span class="pace">
          <input class="pn" type="number" min="1" max="3600" value="${t.secs}"
                 data-pace="${t.key}" data-field="secs" title="一趟几秒">秒
          <span class="x">×</span>
          <input class="pn" type="number" min="1" max="999" value="${t.kills}"
                 data-pace="${t.key}" data-field="kills" title="一趟能杀几只">只
        </span>` : ''}
        <span class="r">${byHour ? waitLabel(v) : oneIn(v)}</span>
        ${v === best ? '<span class="rec">推荐</span>' : ''}
      </div>`;
    }).join('')}</div>
    <p class="hint">${byHour
      ? '每趟的<b>秒数</b>和<b>能杀几只</b>是可以改的估计值 —— 游戏数据里没有这两个数，' +
        '它取决于你的角色。改完这里算的才是你自己的节奏。掉率本身是算出来的，不受影响。'
      : '数字是每杀一次期望掉几个，由游戏掉落表逐层算出，不是抄来的。'}<br>
      魔法寻找对符文<b>没有</b>影响；多人游戏会降低空掉率，这里按单人算。
      掉不出某个符文的目标直接不列 —— 那是掉落表的硬上限，刷再多也不会出。</p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Affix filter                                                        */
/* ------------------------------------------------------------------ */
/*
 * The affixes worth hunting for, grouped the way players talk about them.
 * These are stat ids from the game's own itemstatcost table; an entry matches
 * an item when any of its ids is present with a non-zero value, and the shown
 * number is the largest of them.
 *
 * Deliberately a shortlist, not all ~370 stats: the point is "rings with cast
 * rate and resists", and a wall of every possible stat would bury that.
 */
const AFFIXES = [
  { key: 'fcr', zh: '施法速度', unit: '%', ids: [105] },
  { key: 'ias', zh: '攻击速度', unit: '%', ids: [93] },
  { key: 'fhr', zh: '受击回复', unit: '%', ids: [99] },
  { key: 'fbr', zh: '格挡率', unit: '%', ids: [102] },
  { key: 'frw', zh: '跑步速度', unit: '%', ids: [96] },
  { key: 'res', zh: '抗性', unit: '%', ids: [39, 41, 43, 45] },
  { key: 'fres', zh: '火抗', unit: '%', ids: [39] },
  { key: 'cres', zh: '冰抗', unit: '%', ids: [43] },
  { key: 'lres', zh: '电抗', unit: '%', ids: [41] },
  { key: 'pres', zh: '毒抗', unit: '%', ids: [45] },
  { key: 'life', zh: '生命', unit: '', ids: [7] },
  { key: 'mana', zh: '法力', unit: '', ids: [9] },
  { key: 'str', zh: '力量', unit: '', ids: [0] },
  { key: 'dex', zh: '敏捷', unit: '', ids: [2] },
  { key: 'vit', zh: '体力', unit: '', ids: [3] },
  { key: 'enr', zh: '精力', unit: '', ids: [1] },
  { key: 'allsk', zh: '全部技能', unit: '', ids: [127] },
  { key: 'clssk', zh: '职业技能', unit: '', ids: [83] },
  { key: 'tabsk', zh: '技能树', unit: '', ids: [188] },
  { key: 'mf', zh: '魔法寻找', unit: '%', ids: [80] },
  { key: 'gf', zh: '金币掉落', unit: '%', ids: [79] },
  { key: 'll', zh: '偷取生命', unit: '%', ids: [60] },
  { key: 'ml', zh: '偷取法力', unit: '%', ids: [62] },
  { key: 'ds', zh: '致命一击', unit: '%', ids: [141] },
  { key: 'cb', zh: '压碎打击', unit: '%', ids: [136] },
  { key: 'ow', zh: '撕裂伤口', unit: '%', ids: [135] },
  { key: 'ed', zh: '增强伤害', unit: '%', ids: [17] },
  { key: 'edef', zh: '增强防御', unit: '%', ids: [16] },
  { key: 'ar', zh: '攻击准确率', unit: '', ids: [19] },
  { key: 'pdr', zh: '物理伤害减免', unit: '', ids: [36] },
  { key: 'mdr', zh: '魔法伤害减免', unit: '', ids: [37] },
  { key: 'cnf', zh: '不会被冰冻', unit: '', ids: [153], flag: true },
  { key: 'req', zh: '需求降低', unit: '%', ids: [91] },
];
const AFFIX_BY_KEY = new Map(AFFIXES.map(a => [a.key, a]));

/*
 * The best value an item has for one affix group, or null when it has none.
 *
 * A few stats are stored as fixed point — life and mana count in 1/256ths —
 * so the raw number has to be scaled back down to what the game shows you.
 */
function affixValue(item, a) {
  let best = null;
  for (const s of item.stats) {
    if (!a.ids.includes(s.id) || !s.value) continue;
    const shift = CAT.stat(s.id).shift || 0;
    const v = shift ? Math.round(s.value / (1 << shift)) : s.value;
    if (!v) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

function viewAffix() {
  const picked = state.affixes.map(k => AFFIX_BY_KEY.get(k)).filter(Boolean);

  const chips = AFFIXES.map(a =>
    `<button class="chip" data-affix="${a.key}" aria-pressed="${state.affixes.includes(a.key)}">${a.zh}</button>`).join('');

  let html = `<div class="afbar">
    <div class="aftitle">要求同时具备（与）：${picked.length
      ? picked.map(a => `<b>${a.zh}</b>`).join(' + ')
      : '<span class="thin">还没选，下面列出全部有词条的物品</span>'}
      ${picked.length ? '<button class="chip clr" data-affix="">清空</button>' : ''}</div>
    <div class="afchips">${chips}</div>
  </div>`;

  // AND: an item has to carry every picked affix, not just one of them.
  let rows = report.gear.filter(g =>
    (!state.slot || g.slot === state.slot) &&
    hit(g, state.q) &&
    picked.every(a => affixValue(g, a) !== null));

  // Best first on the affix you picked first — that is the one you care about.
  const lead = picked[0];
  rows = rows.slice().sort((x, y) => {
    if (lead) {
      const d = (affixValue(y, lead) || 0) - (affixValue(x, lead) || 0);
      if (d) return d;
    }
    return (SLOTS.indexOf(x.slot) - SLOTS.indexOf(y.slot)) || x.zh.localeCompare(y.zh, 'zh');
  });

  html += `<div class="afcount">符合的物品：<b>${rows.length}</b> 件${
    rows.length > 300 ? '（只显示前 300 件）' : ''}</div>`;

  if (!rows.length) {
    html += '<div class="empty">没有同时满足这些词条的物品。少选一两个再试。</div>';
    return html;
  }

  html += '<div class="aflist">';
  for (const g of rows.slice(0, 300)) {
    // Show the affixes you asked for first, then whatever else it happens to
    // have from the shortlist — so the reason it matched is always on top.
    const shown = [];
    for (const a of picked) shown.push([a, affixValue(g, a), true]);
    for (const a of AFFIXES) {
      if (a.key === 'res' || picked.includes(a)) continue;
      const v = affixValue(g, a);
      if (v !== null) shown.push([a, v, false]);
    }
    const kind = g.kind === 'unique' ? 'u' : g.kind === 'set' ? 's'
      : g.kind === 'runeword' ? 'w' : g.kind === 'rare' ? 'r' : g.kind === 'crafted' ? 'c' : 'm';
    html += `<div class="afitem">
      <div class="afhead">
        <span class="afname k${kind}">${esc(g.zh)}</span>
        ${QUALITY_ZH[g.quality] && !['unique', 'set'].includes(g.kind)
          ? `<span class="afslot">${QUALITY_ZH[g.quality]}</span>` : ''}
        ${g.slot !== g.zh ? `<span class="afslot">${esc(g.slot)}</span>` : ''}
        ${g.base_zh && g.base_zh !== g.zh ? `<span class="afbase">${esc(g.base_zh)}</span>` : ''}
        ${g.ethereal ? '<span class="afbase">虚空</span>' : ''}
        ${g.sockets ? `<span class="afbase">${g.sockets}孔</span>` : ''}
      </div>
      <div class="afwhere">${copiesHtml([g], { sockets: false })}</div>
      <div class="afmods">${shown.map(([a, v, want]) =>
        `<span class="afmod${want ? ' want' : ''}">${a.flag ? a.zh
          : `${a.zh} ${v > 0 ? '+' : ''}${v}${a.unit}`}</span>`).join('')}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}


/*
 * Runeword / crafting bases: the plain white and ethereal gear sitting in your
 * stash. These carry no affixes, so the affix filter cannot reach them — what
 * matters here is quality, sockets and whether it is ethereal.
 */
const BASE_FILTERS = [
  { key: 'normal', zh: '白装', hit: g => g.quality === 'normal' },
  { key: 'superior', zh: '高质量', hit: g => g.quality === 'superior' },
  { key: 'eth', zh: '无形', hit: g => g.ethereal },
  { key: 'socketed', zh: '已开孔', hit: g => g.sockets > 0 },
  { key: 'empty', zh: '没开孔', hit: g => !g.sockets },
];
const BASE_BY_KEY = new Map(BASE_FILTERS.map(f => [f.key, f]));

function viewBases() {
  const picked = state.bases.map(k => BASE_BY_KEY.get(k)).filter(Boolean);

  let html = `<div class="afbar">
    <div class="aftitle">同时满足（与）：${picked.length
      ? picked.map(f => `<b>${f.zh}</b>`).join(' + ')
      : '<span class="thin">还没选，下面列出全部可当底材的装备</span>'}
      ${picked.length ? '<button class="chip clr" data-base="">清空</button>' : ''}</div>
    <div class="afchips">${BASE_FILTERS.map(f =>
      `<button class="chip" data-base="${f.key}" aria-pressed="${state.bases.includes(f.key)}">${f.zh}</button>`).join('')}</div>
  </div>`;

  // A finished runeword sits on a white base and reads as "normal" quality in
  // the save, but it is spent — you cannot build anything else on it.
  let rows = report.gear.filter(g => g.wearable && g.kind !== 'runeword' &&
    (!state.slot || g.slot === state.slot) &&
    hit(g, state.q) &&
    picked.every(f => f.hit(g)));

  // Most sockets first: that is what decides which runewords a base can hold.
  rows = rows.slice().sort((x, y) => (y.sockets - x.sockets) ||
    (SLOTS.indexOf(x.slot) - SLOTS.indexOf(y.slot)) || x.zh.localeCompare(y.zh, 'zh'));

  const eth = rows.filter(g => g.ethereal).length;
  html += `<div class="afcount">符合的装备：<b>${rows.length}</b> 件${
    eth ? `（其中无形 ${eth} 件）` : ''}
    <span class="thin">已做成符文之语的不算，那些底材已经用掉了</span></div>`;

  if (!rows.length) {
    html += '<div class="empty">存档里没有同时满足这些条件的装备。</div>';
    return html;
  }

  html += '<div class="aflist">';
  for (const g of rows) {
    const kind = g.kind === 'unique' ? 'u' : g.kind === 'set' ? 's'
      : g.kind === 'runeword' ? 'w' : g.kind === 'rare' ? 'r' : g.kind === 'crafted' ? 'c' : 'm';
    html += `<div class="afitem">
      <div class="afhead">
        <span class="afname k${kind}">${esc(g.zh)}</span>
        ${QUALITY_ZH[g.quality] && !['unique', 'set'].includes(g.kind)
          ? `<span class="afslot">${QUALITY_ZH[g.quality]}</span>` : ''}
        ${g.slot !== g.zh ? `<span class="afslot">${esc(g.slot)}</span>` : ''}
        ${g.base_zh && g.base_zh !== g.zh ? `<span class="afbase">${esc(g.base_zh)}</span>` : ''}
      </div>
      <div class="afwhere">${copiesHtml([g], { sockets: false })}</div>
      <div class="afmods">
        <span class="afmod${g.sockets ? ' want' : ''}">${g.sockets ? `${g.sockets} 孔` : '无孔'}</span>
        ${g.ethereal ? '<span class="afmod eth">无形</span>' : ''}
        ${g.ilvl ? `<span class="afmod">物品等级 ${g.ilvl}</span>` : ''}
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

/* ------------------------------------------------------------------ */
/* Terror zones                                                        */
/* ------------------------------------------------------------------ */
/*
 * Offline terror zones are not rolled by your machine — every offline game
 * walks the same fixed calendar — so the whole schedule ships inside this page
 * and nothing here touches the network. Online zones are a different rotation
 * picked by Blizzard's servers, and this page deliberately does not guess at it.
 */
const TZ_START = Date.parse(TZ.start);
const TZ_STEP = TZ.step * 1000;
const TZ_COUNT = TZ.slots.length;
const TZ_END = TZ_START + TZ_STEP * TZ_COUNT;

const ACT_ZH = ['', '一', '二', '三', '四', '五'];
const actZh = n => `第${ACT_ZH[n] || n}幕`;

// Which slot covers an instant, or -1 when the baked-in calendar doesn't reach.
function tzSlot(ms) {
  if (ms < TZ_START || ms >= TZ_END) return -1;
  return Math.floor((ms - TZ_START) / TZ_STEP);
}

const tzIndex = i => TZ.alphabet.indexOf(TZ.slots[i]);
const tzZone = i => TZ.zones[tzIndex(i)];
const tzTime = i => new Date(TZ_START + i * TZ_STEP);

// Always spell dates the Chinese way; the browser default can be dd/mm/yyyy.
const tzDate = ms => new Date(ms).toLocaleDateString('zh-CN',
  { year: 'numeric', month: 'long', day: 'numeric' });
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const mmss = ms => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// "今天 / 明天 / 8月18日 周二" — how far off a day is, said the short way.
function dayLabel(d) {
  const off = Math.round((new Date(d).setHours(0, 0, 0, 0) - tzMidnight(0).getTime()) / 86400000);
  if (off === 0) return '今天';
  if (off === 1) return '明天';
  if (off === 2) return '后天';
  if (off === -1) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

// Local midnight, `off` days from today — the day boundary the player thinks in.
function tzMidnight(off) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + off);
  return d;
}

function viewTz() {
  const now = Date.now();
  const cur = tzSlot(now);
  if (cur < 0) {
    return `<div class="warn">页面内置的恐怖地带排期只覆盖 ${tzDate(TZ_START)} 到
      ${tzDate(TZ_END)}，现在不在范围内。重新运行 <code>python3 make_tz.py</code>
      拉取新排期后重新打包即可。</div>`;
  }

  // No banner and no hover text: the calendar says the time, the act and the
  // map, and that is the whole of it. The countdown rides on the current strip.
  const ends = TZ_START + (cur + 1) * TZ_STEP;
  const countdown = `<b class="tzleft" id="tzleft" data-ends="${ends}">${mmss(ends - now)}</b>`;

  // Everything on this page shares one width box, so the calendar's right edge
  // lands exactly under the zone picker's rather than running off across the page.
  let html = '<div class="tzwrap">';

  // Zone picker. Sorted by act then name, so it reads like the waypoint list.
  const order = TZ.zones.map((z, i) => [z, i])
    .sort(([a, ai], [b, bi]) => (a.act - b.act) || a.zh.localeCompare(b.zh, 'zh') || (ai - bi));
  html += `<div class="tzpick">
    <label for="tzzone">只看某个地区：</label>
    <select id="tzzone" class="tzsel" data-zone>
      <option value=""${state.zone === null ? ' selected' : ''}>全部地区</option>
      ${order.map(([zz, i]) =>
        `<option value="${i}"${state.zone === i ? ' selected' : ''}>${actZh(zz.act)} · ${esc(zz.zh)}</option>`).join('')}
    </select>
    ${state.zone !== null ? '<button class="btn small" data-zone="">看全部</button>' : ''}
  </div>`;

  if (state.zone !== null) {
    // Chasing one zone: the day grid is the wrong shape for it. What you want
    // is "when does Travincal come round again", so list the occurrences.
    const want = TZ.zones[state.zone];
    const times = [];
    for (let i = cur; i < TZ_COUNT && times.length < 60; i++) {
      if (tzIndex(i) === state.zone) times.push(i);
    }
    let rest = 0;
    for (let i = cur; i < TZ_COUNT; i++) if (tzIndex(i) === state.zone) rest++;

    html += `<div class="tzday">
      <h3><span class="act">${actZh(want.act)}</span>${esc(want.zh)}
        <span class="thin">接下来还会出现 ${rest} 次${rest > times.length
          ? `，列出最近 ${times.length} 次` : ''}</span></h3>
    </div>`;

    if (!times.length) {
      html += '<div class="empty">内置排期剩下的时间里，这个地区不会再出现了。</div>';
    } else {
      // Grouped by day, because "明天几点" is the question being asked.
      const days = [];
      for (const i of times) {
        const t = tzTime(i);
        const key = new Date(t).setHours(0, 0, 0, 0);
        if (!days.length || days[days.length - 1].key !== key) days.push({ key, t, slots: [] });
        days[days.length - 1].slots.push(i);
      }
      html += '<div class="tzdays">';
      for (const d of days) {
        html += `<div class="tzdayrow">
          <span class="dl">${esc(dayLabel(d.t))}</span>
          <span class="dt">${d.slots.map(i => {
            const on = i === cur;
            return `<span class="tzhit${on ? ' now' : ''}">${hhmm(tzTime(i))}${
              on ? ` ${countdown}` : ''}</span>`;
          }).join('')}</span>
        </div>`;
      }
      html += '</div>';
    }
  } else {
    // One local day at a time. The slots are evenly spaced, so the day's first
    // slot is found by clock arithmetic rather than by scanning.
    const from = tzSlot(tzMidnight(state.day).getTime());
    const to = tzSlot(tzMidnight(state.day + 1).getTime());
    const first = from >= 0 ? from : 0;
    const last = to >= 0 ? to : TZ_COUNT;

    const label = state.day === 0 ? '今天'
      : state.day === 1 ? '明天'
        : state.day === -1 ? '昨天' : `${state.day > 0 ? '+' : ''}${state.day} 天`;
    const date = tzMidnight(state.day).toLocaleDateString('zh-CN',
      { month: 'long', day: 'numeric', weekday: 'long' });

    html += `
      <div class="tzday">
        <h3>${label} <span class="thin">${esc(date)}</span></h3>
        <span class="sp"></span>
        <button class="btn small" data-day="-1"${from <= 0 ? ' disabled' : ''}>← 前一天</button>
        <button class="btn small" data-day="0"${state.day === 0 ? ' disabled' : ''}>今天</button>
        <button class="btn small" data-day="1"${last >= TZ_COUNT ? ' disabled' : ''}>后一天 →</button>
      </div>
      <div class="tzlist">`;

    for (let i = first; i < last; i++) {
      const zz = tzZone(i);
      const t = tzTime(i);
      const cls = i === cur ? 'now' : (TZ_START + (i + 1) * TZ_STEP <= now ? 'past' : '');
      html += `<div class="tzrow ${cls} a${zz.act}">
        <span class="t">${hhmm(t)}</span>
        <span class="act">${actZh(zz.act)}</span>
        <span class="z">${esc(zz.zh)}</span>
        ${i === cur ? countdown : ''}
      </div>`;
    }
    html += '</div>';
  }

  html += '</div>';

  const daysLeft = Math.floor((TZ_END - now) / 86400000);
  html += `<p class="hint" style="margin-top:18px">
    这是<b>单机（离线）</b>的排期，本机时间算出来，不联网。联机的恐怖地带是另一套轮换，由暴雪服务器决定，这里不做猜测。<br>
    内置排期还剩 ${daysLeft} 天（到 ${tzDate(TZ_END)}），到期前重新运行 <code>python3 make_tz.py</code> 更新。</p>`;
  return html;
}

function renderView() {
  TIPS.clear(); tipSeq = 0;
  hideTip();
  if (state.mode === 'tz') { $('#view').innerHTML = viewTz(); return; }
  if (state.mode === 'skills') { $('#view').innerHTML = viewSkills(); return; }
  if (state.mode === 'runes') { $('#view').innerHTML = viewCube(); return; }
  const fn = { sets: viewSets, uniques: viewUniques, affix: viewAffix, base: viewBases,
    lost: viewLost, dupes: viewDupes };
  $('#view').innerHTML = fn[state.tab]();
}

function render() {
  // Terror zones need no save file, so that page can show before anything is
  // loaded; the other two keep the "how to use" panel up until there is one.
  const standalone = state.mode === 'tz' || state.mode === 'skills';
  $('#modes').hidden = false;
  $('#intro').hidden = !!report || standalone;
  $('#main').hidden = !report && !standalone;
  if (report) {
    const s = report.summary;
    setStatus(`已读取 ${s.files} 个存档文件 · ${s.totalItems} 件物品 · ${report.scannedAt}`);
  }
  renderModes(); renderTop(); renderTabs(); renderFilters();
  if (!$('#main').hidden) renderView();
}

$('#modes').addEventListener('click', e => {
  const b = e.target.closest ? e.target.closest('button[data-mode]') : null;
  if (!b || b.dataset.mode === state.mode) return;
  state.mode = b.dataset.mode;
  render();
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

/* The cube shopping list: add, subtract, drop, clear. Plus day paging on the
   terror-zone page, where 0 means "back to today" and ±1 steps a day. */
$('#view').addEventListener('click', e => {
  const b = e.target.closest
    ? e.target.closest('button[data-add],button[data-sub],button[data-plus],button[data-clear],' +
      'button[data-day],button[data-affix],button[data-base],button[data-zone],' +
      'button[data-dropby]')
    : null;
  if (b && b.disabled) return;
  if (!b) return;
  const d = b.dataset;
  if (d.zone !== undefined) { state.zone = null; renderView(); return; }
  if (d.dropby !== undefined) { state.dropBy = d.dropby; renderView(); return; }
  if (d.base !== undefined) {
    if (!d.base) state.bases = [];
    else if (state.bases.includes(d.base)) state.bases = state.bases.filter(k => k !== d.base);
    else state.bases = [...state.bases, d.base];
    renderView();
    return;
  }
  if (d.affix !== undefined) {
    // Empty value is the "clear" button; otherwise toggle that affix.
    if (!d.affix) state.affixes = [];
    else if (state.affixes.includes(d.affix)) state.affixes = state.affixes.filter(k => k !== d.affix);
    else state.affixes = [...state.affixes, d.affix];
    renderView();
    return;
  }
  if (d.day !== undefined) {
    const step = Number(d.day);
    state.day = step === 0 ? 0 : state.day + step;
    renderView();
    return;
  }
  if (d.clear) { state.target = null; state.qty = 1; }
  else if (d.add) {
    // Clicking the rune already being solved for asks for one more of it.
    if (state.target === d.add) state.qty += 1; else { state.target = d.add; state.qty = 1; }
  } else if (d.plus) state.qty += 1;
  else if (d.sub) state.qty = Math.max(1, state.qty - 1);
  renderView();
});

/* The terror-zone picker is a <select>, so it reports through change. */
$('#view').addEventListener('change', e => {
  const sel = e.target.closest ? e.target.closest('select[data-zone]') : null;
  if (!sel) return;
  state.zone = sel.value === '' ? null : Number(sel.value);
  renderView();
});

$('#q').addEventListener('input', e => {
  state.q = e.target.value.trim().toLowerCase();
  if (report) renderView();
});

document.addEventListener('keydown', e => {
  if (e.key === 'r' && (e.metaKey || e.ctrlKey) && report) { e.preventDefault(); reload(); }
});

/* Back to top, shown once the page has scrolled a screenful. */
{
  const btn = $('#totop');
  const sync = () => btn.classList[window.scrollY > 600 ? 'add' : 'remove']('show');
  window.addEventListener('scroll', sync, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  sync();
}

/* The mode bar is live from the start — the terror-zone page works with no save. */
render();

/*
 * The countdown to the next zone ticks every second. Re-rendering the whole
 * page that often would fight the zone picker for focus, so only the number is
 * touched — and a full re-render happens just once, when the zone changes.
 */
let tzShown = -1;
setInterval(() => {
  if (state.mode !== 'tz') return;
  const cur = tzSlot(Date.now());
  if (cur !== tzShown) { tzShown = cur; renderView(); return; }
  const el = $('#tzleft');
  if (el) el.textContent = mmss(Number(el.dataset.ends) - Date.now());
}, 1000);

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

/* ------------------------------------------------------------------ */
/* Skill icons (from the player's own game files)                      */
/* ------------------------------------------------------------------ */
let SKILL_ICONS = {};

// "Fire Bolt.png", "fire_bolt.PNG" and "firebolt.webp" all mean the same file.
const iconKey = name => name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');

async function pickIcons() {
  if (!window.showDirectoryPicker) {
    setStatus('这个浏览器不支持直接选文件夹，图标载入用 Chrome / Edge。');
    return;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'read' });
  } catch { return; }
  const map = {};
  let n = 0, skipped = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !/\.(png|gif|jpe?g|webp)$/i.test(name)) continue;
    const file = await handle.getFile();
    // A skill icon is a few KB; anything huge is not one, and would bloat the
    // browser database for nothing.
    if (file.size > 512 * 1024) { skipped++; continue; }
    map[iconKey(name)] = await new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(file);
    });
    n++;
  }
  for (const k of Object.keys(map)) if (!map[k]) delete map[k];
  SKILL_ICONS = map;
  await saveIcons(map);
  setStatus(`已载入 ${n} 个技能图标${skipped ? `（跳过 ${skipped} 个过大的文件）` : ''}，只存在你本机。`);
  renderView();
}

/* ------------------------------------------------------------------ */
/* Skill planner                                                       */
/* ------------------------------------------------------------------ */
/*
 * A skill tree you can spend points in, laid out on the game's own grid: three
 * pages of six rows by three columns, positions straight out of skilldesc.
 *
 * The rules enforced are the game's: twenty points a skill, a skill needs your
 * character level to have reached its requirement, and every prerequisite needs
 * at least one point in it. Taking a point back is refused when something else
 * is standing on it — otherwise you could build a tree the game would not let
 * you keep.
 */
const CLASSES = CATALOG.classes || [];
const CLASS_BY_CODE = new Map(CLASSES.map(c => [c.code, c]));

// Levels 2..99 are one point each; the three Act quests hand out four more apiece.
const QUEST_POINTS = 12;
const skillBudget = () => (state.skLevel - 1) + (state.skQuests ? QUEST_POINTS : 0);

const skClass = () => CLASS_BY_CODE.get(state.skClass) || CLASSES[0];
const skPut = id => state.skPts[id] || 0;
const skSpent = () => Object.values(state.skPts).reduce((n, v) => n + v, 0);

/* Why a skill cannot take another point right now, or null when it can. */
function skBlocked(sk) {
  if (skPut(sk.id) >= sk.max) return `最多 ${sk.max} 级`;
  if (state.skLevel < sk.req) return `需要角色 ${sk.req} 级`;
  const cls = skClass();
  for (const pid of sk.pre) {
    if (skPut(pid) < 1) {
      const p = cls.skills.find(x => x.id === pid);
      return `需要先点 ${p ? p.zh : pid}`;
    }
  }
  if (skSpent() >= skillBudget()) return '技能点用完了';
  return null;
}

/* Removing a point is refused while something else is standing on this skill. */
function skDependent(sk) {
  if (skPut(sk.id) !== 1) return null;
  const cls = skClass();
  const on = cls.skills.find(x => skPut(x.id) > 0 && x.pre.includes(sk.id));
  return on ? on.zh : null;
}

function skAdd(id, delta) {
  const cls = skClass();
  const sk = cls.skills.find(x => x.id === id);
  if (!sk) return;
  if (delta > 0) {
    if (!skBlocked(sk)) state.skPts[id] = skPut(id) + 1;
  } else if (skPut(id) > 0 && !skDependent(sk)) {
    state.skPts[id] = skPut(id) - 1;
    if (!state.skPts[id]) delete state.skPts[id];
  }
}

function skTile(sk) {
  const n = skPut(sk.id);
  const blocked = skBlocked(sk);
  const locked = state.skLevel < sk.req || sk.pre.some(p => skPut(p) < 1);
  const cls = ['sk', n ? 'on' : '', locked ? 'locked' : ''].filter(Boolean).join(' ');
  const icon = SKILL_ICONS[iconKey(sk.icon)] || SKILL_ICONS[iconKey(sk.en)];
  return `<button class="${cls}" data-sk="${sk.id}"
      style="grid-row:${sk.row};grid-column:${sk.col}"
      title="${esc(sk.zh)} · ${esc(sk.en)}\n需要角色 ${sk.req} 级${
        sk.pre.length ? '\n前置：' + sk.pre.map(p => {
          const q = skClass().skills.find(x => x.id === p);
          return q ? q.zh : p;
        }).join('、') : ''}${blocked ? '\n' + blocked : ''}">
    <span class="ic"${icon ? ` style="background-image:url(${icon})"` : ''}>${
      icon ? '' : esc(sk.zh.slice(0, 2))}</span>
    <span class="nm">${esc(sk.zh)}</span>
    <span class="lv">${n}<span class="mx">/${sk.max}</span></span>
  </button>`;
}

function viewSkills() {
  const cls = skClass();
  const spent = skSpent();
  const budget = skillBudget();

  let html = `<div class="skbar">
    <div class="skclasses">${CLASSES.map(c =>
      `<button class="chip" data-skcls="${c.code}" aria-pressed="${c.code === cls.code}">${esc(c.zh)}</button>`).join('')}</div>
    <div class="skctl">
      <label>角色等级
        <input type="number" id="sklevel" class="sknum" min="1" max="99" value="${state.skLevel}" data-sklevel></label>
      <label class="skq"><input type="checkbox" data-skquest${state.skQuests ? ' checked' : ''}> 算上三个任务奖励（+12）</label>
      <span class="skpts ${spent > budget ? 'over' : ''}">已用 <b>${spent}</b> / ${budget} 点</span>
      <button class="btn small" data-skreset="1"${spent ? '' : ' disabled'}>清空</button>
      <button class="btn small" data-skicons="1">${
        Object.keys(SKILL_ICONS).length ? `图标已载入 ${Object.keys(SKILL_ICONS).length} 个` : '载入图标文件夹'}</button>
    </div>
  </div>`;

  html += '<div class="sktrees">';
  for (let page = 1; page <= 3; page++) {
    const inPage = cls.skills.filter(s => s.page === page);
    const used = inPage.reduce((n, s) => n + skPut(s.id), 0);
    html += `<div class="sktree">
      <h3>${esc(cls.tabs[page - 1] || `技能树${page}`)} <span class="thin">${used} 点</span></h3>
      <div class="skgrid">${inPage.map(skTile).join('')}</div>
    </div>`;
  }
  html += '</div>';

  html += `<p class="hint" style="margin-top:16px">
    左键加一点，右键（或按住 Alt 点）减一点。等级不够、前置没点的技能是灰的，点不动。<br>
    ${Object.keys(SKILL_ICONS).length ? '' :
      '图标要和游戏一样的话，点「载入图标文件夹」选一个装着技能图标的目录 —— ' +
      '图标只留在你这台机器上，不会上传、也不在这个页面里。'}</p>`;
  return html;
}

/* Skill planner controls. */
$('#view').addEventListener('click', e => {
  const t = e.target.closest ? e.target.closest('[data-sk],[data-skcls],[data-skreset],[data-skicons]') : null;
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.skcls) { state.skClass = d.skcls; state.skPts = {}; renderView(); return; }
  if (d.skreset) { state.skPts = {}; renderView(); return; }
  if (d.skicons) { pickIcons(); return; }
  if (d.sk) {
    // Alt-click takes a point back, same as the right button.
    skAdd(Number(d.sk), e.altKey ? -1 : 1);
    renderView();
  }
});

$('#view').addEventListener('contextmenu', e => {
  const t = e.target.closest ? e.target.closest('[data-sk]') : null;
  if (!t) return;
  e.preventDefault();
  skAdd(Number(t.dataset.sk), -1);
  renderView();
});

/*
 * Number boxes settle on `change`, never on `input`.
 *
 * Re-rendering per keystroke rebuilds the box you are typing into: type "8"
 * towards 80, the view redraws, and the "0" lands nowhere. So the value is
 * only stored while typing, and the page redraws once you leave the field or
 * press Enter.
 */
function numberInput(t, commit) {
  if (!t || !t.dataset) return false;
  if (t.dataset.pace !== undefined) {
    const n = Math.max(1, Number(t.value) || 1);
    state.pace[t.dataset.pace] = { ...(state.pace[t.dataset.pace] || {}), [t.dataset.field]: n };
    // Half-typed numbers are not worth remembering: "80" passes through "8".
    if (commit) savePace(state.pace);
    return true;
  }
  if (t.dataset.mf !== undefined) {
    state.mf = Math.min(2000, Math.max(0, Number(t.value) || 0));
    if (commit) saveMF(state.mf);
    return true;
  }
  if (t.dataset.glv !== undefined) {
    state.glv = Math.min(99, Math.max(1, Number(t.value) || 1));
    if (commit) saveGlv(state.glv);
    return true;
  }
  if (t.dataset.sklevel !== undefined) {
    state.skLevel = Math.min(99, Math.max(1, Number(t.value) || 1));
    return true;
  }
  return false;
}

$('#view').addEventListener('input', e => { numberInput(e.target, false); });

/* The magic-find and gamble-level boxes sit in the toolbar, outside #view. */
for (const id of ['#mfwrap', '#glvwrap']) {
  $(id).addEventListener('input', e => { numberInput(e.target, false); });
  $(id).addEventListener('change', e => {
    if (numberInput(e.target, true)) renderView();
  });
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.blur) { e.preventDefault(); e.target.blur(); }
  });
}

$('#view').addEventListener('change', e => {
  const t = e.target;
  if (numberInput(t, true)) { renderView(); return; }
  if (t && t.dataset && t.dataset.skquest !== undefined) {
    state.skQuests = !!t.checked;
    renderView();
  }
});

// Enter should commit without having to click away first.
$('#view').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target && e.target.dataset &&
      (e.target.dataset.pace !== undefined || e.target.dataset.sklevel !== undefined)) {
    e.preventDefault();
    if (e.target.blur) e.target.blur();
  }
});

/* Icons picked in an earlier session are still on this machine. */
loadIcons().then(m => {
  if (m && Object.keys(m).length) {
    SKILL_ICONS = m;
    if (state.mode === 'skills') renderView();
  }
});

/* Your magic find, kept between visits. */
loadMF().then(n => {
  if (typeof n === 'number' && n > 0) {
    state.mf = n;
    if (report && state.mode === 'gear') { renderTabs(); renderView(); }
  }
});

/* The level you gamble at, kept between visits. */
loadGlv().then(n => {
  if (typeof n === 'number' && n > 0) {
    state.glv = n;
    if (report && state.mode === 'gear') { renderTabs(); renderView(); }
  }
});

/* Your own run pace, kept between visits. */
loadPace().then(m => {
  if (m && Object.keys(m).length) {
    state.pace = m;
    if (state.mode === 'runes') renderView();
  }
});
