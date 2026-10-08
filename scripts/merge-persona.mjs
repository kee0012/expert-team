/**
 * 把 .persona/<team-id>.json 里重写好的 persona 合并进 data/teams.json。
 *
 * 用途：重写内置团队的 persona 时，可以并行派多个子代理各写一支团队，
 * 每支产出一个 `<team-id>.json`（只含 id + persona），最后用本脚本统一校验、统一落盘。
 * 任何一个团队不合格就**整批拒绝** —— 不做部分合并，避免留下「半新半旧」的团队。
 *
 * 校验 = 服务端 normalizeTeam 的白名单规则 + persona 的写作规格（四段标记、字数、禁词）。
 *
 * 用法：node scripts/merge-persona.mjs [--dry]
 *   先建 `<插件根>/.persona/`，把各团队的 JSON 放进去。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEAMS_FILE = path.join(ROOT, 'data', 'teams.json')
/* 素材目录放在**仓库上一级**（= 本插件源码所在的工作目录），与 polish-teams.mjs 一致。 */
const PERSONA_DIR = path.resolve(ROOT, '..', '.persona')
const dry = process.argv.includes('--dry')

if (!fs.existsSync(PERSONA_DIR)) {
  console.error(`[merge] 找不到目录：${PERSONA_DIR}（把各团队的 <team-id>.json 放进去再跑）`)
  process.exit(1)
}

const MARKERS = ['你的职责是', '你的工作方式是', '你的交付物是', '你的纪律是']
/* 无阶段团队不该出现流程承诺或工具名。命中就报出来人工判断，不自动判死。 */
const WARN_WORDS = ['子会话', '流水线', '阶段', '并行开工', 'expert_team']

const doc = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'))
const files = fs.readdirSync(PERSONA_DIR).filter(name => name.endsWith('.json') && name !== 'merge.json')

const errors = []
const warnings = []
const applied = []

for (const file of files) {
  const payload = JSON.parse(fs.readFileSync(path.join(PERSONA_DIR, file), 'utf8'))
  const team = doc.teams.find(item => item.id === payload.teamId)
  if (team === undefined) { errors.push(`${file}: teams.json 里找不到团队 ${payload.teamId}`); continue }

  const incoming = new Map((payload.members ?? []).map(m => [m.id, m.persona]))
  const ids = team.members.map(m => m.id)
  const missing = ids.filter(id => !incoming.has(id))
  const extra = [...incoming.keys()].filter(id => !ids.includes(id))
  if (missing.length > 0) errors.push(`${payload.teamId}: 缺少成员 ${missing.join(', ')}`)
  if (extra.length > 0) errors.push(`${payload.teamId}: 多出成员 ${extra.join(', ')}`)
  if (missing.length > 0 || extra.length > 0) continue

  for (const member of team.members) {
    const persona = incoming.get(member.id)
    if (typeof persona !== 'string' || persona.trim() === '') {
      errors.push(`${payload.teamId}/${member.id}: persona 为空`)
      continue
    }
    if (persona.length > 4000) errors.push(`${payload.teamId}/${member.id}: persona ${persona.length} 字，超过服务端上限 4000`)
    const han = (persona.match(/[\u4e00-\u9fa5]/g) ?? []).length
    if (han < 600) errors.push(`${payload.teamId}/${member.id}: 仅 ${han} 个汉字（规格 700~1200，至少 600 才算合格）`)

    let cursor = -1
    for (const mark of MARKERS) {
      const at = persona.indexOf(mark)
      if (at < 0) { errors.push(`${payload.teamId}/${member.id}: 缺少四段标记「${mark}」`); continue }
      if (at < cursor) errors.push(`${payload.teamId}/${member.id}: 四段标记顺序不对（${mark} 出现在更早的标记之前）`)
      cursor = at
    }
    for (const word of WARN_WORDS) {
      if (persona.includes(word)) warnings.push(`${payload.teamId}/${member.id}: 命中禁词「${word}」`)
    }
  }
  applied.push({ teamId: payload.teamId, members: team.members.length, payload, file })
}

if (errors.length > 0) {
  console.log('❌ 校验未通过，整批不合并：')
  for (const item of errors) console.log('   - ' + item)
  process.exit(1)
}

if (warnings.length > 0) {
  console.log('⚠️  禁词提醒（请人工确认语境是否合理）：')
  for (const item of warnings) console.log('   - ' + item)
  console.log('')
}

for (const item of applied) {
  const team = doc.teams.find(t => t.id === item.teamId)
  for (const member of team.members) {
    member.persona = item.payload.members.find(m => m.id === member.id).persona
  }
  const lens = team.members.map(m => `${m.alias || m.id}=${m.persona.length}`).join(' | ')
  console.log(`✅ ${item.teamId} — ${item.members} 位 · ${lens}`)
}

console.log(`\n共 ${applied.length} 支团队待合并：${applied.map(i => i.teamId).join(', ')}`)
if (dry) { console.log('（--dry：未写盘）'); process.exit(0) }

fs.writeFileSync(TEAMS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`已写回 ${TEAMS_FILE}`)
