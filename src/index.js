/**
 * expert-team — Node half.
 *
 * 「专家团」：跨会话的团队资产（团队卡片 + 成员 persona + 使用案例），
 * 召唤时把每位专家派进一个独立子会话（`ctx.subagents.startContinuable`），
 * 由主会话担任召集人并汇总产出。
 *
 * 设计约束（重要，都是本机踩过的坑）：
 * 1. 严格 inject 只有 `webServer`；其余服务（commands / tools / agents）走
 *    `ctx.inject([...], cb)` 按需装配 —— 服务就绪时执行，服务重启时自动重跑。
 *    不要退回 `ctx.get(name)` 惰性访问：严格模式只认 provider fiber 已 ACTIVE 的服务，
 *    取不到就是 undefined 且**永不重试**，工具与命令会整体静默消失；而 0.2.0 对这类
 *    漏注册只发一条 `dsh: warning: N entries did not activate`，不是 fatal，极难发现。
 *    （历史上严格 inject 缺服务会让插件永久 pending，本机 cordis.patch.yml 曾因此
 *    禁用过多个插件，所以 webServer 仍然只走严格 inject。）
 * 2. 完全不 import 任何 `@deepseek-ai/*`。工具注册直接写原生 JSON Schema ——
 *    `ctx.tools.register` 收的就是 JSON Schema，`defineTool` 只是「参数 DSL → JSON Schema」
 *    的编译器；自己写 schema 就不必依赖它，工具注册因此不会失败。
 * 3. 命令 / 工具的返回值有严格结构：命令必须是 `{kind:'success'|'error', text}`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名，必须与 package.json#name、cordis.patch.yml insert id 一致。 */
export const name = 'expert-team'

/** 严格注入只有 webServer；其余能力在 apply 里用 ctx.inject 装配（见文件头说明 1）。 */
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN_FILE = path.join(HERE, '..', 'data', 'teams.json')
const API_PREFIX = '/expert-team/api/'
/**
 * 路由前缀**不能带尾斜杠**。WebServer 的 prefix 匹配条件是
 * `pathname === p || pathname.startsWith(p + '/')`（webserver/src/index.ts 的 match()），
 * 写成 `'/expert-team/'` 会要求路径以 `'/expert-team//'` 开头，
 * 于是 `/expert-team/api/health` 谁都匹配不到、落到静态兜底变成空 404。
 */
const ROUTE_PREFIX = '/expert-team'
/**
 * 成员头像的静态路由：由宿主按需读取，**不打进客户端 bundle** ——
 * 36 张内联会把 client.js 从 80KB 顶到 200KB，而这些图在页面里天然享受浏览器缓存。
 * 文件名严格限定成两位数字（见 AVATAR_NAME），杜绝 `../` 这类目录穿越。
 */
const AVATAR_PREFIX = '/expert-team/avatar/'
const AVATAR_DIR = path.join(HERE, '..', 'assets', 'member-avatars')
const AVATAR_NAME = /^[0-9]{2}\.jpg$/u
/**
 * 头像索引的上界 —— 必须与 `assets/member-avatars/*.jpg` 的数量、以及客户端
 * `src/client/team-icons.js` 的 `AVATAR_COUNT` 一致（`scripts/gates.mjs` 会校验）。
 * 它是**校验白名单**：越界的索引一律丢掉，让前端回落到「按 id 派生」的那一张，
 * 而不是留下一个拼出来必然 404 的文件名。
 */
const AVATAR_COUNT = 36

/** 头像索引：0..AVATAR_COUNT-1 的整数；其它输入一律 undefined。 */
function cleanAvatar(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= AVATAR_COUNT) return undefined
  return parsed
}

/**
 * 阶段序号：`1..maxStages` 的整数；其它输入一律 undefined（= 该成员不参与阶段编排）。
 *
 * 成员**可以**没有 stage —— 那时整团仍按「一次性并行派遣」处理，与旧行为完全一致。
 * 只有至少两个成员带不同 stage 时，团队才被当作「可分批派遣」。
 */
function cleanStage(value, maxStages) {
  const cap = Number.isInteger(maxStages) && maxStages > 0 ? maxStages : DEFAULT_LIMITS.maxStages
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) return undefined
  return parsed
}

const MAX_BODY_BYTES = 1024 * 1024
/*
 * 各类上限的**默认值** —— 全部可以被 `$DSH_HOME/expert-teams/config.json` 的
 * `limits` 覆盖（见 readConfig）。开发阶段刻意不把上限写死：改配置就能调，
 * 不用改代码、不用重新构建。
 *
 * 默认值的来历：成员数上限 2026-09-22 由 12 提到 13，因为交易分析团队
 * （TradingAgentTeam）是「主理人 + 12 位专业成员」的 13 人编制，13 正好卡在原上限之外。
 * 这个上限**只在本文件校验一次**：客户端表单不做数量上限（只保证 ≥1 位），
 * `scripts/gates.mjs` 也没有对它的断言。
 */
const DEFAULT_LIMITS = {
  /** 成员数上限。 */
  maxMembers: 13,
  /** 画廊卡片上的标签 chip 数量上限（对齐参考版式的 3–4 个）。 */
  maxTags: 4,
  /** 团队预设条（引号句子）数量上限。 */
  maxPresets: 6,
  /** 使用案例数量上限。 */
  maxCases: 6,
  /* 文本字段长度上限。 */
  maxTeamName: 40,
  maxTagline: 90,
  maxCategory: 12,
  maxTagLabel: 10,
  maxMemberName: 30,
  maxMemberAlias: 20,
  maxMemberFocus: 40,
  maxPersona: 4000,
  maxPresetText: 140,
  maxCaseTitle: 40,
  maxCaseDesc: 90,
  maxCaseDelivery: 8000,
  maxCasePrompt: 1200,
  /*
   * 分批派遣与子代理护栏（2026-09 新增）。
   * 背景：过去只有「一次性并行同题派遣」一种语义，persona 里写死的多阶段流程
   * 在运行时没有对应机制。下面三项让阶段编排成为可选能力，并给递归派遣设闸门。
   */
  /** 一次派遣最多同时开多少个子会话（兜底闸门；与实际选中的成员数取小）。 */
  maxChildrenPerSummon: 13,
  /** 允许多少层子代理嵌套：1 = 专家不能再往下派（默认）；2 = 允许专家再派一层。 */
  maxDelegateDepth: 1,
  /** 阶段序号取值范围 1..maxStages（团队 `stages` 声明里的 `stage` 上界）。 */
  maxStages: 9,
  /** 阶段名（如「初步调研」「多空辩论」）长度上限。 */
  maxStageName: 16,
}
const VERSION = '0.2.4'

/* ------------------------------------------------------------------ *
 *  基础设施：路径、读写、校验
 * ------------------------------------------------------------------ */

/** DSH 主目录：优先 $DSH_HOME，回落 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

const USER_DIR = path.join(dshHome(), 'expert-teams')
const USER_FILE = path.join(USER_DIR, 'teams.json')
const CONFIG_FILE = path.join(USER_DIR, 'config.json')
const STATS_FILE = path.join(USER_DIR, 'stats.json')

/** 读 JSON，任何失败都返回 fallback（永不抛）。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免留下半截文件。 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 读取 `$DSH_HOME/expert-teams/config.json`。**每次调用都重新读盘** ——
 * 所以改完配置刷新面板即生效，不需要重启 dsh web（开发阶段就是要这个手感）。
 *
 * 两项语义：
 * - `lockBuiltinTeams`：`true` = 内置团队只读（定稿后的形态）；缺省 / `false` =
 *   内置团队与自定义团队一样可编辑、成员可改、头像可换。写内置 id 的落地方式
 *   是在用户目录里落一份同 id 副本覆盖它（见 TeamRepository.all）。
 * - `limits`：覆盖 DEFAULT_LIMITS 里的任意一项；非法值（非正整数）一律回落到默认值。
 */
