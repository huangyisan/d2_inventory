/*
 * Diablo II: Resurrected save-file parser (browser port).
 *
 * Reads .d2s character files and .d2i shared-stash files entirely in memory.
 * This module never writes anything — it only ever reads the bytes handed to it.
 *
 * The bit layout and the Huffman table for D2R item codes follow the format
 * documented by the ResurrectedTrader/D2SSharp reference implementation.
 */

// (symbol, bits MSB-first, bit length)
const HUFFMAN_TABLE = [
  ['0', 0b11111011, 8], [' ', 0b10, 2], ['1', 0b1111100, 7], ['2', 0b001100, 6],
  ['3', 0b1101101, 7], ['4', 0b11111010, 8], ['5', 0b00010110, 8], ['6', 0b1101111, 7],
  ['7', 0b01111, 5], ['8', 0b000100, 6], ['9', 0b01110, 5], ['a', 0b11110, 5],
  ['b', 0b0101, 4], ['c', 0b01000, 5], ['d', 0b110001, 6], ['e', 0b110000, 6],
  ['f', 0b010011, 6], ['g', 0b11010, 5], ['h', 0b00011, 5], ['i', 0b1111110, 7],
  ['j', 0b000101110, 9], ['k', 0b010010, 6], ['l', 0b11101, 5], ['m', 0b01101, 5],
  ['n', 0b001101, 6], ['o', 0b1111111, 7], ['p', 0b11001, 5], ['q', 0b11011001, 8],
  ['r', 0b11100, 5], ['s', 0b0010, 4], ['t', 0b01100, 5], ['u', 0b00001, 5],
  ['v', 0b1101110, 7], ['w', 0b00000, 5], ['x', 0b00111, 5], ['y', 0b0001010, 7],
  ['z', 0b11011000, 8],
];
const MAX_CODE_LEN = 9;
const DECODE = new Map();
for (const [sym, bits, len] of HUFFMAN_TABLE) DECODE.set(len * 1024 + bits, sym);

const STAT_TERMINATOR = 0x1FF;
const PAIRED_STATS = {
  17: [18], 48: [49], 50: [51], 52: [53], 54: [55, 56], 57: [58, 59],
};
const STAT_ARMORCLASS = 31, STAT_DURABILITY = 72, STAT_MAXDURABILITY = 73;
const STAT_NUMSOCKETS = 194, STAT_QUEST_DIFFICULTY = 128;

const STACKABLE_V100 = new Set(('rvs rvl gcv gfv gsv gzv gpv gcy gfy gsy gly gpy gcb gfb gsb glb gpb ' +
  'gcg gfg gsg glg gpg gcr gfr gsr glr gpr gcw gfw gsw glw gpw skc skf sku skl skz r01 r02 r03 r04 ' +
  'r05 r06 r07 r08 r09 r10 r11 r12 r13 r14 r15 r16 r17 r18 r19 r20 r21 r22 r23 r24 r25 r26 r27 r28 ' +
  'r29 r30 r31 r32 r33 pk1 pk2 pk3 dhn bey mbr toa tes ceh bet fed').split(' '));

// Base-item flag bits, matching make_catalog.py
const FLAG_ARMOR = 1, FLAG_WEAPON = 2, FLAG_GOLD = 4, FLAG_CHARM = 8,
  FLAG_BODYPART = 16, FLAG_PLAYERBODYPART = 32, FLAG_SCROLLBOOK = 64,
  FLAG_STACKABLE = 128, FLAG_QUEST = 256, FLAG_QUESTDIFF = 512;

// Item flags
const F_IDENTIFIED = 0x00000010, F_SOCKETED = 0x00000800, F_IS_EAR = 0x00010000,
  F_INIT = 0x00080000, F_COMPACT = 0x00200000, F_ETHEREAL = 0x00400000,
  F_PERSONALIZED = 0x01000000, F_LOW_QUALITY = 0x02000000, F_RUNEWORD = 0x04000000,
  F_CHRONICLE = 0x10000000, F_CHRONICLE_COMPACT = 0x20000000;

