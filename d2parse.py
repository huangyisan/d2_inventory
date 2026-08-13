"""
Diablo II: Resurrected save-file item scanner.

Reads every .d2s (character) and .d2i (shared stash) file in a directory and
extracts the items, focusing on identifying unique (gold) and set (green) items
and recording where each one lives.

The item bit layout and the Huffman table for D2R item codes follow the format
documented by the ResurrectedTrader/D2SSharp reference implementation, which
derives the Huffman tree from the game binary. Items are parsed in full,
including the trailing stat list, so item boundaries are exact.
"""

import json
import os
import struct

# --------------------------------------------------------------------------
# Huffman table for D2R item type codes: (symbol, bits MSB-first, bit length)
# --------------------------------------------------------------------------
HUFFMAN_TABLE = [
    ('0', 0b11111011, 8), (' ', 0b10, 2), ('1', 0b1111100, 7), ('2', 0b001100, 6),
    ('3', 0b1101101, 7), ('4', 0b11111010, 8), ('5', 0b00010110, 8), ('6', 0b1101111, 7),
    ('7', 0b01111, 5), ('8', 0b000100, 6), ('9', 0b01110, 5), ('a', 0b11110, 5),
    ('b', 0b0101, 4), ('c', 0b01000, 5), ('d', 0b110001, 6), ('e', 0b110000, 6),
    ('f', 0b010011, 6), ('g', 0b11010, 5), ('h', 0b00011, 5), ('i', 0b1111110, 7),
    ('j', 0b000101110, 9), ('k', 0b010010, 6), ('l', 0b11101, 5), ('m', 0b01101, 5),
    ('n', 0b001101, 6), ('o', 0b1111111, 7), ('p', 0b11001, 5), ('q', 0b11011001, 8),
    ('r', 0b11100, 5), ('s', 0b0010, 4), ('t', 0b01100, 5), ('u', 0b00001, 5),
    ('v', 0b1101110, 7), ('w', 0b00000, 5), ('x', 0b00111, 5), ('y', 0b0001010, 7),
    ('z', 0b11011000, 8),
]
MAX_CODE_LEN = 9
DECODE = {(length, bits): sym for sym, bits, length in HUFFMAN_TABLE}

STAT_TERMINATOR = 0x1FF

# Stats that are stored as a group: the leader carries the stat id, the
# followers are written straight after it with no id of their own.
PAIRED_STATS = {
    17: [18],           # item_maxdamage_percent -> item_mindamage_percent
    48: [49],           # firemindam -> firemaxdam
    50: [51],           # lightmindam -> lightmaxdam
    52: [53],           # magicmindam -> magicmaxdam
    54: [55, 56],       # coldmindam -> coldmaxdam, coldlength
    57: [58, 59],       # poisonmindam -> poisonmaxdam, poisonlength
}

STAT_ARMORCLASS = 31
STAT_DURABILITY = 72
STAT_MAXDURABILITY = 73
STAT_NUMSOCKETS = 194
STAT_QUEST_DIFFICULTY = 128

# Item codes that carry an advanced-stash stack size in save versions 100-101.
STACKABLE_V100 = set("""
rvs rvl gcv gfv gsv gzv gpv gcy gfy gsy gly gpy gcb gfb gsb glb gpb gcg gfg gsg glg gpg gcr gfr gsr
glr gpr gcw gfw gsw glw gpw skc skf sku skl skz r01 r02 r03 r04 r05 r06 r07 r08 r09 r10 r11 r12 r13
r14 r15 r16 r17 r18 r19 r20 r21 r22 r23 r24 r25 r26 r27 r28 r29 r30 r31 r32 r33 pk1 pk2 pk3 dhn bey
mbr toa tes ceh bet fed
""".split())


