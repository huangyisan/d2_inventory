"""
Render an item's fixed properties (from the game data tables) as readable text.

These are the catalogue values, not the rolled values in a save file: where a
property has a range the range is shown, so a tooltip reads
"+20~35% 全部抗性" rather than whatever a particular copy happens to have.

Property codes are mapped through a curated template table. Codes with no
template fall back to showing the raw code and value, so an unmapped property
is visibly unmapped rather than silently wrong.
"""

import json
import os

# --------------------------------------------------------------------------
# Templates: property code -> (template, kind)
#
# {v} is the value or range. Templates are ordered roughly as the game shows
# them, but the source tables already list them in a sensible order.
# --------------------------------------------------------------------------
PLAIN = {
    # attributes
    "str": "+{v} 力量",
    "dex": "+{v} 敏捷",
    "vit": "+{v} 体力",
    "enr": "+{v} 精力",
    "all-stats": "+{v} 全部属性",
    "hp": "+{v} 生命",
    "mana": "+{v} 法力",
    "stam": "+{v} 耐力",
    "hp%": "+{v}% 最大生命",
    "mana%": "+{v}% 最大法力",

    # defence
    "ac": "+{v} 防御",
    "ac%": "+{v}% 增强防御",
    "ac-miss": "+{v} 防御(对远程)",
    "ac-hth": "+{v} 防御(对近战)",
    "red-dmg": "伤害减免 {v}",
    "red-dmg%": "伤害减免 {v}%",
    "red-mag": "魔法伤害减免 {v}",
    "block": "+{v}% 格挡率",
    "dur": "+{v} 耐久度",
    "indestruct": "无法破坏",
    "ethereal": "虚空(无法修理)",
    "rep-dur": "每 {v} 秒修复 1 点耐久",
    "rep-quant": "每 {v} 秒补充 1 个",
    "stack": "+{v} 最大堆叠数",

    # offence
    "dmg%": "+{v}% 增强伤害",
    "dmg-norm": "+{v} 伤害",
    "dmg-min": "+{v} 最小伤害",
    "dmg-max": "+{v} 最大伤害",
    "dmg": "+{v} 伤害",
    "att": "+{v} 攻击准确率",
    "att%": "+{v}% 攻击准确率",
    "crush": "{v}% 压碎打击",
    "deadly": "{v}% 致命攻击",
    "openwounds": "{v}% 开放性伤口",
    "ignore-ac": "无视目标防御",
    "reduce-ac": "-{v}% 目标防御",
    "dmg-ac": "-{v} 目标防御",
    "pierce": "{v}% 穿刺攻击",
    "knock": "击退",
    "dmg-undead": "+{v}% 对不死系伤害",
    "dmg-demon": "+{v}% 对恶魔伤害",
    "att-undead": "+{v} 对不死系攻击准确率",
    "att-demon": "+{v} 对恶魔攻击准确率",
    "dmg-to-mana": "{v}% 伤害转为法力",
    "noheal": "阻止怪物治疗",
    "slow": "减慢目标 {v}%",
    "freeze": "冻结目标 +{v}",
    "howl": "{v}% 命中时使怪物逃跑",
    "stupidity": "{v}% 命中时使怪物昏迷",
    "rip": "无法复活尸体",
    "bloody": "额外血腥效果",

    # elemental damage
    "fire-min": "+{v} 最小火焰伤害",
    "fire-max": "+{v} 最大火焰伤害",
    "ltng-min": "+{v} 最小闪电伤害",
    "ltng-max": "+{v} 最大闪电伤害",
    "cold-min": "+{v} 最小冰霜伤害",
    "cold-max": "+{v} 最大冰霜伤害",
    "pois-min": "+{v} 最小毒素伤害",
    "pois-max": "+{v} 最大毒素伤害",
    "cold-len": "冰冻持续 {v}",
    "pois-len": "中毒持续 {v}",

    # resistances
    "res-all": "全部抗性 +{v}%",
    "res-fire": "火焰抗性 +{v}%",
    "res-cold": "冰霜抗性 +{v}%",
    "res-ltng": "闪电抗性 +{v}%",
    "res-pois": "毒素抗性 +{v}%",
    "res-mag": "魔法抗性 +{v}%",
    "res-all-max": "全部最大抗性 +{v}%",
    "res-fire-max": "最大火焰抗性 +{v}%",
    "res-cold-max": "最大冰霜抗性 +{v}%",
    "res-ltng-max": "最大闪电抗性 +{v}%",
    "res-pois-max": "最大毒素抗性 +{v}%",
    "res-pois-len": "中毒时间缩短 {v}%",
    "abs-fire": "吸收火焰伤害 {v}",
    "abs-cold": "吸收冰霜伤害 {v}",
    "abs-ltng": "吸收闪电伤害 {v}",
    "abs-fire%": "吸收 {v}% 火焰伤害",
    "abs-cold%": "吸收 {v}% 冰霜伤害",
    "abs-ltng%": "吸收 {v}% 闪电伤害",
    "half-freeze": "冰冻时间减半",
    "nofreeze": "不会被冰冻",

    # leech / recovery
    "lifesteal": "{v}% 伤害转为生命",
    "manasteal": "{v}% 伤害转为法力",
    "regen": "每秒回复生命 +{v}",
    "regen-mana": "回复法力 +{v}%",
    "regen-stam": "回复耐力 +{v}%",
    "mana-kill": "每次击杀获得 {v} 法力",
    "heal-kill": "每次击杀回复 {v} 生命",
    "demon-heal": "每杀死一个恶魔回复 {v} 生命",
    "stamdrain": "耐力消耗减少 {v}%",

    # speed
    "swing1": "+{v}% 攻击速度",
    "swing2": "+{v}% 攻击速度",
    "swing3": "+{v}% 攻击速度",
    "cast1": "+{v}% 施法速度",
    "cast2": "+{v}% 施法速度",
    "cast3": "+{v}% 施法速度",
    "balance1": "+{v}% 受击回复速度",
    "balance2": "+{v}% 受击回复速度",
    "balance3": "+{v}% 受击回复速度",
    "block1": "+{v}% 格挡速度",
    "block2": "+{v}% 格挡速度",
    "block3": "+{v}% 格挡速度",
    "move1": "+{v}% 跑步速度",
    "move2": "+{v}% 跑步速度",
    "move3": "+{v}% 跑步速度",

    # thorns / misc
    "thorns": "攻击者受到 {v} 点伤害",
    "light-thorns": "攻击者受到 {v} 点闪电伤害",
    "mag%": "+{v}% 魔法物品掉落几率",
    "gold%": "+{v}% 金币掉落数量",
    "light": "+{v} 光照范围",
    "ease": "需求 -{v}%",
    "cheap": "购买花费减少 {v}%",
    "addxp": "+{v}% 经验值获得",
    "sock": "镶孔数 {v}",
    "magicarrow": "+{v} 魔法箭等级",
    "explosivearrow": "+{v} 爆炸箭等级",

    # pierce / mastery
    "pierce-fire": "-{v}% 敌人火焰抗性",
    "pierce-ltng": "-{v}% 敌人闪电抗性",
    "pierce-cold": "-{v}% 敌人冰霜抗性",
    "pierce-pois": "-{v}% 敌人毒素抗性",
    "pierce-mag": "-{v}% 敌人魔法抗性",
    "pierce-dmg": "-{v}% 敌人物理抗性",
    "extra-fire": "+{v}% 火焰技能伤害",
    "extra-ltng": "+{v}% 闪电技能伤害",
    "extra-cold": "+{v}% 冰霜技能伤害",
    "extra-pois": "+{v}% 毒素技能伤害",
    "extra-mag": "+{v}% 魔法技能伤害",
    "pierce-immunity-fire": "可穿透火焰免疫",
    "pierce-immunity-cold": "可穿透冰霜免疫",
    "pierce-immunity-light": "可穿透闪电免疫",
    "pierce-immunity-poison": "可穿透毒素免疫",
    "pierce-immunity-magic": "可穿透魔法免疫",
    "pierce-immunity-damage": "可穿透物理免疫",
}