function readConfig() {
  const doc = readJson(CONFIG_FILE, null)
  const raw = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  const source = raw.limits !== null && typeof raw.limits === 'object' && !Array.isArray(raw.limits)
    ? raw.limits
    : {}
  const limits = {}
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const parsed = Number.parseInt(String(source[key] ?? ''), 10)
    /* 只收正整数：0 / 负数 / 天文数字都回落到默认值，避免手滑把插件卡死。 */
    limits[key] = Number.isInteger(parsed) && parsed > 0 && parsed <= 1000000 ? parsed : fallback
  }
  return { lockBuiltinTeams: raw.lockBuiltinTeams === true, limits }
}

/**
 * 首次运行时把**默认配置**落到盘上，让用户有一份可以直接改的模板。
 * 已经存在就一个字都不动（用户改过的配置是真相）。
 */
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return
  try {
    writeJsonAtomic(CONFIG_FILE, {
      schemaVersion: 1,
      _note: '开发阶段：lockBuiltinTeams=false 时内置团队可编辑、成员可改；定稿后改成 true 即锁定为只读。limits 覆盖各项上限，删掉某项即用默认值。',
      lockBuiltinTeams: false,
      limits: DEFAULT_LIMITS,
    })
  } catch {
    /* 写不进去也不影响主流程，readConfig 会回落到默认值。 */
  }
}

const KEBAB = /^[a-z0-9][a-z0-9-]{0,39}$/
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** 去掉控制字符、trim、按上限截断；空串返回 undefined。 */
function clean(value, max) {
  if (typeof value !== 'string') return undefined
  const stripped = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (stripped === '') return undefined
  return stripped.length > max ? stripped.slice(0, max) : stripped
}

/** 校验并规范化用户提交的团队。不合法返回 `{ error }`。limits 来自 readConfig。 */
function normalizeTeam(input, limits = DEFAULT_LIMITS) {
  if (input === null || typeof input !== 'object') return { error: 'team 必须是一个对象' }
  const id = clean(input.id, 40)
  if (id === undefined || !KEBAB.test(id)) {
    return { error: 'id 必须是小写字母/数字/连字符，1–40 位，且以字母或数字开头' }
  }
  const teamName = clean(input.name, limits.maxTeamName)
  if (teamName === undefined) return { error: 'name 不能为空（≤40 字）' }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    return { error: 'members 至少需要 1 位专家' }
  }
  if (input.members.length > limits.maxMembers) return { error: `members 最多 ${limits.maxMembers} 位` }

  const members = []
  const seen = new Set()
  let leadCount = 0
  for (const raw of input.members) {
    if (raw === null || typeof raw !== 'object') return { error: 'member 必须是对象' }
    const memberId = clean(raw.id, 40)
    if (memberId === undefined || !KEBAB.test(memberId)) {
      return { error: `成员 id「${String(raw.id)}」不合法（需小写 kebab-case）` }
    }
    if (seen.has(memberId)) return { error: `成员 id 重复：${memberId}` }
    seen.add(memberId)

    const memberName = clean(raw.name, limits.maxMemberName)
    if (memberName === undefined) return { error: `成员 ${memberId} 缺少 name` }
    const persona = clean(raw.persona, limits.maxPersona)
    if (persona === undefined) return { error: `成员 ${memberId} 缺少 persona` }

    const alias = clean(raw.alias, limits.maxMemberAlias)
    const emoji = clean(raw.emoji, 8)
    const avatar = cleanAvatar(raw.avatar)
    const focus = clean(raw.focus, limits.maxMemberFocus)
    const role = raw.role === 'lead' ? 'lead' : 'member'
    if (role === 'lead') leadCount += 1

    members.push({
      id: memberId,
      name: memberName,
      role,
      persona,
      ...alias === undefined ? {} : { alias },
      ...emoji === undefined ? {} : { emoji },
      ...avatar === undefined ? {} : { avatar },
      ...focus === undefined ? {} : { focus },
    })
  }
  if (leadCount > 1) return { error: '只能有 1 位主理人（role: "lead"）' }

  /*
   * 阶段计划（可选，团队级）：声明了就是「可分批派遣」的团队。
   *
   * 为什么放在团队级而不是成员级：同一位专家可能横跨多个阶段（例如深度研究团队的
   * 课题研究员既做 Phase 1 初步调研、又做 Phase 3 逐章起草），成员级单值 stage 表达不了。
   * 这里对数据的硬约束只有三条 —— 阶段序号唯一、引用的成员必须存在、**必须覆盖全部成员**
   * （否则那位专家会永远派不出去，且是静默失败）。
   */
  const stages = []
  if (Array.isArray(input.stages) && input.stages.length > 0) {
    const memberIds = members.map(member => member.id)
    const known = new Set(memberIds)
    const seenStage = new Set()
    const covered = new Set()
    for (const raw of input.stages.slice(0, limits.maxStages)) {
      if (raw === null || typeof raw !== 'object') return { error: 'stages 的每一项必须是对象' }
      const stageNo = cleanStage(raw.stage, limits.maxStages)
      if (stageNo === undefined) return { error: `阶段序号必须是 1–${limits.maxStages} 的整数` }
      if (seenStage.has(stageNo)) return { error: `阶段序号重复：${stageNo}` }
      seenStage.add(stageNo)

      const picked = []
      const seenLocal = new Set()
      for (const id of Array.isArray(raw.members) ? raw.members.map(String) : []) {
        if (!known.has(id)) return { error: `阶段 ${stageNo} 引用了不存在的成员：${id}` }
        if (seenLocal.has(id)) continue
        seenLocal.add(id)
        picked.push(id)
        covered.add(id)
      }
      if (picked.length === 0) return { error: `阶段 ${stageNo} 没有指定任何成员` }

      const stageName = clean(raw.name, limits.maxStageName)
      stages.push({
        stage: stageNo,
        members: picked,
        ...stageName === undefined ? {} : { name: stageName },
      })
    }
    stages.sort((a, b) => a.stage - b.stage)
    /* 序号必须从 1 连续递增：这样「阶段序号」与「第几个阶段」永远是同一个数，
       面板、prompt 与 guidance 里就不会出现两套编号。 */
    for (let index = 0; index < stages.length; index++) {
      if (stages[index].stage !== index + 1) {
        return { error: '阶段序号必须从 1 开始且连续（1、2、3…）' }
      }
    }
    const missing = memberIds.filter(id => !covered.has(id))
    if (missing.length > 0) {
      return { error: `这些成员没有被任何阶段引用：${missing.join('、')}（声明了 stages 就必须覆盖全部成员）` }
    }
  }

  const presets = []
  if (Array.isArray(input.presets)) {
    for (const item of input.presets.slice(0, limits.maxPresets)) {
      const text = clean(item, limits.maxPresetText)
      if (text !== undefined) presets.push(text)
    }
  }

  const cases = []
  if (Array.isArray(input.cases)) {
    for (const raw of input.cases.slice(0, limits.maxCases)) {
      if (raw === null || typeof raw !== 'object') continue
      const title = clean(raw.title, limits.maxCaseTitle)
      if (title === undefined) continue
      const desc = clean(raw.desc, limits.maxCaseDesc)
      const emoji = clean(raw.emoji, 8)
      /*
       * 使用案例的两个正文型字段（白名单式 normalize 必须显式收下，
       * 否则保存/重载后会被静默丢掉 —— 和 category / tags 当年同一个坑）：
       * - delivery：点开案例后弹窗里展示的「交付结果」长文；
       * - prompt：「做同款」填进输入框的提示词（缺省时前端按标题/描述派生）。
       */
      const delivery = clean(raw.delivery, limits.maxCaseDelivery)
      const prompt = clean(raw.prompt, limits.maxCasePrompt)
      cases.push({
        title,
        ...desc === undefined ? {} : { desc },
        ...emoji === undefined ? {} : { emoji },
        ...delivery === undefined ? {} : { delivery },
        ...prompt === undefined ? {} : { prompt },
      })
    }
  }

  /*
   * 画廊卡片骨架四项（对齐参考版式）：
   * category → 分类筛选行；tags → 卡片底部 chip；createdAt → 「最新」排序。
   * publisher 不在这里收 —— 它由 publicView 按来源派生，用户改不了、也不会说谎。
   */
  const tags = []
  if (Array.isArray(input.tags)) {
    for (const item of input.tags.slice(0, limits.maxTags)) {
      const label = clean(item, limits.maxTagLabel)
      if (label !== undefined && !tags.includes(label)) tags.push(label)
    }
  }
  const category = clean(input.category, limits.maxCategory)
  /*
   * createdAt 必须在这里「透传」：reload() 会把用户文件里的每支团队重新走一遍
   * normalizeTeam，没被写回返回对象的字段会被静默丢掉 —— 丢了它就再也排不出「最新」。
   */
  const createdAt = clean(input.createdAt, 40)

  const tagline = clean(input.tagline, limits.maxTagline)
  const emoji = clean(input.emoji, 8)
  const avatar = cleanAvatar(input.avatar)
  return {
    team: {
      id,
      name: teamName,
      accent: HEX_COLOR.test(String(input.accent ?? '')) ? input.accent : '#4F46E5',
      presets,
      cases,
      members,
      ...stages.length === 0 ? {} : { stages },
      ...tagline === undefined ? {} : { tagline },
      ...emoji === undefined ? {} : { emoji },
      ...avatar === undefined ? {} : { avatar },
      ...category === undefined ? {} : { category },
      ...tags.length === 0 ? {} : { tags },
      ...createdAt === undefined ? {} : { createdAt },
    },
  }
}