class BitReader:
    """LSB-first bit reader, matching D2's bitstream convention."""

    def __init__(self, data, bit_pos=0):
        self.data = data
        self.pos = bit_pos

    def read(self, count):
        result = 0
        read = 0
        while read < count:
            byte_index = self.pos >> 3
            if byte_index >= len(self.data):
                raise EOFError("read past end of data")
            bit_offset = self.pos & 7
            take = min(8 - bit_offset, count - read)
            bits = (self.data[byte_index] >> bit_offset) & ((1 << take) - 1)
            result |= bits << read
            self.pos += take
            read += take
        return result

    def bool(self):
        return self.read(1) != 0

    def align(self):
        if self.pos & 7:
            self.pos = (self.pos + 7) & ~7

    @property
    def byte_pos(self):
        return self.pos >> 3

    def seek_byte(self, byte_offset):
        self.pos = byte_offset * 8

    def string8(self, limit=64):
        out = []
        while len(out) < limit:
            ch = self.read(8)
            if ch == 0:
                break
            out.append(chr(ch))
        return "".join(out)


def decode_item_code(reader):
    """Decode a 4-character Huffman-encoded item code."""
    chars = []
    for _ in range(4):
        code = 0
        length = 0
        sym = None
        while length < MAX_CODE_LEN:
            code = (code << 1) | reader.read(1)
            length += 1
            sym = DECODE.get((length, code))
            if sym is not None:
                break
        if sym is None:
            raise ValueError("invalid huffman code")
        chars.append(sym)
    return "".join(chars)


# --------------------------------------------------------------------------
# Item flags
# --------------------------------------------------------------------------
F_IDENTIFIED = 0x00000010
F_SOCKETED = 0x00000800
F_IS_EAR = 0x00010000
F_STARTER = 0x00020000
F_INIT = 0x00080000
F_COMPACT = 0x00200000
F_ETHEREAL = 0x00400000
F_JUST_SAVED = 0x00800000
F_PERSONALIZED = 0x01000000
F_LOW_QUALITY = 0x02000000
F_RUNEWORD = 0x04000000
F_CHRONICLE = 0x10000000
F_CHRONICLE_COMPACT = 0x20000000

QUALITY = {1: "inferior", 2: "normal", 3: "superior", 4: "magic",
           5: "set", 6: "rare", 7: "unique", 8: "craft", 9: "tempered"}

MODE = {0: "stored", 1: "equipped", 2: "belt", 3: "ground",
        4: "cursor", 5: "dropping", 6: "socketed"}

STORE_PAGE = {0: "inventory", 1: "equip", 2: "trade", 3: "cube", 4: "stash", 5: "belt"}

BODY_LOCATION = {
    0: None, 1: "head", 2: "neck", 3: "torso", 4: "right_arm", 5: "left_arm",
    6: "right_ring", 7: "left_ring", 8: "waist", 9: "feet", 10: "gloves",
    11: "right_hand", 12: "left_hand",
}

CHARACTER_CLASS = {0: "Amazon", 1: "Sorceress", 2: "Necromancer", 3: "Paladin",
                   4: "Barbarian", 5: "Druid", 6: "Assassin"}