# Elemental damage ranges: code -> (label, has_duration)
ELEM_RANGE = {
    "dmg-fire": ("火焰伤害", False),
    "dmg-ltng": ("闪电伤害", False),
    "dmg-mag": ("魔法伤害", False),
    "dmg-cold": ("冰霜伤害", True),
    "dmg-pois": ("毒素伤害", True),
    "dmg-elem": ("元素伤害", False),
}

# Per-character-level properties. The value is stored in 1/8 units.
PER_LEVEL = {
    "ac/lvl": "防御",
    "att/lvl": "攻击准确率",
    "hp/lvl": "生命",
    "mana/lvl": "法力",
    "dmg/lvl": "最大伤害",
    "dmg%/lvl": "增强伤害%",
    "str/lvl": "力量",
    "dex/lvl": "敏捷",
    "vit/lvl": "体力",
    "stam/lvl": "耐力",
    "thorns/lvl": "荆棘伤害",
    "mag%/lvl": "魔法物品掉落几率%",
    "gold%/lvl": "金币掉落%",
    "deadly/lvl": "致命攻击%",
    "att-und/lvl": "对不死系攻击准确率",
    "dmg-und/lvl": "对不死系伤害",
    "att-dem/lvl": "对恶魔攻击准确率",
    "dmg-dem/lvl": "对恶魔伤害",
    "res-ltng/lvl": "闪电抗性%",
    "abs-fire/lvl": "吸收火焰伤害",
    "abs-cold/lvl": "吸收冰霜伤害",
    "att%/lvl": "攻击准确率%",
    "regen-stam/lvl": "耐力回复%",
}

