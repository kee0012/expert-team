# expert-team — 开发计划与决策追踪

> 一句话需求：**「我想开发一个类似 WorkBuddy 专家团的 DSH 插件」**
> 形态：`bundle-client` ｜ 分发：本地目录（link）/ git 源 ｜ 包管理：pnpm

---

## ① 需求捕获

| 能力面 | 是否命中 | 交付物 |
|---|---|---|
| 命令/工具 | ✅ | `/expert-team` 斜杠命令；agent 作用域工具 `expert_team_list` / `expert_team_summon` |
| HTTP 接口 | ✅ | `/expert-team/api/*`（teams CRUD / summon / status / health） |
| 浏览器 UI | ✅ | `conversation.input.left` 触发 chip + `shell.overlay` 团队面板 |
| 本地持久化 | ✅ | `$DSH_HOME/expert-teams/teams.json`（自定义团队 / 覆盖内置）、`config.json`（运行配置）、`stats.json`（使用量） |
| 子代理编排 | ✅ | 每位专家 = 一个 `startContinuable` 子会话，persona 注入 |

**用户拍板的三个决策（2026-09-21）**

| # | 问题 | 结论 |
|---|---|---|
| 1 | 召唤后专家怎么干活 | **真子代理 · 每人独立会话** —— `subagents.startContinuable` + persona，可点开看过程，主会话汇总 |
| 2 | 界面入口形态 | **输入卡片工具行的并列 chip + 弹层**，且**空会话态要贴到「标准模式」右侧** —— 注册点 `conversation.input.left` 触发，`shell.overlay` 承载完整版式；hero 态用 `createPortal` 把 chip 落到 hero 行（详见变更记录） |
| 3 | 团队数据来源 | **内置团队 + 面板内自定义** —— 随包内置 14 支 / 85 位专家（0.1 期首发 10 支 / 51 位，后续扩充；最新一支为论衡长文流水线），面板可新建/编辑，自定义存本地 JSON |
| 4 | 面板版式（2026-09-21 追加） | **对齐 WorkBuddy 专家团界面** —— 画廊（标题栏 + 排序 + 分类筛选 + 卡片网格）与详情（头图 + 黑色胶囊 CTA + 引号预设条 + 使用案例 + 成员名册） |

## ② 形态与分发决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 形态 | `bundle-client` | 需要浏览器半，且要作为 profile bundle 装载 |
| 分发 | 本地目录（link）先行，可转 git 源 | 迭代期避免反复走 pnpm 网络链路；`lib/` 已入库，git 源可直接用 |
| 包管理 | pnpm | 与目标 profile 一致 |
| 构建 | esbuild（不装依赖，复用本机既有安装） | 本机 pnpm 仓库已有 esbuild 0.21/0.25/0.28，脚本按序探测 |

## ③ 配方装配

未直接复用 skill 配方库中的现成配方，原因是配方里的槽位名（如 `status`）与 webServer API 形态与目标 DSH 版本（Cordis 4.0.1 / dsh 0.1.3-alpha.1）不符；改为**按源码实测契约手写**，证据见下表。

> **目标版本已在「六轮修订」（2026-10-03）上移到 DSH 0.2.0-rc.2 / Cordis 4.0.4。** 下表每一条契约都在 0.2.0 的 `app.asar` 内重新核实过（命中位置换算为 `/dsh/node_modules/@deepseek-ai/<包>/lib/**`），结论与新增契约见文末那一节。下表列的是**当初选型的依据**，保留原文以便对照。

| 依赖的 DSH 契约 | 源码证据 |
|---|---|
| `conversation.input.left`（list / session，`InputBar` 工具行 `.tools` 内的并列控件） | `packages/client/ui-conversation/src/client/contract/slots.ts:171-172`；渲染点 `skeleton/InputBar.tsx:520-522` |
| `conversation.input.dock`（**入口与「已召唤」标签都不用**：list / session，输入卡片上方整行区，DSH 自己用于 todo / 队列 / 目标。标签改为在 `conversation.input.left` 那个 chip 里就地切换显示） | `slots.ts:166`；使用者 `skeleton/TodoPanel.tsx:137`、`queue/QueueDock.tsx:375`、`ui-goal/src/client/index.ts:83` |
| session 作用域槽自动注入标准 props（`sessionId` / `inputActions` / `useSession` / `useConversation` / `useInput`），与 owner 传参无关 | `packages/client/ui-session/src/client/index.ts:197-210`、`ui-conversation/src/client/apply.ts:202-217` |
| `shell.overlay`（list / root，全帧浮动层） | `packages/client/ui-layout/src/client/index.ts:91` |
| `ctx.slots.inject(key, cb)` + `ctx.slots.register({name,id,order}, Component)` | `packages/experimental/client-ui-agent-team/src/client/mount.ts:66-75` |
| list 槽行允许返回 `null`；outlet 为 `display:contents`（不建 fixed 包含块） | `packages/client/ui-renderer/src/client/scoped-slots.tsx:688-720` |
| session 标准 props 含 `inputActions`（`setDraft` / `submit`） | `packages/client/ui-conversation/src/client/contract/input.ts:229-240` |
| `ctx.commands.register({name,description,handler})`，返回 `{kind:'success'|'error', text}` | `packages/interaction/commands/src/index.ts:60-75`、`types.ts:34-41` |
| `ctx.tools.register({name,description,parameters,output})`，parameters 是原生 JSON Schema | `packages/core/tools/src/index.ts:1027-1047`、`schema.ts:566-572` |
| agent 作用域注册：`agent.ctx.tools.register` + `agent/created`/`agent/disposed` | `packages/experimental/tool-agent-team/src/index.ts:159-176, 391-411` |
| `ctx.subagents.startContinuable({childId,provider,label,request,signal})` | `packages/subagent/subagent/src/continuation.ts:95-120`、`experimental/agent-team/src/roster.ts:280-292` |
| `SubagentStartRequest.persona` 需 provider `capabilities.persona` | `packages/subagent/subagent/src/types.ts:193-200`、`index.ts:640-657` |
| `ctx.get(name)` 惰性取可选服务 | `packages/core/tools/src/index.ts:1010`、`interaction/commands/src/index.ts:389` |
| 禁止引用 experimental 包 | `packages/experimental/AGENTS.md:6-9` |
| 客户端 bundle 为 CJS 经典脚本 + ModuleLoader | `packages/client/modules/src/client/manifest.ts:258-306` |
| **hero 行**由 `heroWorkspaceRow` 渲染，里面装 `WorkspaceChip`（写死子元素）+ `conversation.hero.workspace` + `conversation.hero.agentPreset`，且**只在 hero（空白会话）态渲染** | `client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:293-317`（`hero.agentPreset` 在 315 行）、使用点 `:349` |
| 输入卡片根节点带写死的 `data-composer-card` 属性（可作稳定锚点） | `client/ui-conversation/src/client/skeleton/InputBar.tsx:429` |
| Agent 预设 chip 带 `aria-haspopup="menu"`（`AgentPresetSeat` 自己 211 行也用它做 menu 锚点） | `client/ui-agent-preset/src/client/AgentPresetSeat.tsx:189` |
| `react-dom` 在**平台模块表**里，客户端 bundle 可以 `require('react-dom')` 拿到 `createPortal` | `client/web/src/seed.ts:11,31`（`PLATFORM_MODULES`） |

生成的目录：

```text
expert-team/
├── package.json             # bundle-client 合同
├── cordis.patch.yml         # insert id/name = 包名
├── data/teams.json          # 内置 14 支团队 / 85 位专家（467 KB）
├── locale/{en,zh}.json      # 插件展示元信息（title / description）
├── assets/icon.svg          # 插件图标（956 B，≤256 KiB）
├── src/index.js             # Node half
├── src/client/index.jsx     # 浏览器半
├── scripts/build.mjs        # esbuild（Node ESM + client CJS/ModuleLoader），先写 lib.tmp 再原子替换
├── scripts/gates.mjs        # 合同门禁（随团队数增长：21 支时 300 项）
├── scripts/smoke.mjs        # 120 项宿主半运行时冒烟
├── scripts/client-smoke.mjs # 215 项浏览器半冒烟（含 portal 落位、版式统一性、模态层级）
├── scripts/import-teams.mjs # 外部专家团包草案 → 内置团队（校验/分配头像/合并，见第八轮）
├── scripts/browser-check.py # 32 项真浏览器验收（Playwright）
├── docs/plan.md             # 本文
├── README.md / LICENSE / .gitignore
└── lib/                     # 构建产物（入库）
```

