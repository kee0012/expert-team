/**
 * 把「外部专家团包草案」批量导入为内置团队（沉淀进插件的 `data/teams.json`）。
 *
 * 背景：`下载的专家团/` 下的 skillhub 专家团包（manifest.json + skillsets + skills）
 * 只有工作流与技能文档，没有 expert-team 需要的「成员 persona」。
 * 所以导入分两步：
 *   ① 由执笔环节（人或模型）按 `.tmp/import/SPEC.md` 的规范，把每个包写成一份
 *      **团队草案 JSON**（一个文件一支团队，落在 `.tmp/import/raw/<id>.json`）；
 *   ② 由本脚本做机械校验、补齐头像索引、合并进内置基线。
 * 这一步刻意做成脚本而不是手工编辑 JSON，理由与 promote-team.mjs 相同：
 * 内置数据是白名单，手改一次就可能混进未知字段或撞头像，而 gates 会拦在外面。
 *
 * 语义（与 promote-team.mjs 对齐）：
 *   - 同 id 已存在 → **覆盖内置基线并保持它在数组中的原位置**；
 *   - 新 id → 按草案文件名的字典序插到数组最前面（同时它们的 createdAt 最新，
 *     符合画廊「最新」排序直觉）；
 *   - 头像：团队头像从「未被占用的索引」里顺序分配（互不撞脸），
 *     成员头像按团队种子确定性分配并保证**队内唯一**（gates 的两条硬约束）；
 *   - 草案里出现白名单之外的字段 → 丢弃并打印告警（不写进基线）；
 *   - 结构性问题（缺 name / 缺成员 / persona 为空 / 超长 / stages 未覆盖全部成员）→
 *     全部列出来并**拒绝写盘**（一次改对，不留下半截基线）。
 *
 * 用法：
 *   node scripts/import-teams.mjs                  # 从 .tmp/import/raw 导入全部草案
 *   node scripts/import-teams.mjs --from <dir>     # 指定草案目录
 *   node scripts/import-teams.mjs --dry            # 只预览，不写盘
 *   node scripts/import-teams.mjs --only a,b       # 只导入指定 id
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILTIN_FILE = path.join(ROOT, 'data', 'teams.json')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const fromIndex = argv.indexOf('--from')
const FROM_DIR = fromIndex >= 0 && argv[fromIndex + 1] !== undefined
  ? path.resolve(ROOT, argv[fromIndex + 1])
  : path.join(ROOT, '.tmp', 'import', 'raw')
const onlyIndex = argv.indexOf('--only')
const onlyIds = onlyIndex >= 0 && argv[onlyIndex + 1] !== undefined
  ? argv[onlyIndex + 1].split(',').map(item => item.trim()).filter(Boolean)
  : null

const AVATAR_COUNT = 36
const KEBAB = /^[a-z0-9][a-z0-9-]{0,39}$/
const HEX = /^#[0-9a-fA-F]{6}$/

/* 与 src/index.js 的 DEFAULT_LIMITS 对齐（超长会被宿主的 normalizeTeam 截断，此处提前拦）。 */
const LIMITS = {
  name: 40,
  tagline: 90,
  category: 12,
  tag: 10,
  memberName: 30,
  alias: 20,
  focus: 40,
  persona: 4000,
  preset: 140,
  caseTitle: 40,
  caseDesc: 90,
  caseDelivery: 8000,
}

/*
 * 成员详情页（客户端）按这四个标记词切小节 —— 缺哪个，那个小节就并进上一段，
 * 整段退化成一大坨。所以这里报警告（不阻塞导入）；成员的 persona 建议按这四段来写。
 */
const PERSONA_MARKERS = [
  { label: '你的职责', pattern: /你的职责/ },
  { label: '你的工作方式是', pattern: /你的工作方式是/ },
  { label: '你的交付物', pattern: /你的交付物/ },
  { label: '你的纪律是', pattern: /你的纪律是/ },
]