# --------------------------------------------------------------------------
# Game data
# --------------------------------------------------------------------------
class GameData:
    def __init__(self, data_dir):
        def load(name):
            with open(os.path.join(data_dir, name), encoding="utf-8") as fh:
                return json.load(fh)

        self.armor = load("armor.json")
        self.weapons = load("weapons.json")
        self.misc = load("misc.json")
        self.uniques = load("uniqueitems.json")
        self.setitems = load("setitems.json")
        self.sets = load("sets.json")
        self.itemtypes = load("itemtypes.json")
        self.itemstatcost = load("itemstatcost.json")

        self._build_type_hierarchy()
        self._build_base_items()
        self._build_stats()
        self._build_collections()

    # -- item type hierarchy (Equiv1/Equiv2 parent links) -------------------
    def _build_type_hierarchy(self):
        self.type_parents = {}
        self.type_varinvgfx = {}
        for code, row in self.itemtypes.items():
            code = code.strip()
            parents = [p.strip() for p in (row.get("Equiv1"), row.get("Equiv2")) if p]
            self.type_parents[code] = parents
            self.type_varinvgfx[code] = int(row.get("VarInvGfx") or 0)

    def _ancestors(self, type_code):
        seen = set()
        stack = [type_code]
        while stack:
            cur = stack.pop()
            if not cur or cur in seen:
                continue
            seen.add(cur)
            stack.extend(self.type_parents.get(cur, []))
        return seen

    # -- base items --------------------------------------------------------
    def _build_base_items(self):
        self.base = {}
        for table, kind in ((self.armor, "armor"), (self.weapons, "weapon"), (self.misc, "misc")):
            for code, row in table.items():
                code = code.strip()
                type_code = (row.get("type") or "").strip()
                anc = self._ancestors(type_code)
                self.base[code] = {
                    "code": code,
                    "name": row.get("name") or code,
                    "kind": kind,
                    "type": type_code,
                    "compactsave": bool(row.get("compactsave") or 0),
                    "levelreq": row.get("levelreq") or 0,
                    "is_armor": "armo" in anc,
                    "is_weapon": "weap" in anc,
                    "is_gold": "gold" in anc,
                    "is_charm": "char" in anc,
                    "is_bodypart": "body" in anc,
                    "is_playerbodypart": "play" in anc,
                    "is_scroll_or_book": "scro" in anc or "book" in anc,
                    "is_stackable": bool(row.get("stackable") or 0),
                    "is_quest": bool(row.get("quest") or 0),
                    "questdiffcheck": bool(row.get("questdiffcheck") or 0),
                    "has_variable_gfx": self.type_varinvgfx.get(type_code, 0) > 0,
                }

    # -- stat table --------------------------------------------------------
    def _build_stats(self):
        self.stats = {}
        for name, row in self.itemstatcost.items():
            sid = row.get("*ID")
            if sid is None:
                continue
            self.stats[int(sid)] = {
                "name": name,
                "save_bits": int(row.get("Save Bits") or 0),
                "save_param_bits": int(row.get("Save Param Bits") or 0),
                "save_add": int(row.get("Save Add") or 0),
                "val_shift": int(row.get("ValShift") or 0),
            }

    def stat_info(self, stat_id):
        return self.stats.get(stat_id, {"name": f"stat{stat_id}", "save_bits": 0,
                                        "save_param_bits": 0, "save_add": 0, "val_shift": 0})

    # -- unique / set collections -----------------------------------------
    def _build_collections(self):
        self.unique_by_id = {}
        for row in self.uniques.values():
            uid = row.get("*ID")
            name = (row.get("index") or "").strip()
            if uid is None or not name:
                continue
            code = (row.get("code") or "").strip()
            base = self.base.get(code)
            self.unique_by_id[int(uid)] = {
                "id": int(uid),
                "name": name,
                "code": code,
                "base": row.get("*ItemName") or (base["name"] if base else code),
                "slot": slot_of(base) if base else "其他",
                "lvl": row.get("lvl") or 0,
                "lvlreq": row.get("lvl req") or 0,
                "enabled": bool(row.get("enabled", 1)),
                "spawnable": bool(row.get("spawnable") or 0),
                "rarity": row.get("rarity") or 0,
                "ladder": bool(row.get("ladder") or 0),
            }

        self.setitem_by_id = {}
        for row in self.setitems.values():
            sid = row.get("*ID")
            name = (row.get("index") or "").strip()
            if sid is None or not name:
                continue
            code = (row.get("item") or "").strip()
            base = self.base.get(code)
            self.setitem_by_id[int(sid)] = {
                "id": int(sid),
                "name": name,
                "set": (row.get("set") or "").strip(),
                "code": code,
                "base": row.get("*ItemName") or (base["name"] if base else code),
                "slot": slot_of(base) if base else "其他",
                "lvl": row.get("lvl") or 0,
                "lvlreq": row.get("lvl req") or 0,
            }

        self.set_info = {}
        for name, row in self.sets.items():
            self.set_info[name.strip()] = {
                "name": name.strip(),
                "version": row.get("version"),
            }

    def base_info(self, code):
        return self.base.get(code.strip())