/**
 * 团队 → 下发给浏览器的视图。
 * 含 `persona`：面板内「编辑团队」需要回填人格提示词，而 teams.json 本来就躺在
 * 用户自己机器的 `$DSH_HOME/expert-teams/` 下，下发给同源的浏览器不构成额外暴露。
 */
function publicView(team, usage) {
  const plan = stagePlan(team)
  return {
    id: team.id,
    name: team.name,
    tagline: team.tagline ?? '',
    emoji: team.emoji ?? '👥',
    /** 头像索引；null 表示「没显式挑过」，由前端按团队 id 稳定派生一张。 */
    avatar: cleanAvatar(team.avatar) ?? null,
    accent: team.accent ?? '#4F46E5',
    source: team.source ?? 'builtin',
    /** 卡片名称下方那一行（参考版式里是发布方）。派生而不是收字段，避免出现假来源。 */
    publisher: team.source === 'custom' ? '我的团队' : 'DSH 官方团队',
    category: team.category ?? '',
    tags: Array.isArray(team.tags) ? team.tags : [],
    createdAt: team.createdAt ?? '',
    usageCount: (team.usageCount ?? 0) + (usage[team.id] ?? 0),
    presets: team.presets ?? [],
    cases: team.cases ?? [],
    members: (team.members ?? []).map(member => ({
      id: member.id,
      name: member.name,
      alias: member.alias ?? '',
      role: member.role === 'lead' ? 'lead' : 'member',
      emoji: member.emoji ?? '🙂',
      /** 头像索引；null 表示没显式挑过，由前端按成员 id 稳定派生。 */
      avatar: cleanAvatar(member.avatar) ?? null,
      focus: member.focus ?? '',
      /** 该成员参与哪些阶段；[] = 不参与阶段编排（整团一次性并行派遣）。 */
      stages: stagesOf(member.id, plan),
      persona: member.persona ?? '',
    })),
    /**
     * 阶段计划；空数组 = 这支团队没有阶段概念（面板据此隐藏「分批派遣」）。
     * 只下发阶段序号 / 名字 / 成员 id，不下发 persona。
     */
    stages: plan.staged
      ? plan.stages.map(item => ({ stage: item.stage, name: item.name, members: item.ids }))
      : [],
  }
}

/* ------------------------------------------------------------------ *
 *  团队仓库
 * ------------------------------------------------------------------ */

/** 内置团队 + 用户自定义团队。同 id 时用户定义覆盖内置。 */
class TeamRepository {
  constructor() {
    this.builtin = []
    this.custom = []
    this.usage = {}
    this.reload()
  }

  reload() {
    const builtinDoc = readJson(BUILTIN_FILE, { teams: [] })
    this.builtin = Array.isArray(builtinDoc?.teams) ? builtinDoc.teams : []

    const customDoc = readJson(USER_FILE, { teams: [] })
    const rawCustom = Array.isArray(customDoc) ? customDoc : (customDoc?.teams ?? [])
    /* 上限跟着 config.json 走：readConfig 每次读盘，所以改配置后重载即生效。 */
    const { limits } = readConfig()
    this.custom = []
    for (const raw of Array.isArray(rawCustom) ? rawCustom : []) {
      const { team } = normalizeTeam(raw, limits)
      if (team !== undefined) this.custom.push({ ...team, source: 'custom' })
    }

    this.usage = readJson(STATS_FILE, {}) ?? {}
  }

  all() {
    const byId = new Map()
    for (const team of this.builtin) byId.set(team.id, { ...team, source: 'builtin' })
    for (const team of this.custom) byId.set(team.id, team)
    return [...byId.values()]
  }

  get(id) {
    return this.all().find(team => team.id === id)
  }

  /**
   * 该 id 是否来自内置基线（`data/teams.json`）。
   * 锁定模式（config.lockBuiltinTeams=true）下，命中它的写入会被拒绝 ——
   * 开发阶段这条分支不会触发，放开后内置团队就是普通的可编辑团队。
   */
  isBuiltin(id) {
    return this.builtin.some(team => team.id === id)
  }

  list() {
    return this.all().map(team => publicView(team, this.usage))
  }

  view(id) {
    const team = this.get(id)
    return team === undefined ? undefined : publicView(team, this.usage)
  }

  upsert(team) {
    /*
     * 新建时盖一次 createdAt；编辑已有团队（改 tagline / 成员之类）不覆盖时间戳，
     * 否则「最新」排序会被编辑行为刷乱 —— 排序该反映创建顺序，不是最后修改顺序。
     */
    const previous = this.custom.find(item => item.id === team.id)
    const createdAt = team.createdAt ?? previous?.createdAt ?? new Date().toISOString()
    this.custom = [
      ...this.custom.filter(item => item.id !== team.id),
      { ...team, source: 'custom', createdAt },
    ]
    writeJsonAtomic(USER_FILE, { schemaVersion: 1, teams: this.custom })
  }

  /** 删除一个自定义团队；内置团队删不掉（会重新出现）。 */
  remove(id) {
    const before = this.custom.length
    this.custom = this.custom.filter(item => item.id !== id)
    writeJsonAtomic(USER_FILE, { schemaVersion: 1, teams: this.custom })
    return this.custom.length < before
  }