## ④ 本地验证

| 检查 | 结果（基线，2026-10-03 在 0.2.0-rc.2 上重跑） |
|---|---|
| `node scripts/build.mjs` | ✅ `lib/index.js` 52.6 KB（ESM）+ `lib/client.js` 101.7 KB（CJS + ModuleLoader）；原子替换 |
| `node scripts/gates.mjs` | ✅ **223 / 223** 通过（报告 `.tmp/gates-report.txt`；含新并入团队的 11 项） |
| `node scripts/smoke.mjs` | ✅ **120 / 120** 通过（报告 `.tmp/smoke-report.txt`） |
| `node scripts/client-smoke.mjs` | ✅ **215 / 215** 通过（自带真实 hook 运行时；报告 `.tmp/client-smoke-report.txt`） |
| `dsh-plugin-dev check --cwd .` | ✅ **OK（8 passed / 0 failed / 2 warned / 5 skipped）** —— 官方检查器（详见六轮修订） |
| `npm pack --dry-run` | ✅ 49 文件 / package 369.8 kB / unpacked 838.5 kB（第七轮补正后重测；同上一次 376.0 / 855.5 的差异来自 lib 与 `data/teams.json` 重新生成，包内容与文件数未变） |
| `python scripts/browser-check.py` | ⚠️ 需 Playwright + 带 token 的运行中 URL（本机当前跑不通，见 ⑤） |
| React / ReactDOM 外置 | ✅ `require("react")` / `require("react-dom")` 均保留，产物未内联 React |
| 名称三处一致 | ✅ `package.json#name` == patch insert id/name == ModuleLoader id（banner 现由 `package.json` 读出） |
| `@deepseek-ai/*` 依赖 | ✅ 零引用（连动态 import 都没有）；`peerDependencies` 也刻意不声明 |
| 主题令牌 | ✅ 用到的 24 个 `--dsw-*` 已逐个在 0.2.0 令牌表（210 个）里核对存在 |

冒烟覆盖的关键路径：health / teams 列表（断言**不下发 persona 正文**）/ 自定义团队 CRUD 与四种非法输入（400）/ 内置团队删不掉 / 召唤 6 位专家并断言 `request.parent`、`persona` 原生通道、`label`、`prompt` 内容 / persona 能力缺失时的**回退路径** / NO_PARENT(409) / NO_TEAM(404) / 空 task(400) / 超大 body(413) / 命令四种分支。

**验证中发现并修掉的真问题**

1. `CommandResult` 实际是 `{kind:'success'|'error', text}`；首版按 `{content}` 写，会被 `normalizeResult` 直接抛 `TypeError`。
2. 首版用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册工具 → 沙箱里解析不到，工具静默不注册。查明 `defineTool` 只做「参数 DSL → JSON Schema」编译后，改为**手写原生 JSON Schema**，依赖归零。
3. `命令 show` 名册原缺角色标签、`命令 summon` 原缺团队 id —— 均补上，测试断言随之收紧。
4. 冒烟桩 `FakeReq` 缺 `destroy()`（真实 `IncomingMessage` 有），超限分支暴露后补上。

## ⑤ 安装与浏览器冒烟

安装命令（CLI 在**桌面版安装目录**里，不在源码仓库、也不在 PATH 上）：

```powershell
$dsh = 'D:\Program Files\deepseek harness\resources\runtime\cli\bin\dsh.cmd'
# link: = 软链到开发目录，改完 src 跑一次 build 即生效（不用重装、不用拷副本）
& $dsh plugin --profile desktop add "link:D:\DSH\dshworkspace\expert-team\expert-team"
& $dsh plugin --profile web     add "link:D:\DSH\dshworkspace\expert-team\expert-team"
```

> 五轮修订里那段 `file:` + 手工拷 profile 的办法**已废弃**（pnpm 的 `file:` 会拷贝、CLI 入口也在旧源码仓库里）。
> 仍然成立的一条：**路径别含中文** —— `dsh plugin` 内部经 `cmd.exe`（GBK）转发给 pnpm，非 ASCII 路径会被弄坏
> （症状：报 `declares no dsh.bundle`，且 `node_modules/<包名>` 变成空目录）。开发目录必须含中文时，直接调
> `node "<安装目录>\resources\runtime\pnpm\bin\pnpm.cjs" add "file:<路径>" --dir <profile 目录>` 绕开 shell，再让 CLI reconcile。

安装前基线：确认目标 profile 的 `cordis.patch.yml` 当前健康（可用 `--profile <名> --dump-config`），再叠加。

| 项 | 状态 |
|---|---|
| 安装 | ✅ **已装进 desktop profile（2026-10-03 晚上，本轮实测）**：先删掉那个指向工作区根、少一层的坏 Junction（`cmd /c rmdir`，只删链接本身），再 `dsh plugin --profile desktop add "link:D:\DSH\dshworkspace\expert-team\expert-team"` → exit 0；profile `dependencies` 与 `dsh.profile.bundles`（现 16 项）都含 `expert-team`，`node_modules/expert-team` Junction 指向插件目录。**活体验证**：19387 上 `GET /expert-team/api/health` → 200 `{plugin:"expert-team",version:"0.2.0",teams:13,subagentProvider:"spawn",personaNative:true}`、`GET /api/teams` → 200 / 13 支。`profiles/web` 里那份**旧包名** `dsh-expert-team`（v0.1.0，依赖指向已被删掉的 `D:/workBuddy/开发/dsh-expert-team`）**仍在**，用户当时选择先不清理。 |
| 热加载边界 | ⚠️ **Node half 不能靠命令热重载**（本轮实测）：`TeamRepository` 在 `apply` 里只构造一次（`src/index.js:1453`），`reload()` 只被构造器调用 → 改 `data/teams.json` 后运行中的实例仍是旧清单（加完第 14 支后 health 仍报 `teams:13`）。实测**两条都没触发重载**：改插件自己的 `cordis.patch.yml`、以及重跑一次 `dsh plugin … add`（幂等、exit 0）。要么在 GUI 的插件管理里关掉再打开，要么重启桌面应用；刷新页面只换浏览器半。 |
| HTTP 接口实测 | ✅（0.1.3 时期，web profile）`/expert-team/api/health`、`/api/teams` 200；未知路径 404（prefix 匹配正确）。本轮由 `scripts/smoke.mjs` 的 120 项以假 ctx 全量复跑。 |
| 浏览器冒烟（真实 Chromium，`scripts/browser-check.py`） | ⚠️ **本轮未跑**：该脚本要 Playwright + 一个带 launch token 的运行中 URL，本机当前两个条件都不满足。0.1.3 时期的基线是 24/25 —— 唯一 FAIL 是第三方插件 `dsh-better-sidebar` 的 `cannot get property "remote.session" without inject`（它首轮挂载直接访问 `ctx.remote.session`、未先 inject），与本插件无关（本插件产物零 `remote` 引用）。 |
| 位置回归（真实布局几何，非 DOM 存在性） | ⏸️ 历史基线（0.1.3）：`chip.cy = preset.cy = 451`、`chip.x = preset.right = 591`、`order = 100`、`rowDisplay = flex`。0.2.0 上改为「**锚点契约**」级验证：`[data-slot="conversation.hero.agentPreset"]` 出口存在 + 翻车场景（`.menuAnchor` 包一层）在 `client-smoke` 夹具 17a-2 里断言。 |
| console.error / pageerror | ✅（0.1.3 时期）本插件 0 条 |

## ⑥ 发布准备