# --------------------------------------------------------------------------
# Equipment slot classification (used for "which slot am I missing")
# --------------------------------------------------------------------------
SLOT_BY_TYPE = {
    "helm": "头盔", "phlm": "头盔", "pelt": "头盔", "circ": "头盔",
    "tors": "盔甲",
    "shie": "盾牌", "ashd": "盾牌", "head": "盾牌", "nshd": "盾牌",
    "glov": "手套", "boot": "鞋子", "belt": "腰带",
    "amul": "项链", "ring": "戒指",
    "swor": "武器", "axe": "武器", "club": "武器", "hamm": "武器", "mace": "武器",
    "scep": "武器", "wand": "武器", "staf": "武器", "bow": "武器", "xbow": "武器",
    "spea": "武器", "pole": "武器", "knif": "武器", "tkni": "武器", "jave": "武器",
    "abow": "武器", "aspe": "武器", "ajav": "武器", "h2h": "武器", "h2h2": "武器",
    "orb": "武器", "obow": "武器",
    "char": "护身符", "jewl": "珠宝", "cjwl": "珠宝",
    "grim": "副手",
}


def slot_of(base):
    """Map a base item to a human-facing equipment slot."""
    if not base:
        return "其他"
    t = base["type"]
    if t in SLOT_BY_TYPE:
        return SLOT_BY_TYPE[t]
    if base["is_charm"]:
        return "护身符"
    if base["is_armor"]:
        return "盔甲类"
    if base["is_weapon"]:
        return "武器"
    return "其他"


# --------------------------------------------------------------------------
# Item parsing
# --------------------------------------------------------------------------
def read_stat_list(r, gd):
    """Read a stat list up to the 0x1FF terminator."""
    stats = []
    while True:
        stat_id = r.read(9)
        if stat_id == STAT_TERMINATOR:
            break
        info = gd.stat_info(stat_id)
        if info["save_bits"] == 0:
            raise ValueError(f"stat {stat_id} has no save bits")
        if info["save_param_bits"]:
            r.read(info["save_param_bits"])
        value = (r.read(info["save_bits"]) - info["save_add"]) << info["val_shift"]
        stats.append((info["name"], value))
        for paired_id in PAIRED_STATS.get(stat_id, []):
            pinfo = gd.stat_info(paired_id)
            pvalue = (r.read(pinfo["save_bits"]) - pinfo["save_add"]) << pinfo["val_shift"]
            stats.append((pinfo["name"], pvalue))
    return stats


