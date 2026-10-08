# expert-team

把一支**多角色专家团**装进 DSH 会话。借鉴 WorkBuddy 的「专家团」体验，但完全按 DSH 的插件机制实现：

- **团队画廊** — 内置 21 支专家团、共 133 位专家（产品设计 / 前沿研究 / 技术工程 / 学术写作 / 内容创作 / 数据智能 / 营销增长 / 人力资源 / 金融投资 / 法律合规 / 命理玄学），版式对齐 WorkBuddy：标题栏 + 排序（综合·最热·最新）+ 分类筛选 chips + 4 列卡片网格（圆头像、名称、`发布方 · N位专家`、简介、标签）。其中 7 支是 2026-10-05 从外部 skillhub 专家团包导入的（统计分析 / UI 原型设计 / 歌词创作 / 代码重构 / 易经起卦 / 紫微斗数 / 材料科研，见「从外部专家团包导入团队」）。另有 **论衡长文流水线**（`lunheng-longform`）是 9 角色 / 6 阶段的深度长文生产流水线 —— 文献 / 数据 / 案例三线并行检索（三角验证：[Lxx] 文献卡、[Dxx] 数据卡、[Cxx] 案例卡）、分析大纲、起草、批判伙伴（C1–C7）与独立审计（G0–G14，含中文 AI 痕迹闸）、修订与同行评审（六维逐字固定：原创性 / 方法论 / 证据强度 / 论证结构 / 写作质量 / 引文规范，总评分 `xx/30` = 六维之和 + 期刊匹配 Top 3）、最后一步的 M 门机械终检由主理人亲自执行（M-Form 11 + M-Exist 11 + M-Fact 1 + M-Integrity 2 = 25 项 = 机械 24 + 人工门 1）。
- **团队详情** — 大圆头像 + 使用次数 + 黑色胶囊「召唤专家团」CTA + 引号预设提问条 + 使用案例缩略图 + 团队成员名册（主理人带 🏅 徽章）。
- **一键召唤** — 点 chip 打开面板，每位专家被派进一个**独立子会话**（`ctx.subagents.startContinuable`），带着自己的角色人格并行开工，可点开逐个查看工作过程。
- **召集人汇总** — 主会话担任召集人，收到「专家团已就位」简报后等待所有专家返回，再汇总成一份统一交付物。
- **自定义团队** — 面板里可以新建/编辑团队：成员 persona、预设提问、使用案例、分类标签都能自己写，存本地 JSON。

## 界面位置

| 场景 | 位置 |
|---|---|
| **空会话态（hero）** | 「专家团」chip 落在「工作区 \| Agent 预设」那一行、紧贴**「标准模式」右侧**，与「标准模式」同排并立（`order: 100`），不另占一行 |
| **有内容的会话** | chip 回落为输入卡片工具行（`+` / 权限 / 计划模式那一行）左侧的并列控件 |
| 点开后 | 全屏模态：团队画廊 → 团队详情 → 召唤任务面板 → 新建/编辑团队 |

**视觉上与邻居同款**（不是"塞进去的异物"）：透明底、鼠标悬停才出底色、16px 单色线性图标、字号 13 / 字重 500 / 行高 20 / 圆角 16 / 内边距 `0 8px` —— 每一项都是拿真机量出来的，见下「设计要点」第 10 条。

## 安装

插件以 **bundle 形态**（`dsh.bundle.patch` + `dsh.client`）分发，装进某个 profile 即可被 DSH 加载。
下面命令里的 `$dsh` 指向 **DSH 自带的 CLI** —— 桌面版把它连同运行时放在安装目录里
（`<安装目录>\resources\runtime\cli\bin\dsh.cmd`），**不在源码仓库、也不在 PATH 上**；
从源码跑 DSH 时等价入口是 `node <checkout>/apps/cli/lib/bin.js`。替换成你自己的路径即可：

```powershell
# DSH 自带 CLI（桌面版示例；按你的安装位置调整）
$dsh = 'D:\Program Files\deepseek harness\resources\runtime\cli\bin\dsh.cmd'
# 本插件目录（= 本 README 所在目录）
$plugin = (Get-Location).Path

# 装到桌面版 profile；装到 web profile 就把 desktop 换成 web
& $dsh plugin --profile desktop add "link:$plugin"

# 卸载
& $dsh plugin --profile desktop remove expert-team
```

- 用 `link:` 指向开发目录：pnpm 建**软链**而不是拷贝，所以改完 `src/` 跑一次 `node scripts/build.mjs`
  就生效，不必重装、也不必再往 profile 里拷一遍（旧版 README 里的 `file:` + 手工拷贝是 pnpm 的旧行为，已不需要）。
- **路径里不要有中文**：`dsh plugin` 内部经 `cmd.exe`（GBK）转发给 pnpm，非 ASCII 路径会被弄坏，
  表现为「报错 `declares no dsh.bundle`，且 `node_modules/<包名>` 变成空目录」。开发目录必须含中文时，
  绕过办法是**直接调 pnpm**（不经 shell），再让 CLI 跑一次 reconcile：
  `node "<安装目录>\resources\runtime\pnpm\bin\pnpm.cjs" add "file:<路径>" --dir <profile 目录>`。
- 装好后**Node 半边热加载**（profile 里 `patchReload: live`，改完 `build` 即重载），
  **客户端半边需要刷新页面**（或重开窗口）才换新 bundle。
- 也可以走 DSH 原生的插件管理通道（等价）：`plugin_manager` 的 `install_bundle` / `remove_bundle`。

装好后：

1. 打开一个**空会话**，「标准模式」右侧应出现「专家团」chip（发过消息后它会回到输入卡片工具行左侧）。
2. 点开 → 选一支团队 → 点「召唤专家团」→ **入口 chip 就地变成团队标签**（`● 团队名 3/3 ▾`，悬停出现 `×`）。
3. 在输入框写下需求、按回车即派遣（这次回车被接管，需求不会当普通消息发出去）；点 `×` 取消召唤、点团队名回画廊换一支。
4. 会话里会出现「专家团已就位」简报，同时左侧会话树里会长出 N 个子会话（每位专家一个）。
5. 健康检查：`GET http://127.0.0.1:<端口>/expert-team/api/health`
   （端口 = 当前 GUI 地址栏里的端口；桌面版本次为 19387，web profile 默认 3080）。

