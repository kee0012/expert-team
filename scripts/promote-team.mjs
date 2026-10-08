/**
 * 把运行时库里的团队**提升为内置团队**（沉淀进插件的 `data/teams.json`）。
 *
 * 为什么需要它：面板里「新建 / 编辑团队」写的是 `$DSH_HOME/expert-teams/teams.json`（用户库），
 * 那份数据**不随插件走** —— 换机器、重装、打包分发都会丢。而 `data/teams.json` 才是
 * 「内置团队」的基线，会跟着插件一起发布。
 * 开发阶段的约定是：**凡是自己攒出来的团队，都沉淀成内置**，所以需要一条把用户库
 * 单向搬进内置基线的通路。
 *
 * 语义（有意如此）：
 *   - 同 id 已存在 → **覆盖内置基线并保持它在数组中的原位置**。
 *     这让「在面板里改好某支内置团队 → 跑一次 promote」成为固化改动的正规动作。
 *   - 新 id → 插到数组最前面（同时它是 createdAt 最新的，符合「最新」排序直觉）。
 *   - 默认把提升过的条目**从用户库移除**：留着会在画廊里形成同 id 副本，
 *     副本优先级更高，于是内置基线的后续更新永远被它盖住、两份数据从此开始漂移。
 *     确实想保留副本时加 `--keep-copy`。
 *   - 团队头像与现有内置团队撞脸时自动换一张没被占用的（gates 会校验「画廊里不撞脸」），
 *     并在报告里写明换成了哪张。
 *
 * 用法：
 *   node scripts/promote-team.mjs                     # 把用户库里所有团队提升为内置
 *   node scripts/promote-team.mjs --ids a,b           # 只提升指定的几支
 *   node scripts/promote-team.mjs --dry               # 只预览
 *   node scripts/promote-team.mjs --keep-copy         # 保留用户库里的副本
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILTIN_FILE = path.join(ROOT, 'data', 'teams.json')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const keepCopy = argv.includes('--keep-copy')
const idsIndex = argv.indexOf('--ids')
const onlyIds = idsIndex >= 0 && argv[idsIndex + 1] !== undefined
  ? argv[idsIndex + 1].split(',').map(s => s.trim()).filter(Boolean)
  : null

const AVATAR_COUNT = 36
const KEBAB = /^[a-z0-9][a-z0-9-]{0,39}$/

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}
const USER_FILE = path.join(dshHome(), 'expert-teams', 'teams.json')

if (!fs.existsSync(USER_FILE)) {
  console.error(`[promote] 找不到用户团队库：${USER_FILE}`)
  process.exit(1)
}
if (!fs.existsSync(BUILTIN_FILE)) {
  console.error(`[promote] 找不到内置团队库：${BUILTIN_FILE}`)
  process.exit(1)
}

const userDoc = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'))
const builtinDoc = JSON.parse(fs.readFileSync(BUILTIN_FILE, 'utf8'))
const userTeams = Array.isArray(userDoc.teams) ? userDoc.teams : []
const picked = onlyIds === null ? userTeams : userTeams.filter(t => onlyIds.includes(t.id))

if (picked.length === 0) {
  console.log(`[promote] 用户库里没有匹配的团队（现有：${userTeams.map(t => t.id).join(', ') || '空'}）`)
  process.exit(0)
}

/* --- 校验：内置数据比用户库更严，坏数据进来会污染基线与 gates --- */
const errors = []
const AVATAR_KEYS = ['emoji', 'avatar', 'accent', 'category', 'tags', 'tagline', 'presets', 'cases', 'stages']
for (const team of picked) {
  if (typeof team.id !== 'string' || !KEBAB.test(team.id)) errors.push(`${team.id}: id 不合法`)
  if (typeof team.name !== 'string' || team.name.trim() === '') errors.push(`${team.id}: 缺 name`)
  if (!Array.isArray(team.members) || team.members.length === 0) errors.push(`${team.id}: 没有成员`)
  if (team.members.filter(m => m.role === 'lead').length > 1) errors.push(`${team.id}: 主理人多于 1 位`)
  for (const member of team.members ?? []) {
    if (typeof member.persona !== 'string' || member.persona.trim() === '') errors.push(`${team.id}/${member.id}: persona 为空`)
    if (member.persona !== undefined && member.persona.length > 4000) errors.push(`${team.id}/${member.id}: persona 超长`)
  }
  for (const key of Object.keys(team)) {
    if (!['id', 'name', ...AVATAR_KEYS, 'members', 'createdAt', 'usageCount', 'source', 'publisher'].includes(key)) {
      errors.push(`${team.id}: 含未知字段「${key}」 —— 内置数据是白名单，请先确认它该不该入库`)
    }
  }
}
if (errors.length > 0) {
  console.log('❌ 校验未通过，未提升任何团队：')
  for (const item of errors) console.log('   - ' + item)
  process.exit(1)
}