def read_item(r, gd, save_version):
    """
    Read one complete item from the bit stream, leaving the reader positioned
    at the start of the next item. Returns a list: the item plus any items
    socketed into it.
    """
    if save_version <= 96:
        magic = r.read(16)
        if magic != 0x4D4A:  # "JM"
            raise ValueError("bad item magic")

    flags = r.read(32)
    is_gamble = bool(flags & F_LOW_QUALITY)
    flags &= ~F_LOW_QUALITY
    flags &= ~F_INIT
    compact = bool(flags & F_COMPACT)

    if save_version > 96:
        high = r.bool()
        v = r.read(2)
        version = v + 99 if high else v
    else:
        version = r.read(10)

    mode = r.read(3)
    if mode not in MODE:
        raise ValueError(f"bad item mode {mode}")

    pos = {"mode": MODE[mode]}
    if mode in (3, 5):
        pos.update(x=r.read(16), y=r.read(16), page=None, body=None)
    else:
        body = r.read(4)
        pos["body"] = BODY_LOCATION.get(body, f"body{body}")
        pos["x"] = r.read(4)
        pos["y"] = r.read(4)
        raw_page = r.read(3)
        pos["page"] = STORE_PAGE.get(raw_page - 1) if raw_page else None

    item = {
        "flags": flags,
        "version": version,
        "position": pos,
        "ethereal": bool(flags & F_ETHEREAL),
        "identified": bool(flags & F_IDENTIFIED),
        "runeword": bool(flags & F_RUNEWORD),
        "personalized": bool(flags & F_PERSONALIZED),
        "personalized_name": None,
        "compact": compact,
        "quality": "normal",
        "stack_count": 1,
        "unique_id": None,
        "set_id": None,
        "item_level": None,
        "sockets": 0,
        "code": None,
        "base_name": None,
    }

    if flags & F_IS_EAR:
        item["code"] = "ear"
        item["base_name"] = "Ear"
        item["is_ear"] = True
        r.read(3)
        r.read(7)
        r.string8()
        base = None
    else:
        code = decode_item_code(r)
        base = gd.base_info(code)
        if base is None:
            raise ValueError(f"unknown item code {code!r}")
        item["code"] = base["code"]
        item["base_name"] = base["name"]
        item["kind"] = base["kind"]
        item["type"] = base["type"]
        item["slot"] = slot_of(base)

    socketed_items = []

    if compact:
        if base and base["is_gold"]:
            big = r.bool()
            item["gold"] = r.read(32) if big else r.read(12)
            if save_version > 96:
                r.bool()
        if save_version > 92 and base and base["is_quest"] and base["questdiffcheck"]:
            info = gd.stat_info(STAT_QUEST_DIFFICULTY)
            r.read(info["save_bits"])
        read_realm_data(r, save_version)
        item["stack_count"] = read_advanced_stash(r, item["code"], save_version)
        item["item_level"] = 1
        item["quality"] = "normal"
        r.align()
        return [item] + socketed_items

    if is_gamble:
        item["quality"] = "inferior"
        r.align()
        return [item] + socketed_items

    socketed_count = r.read(3)
    item["seed"] = r.read(32)
    ilvl = r.read(7)
    item["item_level"] = max(ilvl, 1)

    q = r.read(4)
    if q not in QUALITY:
        raise ValueError(f"bad quality {q}")
    item["quality"] = QUALITY[q]

    if r.bool():
        r.read(3)   # variable graphics index
    if r.bool():
        r.read(11)  # auto affix

    if q == 1 or q == 3:        # inferior / superior
        r.read(3)
    elif q == 4:                # magic
        r.read(11)
        r.read(11)
    elif q in (5, 7):           # set / unique
        file_index = r.read(12)
        if q == 5:
            item["set_id"] = file_index
        else:
            item["unique_id"] = file_index
    elif q in (6, 8):           # rare / craft
        r.read(8)
        r.read(8)
        for _ in range(3):
            if r.bool():
                r.read(11)
            if r.bool():
                r.read(11)
    elif q == 9:                # tempered
        r.read(8)
        r.read(8)
    elif q == 2 and base:       # normal special cases
        if base["is_charm"]:
            if r.bool():
                r.read(11)
            else:
                r.read(11)
        elif base["is_bodypart"] and not base["is_playerbodypart"]:
            r.read(10)
        elif base["is_scroll_or_book"]:
            r.read(5)

    if flags & F_RUNEWORD:
        item["runeword_id"] = r.read(16)

    if flags & F_IS_EAR:
        r.read(3)
        r.read(7)
        r.string8()
    elif flags & F_PERSONALIZED:
        item["personalized_name"] = r.string8()

    read_realm_data(r, save_version)

    if base and base["is_armor"]:
        ac = gd.stat_info(STAT_ARMORCLASS)
        md = gd.stat_info(STAT_MAXDURABILITY)
        du = gd.stat_info(STAT_DURABILITY)
        item["defense"] = r.read(ac["save_bits"]) - ac["save_add"]
        max_dur = r.read(md["save_bits"]) - md["save_add"]
        item["max_durability"] = max_dur
        if max_dur > 0:
            item["durability"] = r.read(du["save_bits"]) - du["save_add"]
    elif base and base["is_weapon"]:
        md = gd.stat_info(STAT_MAXDURABILITY)
        du = gd.stat_info(STAT_DURABILITY)
        max_dur = r.read(md["save_bits"]) - md["save_add"]
        item["max_durability"] = max_dur
        if max_dur > 0:
            item["durability"] = r.read(du["save_bits"]) - du["save_add"]
    elif base and base["is_gold"]:
        big = r.bool()
        item["gold"] = r.read(32) if big else r.read(12)
        if save_version > 96:
            r.bool()

    if save_version > 104:
        if r.bool():
            item["quantity"] = r.read(9)
    elif base and base["is_stackable"]:
        item["quantity"] = r.read(9)

    if flags & F_SOCKETED:
        ns = gd.stat_info(STAT_NUMSOCKETS)
        item["sockets"] = r.read(ns["save_bits"])

    set_mask = 0
    if q == 5:
        set_mask = r.read(5)

    item["stats"] = read_stat_list(r, gd)

    if q == 5:
        for i in range(5):
            if set_mask & (1 << i):
                read_stat_list(r, gd)

    if flags & F_RUNEWORD:
        read_stat_list(r, gd)

    read_chronicle(r, flags, save_version)
    item["stack_count"] = read_advanced_stash(r, item["code"], save_version)

    r.align()

    for _ in range(socketed_count):
        socketed_items.extend(read_item(r, gd, save_version))
    for s in socketed_items:
        s["socketed_in"] = item["code"]

    return [item] + socketed_items