- [x] `.gitignore` 排除 node_modules / .tmp / lib.tmp / lib.prev / `__pycache__`，`lib/` 保留入库
- [x] `package.json#files` 含 `lib`、`data`、`locale`、`assets/member-avatars`、`assets/icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`
- [x] LICENSE（MIT）
- [x] README 含安装 / 用法 / 数据格式 / 设计要点 / 版本适配 / 已知限制
- [x] `icon` + `locale/{en,zh}.json` + `exports["./locale/*.json"]`（0.2.0 展示元信息三件套）
- [x] `engines.node` 对齐 `^22.19.0 || >=24.0.0`；`packageManager`；`pnpm.onlyBuiltDependencies`
- [x] 官方检查器 `dsh-plugin-dev check` 纳入验收（OK，2 warning 已确认无害）
- [ ] README 五语言版本（`dsh-plugin-dev check` 的 `readme-five-langs` warning —— 本插件面向中文使用，暂不产出机器翻译版）
- [ ] git 仓库初始化与 remote（待用户定仓库地址）
- [ ] 截图与仓库 description/topics
- [ ] 包名是否加 scope（`@local/expert-team`）——**待用户决策**，见六轮修订

## 后续可做（未纳入本期）

1. **派遣台账持久化** —— 现在 `GET status` 是内存态，重启即清空；可写进 `$DSH_HOME/expert-teams/dispatches.json`，或订阅 `agent/status` 事件做实时状态。
2. **面板内实时状态** —— 在团队详情里显示每位专家的 running/idle/failed，并支持点击直接跳到子会话（需客户端 `ctx.sessions.refreshSubagents` + `openSubagent`）。
3. **团队包导入导出** —— 支持从 ClawHub 专家包格式或单个 JSON 导入，便于团队资产分发。
4. **头像图片** —— 支持上传自定义头像（需静态资源托管到 `/expert-team/static/*`）。
5. **persona 模板变量** —— persona 内支持 `{{task}}` / `{{team}}` 插值。

## 变更记录

### 2026-09-21 · 入口形态修订（用户反馈）

用户看到真机截图后指出两个问题，均已修正：

1. 触发按钮文案 **「召唤专家团」→「专家团」**（工具行 chip 要短，与 `专家` 等并列控件同量级）。
2. **触发按钮从「独占一行」改为「工具行内并列」**：原先挂在 `conversation.input.dock`，而该槽是
   「输入卡片**上方**的整行区」，DSH 自己拿它放 todo / 队列 / 目标；一枚小按钮挂上去会把输入区顶高一整行，
   视觉上很突兀。改用 `conversation.input.left`（`InputBar` 的 `.tools` 行内 list 槽），
   与 `+`、权限选择、计划模式并列。

> 顺带说明一个约束：图中「标准模式」chip 在 `heroWorkspaceRow` 里，那一行的三个槽
> （`conversation.hero.workspace` / `conversation.hero.brand.mark` / `conversation.hero.agentPreset`）
> **全是 single 且都已被占用**，且该行只在空白会话（hero 态）渲染。
> 所以「紧挨着标准模式」在槽位体系里做不到；`conversation.input.left` 是唯一能做到
> 「同行并列、不另占一行」且在有内容的会话里也常驻的槽。

配套改动：

- `sessionIdOf` 改为**优先取标准 prop `props.sessionId`**，再退回 `props.session?.sessionId`。
  之前只读 `props.session.sessionId`，而 session 作用域槽由 `uiSession.provide` 注入的正是
  `sessionId`，owner 传的 `{}` 里并没有 `session` —— 这条路径此前从未被端到端验证过。
- chip 样式改用 DSH 主题变量（`--dsw-specific-selector` / `--dsw-alias-label-primary`），
  高度 28 对齐 `.add`（28×28），浅色/深色主题自动适配。
- 新增回归护栏：
  - `client-smoke`：「触发按钮根节点直接是 button（不再套块级容器）」「夹具不含 session 快照（只靠标准 prop）」。
  - `browser-check`：新增「chip 是紧凑控件（高 ≤ 34px、宽 ≤ 220px）」与
    「chip 位于输入框下方的工具行（不独占输入框上方一行）」两条**真实布局**断言。
- 测试夹具改为模拟真实契约（owner 传空对象，只有标准 props）。

---

### 2026-09-21 · 二轮修订：chip 落到「标准模式」右侧 + 面板版式对齐 WorkBuddy

用户看真机截图后追加两条要求，均已落地：

**A. 「👥 专家团」chip 要落在「标准模式」右侧（推翻上一轮"做不到"的结论）**

上一轮结论「槽位体系里做不到」只对**槽位**成立，对 **DOM** 不成立。hero 行确实不能用槽位加第三个控件
（三个 `conversation.hero.*` 槽都是 single 语义：同优先级注册抛错、异优先级是遮蔽而非并列），
但仍然可以把 chip **`createPortal` 到那一行的真实 DOM 节点**里。

落地方案：

- 静态注册点仍是 `conversation.input.left`（这是"有内容会话"里正确的落位，也是 portal 失效时的兜底）。
- 组件在**空会话态**（`[data-phase]` 为 `hero`）改为 portal：`findHeroSeatRow()` 取
  `[data-composer-card]` 之前的最后一个 `button[aria-haspopup="menu"]`（即 Agent 预设 chip），
  从它向上跳过 `display: contents` 的槽包装层，得到真正的 flex 行，把 chip portal 进去。
- 视觉顺序用 `order: 100` 保证排在「标准模式」之后（不能插在它前面，因为只能 append）。
- 宿主 DOM 重建会让锚点失联，故用 **400ms 轮询复查**（值未变不重渲染）；一旦失效立刻回退渲染在原地，
  不静默消失。
- 只认语义锚点（`data-composer-card` / `aria-haspopup="menu"`），**不认构建哈希 class**。

真浏览器实测（`browser-check.py`，Playwright 量 bounding rect）：`chip.cy=451 = preset.cy=451`、
`chip.x=591 = preset.right=591`、`order=100`、`rowDisplay=flex` —— 四项全绿。

**B. 面板版式对齐 WorkBuddy 的「专家团」**

用户提供 WorkBuddy 截图（列表页 + 详情页），要求"借鉴/完整复制"。因本机 WorkBuddy 未装那些专家团、无法读源码，
故按截图的**信息架构**重做（不追求像素级复刻）：

- **画廊**：标题栏（「专家团」+ 总数）→ 排序（综合 / 最热 / 最新）→ 分类筛选 chips（全部 + 各分类）
  → 4 列卡片网格（圆头像 + 名称 + `发布方 · N位专家` + 3 行简介 + 标签）。
- **详情**：大圆头像(64) + 名称 + 使用次数 + **黑色胶囊「召唤专家团」CTA**（圆角 999 / 高 44）
  + 引号预设条（`"…"` + 气泡图标）+ 使用案例缩略图卡 + 团队成员 3 列（主理人带 🏅 徽章）。
- 数据层随之扩展：`normalizeTeam` 收 `category` / `tags`(≤4) / `createdAt`；`publicView` 派生 `publisher`
  （内置 → `DSH 官方团队`，自定义 → `我的团队`）；编辑团队时保留原 `createdAt`。
- 内置团队 4 支 / 24 位 → **10 支 / 51 位**（新增内容创作 / 数据智能 / 营销增长 / 人力资源 / 金融投资 / 法律合规），
  才撑得起 4 列网格与分类筛选。

**C. 验收与工具链修正**

- `browser-check.py` 的「chip 不独占一行」断言原为 `rowChildren >= 3`，**依赖本机是否渲染工作区选择器**，
  属环境误报。改为 `rowDisplay === 'flex' && presetInRow && rowChildren >= 2` —— 即断言
  "chip 与「标准模式」共享同一 flex 行、且 chip 不是唯一子节点"，这才是该断言的语义。
- `browser-check.py` 的 token 解析改为**扫描日志里所有 `?token=` 候选逐个探测**，取能过鉴权的那条
  （原来只取最后一条，DSH 重启换 token 后会拿到失效值，导致 5 条断言连环误报）。
  并新增**鉴权门禁**：401 时只报一条明确失败并提示重启，直接退出。
  依据：`packages/client/connection/src/browser-auth.ts` 的 `processLaunchToken` 用 `randomBytes`
   每进程随机生成、**不落盘**，所以 token 过期后无法找回。