  bumpUsage(id) {
    this.usage[id] = (this.usage[id] ?? 0) + 1
    try {
      writeJsonAtomic(STATS_FILE, this.usage)
    } catch {
      /* 统计失败不影响主流程 */
    }
  }
}

/* ------------------------------------------------------------------ *
 *  派发台账
 * ------------------------------------------------------------------ */

/** 记录「哪个团队被派发过、派给了哪些专家」，供面板与 status 接口展示。 */
class DispatchLedger {
  constructor() {
    this.byTeam = new Map()
  }

  record(teamId, task, result) {
    const list = this.byTeam.get(teamId) ?? []
    list.unshift({
      teamId,
      task: task.length > 200 ? `${task.slice(0, 200)}…` : task,
      /** 本次派遣的阶段；null = 一次性整团并行。 */
      stage: result.stage ?? null,
      stageCount: result.plan?.stageCount ?? 1,
      provider: result.provider,
      personaNative: result.personaNative,
      skipped: result.skipped,
      members: result.dispatched,
      at: new Date().toISOString(),
    })
    this.byTeam.set(teamId, list.slice(0, 20))
  }

  list(teamId) {
    if (teamId !== undefined) return this.byTeam.get(teamId) ?? []
    return [...this.byTeam.values()]
      .flat()
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 40)
  }
}

/* ------------------------------------------------------------------ *
 *  召唤
 * ------------------------------------------------------------------ */

/** 从宿主侧 Agent 上容错取出 sessionId（宿主侧字段名是 `session.id`，不是 `sessionId`）。 */
function sessionIdOf(agent) {
  const session = agent?.session
  return session?.id ?? session?.sessionId ?? agent?.id
}

/**
 * 按 sessionId 反查 Agent。
 * `agents.get(id)` 的入参就是「共享的 agent/session id」（见 agent 注册表定义），
 * 优先走它；不可用时再退回遍历 `list()` 逐条比对。
 */
function findAgent(agents, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
  try {
    if (typeof agents.get === 'function') {
      const direct = agents.get(sessionId)
      if (direct !== undefined && direct !== null) return direct
    }
  } catch {
    /* get 不可用则退回遍历 */
  }
  if (typeof agents.list !== 'function') return undefined
  for (const agent of agents.list()) {
    if (String(sessionIdOf(agent)) === String(sessionId)) return agent
  }
  return undefined
}

/** 挑一个支持 continuable 子会话的 provider（方法存在即能力）。 */
function pickProvider(subagents) {
  if (subagents === undefined) return undefined
  let names = []
  try {
    names = subagents.list()
  } catch {
    return undefined
  }
  const preferred = ['spawn', 'fork', 'default', 'in-process']
  const ordered = [...preferred.filter(n => names.includes(n)), ...names.filter(n => !preferred.includes(n))]
  for (const candidate of ordered) {
    let provider
    try {
      provider = subagents.getProvider(candidate)
    } catch {
      provider = undefined
    }
    if (provider !== undefined && typeof provider.prepareContinuable === 'function') {
      return { name: candidate, capabilities: provider.capabilities ?? {} }
    }
  }
  return undefined
}

/** 注入给下游的上游产出上限（字符）。超出部分截断并显式标注。 */
const CONTEXT_LIMIT = 20000

/**
 * 团队 → 阶段计划。
 *
 * - 团队声明了 `stages`：按声明分桶。同一位成员可以同时出现在多个阶段
 *   （深度研究团队的课题研究员既做初步调研、又做逐章起草）。
 * - 没声明（字段缺失 / 为空）：整团视作**单个阶段** → `staged: false`。这时派遣
 *   与旧行为一个字节都不差：一次性并行下发、所有人拿到同一份任务、prompt 里
 *   不出现任何「第几个阶段」的措辞。
 */
function stagePlan(team) {
  const members = Array.isArray(team.members) ? team.members : []
  const whole = () => ({
    staged: false,
    stageCount: 1,
    stages: [{ stage: 1, name: '', members, ids: members.map(member => member.id) }],
  })
  const declared = Array.isArray(team.stages) ? team.stages : []
  if (declared.length === 0) return whole()

  const byId = new Map(members.map(member => [member.id, member]))
  const stages = declared
    .map(item => {
      const roster = (Array.isArray(item.members) ? item.members : [])
        .map(id => byId.get(id))
        .filter(member => member !== undefined)
      return {
        stage: item.stage,
        name: item.name ?? '',
        members: roster,
        ids: roster.map(member => member.id),
      }
    })
    .filter(item => item.members.length > 0)
    .sort((a, b) => a.stage - b.stage)
  if (stages.length === 0) return whole()
  return { staged: stages.length > 1, stageCount: stages.length, stages }
}

/** 某位成员出现在哪些阶段；无阶段团队返回 []（表示「不参与阶段编排」）。 */
function stagesOf(memberId, plan) {
  if (!plan.staged) return []
  return plan.stages.filter(item => item.ids.includes(memberId)).map(item => item.stage)
}

/** 组装某位专家的开局指令。persona 走不了原生通道时并入 prompt。 */
function buildMemberPrompt(team, member, task, personaInline, options = {}) {
  const parts = []
  const alias = member.alias !== undefined && member.alias !== '' ? `（${member.alias}）` : ''
  parts.push(`【${team.name} · 专家团任务】你是本次任务中的一位专家：${member.name}${alias}。`)
  if (personaInline) {
    parts.push('', '—— 你的角色设定 ——', String(member.persona ?? ''))
  } else if (member.focus !== undefined && member.focus !== '') {
    parts.push('', `—— 你的职责范围 ——`, member.focus)
  }

  /*
   * 分批派遣才写「流程位置」段：它告诉这位专家上游是谁、下游是谁，
   * 从而让他自己守住边界（上游的活不重做、下游的活不代笔）。
   * 无阶段团队不写这一段 —— 旧行为一个字都不变。
   */
  const stage = options.stage
  const stageCount = Number.isInteger(options.stageCount) ? options.stageCount : 0
  /* 「是否分批派遣」只判定一次并命名：下面三处（写流程位置、补第 6 条、编排第 7 条）用的是同一个条件。 */
  const staged = Number.isInteger(stage) && stageCount > 1
  if (staged) {
    parts.push(
      '',
      '—— 你在流程中的位置 ——',
      `本次是**第 ${stage} / ${stageCount} 阶段**的分批派遣：你只做本阶段的事。`,
    )
    const upstream = Array.isArray(options.upstream) ? options.upstream.filter(Boolean) : []
    const downstream = Array.isArray(options.downstream) ? options.downstream.filter(Boolean) : []
    if (upstream.length > 0) {
      parts.push(`· 你的输入来自上游成员（${upstream.join('、')}）；若上游产出已随本指令给出，以它为准，不要重新造一遍。`)
    } else {
      parts.push('· 你是本流程的起点，没有上游产出可依赖；缺信息就写明假设。')
    }
    if (downstream.length > 0) {
      parts.push(`· 你的产出会被原文交给下游成员（${downstream.join('、')}），请写成对方能直接接着做的形式。`)
    } else {
      parts.push('· 你是本流程的最后一环，最终交付物由你所在阶段收口。')
    }
  }

  const context = typeof options.context === 'string' ? options.context.trim() : ''
  if (context !== '') {
    const clipped = context.length > CONTEXT_LIMIT
      ? `${context.slice(0, CONTEXT_LIMIT)}\n\n（上游产出过长，已在此截断）`
      : context
    parts.push('', '—— 上游产出（本阶段的输入）——', clipped)
  }

  parts.push('', '—— 本次任务 ——', task)
  parts.push(
    '',
    '—— 工作要求 ——',
    '1. 只从你本角色的视角切入，不要越界包办其他专家的职责。',
    '2. 直接给出可用的产出，不要只列提纲、也不要反问索取更多信息；缺信息就写出你的假设。',
    '3. 结论先行、依据在后；不确定处显式标注「不确定」。',
    '4. 不编造数据与文献。',
    '5. 收尾时把成果整理成一段可直接被召集人拼接进终稿的交付内容。',
  )
  if (staged) {
    parts.push('6. 分批派遣：你的产出会被原文交给下游，请自包含，不要用「见上文」这类指代。')
  }
  /* 防嵌套召唤的软约束（宿主不支持对专家团工具做硬 deny，见 summonTeam 注释）。 */
  if (options.noNestedSummon === true) {
    const ruleNo = staged ? 7 : 6
    parts.push(`${ruleNo}. 不要再召唤其他专家团、也不要再派遣下属子代理：这次任务由你本人直接完成。`)
  }
  return parts.join('\n')
}