### 仓库里有什么（从零上手）

| 路径 | 内容 |
|---|---|
| `src/index.js` · `src/client/index.jsx` | 宿主半（Cordis 插件）与浏览器半（CJS + ModuleLoader）源码 —— **改代码改这里** |
| `lib/` | 构建产物，**已入库**（从 git 源安装不会跑构建脚本）；用 `node scripts/build.mjs` 重新生成 |
| `data/teams.json` | **内置 21 支团队 / 133 位专家**的全部数据（团队、成员 persona、阶段计划、预设与案例） |
| `assets/member-avatars/` | 36 张成员头像（含上游出处与许可 `README.md` / `LICENSE.upstream.txt` / `NOTICE.upstream.txt`） |
| `locale/` · `assets/icon.svg` | 插件管理器里显示的标题 / 描述 / 图标 |
| `scripts/` | 构建、门禁、两套冒烟、真浏览器验收、团队提升与导入脚本 |
| `docs/plan.md` · `docs/expert-pack-import.md` | 开发决策追踪（含每轮适配依据）；外部专家团包的执笔规范与导入流程 |
| 被 `.gitignore` 排除 | `node_modules/`、`.tmp/`、`lib.tmp|prev/`、`*.tgz`、`*.log`、`__pycache__/` |

从零上手（只需 Node 22.19+ / 24 与 pnpm）：

```bash
pnpm install                 # 只装构建用的 esbuild
node scripts/build.mjs       # 生成 lib/index.js + lib/client.js
node scripts/gates.mjs && node scripts/smoke.mjs && node scripts/client-smoke.mjs
```

无需任何 `@deepseek-ai/*` 依赖、也不联网即可构建（esbuild 找不到时会去 `DSH_ESBUILD_SEARCH`
与 `$DSH_HOME/plugins`、`~/.dsh/plugins` 等标准位置复用已有安装）。

## 用法

### 面板

- **召唤**：选团队 → 「🚀 召唤专家团」→ 预设提问点一下即可填入 → 在输入框那枚团队标签的成员菜单里勾选要派遣的成员 → 在输入框写下需求按回车即派遣。
- **分批派遣（流水线团队）**：带阶段计划的团队，成员菜单顶部会出现一排阶段按钮（`一次性 | P1 初步调研 | P2 规划大纲 | …`）。
  点某一阶段 = **只派这一阶段的成员**；后续阶段**由召集人接力**：每位专家收尾时会把成果回传主会话，
  召集人收齐本阶段全部回传后，把产出原文作为 `context` 再调一次 `expert_team_summon`（带上下一个 `stage`）—— 见 `summonBriefing` 注入的那段指引。
  也就是说：**你只需要点一次第 1 阶段，整条流水线会自动往后跑**。菜单里的「一次性」按钮则退回旧行为（全部成员同题并行）。
  面板不负责收集中间产出 —— 各专家的回传只到主会话那里，面板拿不到，所以第 2 阶段起由手里有内容的那一方（召集人）驱动。
- **渐进降级的护栏**：派遣时会给专家子会话设子代理层数上限（`limits.maxDelegateDepth`，默认 1 层），
  防止「专家又各自召唤一支团」导致子会话数量爆炸。provider 若没声明 `depthLimit` capability，
  护栏**不会假装生效** —— 面板与工具的返回值里会如实报告降级情况。
- **为什么不用 `toolFilter` 硬禁专家团工具**：本插件的 `expert_team_list` / `expert_team_summon` 是注册在
  **每个 agent 自己的作用域**里的（`agent.ctx.tools.register`），而宿主的 `tools.restrict()` 只认
  **全局或祖先作用域**提供的工具名。把它们写进 `toolFilter` 会让宿主抛
  `tools.restrict() names unknown global tools ...`，**整批派遣全部失败**（v0.2.2 实测翻车，
  表现是面板派遣失败后草稿里灌进一大段英文报错）。所以只允许 1 层时改为在专家提示词里写一条软约束
  （「不要再召唤其他专家团、也不要再派遣下属子代理」），并在返回值里用 `guard.nestedSoftOnly` 如实标注；
  `guard.toolsDenied` 保留但恒为 `false`。
- **新建/编辑**：右上角「+ 新建团队」。自定义团队存 `$DSH_HOME/expert-teams/teams.json`；与内置团队同 id 时覆盖内置，删除后恢复内置版本。
  **开发阶段内置团队同样可以直接编辑**（保存即在用户目录落一份同 id 副本），是否锁成只读由 `config.json` 决定 —— 见「开发期配置」。
  攒出来的团队想**沉淀成内置基线**（跟随插件走，而不是躺在用户目录里），跑 `node scripts/promote-team.mjs` —— 见「开发阶段：把团队沉淀为内置」。
- **头像**：团队图标与成员头像用的是**同一套 36 张插画**（圆形，见 [assets/member-avatars](assets/member-avatars/README.md)）——
  点格子换一张，不用手打字符。表单打开时会按 id / 名称自动落一张；
  之后改文案**不会**让它乱跳（索引是文本哈希来的，跟着输入走会"每敲一个字换张脸"），
  想换就点「推荐这张」采纳新推荐、或直接点网格里任意一张。一旦你亲手挑过，就不会再被自动改。
- **成员详情**：在团队详情的「团队成员」里点任意一位，弹出该成员的完整信息 ——
  称呼 / 昵称 / 职责 / 角色 / 头像 / 人格提示词，提示词按「职责 · 工作方式 · 交付物 · 纪律」
  分块展示（也可以切回整段编辑）。保存后列表与团队配置同步刷新。
  **内置团队在开发阶段同样可直接改**；只有把配置里的 `lockBuiltinTeams` 打开，才退回「只读、另存为自定义」的形态。

### 斜杠命令

```
/expert-team list                 列出全部团队
/expert-team show <团队id>        看某支团队的成员名册
/expert-team summon <团队id>      给出派遣指引
```

### 模型工具（agent 作用域）

| 工具 | 作用 |
|---|---|
| `expert_team_list` | 列出团队 id、名称、成员名册与职责 |
| `expert_team_summon` | `{team_id, task, member_ids?}`，为每位专家开独立子会话并返回子会话 id |