const QUALITY = { 1: 'inferior', 2: 'normal', 3: 'superior', 4: 'magic', 5: 'set',
  6: 'rare', 7: 'unique', 8: 'craft', 9: 'tempered' };
const MODE = { 0: 'stored', 1: 'equipped', 2: 'belt', 3: 'ground', 4: 'cursor',
  5: 'dropping', 6: 'socketed' };
const STORE_PAGE = { 0: 'inventory', 1: 'equip', 2: 'trade', 3: 'cube', 4: 'stash', 5: 'belt' };
const BODY_LOCATION = { 0: null, 1: 'head', 2: 'neck', 3: 'torso', 4: 'right_arm',
  5: 'left_arm', 6: 'right_ring', 7: 'left_ring', 8: 'waist', 9: 'feet', 10: 'gloves',
  11: 'right_hand', 12: 'left_hand' };
const CHARACTER_CLASS = { 0: '亚马逊', 1: '女法师', 2: '死灵法师', 3: '圣骑士',
  4: '野蛮人', 5: '德鲁伊', 6: '刺客' };

/** LSB-first bit reader, matching D2's bitstream convention. */
class BitReader {
  constructor(data, bitPos = 0) {
    this.data = data;
    this.pos = bitPos;
  }

  read(count) {
    let result = 0, readBits = 0;
    while (readBits < count) {
      const byteIndex = this.pos >>> 3;
      if (byteIndex >= this.data.length) throw new RangeError('读取超出文件末尾');
      const bitOffset = this.pos & 7;
      const take = Math.min(8 - bitOffset, count - readBits);
      const bits = (this.data[byteIndex] >>> bitOffset) & ((1 << take) - 1);
      // Use multiplication so 32-bit reads stay unsigned.
      result += bits * Math.pow(2, readBits);
      this.pos += take;
      readBits += take;
    }
    return result;
  }

  bool() { return this.read(1) !== 0; }
  align() { if (this.pos & 7) this.pos = (this.pos + 7) & ~7; }
  get bytePos() { return this.pos >>> 3; }

  string8(limit = 64) {
    let out = '';
    while (out.length < limit) {
      const ch = this.read(8);
      if (ch === 0) break;
      out += String.fromCharCode(ch);
    }
    return out;
  }
}

function decodeItemCode(r) {
  let out = '';
  for (let i = 0; i < 4; i++) {
    let code = 0, len = 0, sym;
    while (len < MAX_CODE_LEN) {
      code = (code << 1) | r.read(1);
      len++;
      sym = DECODE.get(len * 1024 + code);
      if (sym !== undefined) break;
      sym = undefined;
    }
    if (sym === undefined) throw new Error('无效的物品编码');
    out += sym;
  }
  return out;
}

/** Wraps the embedded catalogue with the lookups the parser needs. */
class Catalog {
  constructor(raw) {
    this.raw = raw;
    this.bases = raw.bases;
    this.stats = raw.stats;
    this.uniqueById = new Map();
    raw.uniques.forEach((u, index) => u.ids.forEach(id => this.uniqueById.set(id, index)));
    this.setById = new Map();
    raw.sets.forEach((g, gi) => g.pieces.forEach((p, pi) => this.setById.set(p.id, [gi, pi])));
  }

  base(code) {
    const b = this.bases[code];
    if (!b) return null;
    return { name: b[0], zh: b[1] || b[0], flags: b[2], slot: b[3], code };
  }

  stat(id) {
    const s = this.stats[id];
    return s ? { bits: s[0], paramBits: s[1], add: s[2], shift: s[3] }
             : { bits: 0, paramBits: 0, add: 0, shift: 0 };
  }
}

/*
 * Reads one stat list and returns what it actually said. The values are only
 * needed so the page can filter by affix ("rings with faster cast rate"); the
 * bitstream must be walked either way, so keeping the numbers is free.
 *
 * `add` is the table's storage offset: resistances are stored biased so that a
 * negative value fits an unsigned field, so it has to come back off here.
 */