- `gates.mjs` 增加：client 产物需保留 `require("react-dom")` 外置 + `data-composer-card` 锚点；
  每支团队需有非空 `category`、`tags`(1–4)、`createdAt`；内置团队 ≥ 8 支。
- `smoke.mjs` 把写死的「4 支 / 5 支」断言改为**从 `data/teams.json` 实时读内置团队数**。
  加团队是常规迭代，不该让脚本跟着变红；这条最初正是因为加了 6 支团队后 4 项断言集体失败才暴露的。
  同时补一条「命令 list 报出团队总数」的断言。
- `src/index.js` 里 `/expert-team summon` 的引导文案同步更新（原来只说"输入框工具行左侧"，
  现在补上"空会话在「标准模式」右侧"）。

最终校验：build ✅ ｜ gates **119/119** ｜ 宿主冒烟 **63/63** ｜ 浏览器半冒烟 **157/157** ｜
真浏览器 **28/29**（唯一失败为第三方 `dsh-better-sidebar` 的 `remote.session`）。

---

### 2026-09-21 · 三轮修订：chip 与同行邻居「设计统一」（用户截图反馈）

用户截图圈出 hero 行，指出「专家团」和旁边的「dshworkspace | 标准模式」**不是一套设计**。用 Playwright
量了那一行三个控件的计算样式后，差异被定位到**两点**（其余 7 项本就一致）：

| 项 | 邻居（工作区 / 标准模式） | 我们（修复前） |
|---|---|---|
| 静止态背景 | `rgba(0, 0, 0, 0)` 透明 | **`rgba(0, 113, 227, 0.1)` 淡蓝** |
| 图标 | 2 个 svg（16px 线性图标 + 12–14px 灰 chevron） | **0 个 svg**，用的是彩色 `👥` emoji |
| 字号 / 字重 / 行高 / 圆角 / padding / gap / 高度 | 13 / 500 / 20 / 16 / 0 8 / 4 / 28 | 一致 ✅ |

**根因（真 bug，不是审美问题）**：`Trigger` 里 `const open = useCallback(...)` 是「打开面板」的**函数**，
而样式写成 `rowChip(open || hover ? { background: HOVER_BG } : {})` —— 函数对象**恒为真**，
于是 chip 静止态也永久带着悬停底色。工具行那版写的是 `state.open`，所以没这个毛病。
修复：改为 `state.open || hover`。

**图标替换**：新增 `IconUsersInline`（`viewBox 0 0 16 16` + 1px 描边 + `currentColor`），
hero 行按 16px 渲染、工具行按 14px 渲染 —— 两个尺寸都是量出来的（hero 行邻居图标 16×16、
工具行邻居图标 14×14），不是拍脑袋定的。

**新增回归护栏（三层，防止再犯）**

- `client-smoke`（148 → **157**）：静止态背景必须 `transparent`；图标必须是 1 个 svg；
  hero 行 16px / 工具行 14px；图标用 `currentColor`；文案里不得出现 emoji；
  **悬停要仍给底色、移开要收回**（静止透明 ≠ 没有反馈）。
  坑：section 17 跑的时候面板还开着（`state.open === true`），此时带高亮底是**预期行为** ——
  断言前必须先把面板关掉再验静止态。
- `browser-check`（25 → **29**）：在真实 Chromium 里断言静止底色为 `rgba(0,0,0,0)`、
  图标 svg 数 ≥ 1、**图标尺寸与邻居相等**（实测 `chip=16 preset=16`）、
  **悬停底色与邻居完全相同**（实测两边都是 `rgba(0,113,227,0.1)`）。
  悬停比较不能用 Playwright 的 `.last` 定位邻居：卡片里的「工作区内修改」也带
  `aria-haspopup="menu"`，会打偏；改用与 `findHeroSeatRow` 同一套过滤逻辑取盒子，再用坐标 hover。

最终校验：build ✅ ｜ gates **119/119** ｜ 宿主冒烟 **63/63** ｜ 浏览器半冒烟 **157/157** ｜
真浏览器 **28/29**（唯一失败仍为第三方 `dsh-better-sidebar` 的 `remote.session`）。

---

### 2026-09-21 · 四轮修订：模态被右侧文件树面板盖住（用户截图反馈）

用户截图圈出右侧：**专家团模态开着，右半边却被右侧文件树面板挡住**。

**根因：被关进了别人的层叠上下文，不是 z-index 写小了。**

DOM 实测（`page.evaluate` 逐层 dump）：

| 元素 | z-index | 定位 | 备注 |
|---|---|---|---|
| 我们的模态外框 | 9999 | fixed | 但**父级**是 `eK4aRG_overlayLayer` |
| `eK4aRG_overlayLayer`（`shell.overlay` 的容器） | **20** | absolute | **形成层叠上下文** → 内部一切都被封顶在 20 |
| 右侧文件树 `nArs4W_panel` | **40** | absolute | 外层容器 25；不在 overlay 层内 |
| DOM 顺序 | — | — | 模态 index 647，文件面板 index 858（它也更靠后） |

所以 40 > 20：文件树压住模态。**在 overlay 层内部无论写多大的 z-index 都无效** ——
它只是"层内第一"，相对整页仍是 20。

**修法**：模态 portal 到 `document.body`（新增 `portalToBody(node)`），回到**根层叠上下文**，
`9999 > 40` 才真正成立。与入口 chip 的 portal 同一个思路：
**槽位只负责"让宿主知道有这个东西"，定位与层级自己管。**
降级：`document` / `document.body` 不可用时原地返回（单测假 DOM、SSR 行为不变）。

**验证方式：不做 z-index 数字比较，做命中测试。**
跨层叠上下文比 z-index 数字本身就是错的；正确做法是在**两块的真实重叠区**取一点，
用 `document.elementFromPoint(x, y)` 看最上层元素是不是落在模态内。
`browser-check` 实测：

- `模态挂在 document.body 下` → `zIndex=9999 inBody=True`
- `模态与右侧文件面板确实重叠` → 重叠 `185×707`（**先证明"确实重叠"，断言才有意义**）
- `重叠区最上层是专家团模态` → 探针点 `(1219, 500)` 命中，`落在模态内=True`

**新增护栏**
- `client-smoke`（157 → **161**）：模态 portal 容器必须是 `document.body`；
  仍是 `role=dialog` + 同款 `aria-label`；关闭后不留残影。
  **踩坑**：section 17 里「最后一个 portal 就是 chip」的假设失效了（模态也会 portal），
  改为**按容器过滤**（`chipPortals = portals.filter(p => p.container === seatRow)`）——
  这是"把模态改成 portal"之后连带暴露出来的测试脆弱点。
- `browser-check`（29 → **32**）：上述三条层级断言。

最终校验：build ✅ ｜ gates **119/119** ｜ 宿主冒烟 **63/63** ｜ 浏览器半冒烟 **161/161** ｜
真浏览器 **31/32**（唯一失败仍为第三方 `dsh-better-sidebar` 的 `remote.session`）。

### 2026-09-22 · 五轮修订：开发阶段「不锁定内置项」+ 上限全部可配置（用户要求）

**用户要求**：插件处于开发阶段，所有团队 / 专家相关项都必须保持可修改，不能写死成不可更改的内置项；
等确认定稿后再改成内置只读。可修改的具体形式由用户从四个方案里选定。

**选定方案**：**配置文件开关**（`$DSH_HOME/expert-teams/config.json`），并把各项上限一并放进去。

**原本「锁」在哪里（复盘）**：后端其实没有硬保护 —— `POST /api/teams` 一直允许写内置 id，
落地方式是在用户目录落一份同 id 副本覆盖内置（`TeamRepository.all()` 里 custom 后放）。
真正的锁只有前端三处：详情页的「编辑」入口、`MemberDialog` 的 `readOnly`、以及那段只读说明文案。
所以这次的分歧点不是"能不能写"，而是"要不要让用户看见并点得动"。

**实现**

