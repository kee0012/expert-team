# 从外部专家团包导入团队（执笔规范 + 导入器）

本文件是**可复用的导入流程说明**，也是给执笔环节（人或模型）的写作规范。
`scripts/import-teams.mjs` 只负责机械部分（校验 → 分配头像 → 合并进 `data/teams.json`），
**不生成 persona** —— 那一步必须由读过源包的人/模型完成。

## 0. 两种来源形态（先判断你手上是哪种）

| 形态 | 特征 | 处理 |
|---|---|---|
| **skillhub 专家团包** | `manifest.json`（`type: "skillhub-expert-package"`）+ `skillsets/<slug>.md` + `skills/<slug>/SKILL.md` | 标准流程，见下 |
| **技能包 / 宿主插件** | 没有 `manifest.json`：可能是某个 agent 宿主的插件（如 OpenClaw 插件），只附带一个 `SKILL.md` | 按那个技能的流程与工具集**拆分角色**，并在 persona 里写明工具链不可用时的降级路径 |

`.zip` 形态的 `skills/` 需要先解压再读。

## 1. 映射口径（固定的，不要自由发挥）

- **一个包 = 一支团队**：1 位**主理人（lead）** + **skillset 里每个 skill 各 1 位专家（member）**。
  主理人只负责确认参数、调度、中转上下文、汇总收口与终检，**不代写任何成员的专业产出**。
- **members[].id 优先直接用 skill 的 slug**（kebab-case；skill slug 就是它）。主理人用 `<短前缀>-chief`。
- **skillset 标注的「获取层 / 分析层 / 输出层」直接变成团队 `stages`**：同层内的 skill 放同一阶段（并行），
  层与层之间串行；主理人落在最后一个「汇总收口」阶段。`stages` 必须覆盖**全部**成员。
- **persona 必须自带可执行方法论**：从 `SKILL.md` / `references/` / `scripts/` 提炼**真实**的方法名、参数、
  阈值、公式、工具名与输出格式。因为这些 skill 通常**没有**装进目标环境的技能目录
  （先在 `$DSH_HOME/skills` 下逐个核对），persona 里要写明：
  > 若当前环境已安装 `<skill-slug>` 技能就优先调用它，否则按本角色的方法论自行完成。
- **不做的事**：不搬源包里的脚本与数据（体积与许可都不可控），不把脚本做不到的能力写成脚本能力，
  不编造方法名 / 文献 / 接口地址。做不到的如实写成「人工判读」或「按已知规则推导」。

## 2. 团队草案 JSON 的字段白名单

写到 `<草案目录>/<team-id>.json`，**一个文件一支团队**，内容是**单个对象**（不是数组、不带 markdown 围栏）：

```json
{
  "id": "<小写 kebab-case，≤40，通常用 manifest.slug>",
  "name": "中文团队名（≤40 字）",
  "tagline": "一句话简介（≤90 字）",
  "emoji": "一个 emoji",
  "accent": "#RRGGBB",
  "category": "<画廊分类，≤12 字；沿用现有分类或新增>",
  "tags": ["≤4 个，每个 ≤10 字"],
  "createdAt": "2026-10-05T12:00:00+08:00",
  "presets": ["≤6 条，每条 ≤140 字，写成用户真会开口的一句需求"],
  "cases": [
    { "emoji": "📄", "title": "≤40 字", "desc": "≤90 字", "delivery": "≤8000 字 Markdown 成品示例" }
  ],
  "members": [
    {
      "id": "kebab-case，团内唯一",
      "name": "角色名（≤30 字）",
      "alias": "中文人名昵称（≤20 字）",
      "role": "lead | member（整团恰好 1 位 lead）",
      "emoji": "一个 emoji",
      "focus": "职责一句话（≤40 字）",
      "persona": "简体中文 800–1500 字（硬上限 4000）"
    }
  ],
  "stages": [
    { "stage": 1, "name": "≤16 字", "members": ["成员 id"] }
  ]
}
```

**硬约束**：

1. **不要写 `avatar` 字段**（团队与成员都不要）—— 由导入器统一分配（团队头像不撞脸、成员头像队内唯一）。
2. **字段只能出现在上面的白名单里**：`skills` / `version` / `notes` / `source` 之类会被导入器丢弃并告警。
3. **中文字段里禁止英文半角双引号**：`profile="chrome"` 这种写法会直接写坏 JSON
   （真实踩过：`SyntaxError: Expected ',' or '}' after property value in JSON at position 14527`）。
   要强调字面量就用中文引号「」或直接不加引号。