`expert_team_summon` 只为该会话所属 agent 注册（跟随 `agent/created` / `agent/disposed` 生命周期），不会污染其他会话。

### HTTP 接口

同源前缀 `/expert-team/api/`，无需鉴权但请求体上限 1MB：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `health` | 插件与 subagent provider 状态 |
| GET | `config` | 当前运行配置（`lockBuiltinTeams` + 各项 `limits`） |
| GET | `teams` | 全部团队（**不含 persona 正文**）+ 当前配置 `config` |
| POST | `teams` | 新建/覆盖团队（含字段校验）；配置里锁定内置时，改内置 id 返回 403 `LOCKED` |
| GET | `teams/<id>` | 单支团队 |
| DELETE | `teams/<id>` | 删除自定义团队（内置团队删不掉） |
| POST | `summon` | `{sessionId, teamId, task, memberIds?}` → 直接派遣 |
| GET | `status?teamId=` | 本次运行期内的派遣台账 |

## 团队数据格式

内置团队在 `data/teams.json`，用户团队在 `$DSH_HOME/expert-teams/teams.json`，同一结构：

### 开发期配置 `config.json`

首次启动会在 `$DSH_HOME/expert-teams/config.json` 落一份默认配置，让用户有一份可以直接改的模板；
改完**重开面板（或再点一下入口）即生效**，不需要重启 dsh web。

```jsonc
{
  "schemaVersion": 1,
  "lockBuiltinTeams": false,   // false = 内置团队可编辑（开发阶段）；true = 内置只读（定稿后）
  "limits": {                  // 各项上限；删掉某项即回落到代码里的默认值
    "maxMembers": 13,          // 成员数
    "maxTags": 4,              // 卡片标签 chip 数
    "maxPresets": 6,
    "maxCases": 6,
    "maxPersona": 4000         // 成员 persona 字数
    // …完整键名见 src/index.js 的 DEFAULT_LIMITS
  }
}
```

`limits` 里只接受正整数，非法值（0 / 负数 / 非数字）一律回落到默认值 —— 免得手滑把插件卡死。

```jsonc
{
  "schemaVersion": 1,
  "teams": [
    {
      "id": "my-team",                 // 小写 kebab-case，≤40
      "name": "我的专家团",
      "tagline": "一句话简介",
      "emoji": "🎯",
      "accent": "#4F46E5",
      "category": "产品设计",           // 画廊分类筛选用
      "tags": ["需求分析", "竞品对标"],  // ≤4 个，卡片上的标签
      "createdAt": "2026-09-21T10:00:00+08:00",   // 供「最新」排序；编辑时保留原值
      "presets": ["预设提问一", "预设提问二"],   // ≤6 条；每条 ≤140 字，写成用户真会开口的需求
      "cases": [                                 // 使用案例；点开看「交付结果」长什么样
        {
          "emoji": "📄",
          "title": "用例名",                     // ≤40 字
          "desc": "一句话说明",                  // ≤90 字
          "delivery": "# 交付结果示例 …"          // 可选：这个案例跑完后的成品长什么样（≤8000 字 Markdown）
        }
      ],
      "members": [
        {
          "id": "lead-one",            // 小写 kebab-case，团内唯一
          "name": "牵头人",
          "alias": "小牵",
          "role": "lead",              // lead | member，整团最多 1 位 lead
          "emoji": "🧭",
          "focus": "职责范围一句话",
          "persona": "你是……你的职责是……你的工作方式是……你的交付物是……你的纪律是……"
        }
      ],
      // 可选：阶段计划。声明了它就是「可分批派遣」的流水线团队；不写 = 一次性并行派遣。
      "stages": [
        { "stage": 1, "name": "初步调研", "members": ["topic-researcher"] },
        { "stage": 2, "name": "规划大纲", "members": ["research-planner"] }
      ]
    }
  ]
}
```

**`stages`（阶段计划）的规则**：

- **团队级字段，不是成员级** —— 同一位专家可以横跨多个阶段（深度研究团队的课题研究员既做初步调研、又做逐章起草）。成员级单值表达不了这件事。
- `stage` 序号必须 **从 1 连续递增**（1、2、3…），这样「阶段序号」与「第几个阶段」永远是同一个数。
- **必须覆盖全部成员**：声明了 `stages` 却有成员没被任何阶段引用，服务端直接返回 400。否则那位专家会永远派不出去，而且是**静默**的。
- 引用的成员 id 必须存在；同一阶段内不重复；阶段数上限见 `config.json` 的 `limits.maxStages`（默认 9）。
- 判别只看一个事实：**`stages` 有几个条目**。≥2 就是流水线团队（面板显示「N 阶段流水线」徽标、成员菜单出现阶段切换），=0 或只有 1 个阶段则与旧行为逐字一致（prompt 里不会出现任何阶段措辞）。

**persona 写法建议**：写「职责 / 工作方式 / 交付物 / 纪律」四段（**按这个顺序，且把这四个词原样写进去** —— 成员详情会按标记切小节，`scripts/merge-persona.mjs` 也据此校验），比写形容词有效得多。内置 133 位专家基本都是这个结构（多在 700~1500 汉字；歌词创作团队有 3 段到 2064~2563 字，因为要把 171+ 元标签速查、韵部表与 MV 流水线塞进 persona，仍在 4000 字硬上限内），可以直接抄改。判断一段 persona 写得好不好，看三点：① 有没有写清**与同团其他成员的分工边界**（不写边界，多角色就会重复劳动）；② 工作方式是不是可执行的分步动作（而不是「深入分析」这类形容词）；③ 纪律里有没有**反例**。

**内容资产的规格**（三样都要齐，缺哪样这支队看起来就「薄」）：

| 资产 | 规格 | 为什么 |
|---|---|---|
| `persona` | 700~1200 汉字，四段式 | 一位专家的全部行为约束都在这一段里 |
| `presets` | 5~6 条，每条 ≤140 字 | 它们是面板上「点一下就能用」的入口，2 条太少、用户不知道这队还能干什么 |
| `cases[].delivery` | 每个案例 800~2500 字 Markdown 成品示例 | 「使用案例」点开要能看到**交付结果长什么样**；只有一句 desc 等于没有案例 |

三条 `delivery` 与 6 条 `presets` 的写法参考 `deep-research-team.json`（用户自建、效果好）。补齐多支团队时用 `scripts/polish-teams.mjs` 批量合并 + 校验。