- 新增 `readConfig()`：读 `config.json` 的 `lockBuiltinTeams`（缺省 `false`）与 `limits`；
  **每次调用都重新读盘**，于是改完配置重开面板即生效（配合下面的 `loadToken`）。
  `limits` 只收正整数，非法值回落到默认值 —— 免得手滑把插件卡死。
- `DEFAULT_LIMITS` 取代原先散落的 `MAX_MEMBERS` / `MAX_TAGS` 与十几处 `clean(x, N)` 字面量：
  成员数、标签数、预设条数、案例数，以及团队名 / 简介 / 分类 / 标签 / 成员名 / 昵称 /
  职责 / persona / 预设文本 / 案例标题 / 描述 / 交付 / 提示词的字数上限，全部可覆盖。
- `normalizeTeam(input, limits)` 收配置；`TeamRepository` 新增 `isBuiltin(id)`。
- `GET /api/teams` 响应带上 `config`（少一次往返）；新增 `GET /api/config`；
  锁定模式下写入内置 id 返回 **403 `LOCKED`**（只藏 UI 不算"不可更改"）。
- 前端：`store.config` 收下发配置，`Detail` 由 `lockBuiltinTeams` 决定编辑入口与成员只读态；
  编辑内置团队时给出显式提示（保存 = 落一份同 id 副本，会盖掉以后的内置更新）。
- `ensureConfigFile()`：首次启动落一份默认可改的配置模板（已存在则不动）。启动日志打印当前锁定态。

**踩坑：点入口是幂等打开，所以"重开面板刷新配置"并不成立。**
`Trigger` 的 `onClick` 是 `patch({open: true})`；面板已开时点它 `open` 值不变，
而 Modal 的加载 effect 依赖 `[state.open]` → 不会重跑 → 新配置读不进来
（冒烟里的现象是 `GET /api/teams` 计数 `12 → 12`）。
加 `store.loadToken`（每次点入口 +1）并把 effect 依赖改成 `[state.open, state.loadToken]` 后成立，
顺带给了用户一个"点一下入口就刷新"的手感。

**冒烟断言同步**（原先写死的三条"内置只读"断言，语义已反）：
未锁定 → 断言内置出「编辑」入口、成员详情有「保存成员」、且**不**出现只读提示；
新增第 18 节锁定态回归（`lockBuiltinTeams=true` 重开面板）→ 断言编辑入口消失、
成员详情只读且给出解锁说明、自定义团队仍可编辑。

**留给下一次的迁移点**：定稿时把 `config.json` 的 `lockBuiltinTeams` 改成 `true` 即可锁定，
代码不用动；但用户目录里已经落下的**同 id 副本不会自动回滚** —— 若要"干净的内置基线"，
需要额外做一次"清掉覆盖副本"的动作（本期未做，用户选了"能编辑就够、不做删除"）。

### 2026-10-03 · 六轮修订：适配 DSH 0.2.0-rc.2（本次）

**背景**：本机 DSH 已从 0.1.3-alpha.1 升到 **0.2.0-rc.2（Cordis 4.0.4）**，插件停留在旧契约上。
本轮按 `dsh-plugin-studio` skill 的合同清单 + 0.2.0 **自带**的官方开发 skill（`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`）
逐条核实，并直接读 `app.asar` 里的宿主源码取证（探针 `_asar/probe.mjs`、`_asar/tokens.mjs`）。

**A. 宿主侧（Node half）**

- 命令 / 工具注册由「`ctx.get(name)` 惰性访问」改为 **`ctx.inject([...], scoped => …)` 按需装配**
  （`ctx.inject(['commands'], …)`、`ctx.inject(['agents','tools'], …)`）：服务就绪才装配、重启自动重跑、作用域卸载连带回收；
  取不到服务不再让插件 pending。**请求处理路径**仍 `ctx.get('agents'/'subagents')` 现取现用，取不到返回可读错误。
- 工具注册现状已按 0.2.0 `core/tools` 契约复核：`parameters` 是原生 JSON Schema、`output` 是 `{schema, render}`、
  `execute(args, exec)` 用 `exec.agent` / `exec.signal`；per-agent 注册跟随 `agent/created` / `agent/disposed`，
  disposer 按 agent 存回插件自己的 effect。

**B. 客户端（浏览器半）**

- **主题令牌化**：全部界面颜色改 `--dsw-alias-*` + 浅色兜底。修掉两个**不存在**的令牌名
  （`--dsw-alias-fill-accent` / `--dsw-static-white` 在 0.2.0 令牌表里 0 命中 → 主按钮此前根本不跟主题走），
  并修掉「用 `label-primary` 当按钮底色」导致深色主题**白底白字**的问题（改用 `button-primary-fill`）。
  用到的 24 个令牌逐个在 210 个令牌里核对存在（定义点 `dsh-client-ui-theme/lib/client.js:1148`）。
- **hero 落位改用公开锚点**：首选 `[data-slot="conversation.hero.agentPreset"]` —— `ui-renderer` 的 `SlotOutlet`
  给**每个槽位出口**渲染 `data-slot={slotKey}`（`dsh-client-ui-renderer/lib/client.js:1094-1104`），是公开契约；
  取不到才回退到 `data-phase` / `data-composer-seat` / `data-composer-card` / `aria-haspopup="menu"` 那套启发式。
  回退判据由「这一层里有并列的两个 chip」改为「**这一层只有一个孩子**」——因为**开启开发者工具时** Agent 预设 chip
  外面会多包一层 `._oGoKq_menuAnchor{min-width:54px}`（哈希类名，`dsh-client-ui-agent-preset/lib/client.js:378`），
  hero 行里只剩一个 chip 可见，旧判据会落进这个 54px 包装里被挤扁（`client-smoke` 夹具 17a-2 钉住这个场景）。
- 槽位注册补 `dsh.client.inject`（`dsh-client-ui-conversation` / `dsh-client-ui-layout`，用于激活排序）与 `immediately: true`。

**C. 清单与构建**

- `engines.node` → `^22.19.0 || >=24.0.0`（官方检查器唯一 FAIL 项）、`packageManager: pnpm@11.7.0`、
  顶层 `icon: assets/icon.svg`、`locale/{en,zh}.json` + `exports["./locale/*.json"]`（0.2.0 展示元信息三件套，契约在
  `dsh-app-boot/lib/index.js:1860-1999` 的 `iconOf` / `dictionariesOf` / `readPluginMeta`）、`pnpm.onlyBuiltDependencies: ["esbuild"]`、
  `.gitignore` 补 `__pycache__` / `*.pyc` / `lib.tmp` / `lib.prev`。
- `scripts/build.mjs`：**先写 `lib.tmp/`、两半都成功后再原子替换 `lib/`**（旧版开头就 `rmSync(lib)`，一次 esbuild
  解析失败便把唯一发布物清空，两套冒烟当场 `ERR_MODULE_NOT_FOUND`）；banner 的 ModuleLoader id 改为读 `package.json.name`。
- `scripts/gates.mjs` 由 119 项扩到 **212 项**（并入论衡长文流水线后为 **223 项**），新增：`locale` / `icon` 全部硬规则、`engines`、`packageManager`、
  `dsh.client.immediately`、以及**`lib/index.js` 的 VERSION 与 `package.json` 一致**（`npm pack` 只收 `lib` 不收 `src`，
  这条以前没人管，曾出现 lib 0.1.0 / src 0.2.0 的错版发布物）。
- 官方检查器落地：`node <profile>/node_modules/dsh-plugin-guide/bin/dsh-plugin-dev.js check --cwd .` →
  **OK（8 passed / 0 failed / 2 warned / 5 skipped）**（改动前是 FAILED：唯一 FAIL 为 `manifest-engines`）。
  两个 warning 已确认无害：`readme-five-langs`（本插件面向中文）、`redline-effect-registration`
  （**误报**：命中的是 `src/index.js:1094` 的 `res.off('close', abortOnClose)`，属 HTTP 每请求清理、不是注册拆卸）。

**D. 刻意不做 / 待用户决策**