4. 字数上限是硬上限；`stages` 序号从 1 连续、不重复、覆盖全部成员。
5. 全部文本用简体中文（skill 名 / 工具名 / 方法名保留英文原名）。
6. **草案全部写完、且所有执笔者都确认结束之后**再跑导入 —— 并行执笔时中途落盘会与后来写入的版本漂移
   （真实踩过：两次导入后有两支团队的草案又被改写，只能重跑导入对齐）。

## 3. persona 写法（成员详情页按这四个标记切小节）

四段式**连续段落**（不要 Markdown 标题、不要列表符号堆砌，可以 ①②③ 编号）：

1. **身份与职责** —— 「你是「<角色名> · <别名>」，<团队名>的<定位>。你的职责是……」
2. **工作方式** —— `你的工作方式是：` + 可执行的分步动作，写清真实判据、阈值、公式、工具名
3. **交付物** —— `你的交付物是：` + 产出形态（文档 / 图表 / JSON / 代码 / 报告）
4. **纪律** —— `你的纪律是：` + 不做什么、不确定怎么标注、与上下游的分工边界、以及技能不可用时的降级路径

写得好的判断标准：① 有没有写清**与同团其他成员的分工边界**；② 工作方式是不是可执行动作而不是形容词；
③ 纪律里有没有**反例**。参考 `data/teams.json` 里 `software-company`（5 人，约 800 字/段）与
`deep-research-team`（7 人，带 stages）。

> 长度：建议 800–1500 字。装速查表类内容（如元标签表、韵部表、排盘契约）的 persona 可以更长
> （现有内置团队最长的一段是 2563 字），只要不超过 4000 硬上限；**不要为了凑字数而注水**。

## 4. 导入

```bash
node scripts/import-teams.mjs --from <草案目录>          # 导入全部草案
node scripts/import-teams.mjs --from <草案目录> --dry    # 只预演
node scripts/import-teams.mjs --from <草案目录> --only a,b
```

导入器会：白名单校验（结构性问题**整体拒写**、未知字段丢弃并告警）→ 团队头像三选一
（草案自带 → 复用库里同 id 团队的原头像 → 空闲池顺序取，因此**重跑幂等、头像不抖**）→
成员头像队内唯一 → 同 id 覆盖保持数组原位、新 id 插到最前 → 写盘前整体自洽复检。

导入完照例：

```bash
node scripts/build.mjs
node scripts/gates.mjs && node scripts/smoke.mjs && node scripts/client-smoke.mjs
```

**运行中的实例不会自动看到新团队**：`TeamRepository` 在插件 `apply` 时只构造一次，
要么重载插件，要么重启宿主应用。

## 5. 已导入的来源（溯源表）

首批 7 支（2026-10-05 并入，插件 0.2.2；每支的 `members[].id` 就是它来源 skill 的 slug）：

| 团队 id | 来源包 | 来源形态 | skill → 成员 |
|---|---|---|---|
| `academic-statistical-analysis` | `academic-statistical-analysis` | skillhub 包（skills 为 zip） | r-stats / biostatistics / data-analysis-workflow / statistics-2 / data-analyst-cn / mathgraphs |
| `design-ui-prototype` | `design-ui-prototype` | skillhub 包 | prd-to-prototype / design-to-code / afrexai-ui-design-system / ui-design / wireframe / frontend-design-pro |
| `content-creation-lyrics-songwriting` | `content-creation-lyrics-songwriting` | skillhub 包 | acestep-songwriting / insight-song / suno-poetry-music-creator / suno-music-composer / suno-browser-songmaking / songwriting-and-ai-music（承载 MV 流水线） |
| `tech-code-refactoring` | `tech-code-refactoring` | skillhub 包 | code-analyzer / agent-git-oracle / uncle-bob / code-refactoring / system-architect / simplify |
| `mysticism-yijing-divination` | `mysticism-yijing-divination` | skillhub 包（skills 为 zip） | gua / liuyao-yijing / meihua-yishu-divination / xiaoliuren / yi / cyber-iching-master |
| `mysticism-ziwei-doushu` | `mysticism-ziwei-doushu` | skillhub 包（skills 为 zip） | zwds-openclaw / ziwei-fortune / ziwei-doushu / ziwei-dou-shu / destiny-fusion-pro / zwds-hepan-openclaw |
| `materials-lab` | `materials-lab-0.1.0` | **宿主插件**（OpenClaw 插件 `@cranesun/openclaw-materials-lab` + 一个技能） | materials-chief(lead) / candidate-scout / structure-analyst / candidate-ranker / research-note-keeper / report-delivery-officer |

**溯源与许可**：源包只用于提炼 persona，**没有**把它们的脚本、数据或技能文件复制进本插件
（那些内容的许可见源包自身）；团队定义本身（角色、阶段、纪律）是本插件的数据。
