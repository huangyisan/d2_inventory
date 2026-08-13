# 暗黑破坏神2 收藏台账

扫描 D2R 存档，列出你拥有的暗金装备与绿色套装、分别放在哪个小号上、还差哪些没收集，
以及哪些是可以清掉的重复件。

**存档只读打开，绝不修改、绝不上传。**

## 用法

双击 `暗黑2收藏台账.html`（推荐 Chrome / Edge），点「选择存档文件夹」，选中：

- macOS：`~/Library/Application Support/Blizzard/Diablo II Resurrected/`
- Windows：`%USERPROFILE%\Saved Games\Diablo II Resurrected\`

玩完游戏存档后，回页面点「重新读取」即可刷新。文件夹会被记住，下次打开自动载入。

页面是一个完全自包含的 HTML：不需要服务器、不需要 Python、不联网。

## 六个视图

| 视图 | 用途 |
| --- | --- |
| 套装收集 | 每套的部位清单，已有的标绿、缺的划掉 —— 看「还差哪几件」 |
| 暗金收集 | 全部暗金对照表，可按部位筛选、只看未拥有的 |
| 我的收藏 | 已有物品列表，显示数量和所在小号 —— 找「东西放哪了」 |
| 重复清理 | 只列拥有 2 件以上的，每种留 1 件即可 |
| 找回清单 | 游戏内「编年史」记录找到过、但当前存档里没有的物品 |
| 按小号 | 逐个小号看身上的暗金/绿装 |

鼠标悬停在任意物品名上会显示属性。这些是游戏数据表里的固定属性，
会浮动的属性显示为区间（如 `全部抗性 +20~35%`），不是某一件的实际洗练值。

## 开发

运行时不需要以下任何东西；它们只用于重新生成页面和校验解析器。

```bash
python3 fetch_data.py      # 下载游戏数据表（uniqueitems/setitems/armor/weapons/...）
python3 fetch_names.py     # 下载 D2R 官方多语言字符串表
python3 fetch_t2s.py       # 下载 OpenCC 繁转简对照表
python3 fetch_props.py     # 下载属性/技能表
python3 make_catalog.py    # 生成内嵌用的精简目录 data/catalog.json
python3 make_page.py       # 打包成单文件 暗黑2收藏台账.html
```

校验（浏览器解析器 vs Python 参考实现，必须逐字段一致）：

```bash
python3 dump_reference.py && node verify.mjs   # 两份解析结果对比
node test_page.mjs                             # 加载打包产物并核对统计数字
```

### 文件

- `src/parser.js` — 浏览器端 .d2s / .d2i 解析器
- `src/app.js` — 目录选择、交叉比对、渲染
- `src/page.html` — 页面骨架与样式
- `props.py` — 属性码 → 中文描述的渲染器
- `d2parse.py` — Python 参考解析器，用于交叉验证

### 存档格式说明

D2R 存档版本 105。相比经典版的主要差异，均已处理：

- 物品类型码改为 Huffman 压缩编码（码表取自游戏二进制）
- 存档内 16 字节角色名字段被移除，角色名即文件名，其后 header 字段整体前移 16 字节
- 物品不再有逐件 `JM` 前缀，只有区段头有
- 物品格式版本改为 1 bit 标志 + 2 bit 数值
- v105 起所有物品都带 1 bit 数量标志位

物品需要完整解析到属性列表末尾才能确定边界，因此解析器实现了完整的
stat list 读取（含成对属性组），而不是靠扫描猜测下一件的位置。

数据来源：[blizzhackers/d2data](https://github.com/blizzhackers/d2data)（游戏数据表）、
[SeonEngineer/D2R](https://github.com/SeonEngineer/D2R)（官方多语言字符串）、
[ResurrectedTrader/D2SSharp](https://github.com/ResurrectedTrader/D2SSharp)（存档格式参考实现）。