- **不加 `peerDependencies`**：0.2.0 的版本门禁读的是 `peerDependencies`（`dsh-app-boot/README.zh.md:52` 明确**不是**
  `engines.dsh`），但**没有声明就不施加任何版本约束**；本插件零 `@deepseek-ai/*` 引用、运行时全靠能力探测
  （`capabilities.persona` / `prepareContinuable`），不声明反而是前向兼容的最大化。代价是失去「装到不兼容版本时提前报错」。
- **不改包名**（仍是裸名 `expert-team`）：0.2.0 模板一律带 scope，但本插件是本地开发插件、不发布 npm；
  改名会牵动 ModuleLoader id / `cordis.patch.yml` 的 `id`+`name` / 门禁 / 已装 profile。真要发布时再改（只需两处，banner 已自动跟随）。
- **不加 ErrorBoundary**：`scripts/client-smoke.mjs` 的假 React 只支持函数组件，加类组件边界必须同时扩展假运行时
  （`React.Component` 基类 + `isClass` 判定 + `setState` + `getDerivedStateFromError` 重渲染分支）；收益（槽位崩溃不留白）
  暂不抵改造成本，记为后续。
- **不清理 `.tmp/`**（250 文件 / 4.0 MB 历史调试残渣）：不在 `files` 白名单、不进包，留给用户自己决定。
  本轮只删掉了误建的空目录 `expert-team/expert-team/`。

**E. 5 条与 0.2.0 相关的既有事实复核**（都可能左右后续大改）

1. `conversation.input.left`、`shell.overlay` **都还在**（渲染点分别在 `dsh-client-ui-conversation/lib/client.js:17524`、`dsh-client-ui-layout/lib/client.js:312`）。
2. `data-composer-card` / `data-phase` / `data-composer-seat` **都还在**，另有更稳的 `data-slot`（见 B）。
3. `@deepseek-ai/dsh-experimental-agent-team`（含 `-tool-` / `-client-ui-` 三个包）**不暴露任何可复用的 cordis 服务**：
   `provide(` / `ctx.set(` 命中数 0、不注册 `expert_team_*` 工具、结构里没有 persona/头像/案例字段、投影 `.strict()`、
   数据锚定单会话事件流。→ **自建 `subagents.startContinuable` 派遣是正确路线**，不需要改为委派官方 agent-team。
4. `subagents.startContinuable` 及 `SubagentStartRequest = {label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona?}`
   契约未变（`dsh-subagent/lib/typert.host.js:779`；能力闸门 `lib/index.js:3192-3196`；persona 落地为子上下文
   `deployment:persona-prefix` 的 systemPrompt 段落）。新增的 `@deepseek-ai/dsh-persona` 是给 **preset/agent** 用的
   人设行，与 subagent 的 persona 能力**是两回事**，不要混用。
5. 同类竞品 `@michengai/dsh-agency-agents` 也占 `conversation.input.left`（order 0，本插件 40），功能性重叠由用户按需取舍。

**F. 验收基线（本次末态）**

`build` ✅ ｜ gates **223/223** ｜ smoke **120/120** ｜ client-smoke **215/215** ｜
`dsh-plugin-dev check` **OK (8 / 0 / 2 / 5)** ｜ `npm pack --dry-run` **49 文件 / 369.8 kB（解包 838.5 kB，第七轮补正后重测）**。
真浏览器验收（`browser-check.py`）本轮**没能复跑**：需要 Playwright 与一个带 launch token 的运行中 URL，本机当前都不具备；
19387 这个桌面 GUI 本轮**已装载本插件并活体验证 200**（见 ⑤），但运行中的实例要重载/重启才会看到后加的团队。

**G. 第七轮：并入「论衡长文流水线」专家团（2026-10-03）**

- 来源：`github.com/zuoyunlai/lunheng-article-pipeline-dsh`（v18.72.0、commit `93e2232`、MIT）。**不安装该插件**，只把它的深度长文生产内核抽成**本插件的一支内置专家团**（用户 m00001/m00006 的想法）。
- 团队字段：`id: lunheng-longform`、name「论衡长文流水线」、category 学术写作、avatar 12（并入前为空闲号）、
  accent `#0F766E`、tagline「三角验证 / 独立审计 / 期刊匹配」、tags 深度长文 / 三角验证 / 独立审计 / 期刊匹配、
  emoji 📜、6 条预设、3 个使用案例（三角检索与选题定稿 / 批判与独立审计 / 期刊匹配与终检放行）。
- 9 位成员（源项目的 T0 主控与 T8 终检合为一位 `lead`）：终检主控（lead）、文献检索员、数据检索员、案例检索员、
  分析员、写手、批判伙伴、审计员、同行评审。每段 persona 四段式（职责 / 工作方式 / 交付物 / 纪律），700~1200 汉字，
  通过 `scripts/merge-persona.mjs` 的标记与字数口径。
- 6 个阶段，覆盖全部 9 人：定题与三角检索 → 分析与大纲 → 起草初稿 → 批判与独立审计 → 修订与审稿 → 终检交付。
- 写进 persona / 案例的源机制：T1/T2/T3 三线并行检索与 `[Lxx]`/`[Dxx]`/`[Cxx]` 证据卡、三角验证（核心论点至少两类证据，
  缺角标注、**严禁编造**）、C1–C7 批判报告、G0–G14 独立审计（含 G14 中文 AI 痕迹闸八维）、修订 ≤2 轮、
  T9 六维评分（原创性 / 方法论 / 证据强度 / 论证结构 / 写作质量 / 引文规范，逐维 x/5、总评分 xx/30 = 六维之和）+
  期刊匹配 Top 3（综合 = 0.5×主题 + 0.3×风格 + 0.2×归一化总分，容差 ±1.5）、
  M 门（M-Form 11 + M-Exist 11 + M-Fact 1 + M-Integrity 2 = **25 项 = 机械 24 + 人工门 1**）与退出码如实记录、四道人在环节点。
- **与源项目的差异（如实声明）**：源项目是「技能 + 脚本 + 工具」三件套（M 门脚本、4 个只读工具、机制文件写保护）；
  本插件只做**专家团这一层** —— 把角色、阶段、纪律、交付物写成 persona 与阶段计划，不搬脚本与门禁工具，
  真需要跑机械终检时由主理人在会话里执行。另：用户口述的「M 门 23 项」指 `M-Form 11 + M-Exist 11 + M-Fact 1 = 23` 项纯机械硬检查，
  源文档完整口径是 **25 项**（再加 M-Integrity 1–2，其中 M-Integrity-2 为主控人工门，故机械共 24 项）；本轮按完整口径写，
  README 与 persona 里的项数已同步（此前写「与源文档差 1 项」的说法作废）。
- 验证：并入后 gates **223/223**（+11 项）、smoke **120/120**（health / 列表 / 命令都随 `BUILTIN_COUNT` 报 14 支）、
  `dsh-plugin-dev check` 仍 OK；`data/teams.json` 430.0 → 466.8 KB，**前 13 支逐字节一致**（无重排漂移）。
