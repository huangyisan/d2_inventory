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

页面右上角显示当前版本（构建时的 commit 短哈希），刷新后一眼就能确认拿到的是哪个构建；
鼠标悬停显示构建时间。哈希后带 `+` 表示这份是工作区有未提交改动时生成的本地构建。

「备份存档」把当前读到的全部存档原样打包成带时间戳的 zip 下载。存档本身不会被改动。

## 五个视图

| 视图 | 用途 |
| --- | --- |
| 套装收集 | 每套的部位清单，已有的标绿、缺的划掉 —— 看「还差哪几件」 |
| 暗金收集 | 全部暗金对照表，可按部位筛选、只看未拥有的 |
| 重复清理 | 只列拥有 2 件以上的，每种留 1 件即可 |
| 找回清单 | 游戏内「编年史」记录找到过、但当前存档里没有的物品 |
| 符文合成 | 购物车式的合成计算器，见下 |

### 符文合成

点符文把它加进「我要合成」清单，再点一次加一个数量，每项可以 `−` `+` `×`。
仓库里的符文宝石是参考列表，作为起始材料。

- 目标符文一律**从配方做起**：点 24 号是要合一个出来，不会拿仓库里现成的 24 号交差；
  现货只在它作为下层材料时才动用
- 清单里多个目标**共用同一份材料**，要 2 个乌姆就实打实吃掉 4 个普尔
- 合不出来时给出「这些材料最多凑出 N 个」，N 由二分求得（plan 对数量单调）
- 缺口报在**断掉的那一层**，不会展开成「差 17 亿个艾尔符文」

升级配方：10 号以下 3 换 1，11–21 号 3 换 1 加宝石，22 号往上 2 换 1 加更高品质宝石；
宝石 3 颗同色同级升一级。自动分类储物箱里的符文宝石是**成摞**的，按摞里的数量计。
已镶进装备的不计入可用材料。

鼠标悬停在任意物品名上会显示属性。这些是游戏数据表里的固定属性，
会浮动的属性显示为区间（如 `全部抗性 +20~35%`），不是某一件的实际洗练值。

## 部署（Cloudflare Pages）

Git 集成，推到 `master` 自动构建：

| 字段 | 值 |
| --- | --- |
| 生产分支 | `master` |
| 构建命令 | `python3 make_page.py` |
| 构建输出目录 | `dist` |

构建命令不是必需的（`dist/index.html` 已提交，留空也能部署），但填上之后
Cloudflare 会注入 `CF_PAGES_COMMIT_SHA`，页面右上角就显示**真正部署的那个 commit**；
留空的话显示的是本地打包时 HEAD 的哈希，会落后一个提交并带 `+`。

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