/**
 * 把多位成员的失败原因压成一行人话。
 *
 * 面板会把这段文本原样写进会话草稿，而宿主返回的原始报错可能非常长
 * （例如 `tools.restrict()` 的报错会把整张全局工具表列一遍）。所以这里：
 * 同一原因的成员合并成一条，每条原因截断到 160 字。
 */
function summarizeFailures(skipped) {
  const groups = new Map()
  for (const item of skipped) {
    const sample = String(item?.reason ?? '').replace(/\s+/gu, ' ').trim()
    const key = sample.slice(0, 160)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, { names: [item.name], sample })
    else bucket.names.push(item.name)
  }
  return [...groups.values()].map(group => {
    const heads = group.names.slice(0, 4).join('、')
    const who = group.names.length > 4 ? `${heads} 等 ${group.names.length} 位` : heads
    const detail = group.sample === ''
      ? '（宿主未给出错误信息）'
      : `${group.sample.length > 160 ? `${group.sample.slice(0, 160)}…` : group.sample}`
    return `${who}：${detail}`
  }).join('；')
}

/**
 * 把一支专家团派进独立子会话。
 *
 * 两种语义，由 `options.stage` 决定：
 * - **未指定 stage**：一次性派遣（旧的、也是无阶段团队的唯一语义）——
 *   所有选中成员收到同一份任务，并行开工。
 * - **指定 stage**：分批派遣 —— 只派该阶段的成员，并把他们上游的产出
 *   （`options.context`）随指令一起下发，让「上一阶段的产出」真的成为「下一阶段的输入」。
 *
 * 护栏（`options.blockNestedSummon !== false` 时生效）：给子会话传 `maxDepth`
 * （默认 1 层，专家不能再往下派子代理）并在只允许 1 层时额外 deny 掉专家团工具。
 * provider 若不声明对应 capability，则如实降级并记进 `guard.degraded`，绝不假装已生效。
 *
 * @returns {Promise<object>} dispatched / skipped / provider / personaNative / stage / guard
 */
async function summonTeam(subagents, parentAgent, team, task, memberIds, signal, options = {}) {
  // 契约兜底：`spec.signal` 在 DSH 侧是必填（`startContinuable` 会直接调用
  // `signal.throwIfAborted()`），漏传会以 TypeError 的形式炸掉整次派遣。
  // 所以这里绝不把 undefined 透传下去 —— 调用方漏传时退化为「不可取消」。
  const effectiveSignal = signal ?? new AbortController().signal
  const picked = pickProvider(subagents)
  if (picked === undefined) {
    const error = new Error('DSH 当前没有注册任何支持 continuable 子会话的 subagent provider')
    error.code = 'NO_PROVIDER'
    error.status = 503
    throw error
  }
  const capabilities = picked.capabilities ?? {}
  const personaNative = capabilities.persona === true
  const { limits } = readConfig()

  const plan = stagePlan(team)
  const stage = Number.isInteger(options.stage) && options.stage >= 1 ? options.stage : undefined
  const stageBucket = stage === undefined ? undefined : plan.stages.find(item => item.stage === stage)
  if (stage !== undefined && stageBucket === undefined) {
    const error = new Error(`本团没有第 ${stage} 阶段（共 ${plan.stageCount} 个阶段）`)
    error.code = 'NO_STAGE'
    /* HTTP 层按 status 回状态码：调用方传了不存在的阶段，是 400 而不是 500。 */
    error.status = 400
    throw error
  }

  const selected = Array.isArray(memberIds) && memberIds.length > 0
    ? team.members.filter(member => memberIds.includes(member.id))
    : team.members
  let wanted = stageBucket === undefined
    ? selected
    : selected.filter(member => stageBucket.ids.includes(member.id))
  if (wanted.length === 0) {
    const error = new Error(stage === undefined ? '没有选中任何专家' : `第 ${stage} 阶段没有选中任何专家`)
    error.code = 'NO_MEMBER'
    error.status = 400
    throw error
  }

  /* 兜底闸门：一次派遣最多开多少个子会话（与成员数上限取小）。 */
  const cap = Math.max(1, Math.min(limits.maxChildrenPerSummon, limits.maxMembers))
  const overflow = wanted.length > cap ? wanted.slice(cap).map(member => member.name) : []
  if (overflow.length > 0) wanted = wanted.slice(0, cap)

  /* 上游 / 下游成员名：写进 prompt，让每位专家自己守住边界。 */
  const upstreamNames = stage === undefined ? [] : plan.stages
    .filter(item => item.stage < stage)
    .flatMap(item => item.members.map(member => member.name))
  const downstreamNames = stage === undefined ? [] : plan.stages
    .filter(item => item.stage > stage)
    .flatMap(item => item.members.map(member => member.name))
  const context = typeof options.context === 'string' ? options.context : undefined

  /*
   * 护栏：只做本机能兑现的事。
   * - 深度上限靠 provider 的 `depthLimit` 能力（下传 `maxDepth`）。
   * - 「禁止专家再召集团」**不做硬 deny**：宿主 `tools.restrict()` 只认全局或祖先作用域
   *   提供的工具名，而本插件的 expert_team_list / expert_team_summon 是用
   *   `agent.ctx.tools.register` 注册在**每个 agent 自己的作用域**里的。一旦把它们写进
   *   `toolFilter`，宿主会在子作用域里解析不到并直接抛 `unknown global tools`，
   *   整批派遣全部失败（v0.2.2 实测，也是「对话框里出现一大段英文」的根源）。
   *   因此改为写进 prompt 的软约束，并在 guard 里如实标注。
   */
  const blockNested = options.blockNestedSummon !== false
  const depthCap = Number.isInteger(limits.maxDelegateDepth) && limits.maxDelegateDepth >= 1
    ? limits.maxDelegateDepth
    : 1
  const guard = { depthLimited: false, toolsDenied: false, depthCap, nestedSoftOnly: false, degraded: [] }
  if (blockNested) {
    if (capabilities.depthLimit === true) guard.depthLimited = true
    else guard.degraded.push('depthLimit')
    if (depthCap <= 1) guard.nestedSoftOnly = true
  }

  const dispatched = []
  const skipped = []
  for (const member of wanted) {
    const childId = randomUUID()
    try {
      const started = await subagents.startContinuable({
        childId,
        provider: picked.name,
        label: stage === undefined ? `${team.name} · ${member.name}` : `${team.name} · P${stage} · ${member.name}`,
        request: {
          prompt: [{
            type: 'text',
            text: buildMemberPrompt(team, member, task, !personaNative, {
              stage,
              stageCount: plan.stageCount,
              upstream: upstreamNames,
              downstream: downstreamNames,
              context,
              noNestedSummon: guard.nestedSoftOnly,
            }),
          }],
          parent: parentAgent,
          ...personaNative && member.persona !== undefined && member.persona !== ''
            ? { persona: member.persona }
            : {},
          ...guard.depthLimited ? { maxDepth: depthCap } : {},
        },
        signal: effectiveSignal,
      })
      dispatched.push({
        memberId: member.id,
        name: member.name,
        alias: member.alias ?? '',
        /* 本次派遣所属阶段；0 = 一次性整团派遣。 */
        stage: stage ?? 0,
        childSessionId: started?.childId ?? childId,
        messageId: started?.messageId ?? null,
        dispatchedAt: new Date().toISOString(),
      })
    } catch (error) {
      skipped.push({ memberId: member.id, name: member.name, reason: String(error?.message ?? error) })
    }
  }
  if (dispatched.length === 0) {
    const error = new Error(`全部 ${skipped.length} 位专家派发失败：${summarizeFailures(skipped)}`)
    error.code = 'ALL_FAILED'
    error.status = 502
    throw error
  }
  return {
    dispatched,
    skipped,
    provider: picked.name,
    personaNative,
    stage: stage ?? null,
    plan,
    guard,
    overflow,
    contextChars: typeof context === 'string' ? context.length : 0,
  }
}