CLASS_SKILL = {
    "ama": "亚马逊", "sor": "女法师", "nec": "死灵法师", "pal": "圣骑士",
    "bar": "野蛮人", "dru": "德鲁伊", "ass": "刺客", "war": "野蛮人",
}

ELEM_SKILL = {"fireskill": "火焰", "coldskill": "冰霜", "ltngskill": "闪电", "poisskill": "毒素"}

# item_addskill_tab index -> tab name.
# Index is class_order*3 + (SkillPage-1); the order below was derived from
# skills.json/skilldesc.json rather than written from memory.
SKILL_TABS = {
    0: "亚马逊 · 弓与十字弓", 1: "亚马逊 · 被动与魔法", 2: "亚马逊 · 标枪与长矛",
    3: "女法师 · 火焰", 4: "女法师 · 闪电", 5: "女法师 · 冰霜",
    6: "死灵法师 · 诅咒", 7: "死灵法师 · 毒素与白骨", 8: "死灵法师 · 召唤",
    9: "圣骑士 · 战斗技能", 10: "圣骑士 · 攻击灵气", 11: "圣骑士 · 防御灵气",
    12: "野蛮人 · 战斗技能", 13: "野蛮人 · 战斗专精", 14: "野蛮人 · 战吼",
    15: "德鲁伊 · 召唤", 16: "德鲁伊 · 变身", 17: "德鲁伊 · 元素",
    18: "刺客 · 陷阱", 19: "刺客 · 暗影原则", 20: "刺客 · 武术",
}

ON_EVENT = {
    "hit-skill": "攻击时", "gethit-skill": "受击时", "death-skill": "死亡时",
    "att-skill": "攻击时", "kill-skill": "击杀时", "levelup-skill": "升级时",
}