**`publisher` 不用手写**：它是派生字段（内置团队 → `DSH 官方团队`，自定义团队 → `我的团队`），由宿主在 `publicView` 里算出来，卡片上的 `发布方 · N位专家` 用的就是它。

## 设计要点（为什么这么写）

这些约束来自本机 DSH 的实测教训，改动前请先读：

1. **严格 `inject` 只声明 `webServer`**（`export const inject = ['webServer']`）。原因：严格 inject 缺服务会让插件永久 pending，而 DSH loader 把 pending 当 **fatal boot error**——本机 `cordis.patch.yml` 里已因此禁用了 6 个以上插件。
   其余服务分两条路走：**注册面用 `ctx.inject([...], scoped => …)` 按需装配**（`ctx.inject(['commands'], …)` 装斜杠命令、`ctx.inject(['agents','tools'], …)` 装两个模型工具）——服务就绪时执行、服务重启后自动重跑、作用域卸载时连带回收里面的注册，**服务缺失不是错误、只是那条能力不生效**；**请求处理面在真正要用的那一刻 `ctx.get('agents')` / `ctx.get('subagents')` 取一次**，取不到就返回一句可读错误（`DSH 未提供 agents/subagents 服务，无法派遣专家`），同样不让插件 pending。
2. **完全不引用任何 `@deepseek-ai/*`**。工具注册直接写**原生 JSON Schema**（`ctx.tools.register` 收的就是 JSON Schema，`defineTool` 只是「参数 DSL → JSON Schema」的编译器）。少一个依赖，就少一条加载失败路径。
3. **不与内置 agent-team 耦合，也不重造它的轮子**。0.2.0 运行时里装的是 `@deepseek-ai/dsh-experimental-agent-team`（外加 `-tool-` / `-client-ui-` 两个配套包）：实测这三个包里 `provide(` / `ctx.set(` 命中数都是 **0**，也**不注册** `expert_team_*` 之类的工具 —— 它是一套「隐式根团队 + 持久对等邮箱 + 共享任务 DAG」的自用实现，**没有对外暴露任何可复用的 cordis 服务**；再加上它的成员结构没有 persona / 头像 / 使用案例字段、投影 schema 是 `.strict()`、数据锚定在单个会话的事件流里——装不下「跨会话的团队卡片库」。所以团队数据自持，只复用底层稳定契约 `ctx.subagents.startContinuable` / `ctx.sessions`。
   > 同类竞品 `@michengai/dsh-agency-agents` 也往 `conversation.input.left` 注册 chip（它 order 0、本插件 order 40，两者会并排出现）；它同时也是 0.2.0 官方写法的现成范例——`slots.register` 除 `name/id/order` 外还接受 `locale` / `inject` 选项，`settings.section` 条目还支持 `label()` 与 `icon`。
4. **persona 走能力探测 + 回退**。`SubagentStartRequest.persona` 需要 provider 声明 `capabilities.persona === true`，否则 `startContinuable` 直接抛 `UNSUPPORTED_CAPABILITY`。所以运行时会先探测：支持就传 `persona`；不支持就把 persona 正文并进 `request.prompt`，行为等价、只是少一层原生通道。`GET health` 里的 `personaNative` 就是这个探测结果。
5. **召唤是「模型决策 + 宿主执行」两层**。客户端点「确认派遣」先打 `POST /summon` 由宿主直接建子会话（确定性高）；若返回失败（会话已关闭 / 无 provider / 无服务），自动回退为把「请调用 expert_team_summon」的简报提交进会话，交给模型完成。
6. **客户端 bundle 是 CJS 经典脚本**，由 `window.__ModuleLoader__.load({ id, factory })` 包装，`react` 必须 external（内联第二份 React 会导致 hooks 崩溃）。两个注册点（`conversation.input.left` 触发 chip / `shell.overlay` 模态）来自同一模块实例，靠模块级 store 共享状态——因为 `shell.overlay` 是 root 作用域、拿不到会话的 `inputActions`。
7. **入口槽位选型**：`conversation.input.dock` 是「输入卡片上方的**整行**信息区」，DSH 自己拿它放 todo / 队列 / 目标（`TodoPanel`、`QueueDock`、`ui-goal`）——一枚小按钮挂上去会独占一行、把输入区顶高一整行。所以注册点用 `conversation.input.left`（`InputBar` 的 `.tools` 行内 list 槽），与 `+`、权限选择、计划模式并列。这也是**有内容会话**里的落位方式。
   「已召唤」标签**复用同一个控件**（激活时入口 chip 就地变成团队标签），不再往 `conversation.input.dock` 另挂第二份 —— 那个槽会让一枚小胶囊独占一行、悬在输入框上方，视觉上离输入框很远；状态与入口本就是同一件事，合并后取消召唤即自动还原。**全插件只有两个注册点**。