/* ------------------------------------------------------------------ *
 *  HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 成员头像。文件名只认 `NN.jpg`（两位序号），读盘失败一律 404。
 *
 * `no-cache` 而不是长缓存：本地读一张 4KB 的图开销可以忽略，
 * 而素材换代（重跑 build-avatars 或直接替换 assets/member-avatars）后能立刻生效，
 * 不会出现「换了图浏览器仍拿旧头像」这种查半天的怪现象。
 */
function sendAvatar(res, name) {
  if (!AVATAR_NAME.test(name)) return sendJson(res, 404, { ok: false, error: 'not found' })
  let buffer
  try {
    buffer = fs.readFileSync(path.join(AVATAR_DIR, name))
  } catch {
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': buffer.length,
    'cache-control': 'no-cache',
  })
  res.end(buffer)
}

/** 读取并解析 JSON body，超过 1MB 直接 413。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大（上限 1MB）')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.status = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function mountHttp(ctx, repo, ledger) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()
      // 头像在 API 前缀之外（`/expert-team/avatar/NN.jpg`），必须先于下面的 API 兜底判断。
      if (route.startsWith(AVATAR_PREFIX)) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendAvatar(res, route.slice(AVATAR_PREFIX.length))
      }
      if (!route.startsWith(API_PREFIX)) return sendJson(res, 404, { ok: false, error: 'not found' })
      const endpoint = route.slice(API_PREFIX.length)
      const agents = ctx.get('agents')
      const subagents = ctx.get('subagents')

      try {
        if (endpoint === 'health' && method === 'GET') {
          const picked = pickProvider(subagents)
          return sendJson(res, 200, {
            ok: true,
            plugin: name,
            version: VERSION,
            teams: repo.all().length,
            subagentProvider: picked?.name ?? null,
            personaNative: picked?.capabilities?.persona === true,
          })
        }

        if (endpoint === 'config' && method === 'GET') {
          return sendJson(res, 200, { ok: true, config: readConfig() })
        }

        if (endpoint === 'teams' && method === 'GET') {
          /*
           * config 随团队列表一起下发：前端据此决定「内置团队能不能编辑」、
           * 以及表单里各项上限的提示文案 —— 省掉一次额外往返。
           */
          return sendJson(res, 200, { ok: true, teams: repo.list(), config: readConfig() })
        }

        if (endpoint === 'teams' && method === 'POST') {
          const body = await readBody(req)
          const config = readConfig()
          const { team, error } = normalizeTeam(body?.team ?? body, config.limits)
          if (team === undefined) return sendJson(res, 400, { ok: false, error })
          if (config.lockBuiltinTeams && repo.isBuiltin(team.id)) {
            return sendJson(res, 403, {
              ok: false,
              error: '内置团队已锁定（config.json 的 lockBuiltinTeams=true）。'
                + '想改内置团队，请把该配置改回 false，或先把它「另存为」一支自定义团队。',
              code: 'LOCKED',
            })
          }
          repo.upsert(team)
          return sendJson(res, 200, { ok: true, team: repo.view(team.id) })
        }

        if (endpoint.startsWith('teams/')) {
          const id = decodeURIComponent(endpoint.slice('teams/'.length))
          if (method === 'GET') {
            const team = repo.view(id)
            if (team === undefined) return sendJson(res, 404, { ok: false, error: '团队不存在' })
            return sendJson(res, 200, { ok: true, team })
          }
          if (method === 'DELETE') {
            if (repo.get(id) === undefined) return sendJson(res, 404, { ok: false, error: '团队不存在' })
            const removed = repo.remove(id)
            return sendJson(res, 200, { ok: true, removed, stillVisible: repo.get(id) !== undefined })
          }
        }

        if (endpoint === 'summon' && method === 'POST') {
          const body = await readBody(req)
          if (agents === undefined || subagents === undefined) {
            return sendJson(res, 503, {
              ok: false,
              error: 'DSH 未提供 agents/subagents 服务，无法派遣专家',
              code: 'NO_SERVICE',
            })
          }
          const team = repo.get(String(body?.teamId ?? ''))
          if (team === undefined) return sendJson(res, 404, { ok: false, error: '团队不存在' })
          const task = clean(body?.task, 4000)
          if (task === undefined) return sendJson(res, 400, { ok: false, error: 'task 不能为空' })
          /* 上游产出可以比 task 长得多：面板分批派遣时把上一阶段的产出整段带过来。 */
          const context = clean(body?.context, CONTEXT_LIMIT)
          const stage = Number.isInteger(body?.stage) && body.stage >= 1 ? Number(body.stage) : undefined
          const parent = findAgent(agents, body?.sessionId)
          if (parent === undefined) {
            return sendJson(res, 409, {
              ok: false,
              error: '找不到对应的会话（会话可能已关闭，请刷新页面后重试）',
              code: 'NO_PARENT',
            })
          }
          // DSH 的 `subagents.startContinuable` 契约里 `spec.signal` 是**必填**：
          // 它内部直接调用 `spec.signal.throwIfAborted()`，没有 undefined 保护，
          // 漏传会以 `Cannot read properties of undefined (reading 'throwIfAborted')`
          // 的形式炸掉每一位专家的派遣（整次召唤 500）。
          // HTTP 路径没有工具执行上下文可借用，所以用请求自身的生命周期造一个真实 Signal。
          const controller = new AbortController()
          const abortOnClose = () => controller.abort()
          res.on('close', abortOnClose)
          try {
            const result = await summonTeam(subagents, parent, team, task, body?.memberIds, controller.signal, {
              stage,
              context,
            })
            repo.bumpUsage(team.id)
            ledger.record(team.id, task, result)
            /*
             * 响应刻意**不下发** plan 里成员对象的 persona —— 面板只需要阶段名册，
             * 而这份响应会原样回给浏览器。persona 归 GET /teams 管。
             */
            return sendJson(res, 200, {
              ok: true,
              teamId: team.id,
              stage: result.stage,
              stageCount: result.plan.stageCount,
              plan: result.plan.stages.map(item => ({
                stage: item.stage,
                name: item.name,
                members: item.members.map(member => ({
                  id: member.id,
                  name: member.name,
                  alias: member.alias ?? '',
                })),
              })),
              provider: result.provider,
              personaNative: result.personaNative,
              dispatched: result.dispatched,
              skipped: result.skipped,
              guard: result.guard,
              overflow: result.overflow,
              contextChars: result.contextChars,
            })
          } finally {
            res.off('close', abortOnClose)
          }
        }

        if (endpoint === 'status' && method === 'GET') {
          const teamId = url.searchParams.get('teamId') ?? undefined
          return sendJson(res, 200, { ok: true, dispatches: ledger.list(teamId) })
        }

        return sendJson(res, 404, { ok: false, error: `未知接口：${method} ${route}` })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 500
        const message = String(error?.message ?? error)
        // 面板只拿到（可能被截断的）摘要，所以完整报错必须落到日志里 ——
        // 否则兜底文案里那句「完整报错见 DSH 日志」就是一句假话。
        ctx.logger?.warn?.(`expert-team: ${method} ${route} → ${status}：${message}`)
        return sendJson(res, status, {
          ok: false,
          error: message,
          code: error?.code ?? null,
        })
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 *  斜杠命令（返回结构必须是 {kind, text}）
 * ------------------------------------------------------------------ */