function readStatList(r, cat) {
  const out = [];
  for (;;) {
    const statId = r.read(9);
    if (statId === STAT_TERMINATOR) break;
    const info = cat.stat(statId);
    if (!info.bits) throw new Error(`属性 ${statId} 缺少位宽定义`);
    const param = info.paramBits ? r.read(info.paramBits) : 0;
    out.push({ id: statId, param, value: (r.read(info.bits) - (info.add || 0)) << (info.shift || 0) });
    for (const pid of (PAIRED_STATS[statId] || [])) {
      const sub = cat.stat(pid);
      out.push({ id: pid, param: 0, value: (r.read(sub.bits) - (sub.add || 0)) << (sub.shift || 0) });
    }
  }
  return out;
}

function readRealmData(r, saveVersion) {
  if (saveVersion <= 86) return;
  if (!r.bool()) return;
  const count = saveVersion > 96 ? 4 : (saveVersion > 93 ? 3 : 2);
  for (let i = 0; i < count; i++) r.read(32);
}

/*
 * The auto-sorting stash tabs (gems / runes / materials) hold stacks, not
 * single items: one entry can be "6 × Pul Rune". Returns how many the entry
 * stands for, 1 when there is no stack count.
 */
function readAdvancedStash(r, code, saveVersion) {
  if (saveVersion <= 99) return 1;
  if (saveVersion <= 101) {
    if (!STACKABLE_V100.has(code)) return 1;
  } else if (!r.bool()) return 1;
  return Math.max(1, r.read(8));
}

function readChronicle(r, flags, saveVersion) {
  if (saveVersion <= 99 || !(flags & F_CHRONICLE)) return;
  r.read(16);
  const compact = !!(flags & F_CHRONICLE_COMPACT);
  if (!compact) r.read(32);
  let count = compact ? 1 : r.read(4);
  count = Math.min(count, 8);
  for (let i = 0; i < count; i++) { r.read(32); r.read(32); }
}

/**
 * Read one complete item, leaving the reader at the start of the next one.
 * Returns [item, ...itemsSocketedIntoIt].
 */