8. **空会话态想落到「标准模式」右边，槽位方案是做不到的**。hero 行由 `heroWorkspaceRow` 渲染，里面三个槽（`conversation.hero.workspace` / `.agentPreset` / `.brand.mark`）在 `slots.ts` 里都是 **single** 语义：同优先级再注册直接抛错，异优先级是**遮蔽**（顶掉别人）而不是并列。所以那一行**不能**用槽位加第三个控件。最终方案是 **`createPortal` 到 hero 行的真实 DOM 节点**（见下一条）。
9. **portal 落位靠语义锚点，不靠 class —— 而且必须先问「现在是哪个阶段」**。DSH 的 class 是构建哈希（`_seat_1a2b3` 之类）不能依赖，改用这几个稳定锚点：
   - **`[data-slot="conversation.hero.agentPreset"]`（首选）** — `ui-renderer` 的 `SlotOutlet` 会给**每一个槽位出口**渲染一层 `<div data-slot={slotKey} style={{display:'contents'}}>`（`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1094-1104`），key 就是槽位名本身、属公开契约。挂到它的 `parentElement` 上就是 hero 行本体，**不必再猜"往上跳几层"**；取不到时降一级试 `conversation.hero.workspace`。
   - `[data-composer-card]` — `InputBar.tsx` 里写死的卡片根节点，用来把「输入卡片内的控件」排除掉；
   - `[data-phase]` — `ConversationRoot` 打在会话根上的阶段（`settling` / `hero` / `active`）。**「工作区 | Agent 预设」那一行只在 `hero`（空会话）态存在**，所以非 `hero` 一律返回 null，chip 留在工具行；
   - `[data-composer-seat]` — 包住 hero 行 + dock + 输入卡片的输入区容器，把扫描范围收在它里面；
   - `button[aria-haspopup="menu"]` — 行内两个选择器 chip（工作区 / Agent 预设）都带这个属性。

   **取不到槽位出口时的回退路径**：从 seat 往上爬，条件是「这一层的 `display` 是 `contents`，**或者这一层只有一个孩子**」（最多 12 跳，到 `body` 就放弃、原地渲染）。因为**开启开发者工具时** Agent 预设 chip 外面会多包一层 `._oGoKq_menuAnchor{min-width:54px;max-width:100%}`（`dsh-client-ui-agent-preset/lib/client.js:378`，哈希类名不能依赖）——它是个实打实的盒子、且只有一个孩子；旧判据「这一层里有没有并列的两个 chip」会在只有预设 chip 可见时**误落进这层 54px 包装里被挤扁**。`client-smoke` 对这个场景钉了两条断言（夹具 17a-2）。

   **前两个门禁缺一不可**：`aria-haspopup="menu"` 并不是 hero 行独有的。deliverables 的「本轮文件改动」（`conversation.chat.turnTail`）渲染在消息流里、位于输入卡片之前，而它**每个文件卡片右侧都有一个「打开 ▾」菜单按钮** —— 命中同一选择器、同样满足「在卡片之前」。只按老判据扫全文档，那个按钮会被认成 hero 行的 seat，「● 团队名 n/m」标签就被 portal 进那一行文件卡片里，看起来像从会话内容里凭空冒出来一个团队标签（真机截图复现过）。

   拿到行之后再用 `order: 100` 保证它视觉上排在「标准模式」之后。宿主 DOM 重建时锚点会失效，所以用 400ms 轮询复查（值相同不重渲染），失效即回退渲染在原地（`input.left`），**不会静默消失**。
10. **chip 的视觉规格全部来自真机实测，不靠猜**。hero 行里那两个邻居 chip（工作区 / Agent 预设）量出来是：`backgroundColor: rgba(0,0,0,0)`、`fontSize: 13px`、`fontWeight: 500`、`lineHeight: 20px`、`borderRadius: 16px`、`padding: 0 8px`、`gap: 4px`、`min-height: 28px`，图标是 **16×16 / `viewBox 0 0 16 16` / 1px 描边 / `currentColor`**，悬停底色走 `--dsw-alias-interactive-bg-hover`。我们的 chip 逐项对齐这些值，**包括图标也换成同规格的线性 svg**——`👥` emoji 自带彩色字形，混在一排单色线性图标里一眼就是外挂控件。
    两个曾经踩到的点：
    - **别把「打开面板的函数」当布尔用**。`const open = useCallback(...)` 之后若写成 `open || hover ? 高亮 : 透明`，函数对象恒为真 → chip **静止态也永久带悬停底色**（本主题下是 `rgba(0,113,227,.1)` 的淡蓝），看起来就是个突兀的蓝色胶囊。必须是 `state.open || hover`。
    - **工具行与 hero 行的图标尺寸不同**（工具行 14px、hero 行 16px），所以图标尺寸跟着所在行走，不要写死一个值。
    - **成员下拉的方向要跟着可用空间走，不能写死 `top: rect.bottom + 6`**。chip 落进输入卡片工具行后就在页面最底部，向下开会被输入卡片连同视口一起裁掉（只剩「派遣成员」那一行标题）。现在按上下两侧的可用空间选方向；向上开时用 `bottom` 定位而不是自己算一个 `top` —— 菜单高度由内容决定，开之前并不知道，贴边界只给 `maxHeight`，剩下的交给布局引擎。`client-smoke` 把两个方向各钉了一条断言。
11. **模态也必须 portal 到 `document.body`，否则会被别的面板盖住**。`shell.overlay` 的容器（`_overlayLayer`）自己带 **`z-index: 20`**，因而**形成一个层叠上下文** —— 在它内部写多大的 z-index 都只是「这一层内部的第一名」，相对整页仍然被压在 20。而右侧文件树面板是 `z-index: 25 / 40` 的独立层，于是会出现「模态明明写着 9999，右半边却被文件树挡住」这种反直觉现象。**根因不在 z-index 写小了，而在我们被关进了别人的层叠上下文。** 把模态 portal 到 `body` 后就回到根层叠上下文，`9999 > 40` 才真正成立。
    - 判断这类问题**不要比 z-index 数字**（跨层叠上下文比数字是错的），要在重叠区做**命中测试**：`document.elementFromPoint(x, y)` 看最上层元素是否落在模态内。`browser-check.py` 就是这么断言的（先算出两块的真实重叠区，确认「确实重叠」再 hit-test）。
    - 降级：`document` / `document.body` 不可用时（单测假 DOM、SSR）原地返回，行为不变。
12. **团队数据的分类/标签要显式透传**。`normalizeTeam` 是白名单式的，`category` / `tags` / `createdAt` 必须逐个显式收下，否则「保存后再 reload 就静默丢字段」——画廊的分类筛选和「最新」排序会莫名其妙批量失效。`createdAt` 在编辑时要保留原值（`team.createdAt ?? previous?.createdAt ?? now`），不然改一次名字就会跳到「最新」第一位。
13. **session 作用域槽的入参不用自己接**：`renderSlot('conversation.input.left', {})` 传的是空对象，但 `uiSession.provide` 会给每个 session 作用域条目注入标准 props —— `sessionId`（`ui-session` 的 `BUILTIN_SOURCE`）、`inputActions`（`ui-conversation`）、以及 `useSession` / `useConversation` / `useInput` 三个 hook。组件只依赖 `sessionId + inputActions` 就够，不需要 owner 转发。
14. **界面颜色一律走主题变量，且每个都带浅色兜底**：`var(--dsw-alias-*, <原浅色值>)`。
    DSH 的 210 个 `--dsw-*` 令牌定义在 `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1148` 的 `design_platform_css_default` 里（浅色/深色两套值同源），所以「令牌 + 兜底」的写法即使在旧版 DSH 上也不会变成黑块。
    本插件用到的 24 个令牌（`bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-mask-1` / `border-l2` / `interactive-bg-hover(-accent)` / `interactive-bg-active` / `label-primary|secondary|tertiary` / `button-primary-fill` / `brand-primary` / `static-neutral-00` / `state-error-primary|secondary` / `state-business-primary|tertiary` / `state-warn-label|secondary|tertiary` / `shadow-lv2|lv3` / `specific-selector`）已**逐个在真机令牌表里核对存在**。
    两个踩过的坑：① 旧代码里的 `--dsw-alias-fill-accent` 与 `--dsw-static-white` **在 0.2.0 里根本不存在**（令牌表 0 命中），于是主按钮一直吃兜底色，深色主题下就是一颗不跟主题走的黑胶囊；② 主按钮底色**不能**拿 `label-primary` 顶替（深色主题下它接近白色，配写死的白字 = 白底白字），要用 `button-primary-fill`。
    唯一**故意保留**的十六进制字面量是团队 `accent` 的默认值 `#4F46E5`：代码要拿它拼 `${accent}1f` / `${accent}59` 这类十六进制 alpha（`var()` 拼不出来），注释里已写明。
    chip 的 `height: 28` 与 DSH 的 `.add`（28×28）对齐，浅色/深色主题都不用额外适配。