const TEAM_KEYS = ['id', 'name', 'emoji', 'avatar', 'accent', 'category', 'tags', 'tagline', 'presets', 'cases', 'stages', 'members', 'createdAt']
const MEMBER_KEYS = ['id', 'name', 'alias', 'role', 'emoji', 'avatar', 'focus', 'persona']
const CASE_KEYS = ['emoji', 'title', 'desc', 'delivery', 'prompt']
const STAGE_KEYS = ['stage', 'name', 'members']

const warnings = []
const errors = []
const warn = message => warnings.push(message)
const fail = message => errors.push(message)

/* --- 读入内置基线与草案 ------------------------------------------------- */

if (!fs.existsSync(BUILTIN_FILE)) {
  console.error(`[import] 找不到内置团队库：${BUILTIN_FILE}`)
  process.exit(1)
}
const builtinDoc = JSON.parse(fs.readFileSync(BUILTIN_FILE, 'utf8'))
if (!Array.isArray(builtinDoc.teams)) {
  console.error('[import] 内置团队库结构异常：teams 不是数组')
  process.exit(1)
}

if (!fs.existsSync(FROM_DIR)) {
  console.error(`[import] 找不到草案目录：${FROM_DIR}`)
  process.exit(1)
}
const draftFiles = fs.readdirSync(FROM_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
if (draftFiles.length === 0) {
  console.error(`[import] 草案目录里没有 *.json：${FROM_DIR}`)
  process.exit(1)
}

const drafts = []
for (const file of draftFiles) {
  const full = path.join(FROM_DIR, file)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (error) {
    fail(`${file}: 不是合法 JSON —— ${String(error?.message ?? error)}`)
    continue
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${file}: 顶层必须是团队对象（不是数组）`)
    continue
  }
  const id = typeof parsed.id === 'string' ? parsed.id : path.basename(file, '.json')
  if (onlyIds !== null && !onlyIds.includes(id)) continue
  drafts.push({ file, id, team: parsed })
}

/* --- 逐支校验与规范化 --------------------------------------------------- */

const str = value => (typeof value === 'string' ? value.trim() : '')
const lengthIssues = (teamId, where, label, value, max, required = true) => {
  const text = str(value)
  if (text === '') {
    if (required) fail(`${teamId}/${where}: ${label} 不能为空`)
    return undefined
  }
  if ([...text].length > max) fail(`${teamId}/${where}: ${label} 超长（${[...text].length} > ${max}）`)
  return text
}

/*
 * 团队头像：先让内置占位，再给新团队顺序分配未被占用的索引。
 *
 * 关键细节（幂等性）：**本次会被覆盖的同 id 团队**，它的头像不能算「已被占用」——
 * 否则重跑一次导入，这支队就会从空闲池里另拿一张脸，头像每次重跑都抖一次。
 * 所以先从占用集合里排除它们，分配时优先复用原头像。
 */
const incomingIds = new Set(drafts.map(draft => draft.id))
const takenTeamAvatars = new Set(
  builtinDoc.teams
    .filter(team => !incomingIds.has(team.id))
    .map(team => team.avatar)
    .filter(value => Number.isInteger(value)),
)
const freeAvatars = []
for (let index = 0; index < AVATAR_COUNT; index++) {
  if (!takenTeamAvatars.has(index)) freeAvatars.push(index)
}

const normalized = []
for (const draft of drafts) {
  const raw = draft.team
  const teamId = str(raw.id)
  if (!KEBAB.test(teamId)) {
    fail(`${draft.file}: id「${teamId}」不合法（需小写 kebab-case，1–40 位）`)
    continue
  }

  for (const key of Object.keys(raw)) {
    if (!TEAM_KEYS.includes(key)) warn(`${teamId}: 丢弃团队级未知字段「${key}」`)
  }

  const name = lengthIssues(teamId, 'team', 'name', raw.name, LIMITS.name)
  const category = lengthIssues(teamId, 'team', 'category', raw.category, LIMITS.category)
  const tagline = lengthIssues(teamId, 'team', 'tagline', raw.tagline, LIMITS.tagline, false)

  const tags = []
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags.slice(0, 4)) {
      const text = lengthIssues(teamId, 'team', 'tag', tag, LIMITS.tag, false)
      if (text !== undefined && !tags.includes(text)) tags.push(text)
    }
  }
  if (tags.length === 0) fail(`${teamId}: tags 至少 1 个（最多 4 个）`)

  const presets = []
  for (const preset of Array.isArray(raw.presets) ? raw.presets.slice(0, 6) : []) {
    const text = lengthIssues(teamId, 'team', 'preset', preset, LIMITS.preset, false)
    if (text !== undefined) presets.push(text)
  }

  const cases = []
  for (const [index, item] of (Array.isArray(raw.cases) ? raw.cases : []).slice(0, 6).entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`${teamId}/cases[${index}]: 必须是对象`)
      continue
    }
    for (const key of Object.keys(item)) {
      if (!CASE_KEYS.includes(key)) warn(`${teamId}/cases[${index}]: 丢弃未知字段「${key}」`)
    }
    const title = lengthIssues(teamId, `cases[${index}]`, 'title', item.title, LIMITS.caseTitle)
    if (title === undefined) continue
    const desc = lengthIssues(teamId, `cases[${index}]`, 'desc', item.desc, LIMITS.caseDesc, false)
    const emoji = str(item.emoji)
    const delivery = lengthIssues(teamId, `cases[${index}]`, 'delivery', item.delivery, LIMITS.caseDelivery, false)
    const prompt = str(item.prompt)
    cases.push({
      title,
      ...desc === undefined ? {} : { desc },
      ...emoji === '' ? {} : { emoji },
      ...delivery === undefined ? {} : { delivery },
      ...prompt === '' ? {} : { prompt },
    })
  }

  const members = []
  const seenMemberIds = new Set()
  const memberAvatarUsed = new Set()
  const rawMembers = Array.isArray(raw.members) ? raw.members : []
  if (rawMembers.length === 0) fail(`${teamId}: members 至少 1 位`)
  if (rawMembers.length > 13) fail(`${teamId}: members 最多 13 位（当前 ${rawMembers.length}）`)
  let leadCount = 0

  for (const [index, item] of rawMembers.entries()) {
    const where = `members[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`${teamId}/${where}: 必须是对象`)
      continue
    }
    for (const key of Object.keys(item)) {
      if (!MEMBER_KEYS.includes(key)) warn(`${teamId}/${where}: 丢弃成员级未知字段「${key}」`)
    }
    const memberId = str(item.id)
    if (!KEBAB.test(memberId)) {
      fail(`${teamId}/${where}: 成员 id「${memberId}」不合法`)
      continue
    }
    if (seenMemberIds.has(memberId)) {
      fail(`${teamId}/${where}: 成员 id 重复「${memberId}」`)
      continue
    }
    seenMemberIds.add(memberId)

    const memberName = lengthIssues(teamId, memberId, 'name', item.name, LIMITS.memberName)
    const persona = lengthIssues(teamId, memberId, 'persona', item.persona, LIMITS.persona)
    if (memberName === undefined || persona === undefined) continue

    const missingMarkers = PERSONA_MARKERS
      .filter(marker => !marker.pattern.test(persona))
      .map(marker => marker.label)
    if (missingMarkers.length > 0) {
      warn(`${teamId}/${memberId}: persona 缺小节标记「${missingMarkers.join('、')}」`
        + '—— 成员详情会退化成整段文本（建议按「你的职责 / 你的工作方式是 / 你的交付物 / 你的纪律是」四段写 persona）')
    }

    const alias = lengthIssues(teamId, memberId, 'alias', item.alias, LIMITS.alias, false)
    const focus = lengthIssues(teamId, memberId, 'focus', item.focus, LIMITS.focus, false)
    const emoji = str(item.emoji)
    const role = item.role === 'lead' ? 'lead' : 'member'
    if (role === 'lead') leadCount += 1

    /* 成员头像：确定性分配、队内唯一（gates 的硬约束）。草案自带且未占用则尊重它。 */
    let avatar = Number.isInteger(item.avatar) && item.avatar >= 0 && item.avatar < AVATAR_COUNT
      ? item.avatar
      : undefined
    if (avatar !== undefined && memberAvatarUsed.has(avatar)) avatar = undefined
    if (avatar === undefined) {
      /* 起点按成员序号错开，冲突时线性探测；队内唯一由 memberAvatarUsed 保证。 */
      let candidate = (index * 5) % AVATAR_COUNT
      while (memberAvatarUsed.has(candidate)) candidate = (candidate + 1) % AVATAR_COUNT
      avatar = candidate
    }
    memberAvatarUsed.add(avatar)

    members.push({
      id: memberId,
      name: memberName,
      ...alias === undefined ? {} : { alias },
      ...emoji === '' ? {} : { emoji },
      role,
      avatar,
      ...focus === undefined ? {} : { focus },
      persona,
    })
  }
  if (leadCount > 1) fail(`${teamId}: 主理人多于 1 位（${leadCount}）`)

  /* 阶段计划：必须覆盖全部成员、序号从 1 连续。 */
  const stages = []
  const rawStages = Array.isArray(raw.stages) ? raw.stages : []
  if (rawStages.length > 0) {
    const known = new Set(members.map(member => member.id))
    const covered = new Set()
    const seenStages = new Set()
    for (const [index, item] of rawStages.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        fail(`${teamId}/stages[${index}]: 必须是对象`)
        continue
      }
      for (const key of Object.keys(item)) {
        if (!STAGE_KEYS.includes(key)) warn(`${teamId}/stages[${index}]: 丢弃未知字段「${key}」`)
      }
      const stageNo = Number.parseInt(String(item.stage ?? ''), 10)
      if (!Number.isInteger(stageNo) || stageNo < 1 || stageNo > 9) {
        fail(`${teamId}/stages[${index}]: 阶段序号必须是 1–9 的整数`)
        continue
      }
      if (seenStages.has(stageNo)) {
        fail(`${teamId}/stages[${index}]: 阶段序号重复 ${stageNo}`)
        continue
      }
      seenStages.add(stageNo)
      const picked = []
      for (const id of Array.isArray(item.members) ? item.members.map(String) : []) {
        if (!known.has(id)) {
          fail(`${teamId}/stages[${stageNo}]: 引用了不存在的成员「${id}」`)
          continue
        }
        if (picked.includes(id)) continue
        picked.push(id)
        covered.add(id)
      }
      if (picked.length === 0) fail(`${teamId}/stages[${stageNo}]: 没有指定任何成员`)
      const stageName = lengthIssues(teamId, `stages[${stageNo}]`, 'name', item.name, 16, false)
      stages.push({ stage: stageNo, ...stageName === undefined ? {} : { name: stageName }, members: picked })
    }
    stages.sort((a, b) => a.stage - b.stage)
    for (const [index, item] of stages.entries()) {
      if (item.stage !== index + 1) fail(`${teamId}: 阶段序号必须从 1 连续（当前 ${stages.map(s => s.stage).join(',')}）`)
    }
    const missing = [...known].filter(id => !covered.has(id))
    if (missing.length > 0) fail(`${teamId}: 这些成员没有被任何阶段引用：${missing.join('、')}`)
  }

  /*
   * 团队头像三选一：草案自带 → 复用库里同 id 团队的原头像 → 从空闲池顺序取。
   * 三者都要求「未被其它团队占用」，避免画廊里撞脸。
   */
  const previousAvatar = builtinDoc.teams.find(team => team.id === teamId)?.avatar
  let teamAvatar = Number.isInteger(raw.avatar) && raw.avatar >= 0 && raw.avatar < AVATAR_COUNT
    && !takenTeamAvatars.has(raw.avatar)
    ? raw.avatar
    : Number.isInteger(previousAvatar) && !takenTeamAvatars.has(previousAvatar)
      ? previousAvatar
      /* 空闲池是「本批处理前」算的：先前草案若复用原头像，该号已被 takenTeamAvatars
       * 重新占用，必须跳过，否则后面的草案会撞上同一个号（多草案批次导入会整体拒写）。 */
      : freeAvatars.find(value => !takenTeamAvatars.has(value))
  if (teamAvatar === undefined) {
    fail(`${teamId}: ${AVATAR_COUNT} 张团队头像已全部被占用，无法分配`)
    continue
  }
  takenTeamAvatars.add(teamAvatar)

  const accent = HEX.test(str(raw.accent)) ? str(raw.accent) : '#4F46E5'
  const createdAt = str(raw.createdAt) === '' ? new Date().toISOString() : str(raw.createdAt)

  normalized.push({
    id: teamId,
    name,
    ...str(raw.tagline) === '' || tagline === undefined ? {} : { tagline },
    ...str(raw.emoji) === '' ? {} : { emoji: str(raw.emoji) },
    avatar: teamAvatar,
    accent,
    ...category === undefined ? {} : { category },
    tags,
    createdAt,
    presets,
    cases,
    members,
    ...stages.length === 0 ? {} : { stages },
  })
}