def read_realm_data(r, save_version):
    if save_version <= 86:
        return
    if not r.bool():
        return
    count = 4 if save_version > 96 else (3 if save_version > 93 else 2)
    for _ in range(count):
        r.read(32)


def read_advanced_stash(r, code, save_version):
    """
    The auto-sorting stash tabs (gems / runes / materials) hold stacks, not
    single items: one entry can be "6 x Pul Rune". Returns how many the entry
    stands for, 1 when there is no stack count.
    """
    if save_version <= 99:
        return 1
    if save_version <= 101:
        if code not in STACKABLE_V100:
            return 1
    else:
        if not r.bool():
            return 1
    return max(1, r.read(8))


def read_chronicle(r, flags, save_version):
    if save_version <= 99 or not (flags & F_CHRONICLE):
        return
    r.read(16)
    compact = bool(flags & F_CHRONICLE_COMPACT)
    if not compact:
        r.read(32)
    count = 1 if compact else r.read(4)
    count = min(count, 8)
    for _ in range(count):
        r.read(32)
        r.read(32)


def read_items_section(r, gd, save_version, location_hint=None):
    """Read a 'JM' + count item block."""
    magic = r.read(16)
    if magic != 0x4D4A:
        raise ValueError(f"expected JM item section, got 0x{magic:04X}")
    count = r.read(16)
    items = []
    for _ in range(count):
        items.extend(read_item(r, gd, save_version))
    if location_hint:
        for it in items:
            it.setdefault("location_hint", location_hint)
    return items, count


# --------------------------------------------------------------------------
# Display helpers
# --------------------------------------------------------------------------
def item_identity(item, gd):
    """Resolve the display name and collection key of an item."""
    if item.get("unique_id") is not None:
        info = gd.unique_by_id.get(item["unique_id"])
        if info:
            return info["name"], ("unique", item["unique_id"]), info
        return f"未知暗金 #{item['unique_id']}", None, None
    if item.get("set_id") is not None:
        info = gd.setitem_by_id.get(item["set_id"])
        if info:
            return info["name"], ("set", item["set_id"]), info
        return f"未知套装 #{item['set_id']}", None, None
    if item.get("runeword"):
        return f"{item['base_name']} (符文之语)", None, None
    return item["base_name"], None, None


LOCATION_LABEL = {
    "inventory": "背包", "stash": "个人仓库", "cube": "赫拉迪克方块",
    "belt": "腰带栏", "equip": "已装备", "trade": "交易栏",
}
BODY_LABEL = {
    "head": "头部", "neck": "颈部", "torso": "身体", "right_arm": "主手",
    "left_arm": "副手", "right_ring": "右戒指", "left_ring": "左戒指",
    "waist": "腰带", "feet": "脚", "gloves": "手", "right_hand": "主手",
    "left_hand": "副手",
}