function readItem(r, cat, saveVersion) {
  if (saveVersion <= 96) {
    if (r.read(16) !== 0x4D4A) throw new Error('物品标记错误');
  }

  let flags = r.read(32);
  const isGamble = !!(flags & F_LOW_QUALITY);
  flags = (flags & ~F_LOW_QUALITY & ~F_INIT) >>> 0;
  const compact = !!(flags & F_COMPACT);

  let version;
  if (saveVersion > 96) {
    const high = r.bool();
    const v = r.read(2);
    version = high ? v + 99 : v;
  } else {
    version = r.read(10);
  }

  const mode = r.read(3);
  if (!(mode in MODE)) throw new Error(`物品状态值异常 ${mode}`);

  const pos = { mode: MODE[mode] };
  if (mode === 3 || mode === 5) {
    pos.x = r.read(16); pos.y = r.read(16); pos.page = null; pos.body = null;
  } else {
    const body = r.read(4);
    pos.body = BODY_LOCATION[body] !== undefined ? BODY_LOCATION[body] : `body${body}`;
    pos.x = r.read(4);
    pos.y = r.read(4);
    const rawPage = r.read(3);
    pos.page = rawPage ? (STORE_PAGE[rawPage - 1] || null) : null;
  }

  const item = {
    version, position: pos,
    ethereal: !!(flags & F_ETHEREAL),
    identified: !!(flags & F_IDENTIFIED),
    runeword: !!(flags & F_RUNEWORD),
    personalized: !!(flags & F_PERSONALIZED),
    compact, quality: 'normal', uniqueId: null, setId: null, stackCount: 1,
    itemLevel: null, sockets: 0, code: null, baseName: null, slot: '其他',
    stats: [],
  };

  let base = null;
  if (flags & F_IS_EAR) {
    item.code = 'ear'; item.baseName = 'Ear'; item.isEar = true;
    r.read(3); r.read(7); r.string8();
  } else {
    const code = decodeItemCode(r);
    base = cat.base(code.trim());
    if (!base) throw new Error(`未知物品编码 "${code}"`);
    item.code = base.code;
    item.baseName = base.name;
    item.baseZh = base.zh;
    item.slot = base.slot;
  }

  const socketedItems = [];

  if (compact) {
    if (base && (base.flags & FLAG_GOLD)) {
      const big = r.bool();
      item.gold = big ? r.read(32) : r.read(12);
      if (saveVersion > 96) r.bool();
    }
    if (saveVersion > 92 && base && (base.flags & FLAG_QUEST) && (base.flags & FLAG_QUESTDIFF)) {
      r.read(cat.stat(STAT_QUEST_DIFFICULTY).bits);
    }
    readRealmData(r, saveVersion);
    item.stackCount = readAdvancedStash(r, item.code, saveVersion);
    item.itemLevel = 1;
    r.align();
    return [item];
  }

  if (isGamble) {
    item.quality = 'inferior';
    r.align();
    return [item];
  }

  const socketedCount = r.read(3);
  item.seed = r.read(32);
  item.itemLevel = Math.max(r.read(7), 1);

  const q = r.read(4);
  if (!(q in QUALITY)) throw new Error(`品质值异常 ${q}`);
  item.quality = QUALITY[q];

  if (r.bool()) r.read(3);   // variable graphics
  if (r.bool()) r.read(11);  // auto affix

  if (q === 1 || q === 3) {
    r.read(3);
  } else if (q === 4) {
    r.read(11); r.read(11);
  } else if (q === 5 || q === 7) {
    const fileIndex = r.read(12);
    if (q === 5) item.setId = fileIndex; else item.uniqueId = fileIndex;
  } else if (q === 6 || q === 8) {
    r.read(8); r.read(8);
    for (let i = 0; i < 3; i++) {
      if (r.bool()) r.read(11);
      if (r.bool()) r.read(11);
    }
  } else if (q === 9) {
    r.read(8); r.read(8);
  } else if (q === 2 && base) {
    if (base.flags & FLAG_CHARM) {
      r.bool(); r.read(11);
    } else if ((base.flags & FLAG_BODYPART) && !(base.flags & FLAG_PLAYERBODYPART)) {
      r.read(10);
    } else if (base.flags & FLAG_SCROLLBOOK) {
      r.read(5);
    }
  }

  if (flags & F_RUNEWORD) item.runewordId = r.read(16);

  if (flags & F_IS_EAR) {
    r.read(3); r.read(7); r.string8();
  } else if (flags & F_PERSONALIZED) {
    item.personalizedName = r.string8();
  }

  readRealmData(r, saveVersion);

  if (base && (base.flags & FLAG_ARMOR)) {
    const ac = cat.stat(STAT_ARMORCLASS), md = cat.stat(STAT_MAXDURABILITY), du = cat.stat(STAT_DURABILITY);
    item.defense = r.read(ac.bits) - ac.add;
    const maxDur = r.read(md.bits) - md.add;
    item.maxDurability = maxDur;
    if (maxDur > 0) item.durability = r.read(du.bits) - du.add;
  } else if (base && (base.flags & FLAG_WEAPON)) {
    const md = cat.stat(STAT_MAXDURABILITY), du = cat.stat(STAT_DURABILITY);
    const maxDur = r.read(md.bits) - md.add;
    item.maxDurability = maxDur;
    if (maxDur > 0) item.durability = r.read(du.bits) - du.add;
  } else if (base && (base.flags & FLAG_GOLD)) {
    const big = r.bool();
    item.gold = big ? r.read(32) : r.read(12);
    if (saveVersion > 96) r.bool();
  }

  if (saveVersion > 104) {
    if (r.bool()) item.quantity = r.read(9);
  } else if (base && (base.flags & FLAG_STACKABLE)) {
    item.quantity = r.read(9);
  }

  if (flags & F_SOCKETED) item.sockets = r.read(cat.stat(STAT_NUMSOCKETS).bits);

  let setMask = 0;
  if (q === 5) setMask = r.read(5);

  // The item's own affixes. The set-bonus lists that follow are conditional on
  // wearing the rest of the set, and are deliberately not merged in: filtering
  // must answer "what does this item give me", not "what could it give me".
  item.stats = readStatList(r, cat);

  if (q === 5) {
    for (let i = 0; i < 5; i++) if (setMask & (1 << i)) readStatList(r, cat);
  }
  // A runeword's powers are unconditional, so they do count.
  if (flags & F_RUNEWORD) item.stats = item.stats.concat(readStatList(r, cat));

  readChronicle(r, flags, saveVersion);
  item.stackCount = readAdvancedStash(r, item.code, saveVersion);
  r.align();

  for (let i = 0; i < socketedCount; i++) {
    for (const s of readItem(r, cat, saveVersion)) {
      s.socketedIn = item.code;
      socketedItems.push(s);
    }
  }

  return [item, ...socketedItems];
}