function registerCommands(commands, repo) {
  const roster = team => team.members
    .map(member => {
      const alias = member.alias !== undefined && member.alias !== '' ? `（${member.alias}）` : ''
      const role = member.role === 'lead' ? '主理人' : '成员'
      return `${member.role === 'lead' ? '★' : '·'} ${member.name}${alias}｜${role}｜${member.focus ?? ''}`
    })
    .join('\n')

  return commands.register({
    name: 'expert-team',
    description: '专家团：list 列出全部团队 / show <团队id> 看成员 / summon <团队id> 看派遣方式',
    /* 0.2.0 起命令可声明参数提示，斜杠命令面板会显示在名字后面。 */
    input: { hint: 'list | show <团队id> | summon <团队id>' },
    handler: ({ rawInput }) => {
      const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] ?? 'list').toLowerCase()

      if (sub === 'list') {
        const teams = repo.list()
        return {
          kind: 'success',
          text: `可用专家团（${teams.length} 支）：\n${teams
            .map(team => `· ${team.id} — ${team.name}（${team.members.length} 位专家）${team.tagline !== '' ? `｜${team.tagline}` : ''}`)
            .join('\n')}`,
        }
      }

      if (sub === 'show') {
        const team = repo.get(parts[1] ?? '')
        if (team === undefined) {
          return { kind: 'error', text: `找不到团队：${parts[1] ?? '(空)'}` }
        }
        return {
          kind: 'success',
          text: `【${team.name}】${team.tagline ?? ''}\n${roster(team)}`,
        }
      }

      if (sub === 'summon') {
        const team = repo.get(parts[1] ?? '')
        if (team === undefined) {
          return { kind: 'error', text: `找不到团队：${parts[1] ?? '(空)'}` }
        }
        return {
          kind: 'success',
          text: `团队「${team.name}」（id: ${team.id}，${team.members.length} 位专家）\n`
            + '请在「👥 专家团」面板里选中它并填写任务，面板会直接为每位专家开一个独立子会话；'
            + '（入口在空会话的「标准模式」右侧，发过消息后在输入框工具行左侧）'
            + '也可以让模型调用 expert_team_summon 工具完成派遣。',
        }
      }

      return { kind: 'error', text: '用法：/expert-team list | show <团队id> | summon <团队id>' }
    },
  })
}

/* ------------------------------------------------------------------ *
 *  模型可调用的工具（可选能力）
 * ------------------------------------------------------------------ */

/**
 * `ctx` 必须是 `ctx.inject(['agents', 'tools'], …)` 的作用域：
 * 两个服务由框架保证已 ACTIVE，因此不再需要 `ctx.get` + undefined 兜底。
 */
