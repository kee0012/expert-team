/**
 * 把 .polish/<team-id>.json 里的内容资产合并进 data/teams.json。
 *
 * 用于并行给多支团队补齐：
 *   - `presets`：完整替换（原条目必须保留在前）；
 *   - `cases[].delivery`：按 **title 精确匹配** 补进现有案例；
 *   - `leadPersona`（可选）：替换主理人的 persona。
 *
 * 校验对齐服务端 normalizeTeam 的白名单上限 + persona 写作规格；任何一项不过就整批拒绝。
 *
 * 用法：node scripts/polish-teams.mjs [--dry]
 *   先建 `<插件根>/.polish/`，把各团队的 JSON 放进去。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEAMS_FILE = path.join(ROOT, 'data', 'teams.json')
/* 素材目录放在**仓库上一级**（= 本插件源码所在的工作目录），与 merge-persona.mjs 一致。 */
const POLISH_DIR = path.resolve(ROOT, '..', '.polish')
const dry = process.argv.includes('--dry')

const LIMITS = { maxPresets: 6, maxPresetText: 140, maxCaseDelivery: 8000, maxPersona: 4000 }
const MARKERS = ['你的职责是', '你的工作方式是', '你的交付物是', '你的纪律是']

if (!fs.existsSync(POLISH_DIR)) {
  console.error(`[polish] 找不到目录：${POLISH_DIR}`)
  process.exit(1)
}

const han = s => (String(s).match(/[\u4e00-\u9fa5]/g) ?? []).length
const doc = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'))
const errors = []
const warnings = []
const applied = []

/*
 * 只收正式产出：`<team-id>.json`。
 * 下划线开头的是写作过程中的中间产物（子代理留下的 `_xx_meta.json` 之类），
 * 它们可能带着同样的 teamId 但字段不全 —— 收进来会以「案例没补 delivery」的
 * 面目误报到别的团队头上（这个坑真踩过一次）。
 */
const files = fs.readdirSync(POLISH_DIR)
  .filter(name => name.endsWith('.json') && !name.startsWith('_'))
console.log(`[polish] 待合并 ${files.length} 个产出；跳过中间文件：`
  + (fs.readdirSync(POLISH_DIR).filter(n => n.startsWith('_')).join(', ') || '无'))

for (const file of files) {
  const payload = JSON.parse(fs.readFileSync(path.join(POLISH_DIR, file), 'utf8'))
  const team = doc.teams.find(item => item.id === payload.teamId)
  if (team === undefined) { errors.push(`${file}: teams.json 里找不到团队 ${payload.teamId}`); continue }

  /* --- presets --- */
  const presets = Array.isArray(payload.presets) ? payload.presets : []
  if (presets.length > LIMITS.maxPresets) {
    errors.push(`${payload.teamId}: presets ${presets.length} 条，超过上限 ${LIMITS.maxPresets}`)
  }
  for (const item of presets) {
    if (typeof item !== 'string' || item.trim() === '') errors.push(`${payload.teamId}: presets 里有空条目`)
    else if (item.length > LIMITS.maxPresetText) {
      errors.push(`${payload.teamId}: preset 超长 ${item.length}>${LIMITS.maxPresetText}：「${item.slice(0, 24)}…」`)
    }
  }
  for (const original of team.presets ?? []) {
    if (!presets.includes(original)) errors.push(`${payload.teamId}: 原有 preset 被丢掉了「${original.slice(0, 24)}」`)
  }

  /* --- cases[].delivery --- */
  const deliveries = Array.isArray(payload.cases) ? payload.cases : []
  const titles = new Set((team.cases ?? []).map(c => c.title))
  const covered = new Set()
  for (const item of deliveries) {
    if (!titles.has(item.title)) {
      errors.push(`${payload.teamId}: delivery 的 title 匹配不上现有案例「${String(item.title).slice(0, 30)}」`)
      continue
    }
    if (typeof item.delivery !== 'string' || item.delivery.trim() === '') {
      errors.push(`${payload.teamId}/${item.title}: delivery 为空`)
      continue
    }
    if (item.delivery.length > LIMITS.maxCaseDelivery) {
      errors.push(`${payload.teamId}/${item.title}: delivery ${item.delivery.length} 字，超过上限 ${LIMITS.maxCaseDelivery}`)
    }
    if (item.delivery.length < 600) {
      warnings.push(`${payload.teamId}/${item.title}: delivery 仅 ${item.delivery.length} 字（对标范例在 1000 字以上）`)
    }
    covered.add(item.title)
  }
  const missing = [...titles].filter(title => !covered.has(title))
  if (missing.length > 0) errors.push(`${payload.teamId}: 这些案例没补 delivery → ${missing.join(' / ')}`)

  /* --- leadPersona（可选） --- */
  if (payload.leadPersona !== undefined) {
    const lead = team.members.find(m => m.role === 'lead')
    if (lead === undefined) errors.push(`${payload.teamId}: 团队没有 lead，却给了 leadPersona`)
    else {
      const persona = String(payload.leadPersona)
      if (persona.length > LIMITS.maxPersona) errors.push(`${payload.teamId}: leadPersona ${persona.length} 字，超过上限`)
      let cursor = -1
      for (const mark of MARKERS) {
        const at = persona.indexOf(mark)
        if (at < 0) { errors.push(`${payload.teamId}: leadPersona 缺少标记「${mark}」`); continue }
        if (at < cursor) errors.push(`${payload.teamId}: leadPersona 四段标记顺序不对`)
        cursor = at
      }
      if (han(persona) < 600) warnings.push(`${payload.teamId}: leadPersona 仅 ${han(persona)} 汉字`)
    }
  }

  applied.push({ payload, team, presets, deliveries })
}

if (errors.length > 0) {
  console.log('❌ 校验未通过，整批不合并：')
  for (const item of errors) console.log('   - ' + item)
  process.exit(1)
}

for (const item of applied) {
  const { payload, team } = item
  if (item.presets.length > 0) team.presets = item.presets
  for (const one of item.deliveries) {
    const target = (team.cases ?? []).find(c => c.title === one.title)
    if (target !== undefined) target.delivery = one.delivery
  }
  let leadNote = ''
  if (payload.leadPersona !== undefined) {
    const lead = team.members.find(m => m.role === 'lead')
    lead.persona = String(payload.leadPersona)
    leadNote = ` · leadPersona ${lead.persona.length} 字`
  }
  const lens = (team.cases ?? []).map(c => c.delivery?.length ?? 0)
  console.log(`✅ ${team.id} — presets ${item.presets.length} 条 · delivery ${lens.join('/')} 字${leadNote}`)
}

console.log(`\n共 ${applied.length} 支团队待合并`)
if (warnings.length > 0) {
  console.log('\n⚠️  提醒：')
  for (const item of warnings) console.log('   - ' + item)
}
if (dry) { console.log('（--dry：未写盘）'); process.exit(0) }

fs.writeFileSync(TEAMS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`\n已写回 ${TEAMS_FILE}`)