function readItemsSection(r, cat, saveVersion, locationHint) {
  const magic = r.read(16);
  if (magic !== 0x4D4A) throw new Error('未找到物品区段标记');
  const count = r.read(16);
  const items = [];
  for (let i = 0; i < count; i++) items.push(...readItem(r, cat, saveVersion));
  if (locationHint) for (const it of items) if (!it.locationHint) it.locationHint = locationHint;
  return { items, count };
}

function findBytes(data, needle, from = 0) {
  outer: for (let i = from; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000;

/** Parse a .d2s character save. */
export function parseCharacter(data, fileName, cat) {
  if (!(data[0] === 0x55 && data[1] === 0xAA && data[2] === 0x55 && data[3] === 0xAA)) {
    throw new Error('不是有效的 .d2s 存档');
  }
  const version = u32(data, 4);
  const name = fileName.replace(/\.d2s$/i, '');

  // D2R (v97+) dropped the 16-byte in-file character name, so the file name is
  // the character name and every later header field shifts back by 16 bytes.
  const off = version > 96 ? 0 : 16;
  const status = data[0x14 + off];
  const cls = data[0x18 + off];
  const level = data[0x1B + off];

  const result = {
    source: name, sourceType: 'character', file: fileName, version,
    cls: CHARACTER_CLASS[cls] || `未知(${cls})`,
    level, hardcore: !!(status & 0x04),
    items: [], warnings: [],
  };

  const start = findBytes(data, [0x4A, 0x4D]);  // "JM"
  if (start < 0) { result.warnings.push('找不到物品区段'); return result; }

  const r = new BitReader(data, start * 8);
  const main = readItemsSection(r, cat, version);
  result.declaredItemCount = main.count;
  result.items = main.items;

  // Corpse section, then mercenary items. Both are optional and a failure here
  // must not discard the main inventory we already read.
  try {
    const corpse = readItemsSection(r, cat, version, '尸体');
    for (let i = 0; i < corpse.count; i++) {
      r.read(12 * 8);
      result.items.push(...readItemsSection(r, cat, version, '尸体').items);
    }
    result.items.push(...corpse.items);

    const marker = r.read(16);
    if (marker === 0x666A && data[r.bytePos] === 0x4A && data[r.bytePos + 1] === 0x4D) {
      result.items.push(...readItemsSection(r, cat, version, '佣兵装备').items);
    }
  } catch (err) {
    result.warnings.push(`尸体/佣兵区段: ${err.message}`);
  }

  return result;
}

const CHRONICLE_MAGIC = 0xC0EAEDC0;

/**
 * Read a chronicle stash tab: the game's log of every set / unique / runeword
 * the account has ever found. Entries are 10 bytes and byte-aligned.
 */
function readChronicleSection(data, body) {
  if (u32(data, body) !== CHRONICLE_MAGIC) throw new Error('编年史标记错误');
  const version = u16(data, body + 4);
  const setCount = u16(data, body + 6);
  const uniqueCount = u16(data, body + 8);
  const rwCount = u16(data, body + 10);

  let pos = body + 12 + 8;  // counts, then 8 reserved bytes
  const take = n => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ id: u32(data, pos), source: u16(data, pos + 4), timestamp: u32(data, pos + 6) });
      pos += 10;
    }
    return out;
  };
  return { version, sets: take(setCount), uniques: take(uniqueCount), runewords: take(rwCount) };
}