function registerTools(ctx, repo, ledger) {
  const agents = ctx.agents
  const tools = ctx.tools

  const asText = value => [{ type: 'text', text: JSON.stringify(value) }]
  const installed = new Map()

  /* 原生 JSON Schema（等价于 defineTool 对参数 DSL 的编译结果）。 */
  const outputOf = properties => ({
    schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    render: (_args, value) => asText(value),
  })

  const BASE_MEMBER_PROPS = { id: { type: 'string' }, name: { type: 'string' }, alias: { type: 'string' } }
  const itemSchema = extra => ({
    type: 'object',
    properties: { ...BASE_MEMBER_PROPS, ...extra },
    required: [...Object.keys(BASE_MEMBER_PROPS), ...Object.keys(extra)],
    additionalProperties: false,
  })
  /* 名册 / 派遣项都带阶段信息：`stages: []` 表示该成员不参与阶段编排。 */
  const ROSTER_MEMBER_SCHEMA = itemSchema({
    role: { type: 'string' },
    focus: { type: 'string' },
    stages: { type: 'array', items: { type: 'number' } },
  })
  const DISPATCHED_SCHEMA = itemSchema({
    childSessionId: { type: 'string' },
    dispatchedAt: { type: 'string' },
    stage: { type: 'number' },
  })
  const SKIPPED_SCHEMA = itemSchema({ reason: { type: 'string' } })
  const STAGE_PLAN_SCHEMA = {
    type: 'object',
    properties: {
      stage: { type: 'number' },
      stageCount: { type: 'number' },
      name: { type: 'string' },
      members: { type: 'array', items: { type: 'string' } },
    },
    required: ['stage', 'stageCount', 'name', 'members'],
    additionalProperties: false,
  }

  const install = agent => {
    const scoped = agent.ctx
    const disposers = []
    try {
      disposers.push(scoped.tools.register({
        name: 'expert_team_list',
        description: '列出本机可用的专家团：团队 id、名称、成员名册与各自职责范围。'
          + '召唤专家团前必须先调用它确认 team_id 与 member_ids。',
        parameters: { type: 'object', properties: {} },
        output: outputOf({
          teams: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                tagline: { type: 'string' },
                staged: { type: 'boolean' },
                stageCount: { type: 'number' },
                plan: { type: 'array', items: STAGE_PLAN_SCHEMA },
                members: { type: 'array', items: ROSTER_MEMBER_SCHEMA },
              },
              required: ['id', 'name', 'tagline', 'staged', 'stageCount', 'plan', 'members'],
              additionalProperties: false,
            },
          },
        }),
        execute() {
          return Promise.resolve({
            teams: repo.all().map(team => {
              const plan = stagePlan(team)
              return {
                id: team.id,
                name: team.name,
                tagline: team.tagline ?? '',
                staged: plan.staged,
                stageCount: plan.stageCount,
                plan: plan.stages.map(item => ({
                  stage: item.stage,
                  stageCount: plan.stageCount,
                  name: item.name,
                  members: item.members.map(member => member.name),
                })),
                members: (team.members ?? []).map(member => ({
                  id: member.id,
                  name: member.name,
                  alias: member.alias ?? '',
                  role: member.role === 'lead' ? 'lead' : 'member',
                  focus: member.focus ?? '',
                  /* 无阶段团队一律报空数组：别让模型以为它有流水线。 */
                  stages: stagesOf(member.id, plan),
                })),
              }
            }),
          })
        },
      }))

      disposers.push(scoped.tools.register({
        name: 'expert_team_summon',
        description: '召集一支专家团：为每位专家开一个独立的 DSH 子会话（continuable subagent），各自带着本角色的人格开工。'
          + '传 stage 时是「分批派遣」——只派该阶段的成员，并用 context 把上一阶段的产出作为本阶段的输入下发；'
          + '不传 stage 时整团一次性并行派出、所有人收到同一份任务。'
          + '调用之后你（召集人）必须等这些专家返回再推进（下一阶段或汇总），不要自己代劳他们的专业产出。',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string', description: 'expert_team_list 返回的团队 id。' },
            task: { type: 'string', description: '完整自包含的任务描述；同一次派遣的每位专家都收到同一份任务，但按各自角色分工。' },
            member_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '可选：只派遣这些成员 id，省略则派遣该阶段（或整团）的全部成员。',
            },
            stage: {
              type: 'number',
              description: '可选：只派遣该阶段的成员（从 1 开始）。用于分批派遣有阶段计划的团队；'
                + '省略则一次性派出全部选中成员（无阶段团队的默认行为）。',
            },
            context: {
              type: 'string',
              description: '可选：上一阶段专家的产出原文，会作为「上游产出」随指令下发给本阶段每位专家。'
                + '分批派遣时务必把上游结论原样传进来，不要自己压缩成摘要。',
            },
          },
          required: ['team_id', 'task'],
          additionalProperties: false,
        },
        output: outputOf({
          team: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
            required: ['id', 'name'],
            additionalProperties: false,
          },
          provider: { type: 'string' },
          personaNative: { type: 'boolean' },
          stage: { type: 'number' },
          stageCount: { type: 'number' },
          nextStage: { type: 'number' },
          plan: { type: 'array', items: STAGE_PLAN_SCHEMA },
          dispatched: { type: 'array', items: DISPATCHED_SCHEMA },
          skipped: { type: 'array', items: SKIPPED_SCHEMA },
          guardNote: { type: 'string' },
          guidance: { type: 'string' },
        }),
        async execute(args, exec) {
          const subagents = ctx.get('subagents')
          if (subagents === undefined) throw new Error('DSH 未提供 subagents 服务，无法派遣专家')
          const team = repo.get(String(args?.team_id ?? ''))
          if (team === undefined) throw new Error(`找不到专家团：${String(args?.team_id)}`)
          const task = String(args?.task ?? '')
          const memberIds = Array.isArray(args?.member_ids) ? args.member_ids.map(String) : undefined
          const stage = Number.isInteger(args?.stage) ? Number(args.stage) : undefined
          const context = typeof args?.context === 'string' ? args.context : undefined
          const result = await summonTeam(subagents, exec.agent, team, task, memberIds, exec.signal, {
            stage,
            context,
          })
          repo.bumpUsage(team.id)
          ledger.record(team.id, task, result)

          const plan = result.plan
          const planView = plan.stages.map(item => ({
            stage: item.stage,
            stageCount: plan.stageCount,
            name: item.name,
            members: item.members.map(member => member.name),
          }))
          const current = result.stage
          const currentIndex = current === null ? -1 : plan.stages.findIndex(item => item.stage === current)
          const nextStage = currentIndex >= 0 && currentIndex + 1 < plan.stages.length
            ? plan.stages[currentIndex + 1].stage
            : 0
          const guardNote = result.guard.degraded.length === 0
            ? `已给子会话设上限：最多再往下派 ${result.guard.depthCap} 层子代理`
              + `${result.guard.nestedSoftOnly ? '，并在专家提示词里要求它们不要自己召唤专家团（软约束，非硬性禁用）' : ''}。`
            : `本机 subagent provider 不支持 ${result.guard.degraded.join(' / ')}，子会话护栏未生效（专家理论上可再派子代理）。`

          let guidance
          if (current === null) {
            guidance = plan.staged
              ? `已一次性并行派出全部专家。注意：本团带 ${plan.stageCount} 阶段计划，一次性派出时所有人拿到的是同一份任务、`
                + '拿不到彼此产出；想跑真流水线，请改成分批派遣（先派 stage 1，收齐后用 context 派 stage 2）。'
              : '专家们已在独立子会话中并行开工。请等待他们返回结论后再汇总，'
                + '并明确标注哪部分由哪位专家贡献、冲突结论如何裁决。不要重复专家已完成的工作。'
          } else if (nextStage !== 0) {
            guidance = `第 ${current}/${plan.stageCount} 阶段的专家已开工。等这 ${result.dispatched.length} 位全部把结果发回来之后，`
              + `把他们的产出原文合并后作为 context，再调用一次 expert_team_summon（stage=${nextStage}, task=同一个任务, context=上游产出）`
              + `派第 ${nextStage} 阶段。不要在上一阶段没收齐前就往下派。`
          } else {
            guidance = `第 ${current}/${plan.stageCount} 阶段（最后一阶段）的专家已开工。等他们全部返回后，`
              + '把所有阶段的产出汇总成一份结构完整、观点一致的终稿，标注各部分贡献者并裁决冲突结论。'
          }
          if (result.overflow.length > 0) {
            guidance += ` 本次超出单次派遣上限，以下成员未派出，请再派一次：${result.overflow.join('、')}。`
          }

          return {
            team: { id: team.id, name: team.name },
            provider: result.provider,
            personaNative: result.personaNative,
            /* 无阶段派遣报 0，避免让模型以为它是「第 0 阶段」。 */
            stage: current ?? 0,
            stageCount: plan.stageCount,
            nextStage,
            plan: planView,
            dispatched: result.dispatched.map(item => ({
              id: item.memberId,
              name: item.name,
              alias: item.alias ?? '',
              childSessionId: item.childSessionId,
              dispatchedAt: item.dispatchedAt,
              stage: current === null ? 0 : item.stage,
            })),
            skipped: result.skipped.map(item => ({
              id: item.memberId,
              name: item.name,
              alias: team.members.find(member => member.id === item.memberId)?.alias ?? '',
              reason: item.reason,
            })),
            guardNote,
            guidance,
          }
        },
      }))

      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      ctx.logger?.warn?.(`expert-team: 安装专家团工具失败：${String(error?.message ?? error)}`)
      return undefined
    }
  }

  for (const agent of agents.list()) {
    const dispose = install(agent)
    if (dispose !== undefined) installed.set(agent, dispose)
  }
  ctx.on('agent/created', ({ agent }) => {
    const dispose = install(agent)
    if (dispose !== undefined) installed.set(agent, dispose)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  return () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }
}

/* ------------------------------------------------------------------ *
 *  插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  /* 首次运行落一份默认配置，让用户有一份可以直接改的模板（已存在则一个字都不动）。 */
  ensureConfigFile()
  const repo = new TeamRepository()
  const ledger = new DispatchLedger()

  ctx.effect(() => mountHttp(ctx, repo, ledger), 'expert-team:http()')

  /*
   * 可选能力按「服务可用性」装配，而不是在启动瞬间探一次：
   * ctx.inject 的 body 会在所需服务 ACTIVE 时执行、服务重启后自动重跑，
   * 作用域卸载时连带回收它内部注册的命令 / 工具。
   */
  ctx.inject(['commands'], scoped => {
    const dispose = registerCommands(scoped.commands, repo)
    scoped.effect(() => () => {
      if (typeof dispose === 'function') dispose()
    }, 'expert-team:commands()')
  })

  ctx.inject(['agents', 'tools'], scoped => {
    const disposeTools = registerTools(scoped, repo, ledger)
    if (disposeTools !== undefined) {
      scoped.effect(() => disposeTools, 'expert-team:tools()')
    }
  })

  const { lockBuiltinTeams } = readConfig()
  ctx.logger?.info?.(`expert-team: 已加载 ${repo.all().length} 支专家团`
    + `（内置团队：${lockBuiltinTeams ? '只读锁定' : '开发阶段可编辑'}；配置 ${CONFIG_FILE}）`)
}