if (errors.length > 0) {
  console.log(`❌ 草案校验未通过（${errors.length} 项），未写盘：`)
  for (const item of errors) console.log(`   - ${item}`)
  if (warnings.length > 0) {
    console.log(`\n（另有 ${warnings.length} 条告警）`)
    for (const item of warnings) console.log(`   · ${item}`)
  }
  process.exit(1)
}

/* --- 合并进内置基线 ----------------------------------------------------- */

const log = []
for (const team of normalized) {
  const index = builtinDoc.teams.findIndex(item => item.id === team.id)
  if (index >= 0) {
    builtinDoc.teams[index] = team
    log.push(`✅ 覆盖内置基线：${team.id}（${team.members.length} 位专家 / ${team.stages?.length ?? 0} 阶段）`)
  } else {
    builtinDoc.teams.unshift(team)
    log.push(`✅ 新增为内置：${team.id}（${team.members.length} 位专家 / ${team.stages?.length ?? 0} 阶段）`)
  }
}

/* --- 整体自洽校验（头像唯一、阶段引用存在、id 唯一）--------------------- */

const ids = builtinDoc.teams.map(team => team.id)
if (new Set(ids).size !== ids.length) {
  console.log('❌ 内置库出现重复团队 id，未写盘')
  process.exit(1)
}
const avatars = builtinDoc.teams.map(team => team.avatar).filter(value => Number.isInteger(value))
if (new Set(avatars).size !== avatars.length) {
  console.log('❌ 内置团队头像仍有重复，未写盘（gates 会拦）')
  process.exit(1)
}
for (const team of builtinDoc.teams) {
  const memberIds = new Set((team.members ?? []).map(member => member.id))
  const memberAvatars = (team.members ?? []).map(member => member.avatar)
  if (new Set(memberAvatars).size !== memberAvatars.length) {
    console.log(`❌ ${team.id}: 队内成员头像重复，未写盘`)
    process.exit(1)
  }
  for (const stage of team.stages ?? []) {
    for (const id of stage.members ?? []) {
      if (!memberIds.has(id)) {
        console.log(`❌ ${team.id}: 阶段 ${stage.stage} 引用了不存在的成员 ${id}，未写盘`)
        process.exit(1)
      }
    }
  }
}

console.log(log.join('\n'))
if (warnings.length > 0) {
  console.log(`\n告警（已丢弃的未知字段）：`)
  for (const item of warnings) console.log(`   · ${item}`)
}
console.log(`\n内置团队：${builtinDoc.teams.length} 支 / ${builtinDoc.teams.reduce((sum, team) => sum + (team.members?.length ?? 0), 0)} 位专家`)
console.log(`草案来源：${FROM_DIR}`)

if (dry) {
  console.log('\n（--dry：未写盘）')
  process.exit(0)
}

fs.writeFileSync(BUILTIN_FILE, `${JSON.stringify(builtinDoc, null, 2)}\n`, 'utf8')
console.log('\n已写盘。改完内置数据记得 `node scripts/build.mjs` 并跑一次 gates / smoke / client-smoke。')