/* --- 头像去重：内置团队之间不许撞脸（gates 的硬约束） --- */
const takenAvatars = new Set(builtinDoc.teams.map(t => t.avatar).filter(v => Number.isInteger(v)))
const log = []
const avatarFixes = []
for (const team of picked) {
  const already = builtinDoc.teams.some(t => t.id === team.id)
  /* 团队原本就在内置里且头像没被别人占用时，不动它。 */
  if (!Number.isInteger(team.avatar) || (takenAvatars.has(team.avatar) && !already)) {
    const free = [...Array(AVATAR_COUNT).keys()].find(n => !takenAvatars.has(n))
    if (free === undefined) { errors.push(`${team.id}: 36 张头像全被占用，无法去重`); continue }
    avatarFixes.push(`${team.id}: ${team.avatar ?? '(未设)'} → ${free}`)
    team.avatar = free
  }
  takenAvatars.add(team.avatar)
}
if (errors.length > 0) {
  console.log('❌ 头像去重失败：')
  for (const item of errors) console.log('   - ' + item)
  process.exit(1)
}

/* --- 合并 --- */
const stripped = []
for (const team of picked) {
  /* 这两个是运行时派生的展示字段，不属于内置数据（publisher 由宿主按 source 算）。 */
  const clean = { ...team }
  delete clean.source
  delete clean.publisher

  const index = builtinDoc.teams.findIndex(t => t.id === clean.id)
  if (index >= 0) {
    builtinDoc.teams[index] = clean
    log.push(`✅ 覆盖内置基线：${clean.id}（${clean.members.length} 位专家）`)
  } else {
    builtinDoc.teams.unshift(clean)
    log.push(`✅ 新增为内置：${clean.id}（${clean.members.length} 位专家）`)
  }
  stripped.push(clean.id)
}

console.log(log.join('\n'))
if (avatarFixes.length > 0) {
  console.log('\n头像去重（内置团队之间不许撞脸）：')
  for (const item of avatarFixes) console.log('   - ' + item)
}

/* --- 校验内置库整体仍然自洽 --- */
const allAvatars = builtinDoc.teams.map(t => t.avatar).filter(v => Number.isInteger(v))
if (new Set(allAvatars).size !== allAvatars.length) {
  console.log('\n❌ 内置团队头像仍有重复，未写盘（gates 会拦）')
  process.exit(1)
}
for (const team of builtinDoc.teams) {
  const ids = new Set(team.members.map(m => m.id))
  for (const stage of team.stages ?? []) {
    for (const id of stage.members ?? []) {
      if (!ids.has(id)) { console.log(`\n❌ ${team.id}: 阶段 ${stage.stage} 引用了不存在的成员 ${id}`); process.exit(1) }
    }
  }
}

console.log(`\n内置团队：${builtinDoc.teams.length} 支 / ${builtinDoc.teams.reduce((n, t) => n + t.members.length, 0)} 位专家`)
console.log(`用户库：${keepCopy ? '保留副本' : `移除已提升的 ${stripped.length} 支（避免同 id 副本盖住内置更新）`}`)

if (dry) { console.log('\n（--dry：未写盘）'); process.exit(0) }

fs.writeFileSync(BUILTIN_FILE, `${JSON.stringify(builtinDoc, null, 2)}\n`, 'utf8')
if (!keepCopy) {
  userDoc.teams = userTeams.filter(t => !stripped.includes(t.id))
  fs.writeFileSync(USER_FILE, `${JSON.stringify(userDoc, null, 2)}\n`, 'utf8')
}
console.log('\n已写盘。改完内置数据记得 `node scripts/build.mjs` + `node scripts/sync-profile.mjs`，并跑一次 gates。')