- 生效边界：`TeamRepository` 在 `apply` 时构造一次，**运行中的 19387 实例仍报 `teams:13`**；要在画廊看到第 14 支需重载插件或重启桌面应用。
- **第七轮补正（同日）**：按源项目九张角色卡与 `_shared/M-Gate-Algorithm.md`（阈值总表 + 交叉引用）抽回的权威规格**重写 9 段 persona** ——
  此前 persona 里的 G14 八类、C1–C7 名目、审稿六维名与 `/10`、M 门分项均是自拟，**已全部作废更正**：
  G14 = A 学术模板语（综上所述 / 本文认为 / 值得关注的是，任一 ≥3 次）/ B 句式同质化（连续 3 段同句式起头）/
  C 学术套话高频（赋能 / 抓手 / 底层逻辑，全文 ≥5 处）/ D 破折号滥用（占比 >3%）/ E 三项排比（全文 ≥3 处）/
  F 人称错位（我字频 >1%）/ G 个人辨识度缺失（与典型 LLM 风格相似度 >80%）/ H 党报话语堆砌（全文 ≥3 处），
  判级 0–2 Pass / 3–4 Warning 触发 1 轮 / 5+ Fail 触发 2 轮；C1–C7 = 核心论点可攻击性 / 论证链薄弱环节（含因果断面三问）/
  理论假设审查 / 立场中立性 / 反方观点完整性 / 元叙事清理与内部流程词专项 / 一处两用识别；审稿六维逐字固定为
  原创性 / 方法论 / 证据强度 / 论证结构 / 写作质量 / 引文规范，总评分 `xx/30` = 六维之和（档位 accept 26–30 / minor 21–25 /
  major 16–20 / reject <16）。同时修正第三个案例里的六维名、`/10`→`/5`、总分口径与 M 门表（`M-Fact` 行 + 合计 25）。
  persona 汉字数 **701–944**（房格 700–1200）；插件版本 **0.2.0 → 0.2.1**（`package.json` 与 `src/index.js:128` 的 `VERSION`
  同步，`lib/index.js` 已重建），`data/teams.json` 466.8 → **471.2 KB**（482536 B）。
  验证：build ✅、gates **223/223**、smoke **120/120**、client-smoke **215/215**、`dsh-plugin-dev check` OK (8 / 0 / 2 / 5)、
  `npm pack` 49 文件 / 369.8 kB。运行中的 19387 实例仍报 `version:"0.2.0"`、`teams:13`，**需重载插件或重启应用才生效**。

### 2026-10-05 · 第八轮：并入 7 支外部专家团包（0.2.1 → 0.2.2，本次）

**需求**（用户 m00002）：用 `dsh-plugin-guide` 检查插件对 DSH 的适配；把下载到
`D:\DSH\dshworkspace\expert-team\下载的专家团\` 的专家团包并入本插件。

**A. 适配性审计（只读，未改任何源码）**

| 检查 | 结果 |
|---|---|
| `dsh-plugin-dev check --cwd .`（官方检查器 v0.3.19） | **OK（8 passed / 0 failed / 2 warned / 5 skipped）** |
| `scripts/gates.mjs` | 全部通过（改前 223 项） |
| `scripts/smoke.mjs` / `scripts/client-smoke.mjs` | 120 / 120、215 / 215 全通过 |
| asar 契约实测（`_asar/probe.mjs`） | `prepareContinuable`（fork-in-process:52 / spawn-in-process:37）、`startContinuable`（dsh-subagent/lib/index.js:1671）、`request.persona`（types/continuation.js:123）、槽位 `conversation.input.left`（ui-conversation/lib/client.js:17524）、`shell.overlay`、WebServer 前缀匹配（**@deepseek-ai/dsh-host-webserver** lib/index.js:327-329）全部在 0.2.0-rc.2 上成立 |
| 运行实例（desktop profile / 19387） | `/expert-team/api/health` → `{ok,version:"0.2.1",teams:14,subagentProvider:"spawn",personaNative:true}` |

结论：**没有需要修的适配缺陷**；两条 warning 仍是多语 README 缺失与 `redline-effect-registration` 误报
（命中 `src/index.js:1094` 的 `res.off('close', abortOnClose)`，属 HTTP 每请求清理）。

**B. 7 个下载包的实际形态**（重要：不都是同一种东西）

6 个是标准 `skillhub-expert-package`：`manifest.json`（`type/slug/displayName/summary/skills[]`）+
`skillsets/<slug>.md`（YAML frontmatter + 「步骤 N：<名>（获取层/分析层/输出层）」+ 输出物 + 最终输出）+
`skills/<slug>/SKILL.md`（3 个包是 `.zip` 形态，已解压到 `.tmp/unzipped/`）。
第 7 个 `materials-lab-0.1.0` **不是专家团包**，是 OpenClaw 插件 `@cranesun/openclaw-materials-lab`
（`openclaw.plugin.json` + `src/{cli,core,hooks,services,tools}` + `python/` + 一个 `material-science-research` 技能）。

**C. 转换口径（两步）**

包内**没有** expert-team 需要的成员 persona，所以转换分两步，只有第二步是脚本：

1. **执笔**（7 个并行子代理，每个包一个）：按 `.tmp/import/SPEC.md` 把包写成团队草案 JSON
   （`.tmp/import/raw/<team-id>.json`）。口径：1 位主理人（lead）+ skillset 里每个 skill 各 1 位专家；
   skillset 标注的层 → 团队 `stages`（同层并行、层间串行，主理人落在最后「汇总收口」阶段）；
   persona 四段式并写出**从 SKILL.md / references / scripts 提炼的真实判据与参数**；
   每位专家都写明「**若当前环境已安装 `<skill-slug>` 技能就优先调用它，否则按本角色的方法论自行完成**」
   —— 因为这 42 个 skill **都没装进** `$DSH_HOME/skills`（逐个核对过），persona 必须自带可执行方法。
2. **导入**：新增 `scripts/import-teams.mjs`（见 D）。

**D. 新增 `scripts/import-teams.mjs`**（正式交付物，非一次性脚本）

`node scripts/import-teams.mjs --from <草案目录> [--dry] [--only a,b]`：白名单校验（未知字段丢弃并告警；
缺 name / 无成员 / >13 位成员 / lead 多于 1 位 / persona 空或超 4000 字 / `stages` 序号不连续或未覆盖全部成员
→ 列出全部问题并**整体拒绝写盘**）；团队头像三选一（草案自带 → **复用库里同 id 团队的原头像** → 从空闲池顺序取，
所以**重跑幂等、头像不会抖**）、成员头像按队内序号错开保证队内唯一；
同 id 覆盖保持原位置、新 id unshift 到最前；写盘前整体自洽复检（id / 团队头像 / 队内头像唯一 + stage 引用存在）。

**E. 本轮并入的 7 支（新增 48 位专家，团队 14 → 21、专家 85 → 133）**

| id | 名称 | 分类 | 成员 | 阶段 | accent | 承载 |
|---|---|---|---|---|---|---|
| `academic-statistical-analysis` | 统计分析专家团 | 数据智能 | 7（统计总师·邱衡之 + 6） | 4（获取/分析/输出/收口） | `#6D28D9` | 82 统计方法表、贝叶斯与蒙特卡洛、37+ 检验、中文报告、图表验证 |
| `design-ui-prototype` | UI 原型设计团 | 产品设计 | 7（设计总监·郎定稿 + 6） | 5 | `#9333EA` | 零提问 PRD、像素还原、设计令牌三层结构、八维质量审查、线框图、高保真 HTML |
| `content-creation-lyrics-songwriting` | 歌词创作团队 | 内容创作 | 7（歌词出品人·司律成 + 6） | 4 | `#C026D3` | 作词方法论、情感弧线、十四韵部、171+ 元标签、免 Key 浏览器生成、MV Pipeline |
| `tech-code-refactoring` | 代码重构团队 | 技术工程 | 7（重构总监·陆知止 + 6） | 4 | `#15803D` | 结构/DDD 分析、Git 债务盘点、SOLID 评审、重构模式、目标架构、等价简化 |
| `mysticism-yijing-divination` | 易经起卦团队 | 命理玄学 | 7（易经主理·易衡之 + 6） | 5 | `#B91C1C` | 主驱动起卦、纳甲六爻、梅花体用、小六壬、卦辞义理、三层义理融合 |
| `mysticism-ziwei-doushu` | 紫微斗数命理团 | 命理玄学 | 7（命理团主理·玄同 + 6） | 4 | `#4C1D95` | 排盘 JSON、多流派解读、北派飞星、紫微八字融合、双人合盘 |
| `materials-lab` | 材料科研团队 | 前沿研究 | 6（主理人·柯定材 + 5） | 4 | `#047857` | Materials Project 检索、pymatgen 结构分析、显式标准排序、笔记留痕、报告导出 |

**F. 与源包 / 源插件的差异（如实声明）**

- **只做「专家团这一层」**：源包里的 `skills/`、脚本、参考数据**没有**搬进本插件，也没有装进 DSH 技能目录；
  它们的作用是被提炼进 persona 的方法论。真要用某个技能本身，需要另行安装。