/** Parse a .d2i shared-stash save. */
export function parseStash(data, fileName, cat) {
  const name = fileName.replace(/\.d2i$/i, '');
  const result = {
    source: name, sourceType: 'stash', file: fileName,
    version: data.length >= 8 ? u32(data, 4) : 0,
    tabs: [], items: [], chronicle: null, warnings: [],
  };

  let offset = 0, tabIndex = 0;
  while (offset + 64 <= data.length) {
    if (!(data[offset] === 0x55 && data[offset + 1] === 0xAA &&
          data[offset + 2] === 0x55 && data[offset + 3] === 0xAA)) break;
    const stashFormat = u32(data, offset + 4);
    const itemFormat = u32(data, offset + 8);
    const gold = u32(data, offset + 12);
    const size = u16(data, offset + 16);
    const season = u16(data, offset + 18);
    const tabType = stashFormat >= 2 ? data[offset + 20] : 0;
    if (size < 64 || offset + size > data.length) {
      result.warnings.push(`仓库页 ${tabIndex + 1} 大小异常 (${size})`);
      break;
    }

    const tab = { index: tabIndex, gold, season, type: tabType, itemCount: 0 };
    const body = offset + 64;
    // Type 2 is the chronicle log; types 0 and 1 (normal and advanced stash)
    // both hold ordinary item blocks.
    if (tabType === 2) {
      try {
        result.chronicle = readChronicleSection(data, body);
      } catch (err) {
        result.warnings.push(`编年史页: ${err.message}`);
      }
    } else if (data[body] === 0x4A && data[body + 1] === 0x4D) {
      const hint = tabType === 1 ? '进阶仓库' : `共享仓库 第${tabIndex + 1}页`;
      try {
        const r = new BitReader(data, body * 8);
        const sec = readItemsSection(r, cat, itemFormat || 105, hint);
        for (const it of sec.items) it.stashTab = tabIndex;
        tab.itemCount = sec.items.length;
        tab.declaredItemCount = sec.count;
        result.items.push(...sec.items);
      } catch (err) {
        result.warnings.push(`仓库页 ${tabIndex + 1}: ${err.message}`);
      }
    }
    result.tabs.push(tab);
    offset += size;
    tabIndex++;
  }
  return result;
}

const LOCATION_LABEL = { inventory: '背包', stash: '个人仓库', cube: '赫拉迪克方块',
  belt: '腰带栏', equip: '已装备', trade: '交易栏' };
const BODY_LABEL = { head: '头部', neck: '颈部', torso: '身体', right_arm: '主手',
  left_arm: '副手', right_ring: '右戒指', left_ring: '左戒指', waist: '腰带',
  feet: '脚', gloves: '手', right_hand: '主手', left_hand: '副手' };

export function locationLabel(item) {
  if (item.socketedIn) return '镶嵌中';
  if (item.locationHint) return item.locationHint;
  const p = item.position;
  if (p.mode === 'equipped' && p.body) return `身上 · ${BODY_LABEL[p.body] || p.body}`;
  if (p.mode === 'belt') return '腰带栏';
  if (p.page) return LOCATION_LABEL[p.page] || p.page;
  return p.mode;
}

export { BitReader, Catalog };