## 开发

```bash
pnpm run bundle   # esbuild 打包 → lib/index.js（ESM）+ lib/client.js（CJS）；先写 lib.tmp/ 再原子替换
pnpm run gates    # 合同/一致性门禁（随团队数增长，21 支时 300 项；报告写入 .tmp/gates-report.txt）
pnpm run verify   # 上面两条 + 下面两套冒烟，一条命令跑完
node scripts/smoke.mjs         # 宿主半运行时冒烟（120 项）：假 ctx 真跑 HTTP + 命令 + 召唤 + 分批派遣 + 子会话护栏
node scripts/client-smoke.mjs  # 客户端冒烟（215 项）：假 window/React 真跑渲染 + 交互 + portal 落位 + 版式统一性
node scripts/promote-team.mjs --dry    # 把用户库里的团队提升为内置基线（见下节）
node scripts/import-teams.mjs --from <草案目录> --dry   # 把外部专家团包草案批量导入为内置团队（见下节）
node scripts/merge-persona.mjs --dry   # 合并 .persona/*.json 里重写的 persona（含规格校验）
node scripts/polish-teams.mjs --dry    # 合并 .polish/*.json 里的 presets / 案例交付示例（含规格校验）
python scripts/browser-check.py --url "<dsh 带 token 的 URL>"   # 真浏览器验收（Playwright，32 项）
```

**改动后请按这个顺序验收**（改 `src/client/**` 尤其重要 —— 冒烟脚本读的是 `lib/`，忘了 build 就会看到一堆假失败）：

```powershell
node scripts/build.mjs
node scripts/gates.mjs; node scripts/smoke.mjs; node scripts/client-smoke.mjs
node "D:/DSH/.dsh/profiles/desktop/node_modules/dsh-plugin-guide/bin/dsh-plugin-dev.js" check --cwd .   # 官方插件开发检查器
npm pack --dry-run        # 预检发布物内容（49 文件 ≈ 358 kB）
```

`dsh-plugin-dev check` 是**官方**那份检查器（`@deepseek-ai/dsh` 自己的 `dsh plugin` 子命令只是把参数转发给 pnpm，**没有** pack/validate/lint）。本插件当前是
`result: OK (8 passed, 0 failed, 2 warned, 5 skipped)` —— 两个 warning 都已确认无害：`readme-five-langs`（本插件只有中文 README）、
`redline-effect-registration`（**误报**：命中的是 `src/index.js:1094` 那句 `res.off('close', abortOnClose)`，属于 HTTP 每请求清理、不是注册拆卸）。
它**不校验** `locale/` 与 `icon`，那部分由本插件自己的 `gates.mjs` 覆盖，两者互补。

- `lib/` 是构建产物，但**必须入库**（从 git 源安装不会跑构建脚本）。改代码请改 `src/`，不要手改 `lib/`。
- `build.mjs` 的 esbuild 解析顺序：先 `import('esbuild')`（插件自己的 `node_modules` 里就有，`pnpm install` 一次即可），失败再按 `D:/DSH/dshworkspace` → `D:/DSH/.dsh/plugins` 递归找既有安装。所以不联网也能构建。
- **构建是原子的**：先写 `lib.tmp/`，两个产物都成功后才 `rename` 覆盖 `lib/`。构建中途失败**不会**清空发布物（早期版本以 `rmSync(lib)` 开头，一次 esbuild 解析失败就让 `lib/` 消失、两套冒烟双双 `ERR_MODULE_NOT_FOUND`）。
- ModuleLoader id 从 `package.json` 的 `name` 读（不再硬编码），改包名时不会漏改 banner。
- Node 半边**热加载**（profile 的 `patchReload: live`，`pnpm run bundle` 后即重载）；**客户端刷新页面**即可。
- 装成 `link:` 后**不需要**往 profile 里拷副本（软链直接指向开发目录）。只有早期 `file:` 安装方式才需要 `node scripts/sync-profile.mjs` 重新拷贝 —— 那个脚本的目标目录**从 `DSH_HOME` 推出来**（`<DSH_HOME>/profiles/<profile>/node_modules/<包名>`，可用 `--to` / `--profile` 覆盖），源码里不写机器绝对路径。
- `browser-check.py` 会实测 `chip` 与「标准模式」的 `bounding rect`（同 `cy`、`chip.x ≥ preset.right`、`order=100`），这是**位置回归的硬护栏**——只靠单测或肉眼很容易在重构时把落位改回去。
- **改视觉前先在真机上量邻居，不要靠猜**。写个一次性 Playwright 脚本把目标控件和它邻居的 `getComputedStyle` 逐项 dump 出来（`backgroundColor` / `fontSize` / `fontWeight` / `padding` / `gap` / `borderRadius` / 图标 `svg` 的宽高与 `viewBox` / `strokeWidth` / 悬停色），照着对齐。本项目里"这个胶囊不该有底色""图标该多大"这两个结论都是这样量出来的，猜的话两次都会错。
- DSH 的 launch token 是**每进程随机生成且不落盘**的（`packages/client/connection/src/browser-auth.ts` 的 `processLaunchToken`）。所以 `browser-check.py` 会在日志里搜所有 `?token=` 候选逐个探测取能过鉴权的那条；全都失效就只报一条明确的 401 失败并提示重启，不会让后续断言连环误报。