def location_label(item):
    if item.get("socketed_in"):
        return "镶嵌中"
    hint = item.get("location_hint")
    if hint:
        return hint
    p = item["position"]
    if p["mode"] == "equipped" and p.get("body"):
        return f"身上 · {BODY_LABEL.get(p['body'], p['body'])}"
    if p["mode"] == "belt":
        return "腰带栏"
    if p.get("page"):
        return LOCATION_LABEL.get(p["page"], p["page"])
    return p["mode"]


# --------------------------------------------------------------------------
# File parsing
# --------------------------------------------------------------------------
def parse_character(path, gd):
    with open(path, "rb") as fh:
        data = fh.read()

    if data[:4] != b"\x55\xaa\x55\xaa":
        raise ValueError("not a d2s file")
    version = struct.unpack("<I", data[4:8])[0]

    name = os.path.splitext(os.path.basename(path))[0]
    result = {
        "source": name,
        "source_type": "character",
        "file": os.path.basename(path),
        "version": version,
        "items": [],
        "warnings": [],
    }

    if version > 96:
        # D2R (v97+) dropped the 16-byte in-file character name; the file name
        # is the character name, so every header field below shifts by 16.
        status, progression, cls, level = data[0x14], data[0x15], data[0x18], data[0x1B]
    else:
        status, progression, cls, level = data[0x24], data[0x25], data[0x28], data[0x2B]
    result["class"] = CHARACTER_CLASS.get(cls, f"未知({cls})")
    result["level"] = level
    result["progression"] = progression
    result["hardcore"] = bool(status & 0x04)

    start = data.find(b"JM")
    if start < 0:
        result["warnings"].append("找不到物品区段")
        return result

    r = BitReader(data, start * 8)
    items, count = read_items_section(r, gd, version)
    result["declared_item_count"] = count
    result["items"] = items

    # Corpse section: 'JM' + count, then per corpse 12 bytes + an item block.
    try:
        corpse_items, corpse_count = read_items_section(r, gd, version, location_hint="尸体")
        for _ in range(corpse_count):
            r.read(12 * 8)
            more, _ = read_items_section(r, gd, version, location_hint="尸体")
            result["items"].extend(more)
        result["items"].extend(corpse_items)
    except (ValueError, EOFError) as exc:
        result["warnings"].append(f"尸体区段: {exc}")
        return result

    # Mercenary items: 'jf' marker, then an item block if the merc exists.
    try:
        marker = r.read(16)
        if marker == 0x666A:  # 'jf'
            if data[r.byte_pos:r.byte_pos + 2] == b"JM":
                merc_items, _ = read_items_section(r, gd, version, location_hint="佣兵装备")
                result["items"].extend(merc_items)
    except (ValueError, EOFError) as exc:
        result["warnings"].append(f"佣兵区段: {exc}")

    return result


CHRONICLE_MAGIC = 0xC0EAEDC0


def read_chronicle_section(data, body, body_size):
    """
    Read a chronicle stash tab: the game's log of every set / unique / runeword
    the account has ever found. Entries are 10 bytes and byte-aligned.
    """
    magic = struct.unpack("<I", data[body:body + 4])[0]
    if magic != CHRONICLE_MAGIC:
        raise ValueError(f"编年史标记错误 0x{magic:08X}")
    version = struct.unpack("<H", data[body + 4:body + 6])[0]
    set_count, unique_count, rw_count = struct.unpack("<HHH", data[body + 6:body + 12])

    pos = body + 12 + 8  # counts, then 8 reserved bytes

    def take(n):
        nonlocal pos
        out = []
        for _ in range(n):
            item_id, source, timestamp = struct.unpack("<IHI", data[pos:pos + 10])
            pos += 10
            out.append({"id": item_id, "source": source, "timestamp": timestamp})
        return out

    return {
        "version": version,
        "sets": take(set_count),
        "uniques": take(unique_count),
        "runewords": take(rw_count),
    }