- `materials-lab` 的 `materials_*` 工具链属于 OpenClaw 插件，DSH 里不存在，所以 6 段 persona 都写成
  「若工具链可用则优先调用，否则退化为 Materials Project / OQMD / AFLOW 公开检索 + 本地 pymatgen/ASE，
  并显式标注来源是实测 / 离线 mock / 估算」，并保留了原技能的审批门纪律（ASE 弛豫与批量筛选需用户批准）。
- **两支命理团队是文化参考向**：persona 里写明「仅供文化参考、不替代医疗 / 法律 / 财务等专业建议」。

**G. 执笔过程中暴露并处理的问题（可复用的教训）**

1. **子代理产出 JSON 必须显式禁止英文半角双引号**：歌词组首版在 persona 里写了 `profile="chrome"`、`"Kara Codex"`
   之类，直接 `JSON.parse` 失败（`SyntaxError … position 14527 (line 96 column 272)`）；改写为「」后通过。
   `.tmp/import/SPEC.md` 已把这条写成硬约束。
2. **七份草案的 persona 四段标记不齐**（9 处缺「你的职责是 / 你的交付物是」）——成员详情页按这四个标记切小节，
   缺标记会退化成整段文本。用一个确定性后处理脚本把 persona 前 120 字内的首个「，负责」改写为「。你的职责是」，
   把 materials 主理人的「你直接产出：」改写为「你的交付物是：」，全部补齐。
3. **accent 撞色**：三对子代理各自选了同一个 `#7C3AED` / `#6D28D9` / `#0F766E`。accent 不在 gates 约束里，
   但画廊里一眼能看出复制感，所以统一重分配为一组互不重复的 Tailwind 600/700 色（见上表）。
4. **persona 长度**：SPEC 建议 800–1500 字；歌词组有 3 段到 2064–2563 字（要装 171+ 元标签速查与 MV 链路），
   仍在 4000 字硬上限内，**刻意保留不砍** —— 砍了这些 persona 就只剩空话。
5. **并行执笔的「最后写入」不可控**：易经组与紫微组在第一次导入（05:32:42 UTC）之后又各自写了一次草案
   （05:32:45 / 05:33:32），导致库内是它们的中途版本。处理方式：**以草案当前内容为准重跑导入**（脚本确定、幂等），
   并加了一致性校验（把草案与库内条目做键排序后逐字段比对，仅忽略 `avatar`）确认 7 支完全一致。
   教训：并行执笔者全部**确认结束**之前不要落盘导入。

**H. 验收基线（本次末态）**

`build` ✅（`lib/index.js` + `lib/client.js` 101.7 KB）｜ gates **300 / 300**（较 14 支时 +77 项）｜
smoke **120 / 120** ｜ client-smoke **215 / 215** ｜ `dsh-plugin-dev check` **OK (8 / 0 / 2 / 5)** ｜
`data/teams.json` 482 536 B → **717 042 B** ｜ 内置库规模 **21 支 / 133 位专家**。
运行中的 19387 仍报 `version:"0.2.1"` / `teams:14`（`TeamRepository` 在 `apply` 时构造一次），
**需重载插件或重启桌面应用才生效**；本轮重建过 `lib/client.js`，按既有经验（DSH 桌面版坑：运行期重建 link 插件的 client bundle
会让 `/plugins/??…&rev=` 的旧 rev 失效），下次 web boot 若报 `N entries did not activate` 属该现象，重启应用即恢复。

### 2026-10-05 · 第九轮修订：撤掉无效的 toolFilter 硬 deny（用户截图反馈）

**需求**（用户 m00001/m00002）：面板派遣「紫微斗数命理团」后，**输入框草稿里出现一大段英文**。
用户问「这是错误还是什么」，并指出团队分工那段文字没问题、只有英文不对。

**A. 定位（结论：不是幻觉，是插件把宿主原始报错原文灌进了草稿）**

草稿的生成路径是 `src/client/index.jsx` 的 `fallbackBriefing()`：面板直连派遣失败时，
把服务端返回的 `reason` 原样拼进「（面板直连派遣未成功：${reason}）」。而服务端 `summonTeam()`
在全部成员失败时抛 `全部专家派发失败：` + 每位成员各一段原因 —— 于是整屏英文被写进输入框。

失败的真正原因是**我们自己传了一个宿主无法解析的工具白名单**：

| 步骤 | 事实 |
|---|---|
| 1 | `src/index.js` 派遣时下发 `toolFilter: { deny: ['expert_team_list', 'expert_team_summon'] }`（本意：禁止专家再召集团） |
| 2 | 宿主在子作用域里执行 `if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)`（asar：`dsh-tool-subagent/lib/index.js`） |
| 3 | `tools.restrict()` **只认全局或祖先作用域提供的工具名**；本插件的这两个工具是用 `agent.ctx.tools.register` 注册在**每个 agent 自己的作用域**里的 → 在子作用域里解析不到 |
| 4 | 宿主抛 `tools.restrict() names unknown global tools "expert_team_list", "expert_team_summon"; known global tools: …`，每位成员都抛一次，被拼成超长报错 |

旁证：该报错的 `known global tools` 列表里**有** `agent_teams_*` / `orchestrator_*` / `summon_expert*`（全局注册），
**没有** `expert_team_*`；`capabilities.toolFilter === true` 只说明 provider 接受这个参数，不代表名字能解析。
出错会话原文见 `$DSH_HOME/storages/session_projcache/sessions/session-d0e1ecb7-….json`。

**B. 修复（服务端 + 客户端）**

1. **不再做硬 deny**：删掉 `toolFilter` 下发（`guard.toolsDenied` 保留但恒 `false`），
   新增 `guard.nestedSoftOnly`；只允许 1 层时在专家提示词末尾追加一条软约束
   「不要再召唤其他专家团、也不要再派遣下属子代理」（`buildMemberPrompt` 的 `options.noNestedSummon`）。
2. **报错摘要化**：新增 `summarizeFailures(skipped)` —— 同一原因的成员合并成一条、每条原因截断 160 字、
   超过 4 位写「等 N 位」，`ALL_FAILED` 文案改为 `全部 N 位专家派发失败：…`。
3. **草稿截断**：`fallbackBriefing()` 先把 reason 压平空白，超过 120 字截断并追加
   「…（原因过长已截断，完整报错见 DSH 日志）」。
4. `guardNote` 同步改为叙述软约束（「并在专家提示词里要求它们不要自己召唤专家团（软约束，非硬性禁用）」）。
5. **兜底文案说的话必须是真的**：HTTP 路由的 catch 里补 `ctx.logger.warn`，把完整报错写进日志 ——
   旧代码只 `sendJson` 不写日志，草稿里那句「完整报错见 DSH 日志」原本是假话。

**C. 测试同步**

`scripts/smoke.mjs` 第 10.4 段原有一条 **`支持时 deny 掉专家团工具`** ——它保护的正是这个错误行为。
已重写为 `即使 provider 声称支持 toolFilter 也不下发`、`防嵌套改为软约束并如实标注 nestedSoftOnly`、
`软约束确实写进了专家提示词`；降级断言由「degraded 长度 2」改为「长度 1 且含 depthLimit」。

**D. 验收基线（本次末态）**

`build` ✅ ｜ gates **300 / 300** ｜ smoke **125 / 125**（较上轮 +5：护栏软约束与失败摘要断言）｜ client-smoke **215 / 215** ｜
运行中的 19387 仍是旧进程内存态（`TeamRepository` 在 `apply` 时构造），**需重载插件或重启桌面应用才生效**。

**E. 教训（可复用）**

1. **宿主报错不要原样进 UI**：`tools.restrict()` 这类报错会把整张全局工具表列一遍，必须摘要 + 截断后再给人看。
2. **`capabilities.toolFilter === true` ≠ 工具名可用**：能力位只说明参数被接受，名字解析另有规则（只认全局/祖先作用域）。
3. **插件自己注册的工具不要写进 `toolFilter`/`deny`**：用 per-agent `ctx.tools.register` 注册的工具，对子作用域就是不可见的。
4. **旧测试会保护旧 bug**：改契约时先扫一遍断言里有没有在要求错误行为（本轮就有一条）。