### 开发阶段：把团队沉淀为内置

开发阶段的约定是：**自己攒出来的团队一律沉淀成内置基线**（`data/teams.json`），而不是留在
`$DSH_HOME/expert-teams/teams.json` 里 —— 后者不随插件走，换机器 / 重装 / 打包分发都会丢。

```bash
node scripts/promote-team.mjs               # 用户库里全部团队 → 内置
node scripts/promote-team.mjs --ids my-team # 只提升指定的几支
node scripts/promote-team.mjs --dry         # 先看会发生什么
node scripts/promote-team.mjs --keep-copy   # 保留用户库副本（不推荐，理由见下）
```

三条语义，都是有意设计的：

1. **同 id 覆盖内置、且保持它在数组里的原位置**。所以「在面板里把某支内置团队改好 → 跑 promote」
   就是把改动**固化进基线**的正规动作，不需要手工编辑 JSON。
2. **默认从用户库移除**已提升的条目。留着会形成同 id 副本，而**副本优先于内置** ——
   于是内置基线之后的更新永远被它盖住，两份数据从此开始漂移。
3. **团队头像撞脸会自动换一张**。gates 要求画廊里各支团队不撞脸，脚本会挑一张没被占用的顶上去，
   并在输出里写明换成了哪张 —— 不闷声改你的数据。

提升完记得 `node scripts/build.mjs` + `node scripts/sync-profile.mjs`，再跑 `node scripts/gates.mjs`。

### 从外部专家团包导入团队

外部下载的 **skillhub 专家团包**（`manifest.json` + `skillsets/<slug>.md` + `skills/<slug>/SKILL.md`）与
本插件的团队数据**不是同一种东西**：包里只有「一条工作流 + 若干技能文档」，没有 expert-team 需要的
**成员 persona**。所以导入是两步，`scripts/import-teams.mjs` 只负责第二步的机械部分：

1. **执笔**：把每个包按 [`docs/expert-pack-import.md`](docs/expert-pack-import.md)（执笔规范 + 字段白名单 + 映射口径）写成一份**团队草案 JSON**（一个文件一支团队，
   落到任意草案目录，惯例是 `.tmp/import/raw/<team-id>.json` —— `.tmp/` 已在 `.gitignore` 里，不入库）。映射口径是固定的：
   - 1 位**主理人**（lead：确认参数、调度、中转上下文、汇总收口，不代写专业产出）+ **skillset 里每个 skill 各 1 位专家**；
   - `skillsets/*.md` 里标注的「获取层 / 分析层 / 输出层」直接变成团队的 `stages`（同层并行、层间串行），主理人落在最后的「汇总收口」阶段；
   - 每位专家 persona 里写出**该方法论的真实判据与参数**（从 `SKILL.md` / `references/` / `scripts/` 提炼），
     并写一句「**若当前环境已安装 `<skill-slug>` 技能就优先调用它，否则按本角色的方法论自行完成**」——
     因为这些 skill 默认**没有**装进 DSH（`$DSH_HOME/skills`），persona 必须自带可执行的方法，而不是依赖技能存在。
   - 规范里还硬性要求：不写 `avatar`（由脚本统一分配）、字段只许出现在白名单内、
     **中文字段里禁止英文半角双引号**（persona 里常见的 `profile="chrome"` 会把 JSON 写坏，改用「」）。
2. **导入**：脚本做校验、补头像、合并进基线。

```bash
node scripts/import-teams.mjs --from .tmp/import/raw            # 导入全部草案
node scripts/import-teams.mjs --from <dir> --dry                # 只预演（推荐先跑这个）
node scripts/import-teams.mjs --from <dir> --only a,b           # 只导入指定 id
```

脚本语义（与 `promote-team.mjs` 对齐）：

1. **结构性问题一律拒写**：缺 `name`、没有成员、成员超过 13 位、`role: lead` 多于 1 位、
   persona 为空或超过 4000 字、`stages` 序号不连续或**没覆盖全部成员** —— 全部列出来并整体拒绝写盘，
   不会留下半截基线。
2. **未知字段丢弃并告警**：宿主 `normalizeTeam` 是白名单式，混进来的 `skills` / `version` 之类字段
   会在保存/重载时被静默丢掉，所以脚本提前把它们打出来。
3. **头像由脚本分配**：团队头像从「未被占用的索引」里顺序取（gates 要求画廊里 21 支不撞脸），
   成员头像按队内序号错开、保证**队内唯一**。
4. **同 id 覆盖保持原位置；新 id 插到数组最前**（同时它们的 `createdAt` 最新，符合画廊「最新」排序）。

导入完照例：`node scripts/build.mjs` → gates / smoke / client-smoke。**运行中的实例不会自动看到新团队**
（`TeamRepository` 在 `apply` 时构造一次），需要重载插件或重启桌面应用。

> 2026-10-05 首批导入 7 支（统计分析 / UI 原型设计 / 歌词创作 / 代码重构 / 易经起卦 / 紫微斗数 / 材料科研），
> 共 48 位专家。其中「材料科研」的来源 `materials-lab-0.1.0` 其实**不是** skillhub 包，而是一个 OpenClaw 插件
> （`@cranesun/openclaw-materials-lab`，自带 `materials_*` 工具链与一个 `material-science-research` 技能）——
> 它的团队是按那个技能的 8 步流程与工具集拆角色的，persona 里写明了「材料工具链不可用时退化为
> Materials Project / OQMD / AFLOW 公开检索 + 本地 pymatgen/ASE，并标注实测 / 离线 mock / 估算」。

## 已知限制

- 派遣台账（`GET status`）是**内存态**，DSH 重启后清空；子会话本身是持久的，会在左侧会话树里正常保留。
- **团队图标与成员头像**用的是**同一套 36 张插画**（`assets/member-avatars/NN.jpg`），
  由宿主路由 `GET /expert-team/avatar/NN.jpg` 按需提供，索引存成可选的
  `team.avatar` / `member.avatar`（0–35），**缺省时按团队 / 成员 id 稳定派生** ——
  所以老数据一个字段都不用补，同一对象永远同一张脸。素材出处与许可见
  [assets/member-avatars/README.md](assets/member-avatars/README.md)。
  暂不支持自定义头像图片（换上自己的图见该 README 的「换素材」）。