class PropRenderer:
    def __init__(self, data_dir, strings, t2s=None):
        def load(name):
            path = os.path.join(data_dir, name)
            if not os.path.exists(path):
                return {}
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)

        self.strings = strings
        self.t2s = t2s or (lambda s: s)
        skills = load("skills.json")
        skilldesc = load("skilldesc.json")

        self.skill_by_id = {r.get("*Id"): r for r in skills.values() if r.get("*Id") is not None}
        self.skill_by_name = {(r.get("skill") or "").lower(): r for r in skills.values()}
        self.desc_by_name = {r.get("skilldesc"): r for r in skilldesc.values() if r.get("skilldesc")}
        self.unmapped = set()

    def skill_name(self, param):
        """Resolve a skill id (or internal skill name) to a localized name."""
        row = None
        if isinstance(param, int):
            row = self.skill_by_id.get(param)
        elif isinstance(param, str):
            row = self.skill_by_name.get(param.lower())
        if not row:
            return str(param)
        desc = self.desc_by_name.get(row.get("skilldesc"))
        if desc:
            for field in ("str name", "str alt"):
                key = desc.get(field)
                if key:
                    got = self.strings.get(key, None)
                    if got and got != key:
                        return got
        return self.t2s(row.get("skill") or str(param))

    @staticmethod
    def _val(lo, hi):
        lo = 0 if lo is None else lo
        hi = lo if hi is None else hi
        return f"{lo}" if lo == hi else f"{lo}~{hi}"

    def render_one(self, code, param, lo, hi):
        """Render one property row; returns a string or None to skip it."""
        if not code or code.startswith("*"):
            return None

        if code in PLAIN:
            return PLAIN[code].replace("{v}", self._val(lo, hi))

        if code in ELEM_RANGE:
            label, has_dur = ELEM_RANGE[code]
            lo = lo or 0
            hi = hi if hi is not None else lo
            text = f"+{lo}~{hi} {label}" if lo != hi else f"+{lo} {label}"
            if has_dur and param:
                text += f"（持续 {round(param / 25)} 秒）"
            return text

        if code in PER_LEVEL:
            # stored in 1/8 units per character level
            per = (param or 0) / 8
            per = int(per) if per == int(per) else round(per, 2)
            return f"每角色等级 +{per} {PER_LEVEL[code]}"

        if code == "allskills":
            return f"+{self._val(lo, hi)} 全部技能等级"
        if code in CLASS_SKILL:
            return f"+{self._val(lo, hi)} {CLASS_SKILL[code]}技能等级"
        if code in ELEM_SKILL:
            return f"+{self._val(lo, hi)} {ELEM_SKILL[code]}技能等级"
        if code == "randclassskill":
            return f"+{self._val(lo, hi)} 随机职业技能等级"
        if code == "skilltab-war":
            return f"+{self._val(lo, hi)} 【野蛮人 · 战吼】技能等级"
        if code == "magdam-rand":
            return f"+{self._val(lo, hi)} 魔法伤害"
        if code == "skilltab":
            tab = SKILL_TABS.get(param, f"技能树 {param}")
            return f"+{self._val(lo, hi)} 【{tab}】技能等级"
        if code in ("skill", "oskill"):
            return f"+{self._val(lo, hi)} {self.skill_name(param)}"
        if code == "skill-rand":
            return f"+{self._val(lo, hi)} 随机技能等级"
        if code == "aura":
            return f"施放 等级 {self._val(lo, hi)} 的 {self.skill_name(param)} 光环"
        if code == "charged":
            # min = charges, max = skill level
            return f"等级 {hi if hi is not None else lo} 的 {self.skill_name(param)}（{lo} 次充能）"
        if code.lower() in ON_EVENT:
            when = ON_EVENT[code.lower()]
            return f"{lo}% 几率{when}施放 等级 {hi} 的 {self.skill_name(param)}"
        if code == "reanimate":
            return f"{self._val(lo, hi)}% 几率复活敌人为随从"

        self.unmapped.add(code)
        return None

    def render_rows(self, row, count, prefix="prop", par="par", lo="min", hi="max"):
        out = []
        for i in range(1, count + 1):
            code = row.get(f"{prefix}{i}")
            if not code:
                continue
            text = self.render_one(code, row.get(f"{par}{i}"),
                                   row.get(f"{lo}{i}"), row.get(f"{hi}{i}"))
            if text and text not in out:
                out.append(text)
        return out