def parse_stash(path, gd):
    with open(path, "rb") as fh:
        data = fh.read()

    name = os.path.splitext(os.path.basename(path))[0]
    result = {
        "source": name,
        "source_type": "stash",
        "file": os.path.basename(path),
        "tabs": [],
        "items": [],
        "chronicle": None,
        "warnings": [],
        "version": struct.unpack("<I", data[4:8])[0] if len(data) >= 8 else 0,
    }

    offset = 0
    tab_index = 0
    while offset + 64 <= len(data):
        if data[offset:offset + 4] != b"\x55\xaa\x55\xaa":
            break
        item_format = struct.unpack("<I", data[offset + 8:offset + 12])[0]
        gold = struct.unpack("<I", data[offset + 12:offset + 16])[0]
        size = struct.unpack("<H", data[offset + 16:offset + 18])[0]
        season = struct.unpack("<H", data[offset + 18:offset + 20])[0]
        stash_format = struct.unpack("<I", data[offset + 4:offset + 8])[0]
        tab_type = data[offset + 20] if stash_format >= 2 else 0
        if size < 64 or offset + size > len(data):
            result["warnings"].append(f"仓库页 {tab_index} 大小异常 ({size})")
            break

        tab = {"index": tab_index, "gold": gold, "season": season,
               "type": tab_type, "item_count": 0}
        body = offset + 64
        # Type 2 is the chronicle log; types 0 and 1 (normal and advanced
        # stash) both hold ordinary item blocks.
        if tab_type == 2:
            try:
                result["chronicle"] = read_chronicle_section(data, body, size - 64)
            except (ValueError, struct.error) as exc:
                result["warnings"].append(f"编年史页: {exc}")
        elif data[body:body + 2] == b"JM":
            hint = ("进阶仓库" if tab_type == 1 else f"共享仓库 第{tab_index + 1}页")
            try:
                r = BitReader(data, body * 8)
                items, count = read_items_section(r, gd, item_format or 105,
                                                  location_hint=hint)
                for it in items:
                    it["stash_tab"] = tab_index
                tab["item_count"] = len(items)
                tab["declared_item_count"] = count
                result["items"].extend(items)
            except (ValueError, EOFError) as exc:
                result["warnings"].append(f"仓库页 {tab_index + 1}: {exc}")

        result["tabs"].append(tab)
        offset += size
        tab_index += 1

    return result


def parse_directory(save_dir, data_dir):
    gd = GameData(data_dir)
    sources = []
    for fn in sorted(os.listdir(save_dir)):
        path = os.path.join(save_dir, fn)
        if not os.path.isfile(path):
            continue
        try:
            if fn.lower().endswith(".d2s"):
                sources.append(parse_character(path, gd))
            elif fn.lower().endswith(".d2i"):
                sources.append(parse_stash(path, gd))
        except Exception as exc:
            sources.append({"source": os.path.splitext(fn)[0], "source_type": "error",
                            "file": fn, "error": f"{type(exc).__name__}: {exc}",
                            "items": [], "warnings": []})
    return gd, sources


if __name__ == "__main__":
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    save_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "Diablo_2_Resurrected")
    gd, sources = parse_directory(save_dir, os.path.join(here, "data"))

    total = 0
    for src in sources:
        items = src.get("items", [])
        total += len(items)
        extra = ""
        if src["source_type"] == "character":
            extra = (f" {src.get('class')} lv{src.get('level')}"
                     f" 声明={src.get('declared_item_count')}")
        elif src["source_type"] == "error":
            extra = f" 错误: {src['error']}"
        print(f"\n=== {src['source']} [{src['source_type']}]{extra}  解析={len(items)}")
        for w in src.get("warnings", []):
            print(f"    ! {w}")
        for it in items:
            if it["quality"] not in ("unique", "set"):
                continue
            nm, key, info = item_identity(it, gd)
            print(f"    [{it['quality']:6s}] {nm:32s} ({it.get('base_name')}) @ {location_label(it)}")
    print(f"\n合计解析物品: {total}")