- 团队 / 成员的 `emoji` 字段**保留在数据里但不再出现在界面上**：编辑时会原样透传，
  不会因为一次保存把它弄丢（老数据里存着它）。
- 团队卡片上的「使用次数」= 内置基准值 + 本地实际使用次数（存 `$DSH_HOME/expert-teams/stats.json`）。
- **内置 / 自定义团队在开发阶段没有区别**（`lockBuiltinTeams: false`）：都能编辑、改成员、换头像，
  写内置 id = 在用户目录落一份同 id 副本覆盖它。
  把配置里 `lockBuiltinTeams` 置 `true`（定稿形态）后：内置团队退回只读，成员详情不再提供「保存成员」，
  写入内置 id 会被服务端拒绝（403 `LOCKED`），想改只能先「另存为」一支自定义团队。
  提醒：覆盖内置会**盖掉插件升级带来的这支队的内置更新**（同 id 副本优先），删掉副本即恢复基线。
- 成员数据模型是 `{ id, name, alias, role, emoji, avatar, focus, persona }`，**成员级没有独立的「工作流程」字段** ——
  工作方式 / 交付物 / 纪律本来就写在 `persona` 这一段提示词里。所以成员详情是
  **展示结构化、存储不结构化**：查看时按标记切成小节，编辑时仍是整段文本，不需要数据迁移。
  **编排信息只存在于团队级**（`stages`），成员级不重复表达 —— 同一位专家横跨多个阶段是常见需求，
  成员级单值字段会把它逼成「一个人拆成两条成员」。
- **分批派遣不做自动回环**。`stages` 是单向的 DAG：`P1 → P2 → … → Pn`，能做「上一阶段产出成为下一阶段输入」，
  但**不会**自动「审稿判 REVISE → 退回重做 → 再审」。深度研究团队的第 4 阶段（审稿 + 修订）就是这种形态：
  审稿人判定 REVISE 时，需要召集人（或用户）再派一次该阶段，把审稿意见作为 `context` 传进去。
  自动回环要么给团队数据加「回退边」语义、要么由召集人在指导语里自行判断，两者都还没做。
- **chip 的 hero 落位依赖 DSH 的内部 DOM 结构**：首选锚点是 `ui-renderer` 给每个槽位出口渲染的 `[data-slot="<槽位名>"]`（**公开契约**），回退锚点是 `[data-phase]` / `[data-composer-seat]` / `[data-composer-card]` / `button[aria-haspopup="menu"]`（写死的语义属性，比 class 稳，但属**非公开契约**）。这几个锚点在 DSH 0.2.0-rc.2 上已逐个核实存在；将来若全部消失，chip 会**优雅回退**到 `conversation.input.left` 工具行（位置变差但功能不受影响），不会静默消失。
- 真浏览器验收里会看到一条 `pageerror: cannot get property "remote.session" without inject`。这是第三方插件 **`dsh-better-sidebar`** 在首轮挂载时直接访问 `ctx.remote.session`、未先声明 inject 导致的，**与本插件无关**（本插件不引用 `remote.*`，也不产生任何 console error / pageerror）。

## 版本适配（0.2.0 这一轮改了什么）

目标版本：**DSH 0.2.0-rc.2**（Cordis 4.0.4；`engines.node: ^22.19.0 || >=24.0.0`）。相对 0.1.0 的适配改动：

| 项 | 改动 | 依据 |
|---|---|---|
| 命令 / 工具注册 | `ctx.get(...)` 惰性访问 → `ctx.inject([...], scoped => …)` 按需装配（服务就绪时执行、重启后重跑、卸载时回收） | Cordis 生命周期 |
| 主题 | 全部界面颜色改 `--dsw-alias-*` 令牌 + 浅色兜底；修掉两个**不存在**的令牌名（`--dsw-alias-fill-accent` / `--dsw-static-white`） | `dsh-client-ui-theme/lib/client.js:1148` 的 210 个令牌逐个核对 |
| hero 落位 | 新增 `[data-slot="conversation.hero.agentPreset"]` 首选锚点；回退判据由「这一层有两个 chip」改为「这一层只有一个孩子」 | `dsh-client-ui-renderer/lib/client.js:1094-1104`、`dsh-client-ui-agent-preset/lib/client.js:378` |
| 插件清单 | `engines.node` 对齐约定；补 `icon`、`locale/{en,zh}.json`、`exports["./locale/*.json"]`、`packageManager`、`dsh.client.immediately` | `dsh-app-boot/lib/index.js:1860-1999`（`iconOf` / `dictionariesOf` / `readPluginMeta`） |
| 构建 | `lib.tmp/` + 原子替换（构建失败不再清空 `lib/`）；banner 的 ModuleLoader id 改读 `package.json`；`pnpm.onlyBuiltDependencies: ["esbuild"]` | — |
| 门禁 | 新增 locale / icon / engines / packageManager / immediately / lib↔src 版本一致性等断言（**随团队数增长**：14 支时 223 项，21 支时 300 项） | 官方 `dsh-plugin-dev check` 之外的自有补充 |

**刻意不做的两件事**（都有理由）：

- **不加 `peerDependencies`。** 0.2.0 的版本门禁读的是 `peerDependencies`（**不是** `engines.dsh`，见 `dsh-app-boot/README.zh.md:52`），但**未声明 DSH peer 时不施加任何版本约束**；本插件又不 import 任何 `@deepseek-ai/*`（工具注册手写 JSON Schema），运行时一律走能力探测（`persona` / `prepareContinuable`）。所以不声明反而是前向兼容的最大化，代价是失去「装到不兼容版本时提前报错」。
- **不改包名（仍是裸名 `expert-team`）。** 0.2.0 的模板一律用 `@local/<name>` 这类带 scope 的名字，但本插件是**本地开发插件**、不发布 npm；改名会牵动 ModuleLoader id、`cordis.patch.yml` 的 `id`/`name`、门禁与已装 profile 的依赖名。真要发布时再改（只需动 `package.json.name` 与 `cordis.patch.yml` 两处，banner 已自动跟随）。

## License

MIT
