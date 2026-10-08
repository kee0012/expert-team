/**
 * expert-team — Client half（DSH Web / 浏览器侧）。
 *
 * 两个注册点：
 * 1. `conversation.input.left`（list / session 作用域）：「👥 专家团」入口 chip。
 *    它**渲染到哪儿取决于当前是不是空会话态**：
 *      · 空会话（hero）→ portal 进「工作区 | Agent 预设」那一行，紧挨「标准模式」之后；
 *      · 有内容的会话 → 留在输入卡片工具行左侧，与 `+`／权限／计划模式同行。
 *    为什么要 portal：那一行的三个孩子是写死的（WorkspaceChip + `conversation.hero.workspace`
 *    + `conversation.hero.agentPreset`），后两个都是 single 槽且已被占用，槽位层面加不了第三个。
 *    详见 `findHeroSeatRow`。
 *    这个 chip **同时承载「已召唤」状态**（见 `ActiveTeamChip`）：召唤后就在原地把
 *    「👥 专家团」换成「● 团队名 6/6」，取消召唤又变回入口 —— 状态与入口是同一个控件，
 *    不再往 `conversation.input.dock`（输入卡片上方那条独占一行的区域）里另挂一个标签。
 * 2. `shell.overlay`（list / root 作用域）：团队画廊 → 团队详情 → 召唤任务 → 新建/编辑团队 的全屏模态。
 *
 * 版式参照 WorkBuddy「专家团」：画廊 = 标题栏 + 排序 + 分类筛选 + 4 列卡片网格；
 * 详情 = 团队头图 + 黑色胶囊「召唤专家团」+ 引号预设条 + 使用案例 + 团队成员。
 *
 * 两个注册点来自同一个 bundle 模块实例，因此共享下面的 `store`：
 * 触发按钮把当前会话的 `inputActions` 与 sessionId 写进 store，模态用它把「召唤简报」提交进会话。
 *
 * 关于入参：session 作用域的槽位由 `uiSession.provide` 统一注入标准 props
 * （`sessionId` / `useSession` / `useConversation` / `useInput` / `inputActions`），
 * 与 owner 传了什么无关 —— `renderSlot('conversation.input.left', {})` 传的是空对象。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  AVATAR_COUNT,
  avatarFile,
  avatarIndexOf,
  memberAvatarIndex,
  nextAvatar,
  suggestAvatar,
  teamAvatarIndex,
} from './team-icons.js'

export const inject = ['slots']

const PLUGIN_ID = 'expert-team'
const API = '/expert-team/api'

/* ------------------------------------------------------------------ *
 *  极简 store（无需外部依赖；两个槽位共享同一模块实例）
 * ------------------------------------------------------------------ */

const store = {
  open: false,
  view: 'gallery',
  teamId: null,
  teams: [],
  loaded: false,
  error: null,
  /**
   * 服务端随 `GET /api/teams` 一起下发的运行配置：`{ lockBuiltinTeams, limits }`。
   *
   * 开发阶段 `lockBuiltinTeams=false` —— 内置团队与自定义团队一样可编辑、成员可改；
   * 定稿后把 `$DSH_HOME/expert-teams/config.json` 里它改成 true，即恢复「内置只读」。
   * 这里给一份保守缺省（false），避免配置还没拉到时先把入口藏起来。
   */
  config: { lockBuiltinTeams: false, limits: {} },
  /**
   * 「请求重新拉取」的令牌：每点一次入口就 +1。面板打开时如果它变了，
   * Modal 会重新 load —— 于是面板已经开着时再点一下入口，就能刷到最新的
   * 团队列表与 config（改完 config.json 不用重启进程，点一下即可）。
   */
  loadToken: 0,
  input: null,
  sessionId: undefined,
  sort: 'default',
  category: '全部',
  /**
   * 每个会话已「召唤」的专家团：`{ [sessionId]: { teamId, memberIds } }`。
   *
   * 按会话分桶而不是存一个全局单值：注册点虽然是 session 作用域，
   * 但这个 store 是模块级的，同时开着多个会话时不能互相串。
   */
  activeBySession: {},
  /** 点开的使用案例弹窗：`{ teamId, index }`；null = 未打开。 */
  caseView: null,
  version: 0,
}
const listeners = new Set()

function patch(next) {
  Object.assign(store, next)
  store.version += 1
  for (const listener of listeners) listener()
}

function useStore() {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = () => force(value => value + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return store
}

/* ------------------------------------------------------------------ *
 *  API
 * ------------------------------------------------------------------ */

async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`接口返回不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`)
  }
  return payload
}

/* ------------------------------------------------------------------ *
 *  工具函数
 * ------------------------------------------------------------------ */

/**
 * 会话 id 有两套字段名：
 * - session 作用域槽位的标准 prop 是 `sessionId`（`uiSession` 的 BUILTIN_SOURCE 提供）；
 * - owner 传进来的 `session` 快照里叫 `SessionSnapshot.sessionId`（宿主侧才是 `session.id`）。
 * 优先取标准 prop，取不到再退回快照；全都拿不到就必须放弃派遣，否则请求会 409 NO_PARENT。
 */
function sessionIdOf(props) {
  const candidates = [
    props?.sessionId,
    props?.session?.sessionId,
    props?.session?.id,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

const ROLE_LABEL = { lead: '主理人', member: '成员' }

function formatCount(value) {
  if (typeof value !== 'number' || value <= 0) return ''
  if (value >= 10000) return `${(value / 10000).toFixed(2).replace(/\.?0+$/, '')} 万次使用`
  return `${value} 次使用`
}

/**
 * 召唤成功后注入会话的「简报」，让召集人知道专家已就位。
 *
 * 有阶段计划的团队（`team.stages`）会在简报里展开整条流水线，
 * 并明确指示召集人：收齐本阶段产出后，把产出原文作为 `context` 派下一阶段。
 * 这是「分批派遣」的自动推进点 —— 面板只负责启动第 1 阶段，
 * 后续阶段由召集人（它手里才有各专家的回传内容）接力。
 */
function summonBriefing(team, task, dispatched, stage) {
  const roster = dispatched
    .map(item => `- ${item.name}${item.alias ? `（${item.alias}）` : ''} · 子会话 ${item.childSessionId}`)
    .join('\n')
  const plan = Array.isArray(team.stages) ? team.stages : []
  const staged = plan.length > 1
  const nameOf = id => team.members.find(member => member.id === id)?.name ?? id

  const lines = [
    `【专家团已就位】${team.name}`,
    '',
    `已为以下 ${dispatched.length} 位专家各自开了一个独立子会话，他们会带着各自角色设定开工：`,
    roster,
    '',
    `本次任务：${task}`,
    '',
  ]

  if (staged) {
    lines.push(`这是一条分阶段流水线（共 ${plan.length} 个阶段）：`)
    for (const item of plan) {
      const label = item.name !== undefined && item.name !== '' ? `（${item.name}）` : ''
      lines.push(`- 第 ${item.stage} 阶段${label}：${item.members.map(nameOf).join('、')}`)
    }
    lines.push('')
  }

  const currentStage = Number.isInteger(stage) ? stage : null
  const nextStage = currentStage !== null && plan.some(item => item.stage === currentStage + 1)
    ? currentStage + 1
    : null

  if (nextStage !== null) {
    lines.push(
      `本次只派了第 ${currentStage} 阶段。请你作为召集人：`,
      `1. 等这 ${dispatched.length} 位专家全部把结果发回来（他们会主动 send_message 给你）；`,
      `2. 把他们的产出原文合并成 context，调用 expert_team_summon 派下一阶段：`,
      `   { team_id: "${team.id}", stage: ${nextStage}, task: 与本次相同, context: 上一阶段的产出原文 }；`,
      '3. 不要替专家代写任何产出，也不要在上一阶段没收齐前往下派。',
    )
  } else {
    lines.push(
      '请你作为本次任务的召集人：',
      '1. 不要重复专家们已经负责的内容；',
      '2. 等所有专家返回结论后再统一汇总，不要提前收尾；',
      '3. 汇总时标注哪部分由哪位专家贡献；若专家结论冲突，给出你的裁决与理由；',
      '4. 最终交付一份结构完整、观点一致的成果。',
    )
  }
  return lines.join('\n')
}

/** 直接派遣不可用时的兜底简报：让模型自己调用工具完成派遣。 */
function fallbackBriefing(team, task, memberIds, reason, stage) {
  const roster = team.members
    .map(member => `- ${member.id}｜${member.name}${member.alias ? `（${member.alias}）` : ''}｜${ROLE_LABEL[member.role] ?? member.role}｜${member.focus || '—'}`)
    .join('\n')
  const selected = Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length < team.members.length
    ? `\n\n本次只派遣这些成员：${memberIds.join(', ')}`
    : ''
  /*
   * 宿主报错可能非常长（例如 tools.restrict() 的报错会把整张全局工具表列一遍）。
   * 草稿是给人读的，超长就截断，别把整屏英文灌进输入框。
   */
  const whyText = typeof reason === 'string' ? reason.replace(/\s+/gu, ' ').trim() : ''
  const why = whyText === ''
    ? ''
    : `（面板直连派遣未成功：${whyText.length > 120 ? `${whyText.slice(0, 120)}…（原因过长已截断，完整报错见 DSH 日志）` : whyText}）`
  const plan = Array.isArray(team.stages) ? team.stages : []
  const stageHint = plan.length > 1
    ? [
        '',
        `本团是一条分阶段流水线（共 ${plan.length} 个阶段）：`,
        ...plan.map(item => `- 第 ${item.stage} 阶段${item.name !== undefined && item.name !== '' ? `（${item.name}）` : ''}：${item.members.join(', ')}`),
        Number.isInteger(stage)
          ? `请先只派第 ${stage} 阶段（expert_team_summon 传 stage: ${stage}）；收齐这几位专家的回传后，`
            + '把产出原文作为 context、带上下一个 stage 再调一次 expert_team_summon，直到最后一个阶段。'
          : '请分批推进：先派第 1 阶段，收齐产出后把产出原文作为 context 派第 2 阶段，依此类推。',
      ]
    : []
  return [
    `【召唤专家团】请调用 expert_team_summon 工具组建「${team.name}」并完成下面的任务。${why}`,
    '',
    `team_id：${team.id}`,
    Number.isInteger(stage) ? `stage：${stage}` : '',
    `任务：${task}${selected}`,
    ...stageHint,
    '',
    '团队成员（供你了解分工，不必逐个转述）：',
    roster,
    '',
    '调用后请等待所有专家返回，再汇总成一份结构完整、观点一致的交付物，并标注各部分的贡献者。',
  ].filter(line => line !== '').join('\n')
}

/* ------------------------------------------------------------------ *
 *  调色板（对齐参考版式：中性灰 + 黑，卡片纯白）
 * ------------------------------------------------------------------ */

/*
 * 全部走 DSH 主题令牌，十六进制字面色只作为「令牌缺失时的兜底」。
 * 令牌由 `dsh-client-ui-theme` 定义在 `body` 上，暗色主题整体换另一套取值；
 * 面板虽然 portal 到 body，也照样继承得到。硬编码浅色会让暗色主题下
 * 整块 UI 仍是白底浅字（这是 0.2.0 适配里唯一肉眼可见的缺陷）。
 */
const S = {
  page: 'var(--dsw-alias-bg-base, #f7f7f8)',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  text: 'var(--dsw-alias-label-primary, #1f2328)',
  strong: 'var(--dsw-alias-label-primary, #111827)',
  muted: 'var(--dsw-alias-label-tertiary, #8a8f98)',
  body: 'var(--dsw-alias-label-secondary, #6b7280)',
  line: 'var(--dsw-alias-border-l2, #ececee)',
  soft: 'var(--dsw-alias-interactive-bg-hover, #f5f5f6)',
  radius: 12,
}

/* ------------------------------------------------------------------ *
 *  召唤 = 「激活」：把团队带回输入框，而不是在面板里填任务
 * ------------------------------------------------------------------ */

/** 当前会话已激活的专家团；未激活或团队已消失时返回 null。 */
function activeOf(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const entry = state.activeBySession?.[sessionId]
  if (entry === undefined || entry === null) return null
  const team = state.teams.find(item => item.id === entry.teamId)
  if (team === undefined) return null
  const valid = entry.memberIds.filter(id => team.members.some(member => member.id === id))
  return {
    team,
    memberIds: valid.length > 0 ? valid : team.members.map(member => member.id),
    /** 分批派遣的当前阶段；null = 一次性派遣（默认）。 */
    stage: Number.isInteger(entry.stage) ? entry.stage : null,
  }
}

/**
 * 把焦点交回 DSH 输入框。
 * `[data-input-scroll]` 是 InputBar.tsx 写死的语义锚点，比构建哈希 className 稳。
 * 模态是 portal 到 body 的，关闭后浏览器可能把焦点收回，所以隔两帧各抢一次。
 */
function focusComposer() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
  const grab = () => {
    const editor = document.querySelector('[data-input-scroll] [contenteditable]')
    // 鸭子类型而不是 `instanceof HTMLElement`：冒烟用的假 DOM 里没有这个全局构造器。
    if (editor !== null && editor !== undefined && typeof editor.focus === 'function') editor.focus()
  }
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    grab()
    return
  }
  // 模态是 portal 到 body 的，关闭后浏览器可能把焦点收回，所以隔两帧各抢一次。
  window.requestAnimationFrame(() => {
    grab()
    window.requestAnimationFrame(grab)
  })
}

/**
 * 激活一支专家团：写进 store（可选预填草稿）、关掉面板、把焦点交给输入框。
 * 这是新的「召唤」语义 —— 面板不再承担填任务 / 点确认的职责。
 */
function activateTeam(team, draftText, memberIds, stage) {
  const sessionId = store.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') {
    const ids = Array.isArray(memberIds) && memberIds.length > 0
      ? memberIds.filter(id => team.members.some(member => member.id === id))
      : team.members.map(member => member.id)
    const entry = {
      teamId: team.id,
      memberIds: ids.length > 0 ? ids : team.members.map(member => member.id),
      ...Number.isInteger(stage) ? { stage } : {},
    }
    patch({ activeBySession: { ...store.activeBySession, [sessionId]: entry } })
  }
  const actions = store.input
  if (actions !== undefined && actions !== null && typeof draftText === 'string' && draftText !== '') {
    actions.setDraft(draftText)
  }
  patch({ open: false, error: null })
  focusComposer()
}

/** 取消激活（chip 上的 ×，或派遣完成后自动收起）。 */
function deactivateTeam(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (store.activeBySession?.[sessionId] === undefined) return
  const next = { ...store.activeBySession }
  delete next[sessionId]
  patch({ activeBySession: next })
}

/** 只切换激活团队的成员勾选（至少保留一位，否则没有可派的人）。 */
function setActiveMembers(sessionId, memberIds) {
  const entry = store.activeBySession?.[sessionId]
  if (entry === undefined || memberIds.length === 0) return
  /*
   * 手动勾选 = 放弃分批语义：不带 stage 出去。
   * 否则「我勾了 3 位却只派出 2 位」（stage 会在服务端再过滤一次）会让人摸不着头脑。
   */
  patch({ activeBySession: { ...store.activeBySession, [sessionId]: { teamId: entry.teamId, memberIds } } })
}

/**
 * 分批派遣：把勾选换成「第 N 阶段」的成员并记下 stage；传 null 退回一次性派遣。
 * 后续阶段的推进由召集人接力（他手里才有上一阶段的回传内容），见 summonBriefing。
 */
function setActiveStage(sessionId, team, stage) {
  const entry = store.activeBySession?.[sessionId]
  if (entry === undefined) return
  if (stage === null) {
    patch({
      activeBySession: {
        ...store.activeBySession,
        [sessionId]: { teamId: entry.teamId, memberIds: entry.memberIds },
      },
    })
    return
  }
  const bucket = (Array.isArray(team.stages) ? team.stages : []).find(item => item.stage === stage)
  if (bucket === undefined || bucket.members.length === 0) return
  patch({
    activeBySession: {
      ...store.activeBySession,
      [sessionId]: { teamId: entry.teamId, memberIds: [...bucket.members], stage },
    },
  })
}

/* ------------------------------------------------------------------ *
 *  使用案例：交付结果弹窗 + 「做同款」
 * ------------------------------------------------------------------ */

/**
 * 「做同款」的提示词。
 * 案例自带 `prompt` 时优先用它；否则按**这个案例自己**的标题与描述派生 ——
 * 绝不套用一个通用模板，否则填进输入框的内容与用户点的案例对不上。
 */
function sameStylePrompt(team, item) {
  if (typeof item.prompt === 'string' && item.prompt !== '') return item.prompt
  return [
    `用「${team.name}」做同款：${item.title}`,
    item.desc !== undefined && item.desc !== '' ? `目标：${item.desc}` : '',
    '请按该团队的分工方式协作完成，一次交付可直接使用的完整成果：含关键产物清单、明确结论与验收要点。',
  ].filter(part => part !== '').join('\n')
}

/** 交付结果正文的轻量渲染：只认 ### 小标题 / - 列表 / | 表格 | / 普通段落。 */
function renderDelivery(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let index = 0
  let key = 0
  const heading = { fontSize: 13.5, fontWeight: 700, color: S.text, marginTop: 6 }
  const body = { fontSize: 13.5, lineHeight: 1.75, color: S.body, margin: 0 }

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') { index += 1; continue }

    if (line.startsWith('### ')) {
      blocks.push(<div key={key++} style={heading}>{line.slice(4)}</div>)
      index += 1
      continue
    }

    if (line.trim().startsWith('|')) {
      const rows = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = lines[index].trim().replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim())
        if (!cells.every(cell => /^-+$/u.test(cell) || cell === '')) rows.push(cells)
        index += 1
      }
      if (rows.length > 0) {
        blocks.push(
          <div key={key++} style={{ border: `1px solid ${S.line}`, borderRadius: 8, overflow: 'hidden' }}>
            {rows.map((cells, rowIndex) => (
              <div
                key={rowIndex}
                style={{
                  display: 'flex',
                  background: rowIndex === 0 ? S.soft : S.surface,
                  borderTop: rowIndex === 0 ? 'none' : `1px solid ${S.line}`,
                }}
              >
                {cells.map((cell, cellIndex) => (
                  <div
                    key={cellIndex}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '7px 10px',
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: rowIndex === 0 ? S.text : S.body,
                      fontWeight: rowIndex === 0 ? 600 : 400,
                    }}
                  >
                    {cell}
                  </div>
                ))}
              </div>
            ))}
          </div>,
        )
      }
      continue
    }

    if (line.startsWith('- ')) {
      const items = []
      while (index < lines.length && lines[index].startsWith('- ')) {
        items.push(lines[index].slice(2))
        index += 1
      }
      blocks.push(
        <div key={key++} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.map((entry, entryIndex) => (
            <div key={entryIndex} style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.7, color: S.body }}>
              <span style={{ color: S.muted, flex: 'none' }}>·</span>
              <span>{entry}</span>
            </div>
          ))}
        </div>,
      )
      continue
    }

    const paragraph = []
    while (
      index < lines.length
      && lines[index].trim() !== ''
      && !lines[index].startsWith('### ')
      && !lines[index].startsWith('- ')
      && !lines[index].trim().startsWith('|')
    ) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push(<p key={key++} style={body}>{paragraph.join(' ')}</p>)
  }

  if (blocks.length === 0) {
    blocks.push(<p key="empty" style={body}>这个案例还没有补充交付结果。</p>)
  }
  return blocks
}

/** 案例交付结果弹窗（参考 WorkBuddy 的案例详情版式：标题 + 正文卡 + 底部操作）。 */
function CaseDialog({ team, item, onClose, onSameStyle }) {
  const accent = team.accent || '#4F46E5'
  return portalToBody(
    <div
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      style={{
        position: 'fixed',
        inset: 0,
        // 必须高于画廊模态（9999）：案例弹窗是从详情页里再叠一层打开的。
        zIndex: 10000,
        background: 'var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.5))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-label={item.title}
        style={{
          width: 'min(880px, 100%)',
          maxHeight: 'min(86vh, 860px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: S.surface,
          color: S.text,
          borderRadius: 16,
          border: `1px solid ${S.line}`,
          boxShadow: 'var(--dsw-shadow-lv3, 0 24px 60px rgba(15, 23, 42, 0.28))',
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 14px', borderBottom: `1px solid ${S.line}` }}>
          <span
            style={{
              width: 34,
              height: 34,
              flex: 'none',
              borderRadius: 10,
              background: `${accent}14`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 17,
            }}
          >
            {item.emoji || '📄'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 700, color: S.text, lineHeight: 1.35 }}>{item.title}</div>
            {item.desc !== undefined && item.desc !== '' && (
              <div style={{ fontSize: 13.5, color: S.body, marginTop: 6, lineHeight: 1.6 }}>{item.desc}</div>
            )}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            style={btn({ padding: '5px 10px', fontSize: 13 })}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px', background: S.page }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: S.surface,
              border: `1px solid ${S.line}`,
              borderRadius: 12,
              padding: '18px 20px',
            }}
          >
            {renderDelivery(item.delivery)}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 24px', borderTop: `1px solid ${S.line}` }}>
          <button type="button" style={btn()} onClick={onClose}>关闭</button>
          <button type="button" style={primaryBtn()} onClick={onSameStyle}>
            <IconSend size={16} />
            做同款
          </button>
        </div>
      </div>
    </div>,
  )
}

const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

const btn = extra => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: `1px solid ${S.line}`,
  background: S.surface,
  color: S.text,
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 13,
  lineHeight: 1.4,
  cursor: 'pointer',
  fontFamily: 'inherit',
  ...extra,
})

const primaryBtn = extra => btn({
  /* 主按钮必须是「填充 + 反色字」，不能拿正文色当底色：暗色主题下会变成白底白字。 */
  background: 'var(--dsw-alias-button-primary-fill, #111827)',
  color: 'var(--dsw-static-neutral-00, #ffffff)',
  border: '1px solid var(--dsw-alias-button-primary-fill, #111827)',
  fontWeight: 600,
  ...extra,
})

/**
 * 分批派遣的阶段小按钮（「一次性 / P1 收集 / P2 裁决」）。
 * 选中态沿用团队 accent 的浅底 + 描边，与激活态 chip 是同一套语言。
 */
const stageChip = (selected, accent) => btn({
  padding: '2px 8px',
  fontSize: 12,
  borderRadius: 999,
  border: `1px solid ${selected ? `${accent}59` : S.line}`,
  background: selected ? `${accent}1f` : S.surface,
  color: selected ? S.text : S.body,
  fontWeight: selected ? 600 : 400,
  whiteSpace: 'nowrap',
})

/* ------------------------------------------------------------------ *
 *  图标（内联 SVG，不引入图标依赖）
 * ------------------------------------------------------------------ */

function IconChat({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5.6A1.6 1.6 0 0 1 5.6 4h12.8A1.6 1.6 0 0 1 20 5.6v8.8a1.6 1.6 0 0 1-1.6 1.6H12l-4.6 3.4a.4.4 0 0 1-.64-.32V16H5.6A1.6 1.6 0 0 1 4 14.4V5.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.2 9.6c.5-.9 1.2-1.4 2.1-1.4 1 0 1.7.6 1.7 1.5 0 .7-.4 1.1-1 1.6-.5.4-.7.7-.7 1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="11.3" cy="14.2" r="0.9" fill="currentColor" />
    </svg>
  )
}

function IconGrid({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {[[4, 4], [13.5, 4], [4, 13.5], [13.5, 13.5]].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.7" />
      ))}
    </svg>
  )
}

function IconUsers({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8.4" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.4 19c0-2.9 2.5-4.8 5.6-4.8s5.6 1.9 5.6 4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M16.4 6.2a2.7 2.7 0 0 1 0 5.2M17.6 14.6c1.9.4 3.2 1.8 3.2 3.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 行内 chip 的图标。
 *
 * 规格是**照着 DSH 自己量出来的**，不是随手写的：hero 行里两个邻居 chip 的图标是
 * 16×16、`viewBox 0 0 16 16`、1px 描边、颜色 = 文字色；工具行里是同一套视框渲染成 14×14。
 * 所以这里也用 16 视框 + 1px 描边，只在尺寸上跟随所在行。
 *
 * 为什么不继续用 `👥` emoji：emoji 是**自带彩色字形**的位图，和整排单色线性图标不是一套
 * 设计语言 —— 放进「dshworkspace | 标准模式」那一行会立刻显得是外挂控件。
 */
function IconUsersInline({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="6.1" cy="5.7" r="2.1" stroke="currentColor" strokeWidth="1" />
      <path d="M2.4 12.8c0-1.9 1.65-3.05 3.7-3.05s3.7 1.15 3.7 3.05" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M10.9 4.3a1.75 1.75 0 0 1 0 3.4M11.8 9.85c1.2.28 2 1.2 2 2.55" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

function IconSend({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20.4 3.6 3.9 9.8c-.6.2-.6 1 0 1.2l5.4 1.9 1.9 5.4c.2.6 1 .6 1.2 0l6.2-16.5c.2-.5-.3-1-.8-.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 *  头像：团队图标与成员头像共用同一套插画
 * ------------------------------------------------------------------ */

/** 头像文件在宿主路由上的前缀（与 src/index.js 的 AVATAR_PREFIX 一致）。 */
const AVATAR_BASE = '/expert-team/avatar/'

/**
 * 头像图片。
 *
 * 由宿主路由按需提供（`/expert-team/avatar/NN.jpg`），**不内联进 bundle**：
 * 它们是位图，36 张内联会把 client.js 从 70KB 顶到 200KB，而这样写还能吃到浏览器缓存。
 * `index` 由 `team-icons.js` 的纯函数派生（显式挑过的优先，否则按 id 稳定算）。
 *
 * 素材是一批 100×134 的竖幅半身插画，圆形裁切取中心：脸与肩都落在框内。
 */
function AvatarImage({ index, size = 40, title }) {
  return (
    <img
      src={`${AVATAR_BASE}${avatarFile(index)}`}
      width={size}
      height={size}
      alt=""
      aria-hidden
      title={title}
      loading="lazy"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        objectPosition: 'center',
        flex: 'none',
        display: 'block',
        background: 'var(--dsw-alias-bg-layer-2, #f1f3f5)',
      }}
    />
  )
}

/**
 * 成员头像：显式挑过的 `avatar` 优先，否则按成员 id 稳定派生 ——
 * 同一成员永远同一张脸，跨会话、跨机器都稳定。
 */
function PersonAvatar({ seed, avatar, size = 40 }) {
  return <AvatarImage index={avatarIndexOf(seed, avatar)} size={size} />
}

/** 团队图标：显式挑过的 `team.avatar` 优先，否则按团队 id 派生（和成员头像同一套图）。 */
function TeamAvatar({ team, size = 40 }) {
  return <AvatarImage index={teamAvatarIndex(team)} size={size} title={team?.name} />
}

/* ------------------------------------------------------------------ *
 *  触发按钮（两套版式：hero 行 / 工具行）
 * ------------------------------------------------------------------ */

/**
 * 工具行里的 chip 样式。刻意对齐 DSH 自己在那一行的控件：
 * 高度 28、无边框、底色用 `--dsw-specific-selector`（实测与 `+` 按钮同色）、字号 14。
 * 不要给它套块级容器 —— 那会把它推成独立一行。
 */
const chip = extra => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 'none',
  height: 28,
  padding: '0 10px',
  border: 'none',
  borderRadius: 999,
  background: 'var(--dsw-specific-selector, rgba(0, 0, 0, 0.04))',
  color: 'var(--dsw-alias-label-primary, #1f2328)',
  fontSize: 14,
  lineHeight: 1,
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  ...extra,
})

/**
 * 「工作区 | Agent 预设」那一行的 chip 样式。
 * 逐项对齐 DSH 自己的 `.seat`（ui-agent-preset 的 AgentPresetSeat.module.css）：
 * 透明底 + 悬停底色、min-height 28、padding 0 8px、圆角 16、字号 13、字重 500 ——
 * 这样它和「标准模式」看起来是同一套控件，而不是硬塞进去的异物。
 * `order: 100` 是关键：无论 DOM 里排到第几个，都保证视觉上排在「标准模式」之后。
 */
const rowChip = extra => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  flex: 'none',
  order: 100,
  minHeight: 28,
  maxWidth: '100%',
  padding: '0 8px',
  border: 'none',
  borderRadius: 16,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #1f2328)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  ...extra,
})

const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))'

/**
 * 找到「工作区 | Agent 预设」那一行（空会话态才有）。
 *
 * 为什么是 DOM 而不是槽位：那一行由 ConversationRoot 写死三个孩子
 * （WorkspaceChip + `conversation.hero.workspace` + `conversation.hero.agentPreset`），
 * 后两个都是 **single** 槽且已被 ui-workspace / ui-agent-preset 占用 ——
 * single 槽同优先级注册直接抛错，不同优先级是「遮蔽」而非并列。
 * 想在「标准模式」后面再挂一个并列控件，只能把节点放进那一行。
 *
 * 锚点全部是语义属性，不依赖构建哈希 className、也不依赖任何中文文案：
 * - `[data-composer-card]`：输入卡片（DSH 自己打的稳定标记，InputBar.tsx 写死）；
 * - `button[aria-haspopup="menu"]`：行内两个选择器 chip（工作区 / Agent 预设）都带这个属性；
 * - 「行」= 预设 chip 向上跳过 slot 包装层（`display: contents`）后的那个 flex 行。
 *
 * 鲁棒性来自「两个 chip 在同一行」这个事实：即便 Agent 预设因为还未加载完而暂时不渲染，
 * 取到的工作区 chip 也会指向同一行，落位结果一样。
 */
function findHeroSeatRow() {
  if (typeof document === 'undefined') return null
  const card = document.querySelector('[data-composer-card]')
  if (card === null) return null

  /*
   * 门禁一（会话阶段）：那一行**只在 hero（空会话）态存在**，所以先问会话根要 `data-phase`。
   * DSH 把 `data-phase`（`settling` / `hero` / `active`，见 ui-conversation 的 ConversationRoot）
   * 打在会话根节点上，输入卡片是它的后代，`closest` 拿到的必定是**本会话**的根。
   *
   * 这道门不是保险，是必需。下面那套扫描的前提是「文档里只有 hero 行的两个 chip
   * 既是 `aria-haspopup="menu"` 又在卡片之前」—— **有内容的会话里这个前提不成立**：
   * 「本轮文件改动」（deliverables 插件的 `conversation.chat.turnTail`）渲染在消息流里、
   * 位于输入卡片之前，而它每个文件卡片右侧都有一个「打开 ▾」菜单按钮，正是
   * `button[aria-haspopup="menu"]`。于是它被认成 hero 行的 seat，「● 团队名 n/m」
   * 就被 portal 进了那一行文件卡片里，看起来像从会话中凭空冒出来一个团队标签。
   *
   * 取不到 `data-phase`（DSH 改标记、或冒烟用的假 DOM）时不阻断，退回旧的扫描行为。
   */
  const rootEl = typeof card.closest === 'function' ? card.closest('[data-phase]') : null
  const phase = rootEl !== null && typeof rootEl.getAttribute === 'function'
    ? rootEl.getAttribute('data-phase')
    : null
  if (phase !== null && phase !== 'hero') return null

  /*
   * 门禁二（容器范围）：hero 行和输入卡片同属输入区容器 `[data-composer-seat]`。
   * 把扫描范围收在这个容器内，消息流里同名的下拉按钮（deliverables 的「打开 ▾」、
   * 回合尾部的其它菜单）就再也够不着这里 —— 比只靠 `compareDocumentPosition`
   * 判定「在卡片之前」稳得多：那个判据对**任何**更早出现在文档里的按钮都成立。
   */
  const seatEl = typeof card.closest === 'function' ? card.closest('[data-composer-seat]') : null
  const scope = seatEl !== null && typeof seatEl.querySelectorAll === 'function' ? seatEl : document

  /*
   * 只取卡片**之前**的 chip：卡片里的模型 / 权限控件同样在文档里，必须排除。
   * `compareDocumentPosition` 的 DOCUMENT_POSITION_PRECEDING 位天然把卡片后代也排除了
   * （后代只会命中 CONTAINED_BY | FOLLOWING）。
   */
  const seats = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]'))
    .filter(seat => (card.compareDocumentPosition(seat) & Node.DOCUMENT_POSITION_PRECEDING) !== 0)
    /*
     * 必须排除**我们自己**的控件：团队标签里的成员下拉三角同样带 `aria-haspopup="menu"`，
     * 且它就在卡片上方（命中「卡片之前」），于是会被误认成 hero 行的 seat ——
     * Trigger 随即被 portal 进团队标签**内部**，两个 chip 挤成一行、红框位置反而空着。
     * 真机实测踩过这个坑。
     */
    .filter(seat => typeof seat.closest !== 'function'
      || seat.closest('[data-expert-team-active-chip]') === null)
  const seat = seats[seats.length - 1]
  if (seat === undefined) return null

  /*
   * 从 seat 定位「真正的那一行」。
   *
   * 首选**声明的 slot 标识**：DSH 的每个 slot 出口都是
   * `<div data-slot="<slotKey>" style="display:contents">`（renderer 的 `SlotOutlet`），
   * `data-slot` 是稳定属性 —— 不像 module.css 的哈希类名（`Dc7zOa_heroWorkspaceRow`）
   * 会随构建变。hero 行里 `conversation.hero.workspace` / `conversation.hero.agentPreset`
   * 两个出口的父节点就是那一行本身（ui-conversation 的 `heroWorkspaceRow`），
   * 于是不需要任何「往上跳几层」的猜测。
   */
  const outletParent = key => {
    if (typeof scope.querySelector !== 'function') return null
    const outlet = scope.querySelector(`[data-slot="${key}"]`)
    const parent = outlet !== null && outlet !== undefined ? outlet.parentElement : null
    if (parent === null || parent === undefined || parent === document.body || parent === seatEl) return null
    /*
     * 出口的父节点必须是**窄行**（不含输入卡片），否则它可能是更外层的堆叠容器：
     * 把 chip 挂到那儿会掉到输入框下面，比不露头更糟。拿不到 `contains`（假 DOM）时放行。
     */
    if (typeof parent.contains === 'function' && parent.contains(card)) return null
    return parent
  }
  for (const key of ['conversation.hero.agentPreset', 'conversation.hero.workspace']) {
    const row = outletParent(key)
    if (row !== null) return row
  }

  /*
   * 回退（旧版 DSH，或冒烟用的假 DOM）：从 seat 往上找到第一个既不是 `display: contents`
   * 的 slot 包装、又不止一个孩子的层。
   *
   * 不能只跳过 `display: contents`：开启开发者工具时 Agent 预设 chip 外面会多一层
   * `.menuAnchor`（`min-width:54px;max-width:100%`，ui-agent-preset 自己的菜单锚点包装）
   * —— 它是实打实的盒子，chip 被塞进去就会被 54px 挤压甚至换行。
   * 「只有一个孩子的层是包装层」这条判据对 hero 行成立：那一行里始终有工作区 chip
   * 和两个 slot 出口，至少两个元素。一路找不到并列层就返回 null，退回工具行 ——
   * 与其它降级路径一致，宁可不在 hero 行露头，也不要挤变形。
   */
  const elementChildren = node => (node !== null && node.children !== undefined ? node.children.length : 0)
  let row = seat.parentElement
  for (let hops = 0; row !== null && row !== document.body && hops < 12; hops += 1) {
    if (getComputedStyle(row).display === 'contents' || elementChildren(row) < 2) {
      row = row.parentElement
      continue
    }
    break
  }
  return row === null || row === document.body ? null : row
}

/**
 * 订阅那一行。返回 null 表示当前不是空会话态，chip 该留在工具行。
 *
 * 用低频轮询而不是 MutationObserver：hero 行的重建不保证伴随 `data-phase` 变化
 * （会话 / 目标整体重挂时属性可能不变），观察器会漏；这里每 400ms 只做两个 DOM 查询，
 * 且同值不落地（不触发重渲染），既便宜又自愈。
 */
function useHeroSeatRow() {
  const [row, setRow] = useState(null)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const resolve = () => {
      const next = findHeroSeatRow()
      setRow(current => (current === next ? current : next))
    }
    resolve()
    const timer = window.setInterval(resolve, 400)
    return () => { window.clearInterval(timer) }
  }, [])
  return row
}

function Trigger(props) {
  const state = useStore()
  const actions = props?.inputActions
  const sessionId = sessionIdOf(props)
  const seatRow = useHeroSeatRow()
  const [hover, setHover] = useState(false)

  // 把当前会话的 input facade 记进 store，供 root 作用域的模态使用。
  // 必须带变更判断：无条件 patch 会通知本组件重渲染，进而再次 patch —— 死循环。
  // 卸载时清理，否则会话切换后模态可能拿着上一个会话的 actions 提交。
  useEffect(() => {
    if (store.input !== actions || store.sessionId !== sessionId) {
      patch({ input: actions ?? null, sessionId })
    }
    return () => {
      if (store.input === actions && store.sessionId === sessionId) patch({ input: null })
    }
  }, [actions, sessionId])

  const open = useCallback(() => {
    patch({
      open: true,
      view: 'gallery',
      teamId: null,
      error: null,
      category: '全部',
      /* 即便面板已经开着，点入口也算一次「刷新」——见 store.loadToken。 */
      loadToken: (store.loadToken ?? 0) + 1,
    })
  }, [])

  // 拿着过期（已从文档摘下）的行不放，chip 会静默消失 —— 一旦失效就退回工具行。
  const host = seatRow !== null && seatRow.isConnected === true ? seatRow : null

  /*
   * 已召唤 → 这个控件**就地变成**当前团队的标签（同一个位置、同一个宿主）：
   * hero 行里「👥 专家团」原地换成「● 产品战略团队 6/6」，有内容的会话里则落在工具行左侧。
   * 早先它另挂 `conversation.input.dock`（输入卡片上方那条独占一行的区域），
   * 视觉上离输入框远、还白占一行高度 —— 现在合并到这里：取消召唤即还原成入口。
   */
  const active = activeOf(state, sessionId)
  if (active !== null) {
    return (
      <ActiveTeamChip
        sessionId={sessionId}
        session={props?.session}
        host={host}
        onOpenPanel={open}
      />
    )
  }

  /*
   * 注意这里是 `state.open` —— 不是上面那个 `open`。
   * `open` 是「打开面板」的函数（useCallback 的返回值，恒为真），
   * 误写成 `open || hover` 会让 chip **永久带着悬停底色**（DSH 的
   * `--dsw-alias-interactive-bg-hover` 在本主题下是 rgba(0,113,227,.1) 的淡蓝），
   * 于是它在「dshworkspace | 标准模式」那一行里看起来是个突兀的蓝色胶囊。
   */
  const button = (
    <button
      type="button"
      aria-label="专家团"
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="从团队画廊里挑一支专家团，为每位专家开独立子会话"
      style={host !== null
        ? rowChip(state.open || hover ? { background: HOVER_BG } : {})
        : chip(state.open
          ? {
            background: 'var(--dsw-alias-button-primary-fill, #111827)',
            color: 'var(--dsw-static-neutral-00, #ffffff)',
          }
          : hover ? { background: HOVER_BG } : {})}
    >
      <IconUsersInline size={host !== null ? 16 : 14} />
      专家团
    </button>
  )

  return host !== null ? createPortal(button, host) : button
}

/* ------------------------------------------------------------------ *
 *  画廊
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  输入卡片内的「已召唤专家团」标签
 * ------------------------------------------------------------------ */

/**
 * 「已召唤」状态下的入口 chip —— 由 `Trigger` 在同一位置渲染（不再单独注册槽位）。
 *
 * 为什么不是另挂一个槽：早先它挂在 `conversation.input.dock`，也就是**输入卡片上方那条
 * 独占一行的区域**。那里离输入框远、上下都空，一个孤零零的小胶囊很突兀，还白占一行高度；
 * 而 hero 行里本来就有一个「👥 专家团」入口 —— 状态与入口本就是同一件事，
 * 于是合并：召唤后原地换成团队标签，取消召唤即还原成入口。
 * 宿主与版式全部由 `Trigger` 传入（`host` / 两套 chip 样式），这里只管内容与行为。
 *
 * 标签上承载三件事：团队名（点击回画廊换人、悬停出 ×）、已选成员计数、成员下拉。
 * 它还负责**拦截这次提交**：用户在输入框写完需求后按 Enter / 点发送，
 * 这段需求应当作为专家团的任务被派出去，而不是当成普通消息发给主会话。
 * DSH 的 `InputActions` 只有 setDraft/submit，没有提交钩子，所以只能在
 * document 捕获阶段拦 Enter 与「卡片内最后一个可用按钮」。
 */
/** 成员下拉的最大高度（超出就内部滚动）。 */
const MENU_MAX_HEIGHT = 320

function ActiveTeamChip(props) {
  const state = useStore()
  const sessionId = sessionIdOf(props)
  const active = activeOf(state, sessionId)
  /*
   * 渲染位置由 Trigger 决定（它自己就是那个入口 chip）：
   * · host 非空 → portal 进 hero 行 / 就地落在工具行，版本取 rowChip / chip，与邻居同规格；
   * · host 为空（冒烟环境、或行还没解析出来）→ 原地渲染，不 portal。
   */
  const host = props?.host ?? null
  const inline = host !== null
  const onOpenPanel = props?.onOpenPanel
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState(false)
  const [menuRect, setMenuRect] = useState(null)
  const wrapRef = useRef(null)
  const busyRef = useRef(false)

  const activated = active !== null

  const dispatchWith = useCallback(async text => {
    if (busyRef.current || active === null || typeof sessionId !== 'string') return
    busyRef.current = true
    let direct = null
    try {
      direct = await api('/summon', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          teamId: active.team.id,
          task: text,
          memberIds: active.memberIds,
          ...Number.isInteger(active.stage) ? { stage: active.stage } : {},
        }),
      })
    } catch (error) {
      direct = { ok: false, error: String(error?.message ?? error) }
    }
    const actions = store.input
    if (actions !== undefined && actions !== null) {
      if (direct?.ok === true && Array.isArray(direct.dispatched) && direct.dispatched.length > 0) {
        actions.setDraft(summonBriefing(active.team, text, direct.dispatched, active.stage))
      } else {
        // 直连派遣不可用：把分工与失败原因一起交给模型，由它调用工具完成派遣。
        actions.setDraft(fallbackBriefing(active.team, text, active.memberIds, direct?.error, active.stage))
      }
      actions.submit()
    }
    busyRef.current = false
    deactivateTeam(sessionId)
  }, [active, sessionId])

  useEffect(() => {
    if (!activated) return undefined
    // 非浏览器环境（冒烟用的假 DOM / SSR）没有 event target，直接跳过拦截。
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const readDraft = () => {
      if (typeof document.querySelector !== 'function') return ''
      const editor = document.querySelector('[data-input-scroll] [contenteditable]')
      return String(editor?.innerText ?? editor?.textContent ?? '').trim()
    }
    const takeOver = () => {
      const text = readDraft()
      if (text === '') return false
      void dispatchWith(text)
      return true
    }
    const onKeyDown = event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (typeof target?.closest !== 'function') return
      if (target.closest('[data-input-scroll]') === null) return
      if (!takeOver()) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onClick = event => {
      const target = event.target
      if (typeof target?.closest !== 'function') return
      const card = target.closest('[data-composer-card]')
      if (card === null || typeof card.querySelectorAll !== 'function') return
      const button = target.closest('button')
      if (button === null || button.disabled === true) return
      // 带 aria-haspopup 的都是下拉型控件（命令 / 权限 / 计划 / 模型 / 工作区），不是提交。
      if (typeof button.hasAttribute === 'function' && button.hasAttribute('aria-haspopup')) return
      // 提交按钮是卡片里最后一个可用 button（其后的 model 选择器与 ContextMeter 都不满足上面两条）。
      const usable = Array.from(card.querySelectorAll('button')).filter(item => item.disabled !== true)
      if (usable[usable.length - 1] !== button) return
      if (!takeOver()) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('click', onClick, true)
    return () => {
      if (typeof document.removeEventListener !== 'function') return
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [activated, dispatchWith])

  useEffect(() => {
    if (!menu) return undefined
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onDown = event => {
      const target = event.target
      if (typeof target?.closest === 'function' && target.closest('[data-expert-team-member-menu]') !== null) return
      setMenu(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => {
      if (typeof document.removeEventListener !== 'function') return
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [menu])

  const toggleMenu = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect?.()
    /*
     * 菜单默认挂在 chip 下方 —— 但 chip 现在活在**输入卡片工具行**（页面最底部），
     * 下方根本没有 320px 可用：向下开会被输入卡片连同视口一起裁掉，只剩标题行露在外面。
     * 所以按可用空间选方向：哪边宽就往哪边开，并把 maxHeight 收进那一侧的空间里。
     *
     * 向上开时用 `bottom` 而不是「自己算一个 top」：菜单高度由内容决定，开之前并不知道，
     * 贴上边界只给 `maxHeight`，剩下的交给布局引擎。用 top 就得先猜高度再二次校正。
     */
    const viewportH = typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : 800
    const GAP = 6
    if (rect !== undefined && rect !== null && Number.isFinite(rect.top)) {
      const below = viewportH - rect.bottom - GAP
      const above = rect.top - GAP
      const openUp = below < Math.min(MENU_MAX_HEIGHT, above)
      setMenuRect(openUp
        ? {
          left: rect.left,
          fromTop: false,
          offset: viewportH - rect.top + GAP,
          maxHeight: Math.max(140, above - 8),
        }
        : {
          left: rect.left,
          fromTop: true,
          offset: rect.bottom + GAP,
          maxHeight: Math.max(140, below - 8),
        })
    } else {
      // 拿不到真实布局（假 DOM / 尚未挂载）时给一个兜底坐标，菜单照开不误。
      setMenuRect({ left: 16, fromTop: true, offset: 96, maxHeight: MENU_MAX_HEIGHT })
    }
    setMenu(value => !value)
  }, [])

  if (active === null) return null

  const { team, memberIds } = active
  /*
   * 阶段计划：`team.stages` 为空 = 这支团队没有阶段概念（菜单里不出现分批入口）。
   * 进入分批模式后，成员勾选由阶段决定 —— 见 setActiveMembers 的注释。
   */
  const plan = Array.isArray(team.stages) ? team.stages : []
  const staged = plan.length > 1
  const activeStage = Number.isInteger(active.stage) ? active.stage : null
  const stageMembers = activeStage === null
    ? team.members
    : team.members.filter(member => (plan.find(item => item.stage === activeStage)?.members ?? []).includes(member.id))
  const accent = team.accent || '#4F46E5'
  const iconButton = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: S.muted,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 0,
    flex: 'none',
  }

  const menuNode = menu && menuRect !== null ? portalToBody(
    <div
      data-expert-team-member-menu
      style={{
        position: 'fixed',
        left: Math.max(8, menuRect.left),
        /* 贴着 chip 的那一侧：向下开给 top，向上开给 bottom（见 toggleMenu）。 */
        ...(menuRect.fromTop === true ? { top: menuRect.offset } : { bottom: menuRect.offset }),
        zIndex: 9999,
        width: 288,
        maxHeight: menuRect.maxHeight ?? MENU_MAX_HEIGHT,
        overflowY: 'auto',
        background: S.surface,
        border: `1px solid ${S.line}`,
        borderRadius: 12,
        boxShadow: 'var(--dsw-shadow-lv2, 0 16px 40px rgba(15, 23, 42, 0.18))',
        padding: 10,
        fontFamily: FONT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: S.text }}>
          {activeStage === null
            ? `派遣成员（${memberIds.length}/${team.members.length}）`
            : `第 ${activeStage} 阶段（${stageMembers.length} 位）`}
        </span>
        <button
          type="button"
          style={btn({ padding: '2px 8px', fontSize: 12 })}
          onClick={() => setActiveMembers(sessionId, team.members.map(member => member.id))}
        >
          全选
        </button>
      </div>
      {/*
       * 分批派遣入口：点某一阶段就「只派这一阶段的成员」，派出后面板不再插手 ——
       * 后续阶段由召集人收齐产出后带 context 接力（见 summonBriefing）。
       */}
      {staged && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 4px 8px' }}>
          <button
            type="button"
            style={stageChip(activeStage === null, accent)}
            onClick={() => setActiveStage(sessionId, team, null)}
          >
            一次性
          </button>
          {plan.map(item => (
            <button
              key={item.stage}
              type="button"
              title={item.name !== undefined && item.name !== '' ? item.name : `第 ${item.stage} 阶段`}
              style={stageChip(activeStage === item.stage, accent)}
              onClick={() => setActiveStage(sessionId, team, item.stage)}
            >
              {`P${item.stage}${item.name !== undefined && item.name !== '' ? ` ${item.name}` : ''}`}
            </button>
          ))}
        </div>
      )}
      {stageMembers.map(member => {
        const on = stageMembers !== team.members ? true : memberIds.includes(member.id)
        return (
          <label
            key={member.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 6px',
              borderRadius: 8,
              cursor: 'pointer',
              background: on ? `${accent}0f` : 'transparent',
            }}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={activeStage !== null}
              onChange={() => setActiveMembers(
                sessionId,
                on ? memberIds.filter(id => id !== member.id) : [...memberIds, member.id],
              )}
            />
            <PersonAvatar seed={member.id} avatar={member.avatar} size={24} />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 13, color: S.text }}>{member.name}</span>
              <span style={{ fontSize: 11.5, color: S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {member.focus || '—'}
              </span>
            </span>
          </label>
        )
      })}
    </div>,
  ) : null

  const node = (
    <>
      <div
        ref={wrapRef}
        data-expert-team-active-chip
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          /*
           * 规格直接借入口 chip 的两套样式（hero 行 rowChip / 工具行 chip），
           * 差别只剩「淡色底 + 描边」这一层状态色 —— 它和同行邻居必须看起来是同一套控件。
           * 两个关键属性：
           * · `flex: none`（来自 rowChip / chip）挡住 flex 行把标签拉长；
           * · `boxSizing: border-box` 让这 1px 描边不把高度顶出 28px。
           */
          ...(inline ? rowChip() : chip()),
          gap: 2,
          boxSizing: 'border-box',
          maxWidth: '100%',
          background: `${accent}14`,
          border: `1px solid ${accent}2e`,
          // 悬停 / 菜单展开加深，与邻居 chip 的悬停反馈是同一语义。
          ...((hover || menu) ? { background: `${accent}24`, borderColor: `${accent}59` } : {}),
        }}
      >
        {/*
         * 团队名区域 = 「打开画廊换一支」。它沿用入口的 aria-label="专家团"：
         * 真实浏览器脚本与无障碍都靠这个锚点定位，换团队时不能让锚点消失。
         */}
        <button
          type="button"
          aria-label="专家团"
          title="打开团队画廊，换一支专家团"
          onClick={onOpenPanel}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            height: '100%',
            padding: '0 2px',
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontFamily: FONT,
            fontSize: inline ? 13 : 14,
            fontWeight: 600,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          {/*
           * 色点而不是 18px 的人物插画：插画是 64 视框的细节画，缩到 16px 会糊成一个色块；
           * 纯单色图标又和入口的「👥」分不开。色点接过团队 accent，一眼认得出是哪支队。
           */}
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, flex: 'none' }} />
          <span style={{ minWidth: 0, maxWidth: 168, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {team.name}
          </span>
          <span style={{ color: S.muted, fontSize: 11.5, fontWeight: 400, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
            {activeStage === null
              ? `${memberIds.length}/${team.members.length}`
              : `P${activeStage} ${stageMembers.length}/${team.members.length}`}
          </span>
        </button>
        {(hover || menu) && (
          <button
            type="button"
            aria-label="取消召唤专家团"
            title="取消召唤"
            onClick={() => { setMenu(false); deactivateTeam(sessionId) }}
            style={iconButton}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
              <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          aria-label="选择派遣成员"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={toggleMenu}
          style={iconButton}
        >
          <svg
            viewBox="0 0 16 16"
            width="10"
            height="10"
            aria-hidden
            style={{ transform: menu ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
          >
            <path d="M4 6.5 L8 10.5 L12 6.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {menuNode}
    </>
  )

  return inline ? createPortal(node, host) : node
}

const SORTS = [['default', '综合'], ['hot', '最热'], ['new', '最新']]

/** 全部内置分类 + 数据里出现的其他分类，保持稳定顺序（按团队出现次序）。 */
function categoriesOf(teams) {
  const seen = new Set()
  const list = []
  for (const team of teams) {
    const category = typeof team.category === 'string' ? team.category.trim() : ''
    if (category !== '' && !seen.has(category)) {
      seen.add(category)
      list.push(category)
    }
  }
  return list
}

function sortTeams(teams, sort) {
  const list = [...teams]
  if (sort === 'hot') return list.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
  // 「最新」按创建时间倒序；没有时间戳的（老数据 / 用户手写的）排到最后。
  if (sort === 'new') {
    return list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  }
  return list
}

function Tag({ children }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        lineHeight: '18px',
        color: S.body,
        background: S.soft,
        borderRadius: 6,
        padding: '1px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function TeamCard({ team, onOpen }) {
  const accent = team.accent || '#4F46E5'
  /*
   * 流程形态徽标：数据驱动，不写死。
   * 有阶段声明（team.stages）的团队是「分阶段流水线」——成员菜单里可以逐阶段派遣；
   * 没有阶段声明的是「并行视角」——所有专家拿到同一份任务各写一份，召集人汇总。
   * 内置 10 支与用户自建的三支现在都是流水线团队；「并行视角」留给不带 stages 的团队
   * （那仍是一等公民：旧行为逐字保留，只是没有分批入口）。
   */
  const plan = Array.isArray(team.stages) ? team.stages : []
  const staged = plan.length > 1
  const tags = [
    ...(team.source === 'custom' ? ['自定义'] : []),
    ...(Array.isArray(team.tags) ? team.tags : []),
  ].slice(0, 3)
  return (
    <button
      type="button"
      onClick={() => onOpen(team.id)}
      style={{
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        border: `1px solid ${S.line}`,
        borderRadius: S.radius,
        background: S.surface,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 172,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <TeamAvatar team={team} size={44} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: S.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {team.name}
          </div>
          <div style={{ fontSize: 12, color: S.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {`${team.publisher || 'DSH 官方团队'} · ${team.members.length} 位专家`}
          </div>
        </div>
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: '19px',
          color: S.body,
          height: 57,
          overflow: 'hidden',
          flex: 1,
        }}
      >
        {team.tagline}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <span
          title={staged
            ? plan.map(item => `P${item.stage}${item.name !== undefined && item.name !== '' ? ` ${item.name}` : ''}`).join(' → ')
            : '每位专家独立产出，由召集人汇总'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: '18px',
            background: staged ? `${accent}1f` : 'var(--dsw-alias-interactive-bg-hover, #f3f4f6)',
            color: staged ? accent : S.muted,
            border: `1px solid ${staged ? `${accent}33` : S.line}`,
          }}
        >
          {staged ? `${plan.length} 阶段流水线` : '并行视角'}
        </span>
        {tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
      </div>
    </button>
  )
}

function Gallery({ state, onOpenTeam, onCreate, onSort, onCategory }) {
  const categories = useMemo(() => ['全部', ...categoriesOf(state.teams)], [state.teams])
  const visible = useMemo(() => {
    const filtered = state.category === '全部'
      ? state.teams
      : state.teams.filter(team => team.category === state.category)
    return sortTeams(filtered, state.sort)
  }, [state.teams, state.category, state.sort])

  const total = `${state.teams.length} 支团队`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: S.text }}>专家团</span>
        <span style={{ fontSize: 12.5, color: S.muted, marginLeft: 4 }}>{state.teams.length > 0 ? total : ''}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {SORTS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSort(key)}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 14,
                padding: '4px 10px',
                borderRadius: 8,
                color: state.sort === key ? S.strong : S.muted,
                fontWeight: state.sort === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
        {categories.map(category => {
          const active = state.category === category
          return (
            <button
              key={category}
              type="button"
              onClick={() => onCategory(category)}
              style={{
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13.5,
                padding: '6px 14px',
                borderRadius: 999,
                whiteSpace: 'nowrap',
                background: active ? 'var(--dsw-alias-interactive-bg-active, #eaeaec)' : 'transparent',
                color: active ? S.strong : S.body,
                fontWeight: active ? 600 : 400,
              }}
            >
              {category}
            </button>
          )
        })}
      </div>

      {!state.loaded && (
        <div style={{ padding: 40, textAlign: 'center', color: S.muted }}>正在加载专家团…</div>
      )}

      {state.loaded && state.teams.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: S.muted }}>
          还没有任何专家团。
          <div style={{ marginTop: 12 }}>
            <button type="button" style={primaryBtn()} onClick={onCreate}>新建一支专家团</button>
          </div>
        </div>
      )}

      {state.loaded && state.teams.length > 0 && visible.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: S.muted }}>
          {`「${state.category}」分类下暂时没有团队。`}
        </div>
      )}

      {visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(236px, 1fr))', gap: 12 }}>
          {visible.map(team => (
            <TeamCard key={team.id} team={team} onOpen={onOpenTeam} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  详情
 * ------------------------------------------------------------------ */

function SectionTitle({ icon, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: S.strong }}>
      {icon}
      <span style={{ fontSize: 16, fontWeight: 600 }}>{children}</span>
    </div>
  )
}

function Detail({ team, onBack, onEdit, onSummoned, onOpenCase, onRefresh, state }) {
  /*
   * 点开的是哪一位成员。放在本组件内部即可：详情页本身由 `key={team.id}` 锚定，
   * 换团队会重挂，不需要把它提升到 store（不像案例弹窗那样要被别的视图唤起）。
   */
  const [memberView, setMemberView] = useState(null)
  /**
   * 「召唤」不再在面板里填任务：点下去就把这支团队挂到输入卡片上、关掉面板、
   * 把焦点交给 DSH 输入框，用户直接在输入框里写需求。
   * 预设提问与使用案例是「带一句话进输入框」的快捷方式。
   */
  const summon = useCallback(draftText => {
    activateTeam(team, draftText)
    onSummoned()
  }, [team, onSummoned])

  const accent = team.accent || '#4F46E5'
  /*
   * 这支团队现在能不能改：自定义团队永远可改；内置团队看 config.lockBuiltinTeams ——
   * 开发阶段它是 false（**不锁定**），所以内置团队同样出「编辑」入口、成员同样可改；
   * 定稿后把它置 true，就退回「内置只读、只能另存为自定义」的形态。
   */
  const locked = state?.config?.lockBuiltinTeams === true
  const editable = team.source === 'custom' || !locked
  const caseTags = Array.isArray(team.tags) ? team.tags.slice(0, 3) : []
  /** 当前点开的那位成员（团队被换掉时自然变回 null）。 */
  const viewedMember = memberView === null
    ? null
    : (team.members.find(item => item.id === memberView) ?? null)
  /** 阶段计划；空数组 = 这支团队没有流水线（一次性并行派遣）。 */
  const plan = Array.isArray(team.stages) ? team.stages : []
  const nameOfMember = id => team.members.find(item => item.id === id)?.name ?? id

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" style={btn({ padding: '4px 10px' })} onClick={onBack}>← 全部团队</button>
        {editable && (
          <button type="button" style={btn({ padding: '4px 10px' })} onClick={() => onEdit(team)}>编辑</button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <TeamAvatar team={team} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: S.text }}>{team.name}</span>
          </div>
          {team.tagline !== '' && (
            <div style={{ fontSize: 13.5, color: S.body, marginTop: 6 }}>{team.tagline}</div>
          )}
          {/*
           * 流水线团队先把阶段摊开：让用户知道「点了召唤之后，这条线是怎么走的」，
           * 以及哪一阶段可以先派（分批派遣的入口在输入框那枚标签的成员菜单里）。
           */}
          {plan.length > 1 && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: S.muted }}>
                {`分阶段流水线 · ${plan.length} 个阶段（可逐阶段派遣，上一阶段产出会成为下一阶段输入）`}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {plan.map(item => (
                  <span
                    key={item.stage}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: 12.5,
                      background: 'var(--dsw-alias-interactive-bg-hover, #f3f4f6)',
                      border: `1px solid ${S.line}`,
                      color: S.body,
                    }}
                  >
                    <span style={{ fontWeight: 600, color: S.text }}>
                      {`P${item.stage}${item.name !== undefined && item.name !== '' ? ` ${item.name}` : ''}`}
                    </span>
                    <span style={{ color: S.muted }}>{item.members.map(nameOfMember).join('、')}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              onClick={() => summon()}
              style={{ ...primaryBtn(), borderRadius: 999, padding: '0 22px', height: 44, fontSize: 15 }}
            >
              <IconSend />
              召唤专家团
            </button>
          </div>
        </div>
      </div>

      {team.presets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {team.presets.map(preset => (
            <button
              key={preset}
              type="button"
              onClick={() => summon(preset)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                width: '100%',
                boxSizing: 'border-box',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                background: S.soft,
                borderRadius: S.radius,
                padding: '15px 18px',
                color: S.text,
              }}
            >
              <span style={{ fontSize: 15 }}>{`“${preset}”`}</span>
              <span style={{ color: S.muted, display: 'inline-flex' }}><IconChat /></span>
            </button>
          ))}
        </div>
      )}

      {team.cases.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionTitle icon={<IconGrid />}>使用案例</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {team.cases.map((item, caseIndex) => (
              <button
                key={item.title}
                type="button"
                onClick={() => onOpenCase(caseIndex)}
                style={{
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  border: `1px solid ${S.line}`,
                  borderRadius: 10,
                  background: S.surface,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    height: 108,
                    borderRadius: 8,
                    background: `linear-gradient(135deg, ${accent}14, ${accent}05)`,
                    border: `1px solid ${accent}1f`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 34,
                  }}
                >
                  {item.emoji || '📄'}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: S.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title}
                </div>
                {item.desc !== '' && (
                  <div style={{ fontSize: 13, color: S.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.desc}
                  </div>
                )}
                {caseTags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {caseTags.map(tag => <Tag key={tag}>{tag}</Tag>)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionTitle icon={<IconUsers />}>{`团队成员`}</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '18px 12px' }}>
          {team.members.map(member => (
            /*
             * 整格是一个按钮：点开成员详情。
             * 视觉刻意保持原来的「无边框名册」—— 只是多了一个淡淡的 `›` 提示可点，
             * 免得把用户已经认可的那一栏改成一片卡片墙。
             */
            <button
              key={member.id}
              type="button"
              aria-label={`查看成员详情：${member.name}`}
              title="查看 / 编辑这位专家"
              onClick={() => setMemberView(member.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 0,
                padding: '6px 8px',
                margin: '-6px -8px',
                textAlign: 'left',
                font: 'inherit',
                color: 'inherit',
                cursor: 'pointer',
                borderRadius: 10,
                border: '1px solid transparent',
                background: 'transparent',
              }}
            >
              <PersonAvatar seed={member.id} avatar={member.avatar} size={40} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: S.text }}>{member.name}</span>
                  {member.role === 'lead' && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        fontSize: 11,
                        lineHeight: '18px',
                        color: S.body,
                        background: S.soft,
                        borderRadius: 999,
                        padding: '0 7px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      🏅 主理人
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: S.body, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {member.alias !== '' ? `${member.alias} · ${member.focus || '—'}` : (member.focus || '—')}
                </div>
              </div>
              <span aria-hidden style={{ flex: 'none', fontSize: 15, color: S.muted }}>›</span>
            </button>
          ))}
        </div>
      </section>

      {viewedMember !== null && (
        <MemberDialog
          team={team}
          member={viewedMember}
          // 可改性跟着 config.lockBuiltinTeams 走：开发阶段内置团队同样能改成员。
          readOnly={!editable}
          onClose={() => setMemberView(null)}
          onSaved={() => {
            setMemberView(null)
            void onRefresh?.()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  图标选择器（团队头像 / 成员 emoji 共用）
 * ------------------------------------------------------------------ */

/**
 * 头像选择器：36 张插画铺成网格，点一下就换。
 *
 * 交互沿用科研 agent 项目里那套 IconPicker 的思路（**点选，不用手打字符**），
 * 外加一个「推荐这张」的 chip —— 点它就把按名称算出来的那张收下，也可以直接点网格里任意一张覆盖。
 *
 * `compact` 给成员行用：默认只显示一个小小的当前头像，点开才在下方铺开网格，
 * 免得每多一位专家就多铺一屏缩略图。
 */
function AvatarPicker({ value, suggested, onChange, compact = false, hint, name }) {
  const [open, setOpen] = useState(!compact)
  // `value` 是头像索引（number）。没挑过就落在「推荐」上，再没有就落到第一张。
  const active = typeof value === 'number' ? value : (typeof suggested === 'number' ? suggested : 0)
  const recommendable = typeof suggested === 'number' && suggested !== active
  /** 展开按钮的 aria-label：一个表单里可能同时有团队级与多位成员的选择器，必须能区分。 */
  const triggerLabel = name === undefined ? '选择头像' : `选择头像：${name}`

  const chip = (label, onClick, extra) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flex: 'none',
        padding: '2px 9px',
        fontSize: 12,
        lineHeight: '20px',
        fontFamily: 'inherit',
        color: S.body,
        background: S.soft,
        border: `1px solid ${S.line}`,
        borderRadius: 999,
        cursor: 'pointer',
        ...extra,
      }}
    >{label}</button>
  )

  const grid = (
    <div
      role="radiogroup"
      aria-label={`${triggerLabel}：网格`}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, maxWidth: 396 }}
    >
      {Array.from({ length: AVATAR_COUNT }, (unused, index) => {
        const on = index === active
        return (
          <button
            key={index}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`选择头像 ${avatarFile(index)}`}
            title={avatarFile(index)}
            onClick={() => onChange(index)}
            style={{
              width: 38,
              height: 38,
              flex: 'none',
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              borderRadius: '50%',
              background: 'transparent',
              border: `2px solid ${on ? 'var(--dsw-alias-brand-primary, #6366f1)' : 'transparent'}`,
              boxShadow: on ? '0 0 0 3px var(--dsw-alias-interactive-bg-hover-accent, rgba(99, 102, 241, 0.16))' : 'none',
            }}
          >
            <AvatarImage index={index} size={32} />
          </button>
        )
      })}
    </div>
  )

  return (
    <div data-avatar-picker={name ?? ''} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          aria-label={triggerLabel}
          aria-expanded={open}
          title="点这里展开头像网格"
          onClick={() => setOpen(current => !current)}
          style={{
            width: compact ? 36 : 50,
            height: compact ? 36 : 50,
            flex: 'none',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: '50%',
            background: 'transparent',
            border: `1px solid ${S.line}`,
          }}
        >
          <AvatarImage index={active} size={compact ? 30 : 44} />
        </button>

        {recommendable && chip(
          '推荐这张',
          () => onChange(suggested),
          { color: 'var(--dsw-alias-state-business-primary, #4338ca)', background: 'var(--dsw-alias-state-business-tertiary, #eef2ff)', borderColor: 'var(--dsw-alias-border-l2, #c7d2fe)' },
        )}
        {chip('换一个', () => onChange(nextAvatar(active)))}
        {chip(open ? '收起' : '换头像', () => setOpen(current => !current))}
        {hint !== undefined && <span style={{ fontSize: 11.5, color: S.muted }}>{hint}</span>}
      </div>
      {open && grid}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  编辑器
 * ------------------------------------------------------------------ */

const BLANK_MEMBER = { id: '', name: '', alias: '', emoji: '🙂', role: 'member', focus: '', persona: '' }

function TeamEditor({ initial, onCancel, onSaved, config }) {
  /* 各项上限来自服务端 config（可被 config.json 覆盖），缺省值只作兜底。 */
  const limits = config?.limits ?? {}
  const [form, setForm] = useState(() => ({
    id: initial?.id ?? '',
    name: initial?.name ?? '',
    tagline: initial?.tagline ?? '',
    // emoji 不再出现在表单里，但**原样透传**：老数据里存着它，别在一次编辑里把它弄丢。
    emoji: initial?.emoji ?? '👥',
    avatar: typeof initial?.avatar === 'number' ? initial.avatar : null,
    accent: initial?.accent ?? '#4F46E5',
    category: initial?.category ?? '',
    tagsText: (initial?.tags ?? []).join('、'),
    presetsText: (initial?.presets ?? []).join('\n'),
    members: initial !== null && initial !== undefined && initial.members.length > 0
      ? initial.members.map(member => ({ ...BLANK_MEMBER, ...member, persona: member.persona ?? '' }))
      : [{ ...BLANK_MEMBER, id: 'expert-1', role: 'lead' }, { ...BLANK_MEMBER, id: 'expert-2' }],
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  /*
   * 用户是否亲手挑过团队头像。编辑已有团队时默认「挑过」—— 不能让推荐把人家存好的头像改掉；
   * 新建时默认没挑过，于是表单打开时会自动落一张（见下面的 effect）。
   */
  const [avatarTouched, setAvatarTouched] = useState(initial !== null && initial !== undefined)

  const setField = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const pickAvatar = value => { setAvatarTouched(true); setField('avatar', value) }
  const setMember = (index, key, value) => setForm(current => ({
    ...current,
    members: current.members.map((member, i) => (i === index ? { ...member, [key]: value } : member)),
  }))
  const addMember = () => setForm(current => ({
    ...current,
    members: [...current.members, { ...BLANK_MEMBER, id: `expert-${current.members.length + 1}` }],
  }))
  const removeMember = index => setForm(current => ({
    ...current,
    members: current.members.filter((_, i) => i !== index),
  }))

  /*
   * 推荐头像：按团队 id / 名称稳定算一张（纯函数，见 team-icons.js）。
   *
   * 注意这里**不做连续跟随**：索引是从文本哈希来的，跟着输入走会「每敲一个字就换张脸」，
   * 比不推荐还闹心。所以只在「用户还没挑过、而且还没落过值」时自动落一次，
   * 之后推荐值只作为 chip 显示，用户点它才采用。
   */
  const seed = form.id !== '' ? form.id : form.name
  const recommendedAvatar = suggestAvatar(seed)

  useEffect(() => {
    if (avatarTouched || form.avatar !== null) return
    setForm(current => (current.avatar === null ? { ...current, avatar: recommendedAvatar } : current))
  }, [avatarTouched, form.avatar, recommendedAvatar])

  const save = async () => {
    setBusy(true)
    setError(null)
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      tagline: form.tagline.trim(),
      emoji: form.emoji.trim(),
      avatar: form.avatar,
      accent: form.accent,
      category: form.category.trim(),
      // 标签用中文顿号 / 逗号 / 空格分隔都接受，服务端会再截断到 4 个。
      tags: form.tagsText.split(/[、,，\s]+/).map(tag => tag.trim()).filter(tag => tag !== ''),
      presets: form.presetsText.split('\n').map(line => line.trim()).filter(line => line !== ''),
      members: form.members.map(member => ({
        id: member.id.trim(),
        name: member.name.trim(),
        alias: member.alias.trim(),
        emoji: member.emoji.trim(),
        avatar: typeof member.avatar === 'number' ? member.avatar : null,
        role: member.role,
        focus: member.focus.trim(),
        persona: member.persona.trim(),
      })),
    }
    try {
      await api('/teams', { method: 'POST', body: JSON.stringify({ team: payload }) })
      onSaved()
    } catch (caught) {
      setError(String(caught?.message ?? caught))
    }
    setBusy(false)
  }

  const field = (label, value, onChange, placeholder, mono = false) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.body }}>
      {label}
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        style={{
          border: `1px solid ${S.line}`,
          borderRadius: 8,
          padding: '7px 10px',
          fontSize: 13,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
          color: S.text,
          background: S.surface,
        }}
      />
    </label>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" style={btn({ padding: '4px 10px' })} onClick={onCancel}>← 返回</button>
        <span style={{ fontSize: 16, fontWeight: 600, color: S.text }}>
          {initial !== null && initial !== undefined ? '编辑专家团' : '新建专家团'}
        </span>
      </div>

      {initial?.source === 'builtin' && (
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: S.body, background: 'var(--dsw-alias-state-business-tertiary, #eef2ff)', border: '1px solid var(--dsw-alias-border-l2, #c7d2fe)', borderRadius: 8, padding: 10 }}>
          这是一支内置团队。开发阶段可以直接改：保存后会把它写进用户目录
          （$DSH_HOME/expert-teams/teams.json）作为同 id 副本覆盖内置基线 ——
          此后插件升级带来的这支队的内置更新不会自动覆盖你的改动。
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {field('团队 id（小写 kebab-case，召唤时用）', form.id, value => setField('id', value), 'my-team', true)}
        {field('团队名称', form.name, value => setField('name', value), '我的专家团')}
        {field('一句话简介', form.tagline, value => setField('tagline', value), '竞品分析 / 路线图 / 复盘')}
        {field(`分类（画廊筛选行的分类名，≤${limits.maxCategory ?? 12} 字）`, form.category, value => setField('category', value), '技术工程')}
        {field(`标签（最多 ${limits.maxTags ?? 4} 个，用顿号分隔）`, form.tagsText, value => setField('tagsText', value), '代码评审、安全审计')}
        <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: S.body }}>团队图标（点格子挑一张，或直接采纳推荐）</span>
          <AvatarPicker
            value={form.avatar}
            suggested={recommendedAvatar}
            onChange={pickAvatar}
            name="团队图标"
          />
        </div>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.body }}>
        预设提问（每行一条，显示为详情页的快捷提问条）
        <textarea
          value={form.presetsText}
          onChange={event => setField('presetsText', event.target.value)}
          rows={3}
          style={{ border: `1px solid ${S.line}`, borderRadius: 8, padding: 10, fontSize: 13, fontFamily: 'inherit', color: S.text, resize: 'vertical', background: S.surface }}
        />
      </label>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: S.text }}>{`团队成员（${form.members.length}）`}</span>
          <button type="button" style={btn({ padding: '3px 10px', fontSize: 12 })} onClick={addMember}>+ 添加专家</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {form.members.map((member, index) => (
            <div key={index} style={{ border: `1px solid ${S.line}`, borderRadius: 10, padding: 12, background: S.surface, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px auto', gap: 8, alignItems: 'end' }}>
                {field('成员 id', member.id, value => setMember(index, 'id', value), 'analyst', true)}
                {field('称呼', member.name, value => setMember(index, 'name', value), '竞品分析师')}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.body }}>
                  角色
                  <select
                    value={member.role}
                    onChange={event => setMember(index, 'role', event.target.value)}
                    style={{ border: `1px solid ${S.line}`, borderRadius: 8, padding: '7px 8px', fontSize: 13, fontFamily: 'inherit', color: S.text, background: S.surface }}
                  >
                    <option value="member">成员</option>
                    <option value="lead">主理人</option>
                  </select>
                </label>
                <button
                  type="button"
                  style={btn({ padding: '7px 10px', fontSize: 12 })}
                  onClick={() => removeMember(index)}
                  disabled={form.members.length <= 1}
                >
                  删除
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {field('昵称（可选）', member.alias, value => setMember(index, 'alias', value), '竞析')}
                {field('职责范围', member.focus, value => setMember(index, 'focus', value), '竞品对标与差异化')}
              </div>
              {/* 图标单独占一行：网格展开时不会把上面那两列挤变形。 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: S.body }}>成员头像（名册与成员详情里显示的那张图）</span>
                <AvatarPicker
                  compact
                  value={member.avatar}
                  suggested={suggestAvatar(member.id !== '' ? member.id : member.name)}
                  onChange={value => setMember(index, 'avatar', value)}
                  name={member.name !== '' ? member.name : `成员 ${index + 1}`}
                />
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.body }}>
                人格设定 persona（这位专家在独立子会话里的角色提示词，必填）
                <textarea
                  value={member.persona}
                  onChange={event => setMember(index, 'persona', event.target.value)}
                  rows={4}
                  placeholder="你是「竞品分析师」。你的职责是……你的工作方式是……你的交付物是……你的纪律是……"
                  style={{ border: `1px solid ${S.line}`, borderRadius: 8, padding: 10, fontSize: 12.5, fontFamily: 'inherit', color: S.text, resize: 'vertical', background: S.soft }}
                />
              </label>
            </div>
          ))}
        </div>
      </div>

      {error !== null && (
        <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #b42318)', background: 'var(--dsw-alias-bg-layer-2, #fef3f2)', border: '1px solid var(--dsw-alias-state-error-secondary, #fecdca)', borderRadius: 8, padding: 10 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primaryBtn({ opacity: busy ? 0.6 : 1 })} disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存团队'}
        </button>
        <button type="button" style={btn()} onClick={onCancel}>取消</button>
      </div>
      <div style={{ fontSize: 12, color: S.body, lineHeight: 1.6 }}>
        自定义团队保存在 <code>$DSH_HOME/expert-teams/teams.json</code>。与内置团队同 id 时会覆盖内置版本；删除自定义团队后会恢复内置版本。
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  成员详情（查看 / 编辑）
 * ------------------------------------------------------------------ */

/**
 * 把 persona 拆成「角色 / 职责 / 工作方式 / 交付物 / 纪律」几块来**展示**。
 *
 * 数据模型里没有独立的「工作流程」字段 —— 这套信息本来就写在 persona 这一整段提示词里
 * （内置团队的标准写法是「你是「X」。你的职责是…你的工作方式是…你的交付物是…你的纪律是…」）。
 * 所以查看态按这些标记切成小节、编辑态仍然整段编辑：**展示结构化，存储不结构化**，
 * 一个字段都不用加、一条数据都不用迁。拆不出来就整段回显，不会因为格式自由而丢内容。
 */
function splitPersona(persona) {
  const text = String(persona ?? '').trim()
  if (text === '') return []
  const marks = [
    { label: '职责', re: /你的职责是[：:]?/u },
    { label: '工作方式', re: /你的工作方式是[：:]?/u },
    { label: '交付物', re: /你的交付物是[：:]?/u },
    { label: '纪律', re: /你的纪律是[：:]?/u },
  ]
  const hits = []
  for (const mark of marks) {
    const found = mark.re.exec(text)
    if (found !== null) hits.push({ label: mark.label, start: found.index, end: found.index + found[0].length })
  }
  if (hits.length === 0) return [{ label: '角色提示词', body: text }]
  hits.sort((a, b) => a.start - b.start)
  const blocks = []
  const head = text.slice(0, hits[0].start).trim()
  if (head !== '') blocks.push({ label: '角色', body: head })
  hits.forEach((hit, index) => {
    const stop = index + 1 < hits.length ? hits[index + 1].start : text.length
    blocks.push({ label: hit.label, body: text.slice(hit.end, stop).trim() })
  })
  return blocks.filter(block => block.body !== '')
}

const MEMBER_ROLE_LABEL = { lead: '🏅 主理人', member: '成员' }

/**
 * 成员详情弹窗：查看 + 编辑一位专家。
 *
 * 保存走 `POST /api/teams`（服务端本来就是幂等 upsert）—— 「改一位成员」= 把这份 team
 * 带着这一处改动整体回写，**接口层零改动**。回写用的是列表接口下发的原始 team 对象，
 * 所以团队级字段（名称/简介/图标/标签/预设提问）一个都不会被这次编辑碰掉。
 *
 * 内置团队只读：它在服务端是基线，回写同 id 等于把整支团队变成自定义副本 ——
 * 那是有副作用的操作，不该由一次「顺手改个职责」触发；面板上会写明怎么做。
 */
function MemberDialog({ team, member, readOnly = false, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({ ...member, persona: member.persona ?? '' }))
  const [personaEditing, setPersonaEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const editable = readOnly !== true
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))
  const blocks = splitPersona(draft.persona)

  const inputStyle = {
    border: `1px solid ${S.line}`,
    borderRadius: 8,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: 'inherit',
    color: S.text,
    background: editable ? S.surface : S.soft,
  }

  const line = (label, node) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.body }}>
      {label}
      {node}
    </label>
  )

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const members = team.members.map(item => (item.id === member.id
        ? {
          ...item,
          name: draft.name.trim(),
          alias: draft.alias.trim(),
          emoji: draft.emoji.trim(),
          avatar: draft.avatar,
          role: draft.role,
          focus: draft.focus.trim(),
          persona: draft.persona.trim(),
        }
        : item))
      await api('/teams', {
        method: 'POST',
        body: JSON.stringify({ team: { ...team, members } }),
      })
      onSaved()
    } catch (caught) {
      setError(String(caught?.message ?? caught))
    }
    setBusy(false)
  }

  return portalToBody(
    <div
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      style={{
        position: 'fixed',
        inset: 0,
        // 压在画廊模态（9999）之上：成员详情是从详情页里再开的一层。
        zIndex: 10000,
        background: 'var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.42))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-label={`成员详情：${member.name}`}
        style={{
          width: 'min(780px, 100%)',
          maxHeight: 'min(88vh, 880px)',
          overflowY: 'auto',
          background: S.surface,
          color: S.text,
          borderRadius: 16,
          border: `1px solid ${S.line}`,
          boxShadow: 'var(--dsw-shadow-lv3, 0 24px 70px rgba(15, 23, 42, 0.3))',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PersonAvatar seed={member.id} avatar={draft.avatar} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 17, fontWeight: 700 }}>{draft.name !== '' ? draft.name : member.id}</span>
              <span style={{ fontSize: 11.5, color: S.body, background: S.soft, borderRadius: 999, padding: '1px 8px' }}>
                {MEMBER_ROLE_LABEL[draft.role] ?? draft.role}
              </span>
              <span style={{ fontSize: 12, color: S.muted }}>{`${team.name} · ${member.id}`}</span>
            </div>
            <div style={{ fontSize: 12.5, color: S.body, marginTop: 3 }}>
              {`${draft.alias !== '' ? draft.alias : '—'} · ${draft.focus !== '' ? draft.focus : '—'}`}
            </div>
          </div>
          <button type="button" aria-label="关闭" style={btn({ padding: '4px 10px' })} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {line('称呼', (
            <input
              value={draft.name}
              disabled={!editable}
              onChange={event => set('name', event.target.value)}
              style={inputStyle}
            />
          ))}
          {line('昵称（可选）', (
            <input
              value={draft.alias}
              disabled={!editable}
              onChange={event => set('alias', event.target.value)}
              style={inputStyle}
            />
          ))}
          {line('职责范围', (
            <input
              value={draft.focus}
              disabled={!editable}
              onChange={event => set('focus', event.target.value)}
              style={inputStyle}
            />
          ))}
          {line('角色', (
            <select
              value={draft.role}
              disabled={!editable}
              onChange={event => set('role', event.target.value)}
              style={inputStyle}
            >
              <option value="member">成员</option>
              <option value="lead">主理人</option>
            </select>
          ))}
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: S.body }}>成员头像（名册 / 卡片上的那张图）</span>
            {editable
              ? (
                <AvatarPicker
                  compact
                  value={draft.avatar}
                  suggested={suggestAvatar(draft.id)}
                  onChange={value => set('avatar', value)}
                  name="成员头像"
                />
              )
              : <AvatarImage index={avatarIndexOf(draft.id, draft.avatar)} size={40} />}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              人格设定 persona（这位专家在独立子会话里的角色提示词）
            </span>
            {editable && (
              <button
                type="button"
                style={btn({ padding: '3px 10px', fontSize: 12 })}
                onClick={() => setPersonaEditing(current => !current)}
              >
                {personaEditing ? '看结构化视图' : '编辑原文'}
              </button>
            )}
          </div>

          {personaEditing
            ? (
              <textarea
                value={draft.persona}
                onChange={event => set('persona', event.target.value)}
                rows={10}
                style={{
                  border: `1px solid ${S.line}`,
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  fontFamily: 'inherit',
                  color: S.text,
                  resize: 'vertical',
                  background: S.soft,
                }}
              />
            )
            : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  background: S.soft,
                  border: `1px solid ${S.line}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                }}
              >
                {blocks.length === 0 && (
                  <span style={{ fontSize: 12.5, color: S.muted }}>还没有写人格提示词。</span>
                )}
                {blocks.map(block => (
                  <div key={block.label} style={{ display: 'flex', gap: 12 }}>
                    <span style={{ width: 62, flex: 'none', fontSize: 12, color: S.muted, paddingTop: 3 }}>
                      {block.label}
                    </span>
                    <span style={{ fontSize: 13, lineHeight: 1.75, color: S.body, whiteSpace: 'pre-wrap' }}>
                      {block.body}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </div>

        {!editable && (
          <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--dsw-alias-state-warn-label, #b45309)', background: 'var(--dsw-alias-state-warn-tertiary, #fff7ed)', border: '1px solid var(--dsw-alias-state-warn-secondary, #fed7aa)', borderRadius: 8, padding: 10 }}>
            内置团队只读（config.json 里 lockBuiltinTeams=true）。回写同 id 会把整支团队变成你的自定义副本 ——
            开发阶段想直接改它，把 $DSH_HOME/expert-teams/config.json 的 lockBuiltinTeams 改成 false 即可；
            否则请从详情页点「编辑」把它另存为自定义团队后再改。
          </div>
        )}

        {error !== null && (
          <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #b42318)', background: 'var(--dsw-alias-bg-layer-2, #fef3f2)', border: '1px solid var(--dsw-alias-state-error-secondary, #fecdca)', borderRadius: 8, padding: 10 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          {editable && (
            <button
              type="button"
              style={primaryBtn({ opacity: busy ? 0.6 : 1 })}
              disabled={busy}
              onClick={save}
            >
              {busy ? '保存中…' : '保存成员'}
            </button>
          )}
          <button type="button" style={btn()} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
  )
}

/* ------------------------------------------------------------------ *
 *  模态
 * ------------------------------------------------------------------ */

/**
 * 把节点挂到 `document.body`（拿不到 body 时原地渲染，保证降级可用）。
 *
 * 为什么模态必须挂 body：
 * `shell.overlay` 的容器（`_overlayLayer`）自己带 **z-index: 20**，因而**形成一个层叠上下文**。
 * 在它内部写多大的 z-index 都只是"这个层内部的第一名"，相对整页仍然被压在 20。
 * 而右侧的文件树面板是 z-index **25 / 40** 的独立层（相对定位的 panel），
 * 于是会出现「模态明明是 9999，右半边却被文件树挡住」这种反直觉现象 ——
 * 根因不在我们的 z-index 写小了，而在**我们被关在别人的层叠上下文里**。
 *
 * 挂到 body 之后就回到**根层叠上下文**，z-index 才真正参与全页比较（9999 > 40）。
 * 与入口 chip 的 portal 是同一个思路：**槽位只负责"让宿主知道有这个东西"，定位与层级自己管**。
 * 降级：`document` / `document.body` 不可用时（单测的假 DOM、SSR）原地返回，不改变原有行为。
 */
function portalToBody(node) {
  if (typeof document === 'undefined') return node
  const body = document.body
  if (body === null || body === undefined) return node
  return createPortal(node, body)
}

/**
 * shell.overlay 是 root 作用域的 list 槽，渲染时**不传任何 owner props**
 * （`renderSlot('shell.overlay', {})`），所以模态必须自己订阅模块级 store，
 * 不能指望从 props 上拿 state。
 */
function Modal() {
  const state = useStore()

  const team = useMemo(
    () => state.teams.find(item => item.id === state.teamId) ?? null,
    [state.teams, state.teamId],
  )

  const close = useCallback(() => patch({ open: false, error: null }), [])
  const load = useCallback(async () => {
    try {
      const payload = await api('/teams')
      patch({
        teams: payload.teams ?? [],
        loaded: true,
        error: null,
        ...payload.config === undefined || payload.config === null ? {} : { config: payload.config },
      })
    } catch (error) {
      patch({ loaded: true, error: String(error?.message ?? error) })
    }
  }, [])

  /*
   * **打开时 / 再点一次入口时都重新拉一次**：团队列表与 config
   * （lockBuiltinTeams / limits）都在这次响应里。于是改完 config.json
   * 只要重开面板（或再点一下入口）就生效，不用重启 dsh web ——
   * 这正是开发阶段「随时可调」要的手感。
   */
  useEffect(() => {
    if (state.open) void load()
  }, [state.open, state.loadToken, load])

  useEffect(() => {
    if (!state.open) return undefined
    const onKey = event => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.open, close])

  if (!state.open) return null

  const onSummoned = () => {
    close()
    void load()
  }

  // 画廊用浅灰底衬托白卡；详情 / 编辑器用纯白底，浅灰的预设条才读得出来。
  const page = state.view === 'gallery' ? S.page : S.surface

  /*
   * 案例交付结果弹窗：叠在画廊模态之上（zIndex 10000 > 9999），
   * 「做同款」= 激活该团队 + 把它自己那句提示词填进输入框 + 关掉两层弹窗。
   */
  const caseView = state.caseView
  const caseTeam = caseView === null || caseView === undefined
    ? null
    : state.teams.find(item => item.id === caseView.teamId) ?? null
  const caseItem = caseTeam === null ? null : (caseTeam.cases ?? [])[caseView.index] ?? null
  const caseNode = caseTeam !== null && caseItem !== null
    ? (
      <CaseDialog
        team={caseTeam}
        item={caseItem}
        onClose={() => patch({ caseView: null })}
        onSameStyle={() => {
          activateTeam(caseTeam, sameStylePrompt(caseTeam, caseItem))
          patch({ caseView: null })
        }}
      />
    )
    : null

  return portalToBody(
    <div
      onMouseDown={event => { if (event.target === event.currentTarget) close() }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.42))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-label="专家团"
        style={{
          width: 'min(1120px, 100%)',
          maxHeight: 'min(88vh, 940px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: page,
          color: S.text,
          borderRadius: 16,
          border: `1px solid ${S.line}`,
          boxShadow: 'var(--dsw-shadow-lv3, 0 24px 60px rgba(15, 23, 42, 0.24))',
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {state.view !== 'editor' && (
              <button type="button" style={btn({ padding: '5px 12px', fontSize: 12.5 })} onClick={() => patch({ view: 'editor', teamId: null, error: null })}>
                + 新建团队
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={close}
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 18,
              lineHeight: 1,
              color: S.muted,
              padding: '4px 8px',
              borderRadius: 8,
            }}
          >
            ✕
          </button>
        </div>

        {state.error !== null && (
          <div style={{ margin: '12px 20px 0', fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #b42318)', background: 'var(--dsw-alias-bg-layer-2, #fef3f2)', border: '1px solid var(--dsw-alias-state-error-secondary, #fecdca)', borderRadius: 8, padding: 10 }}>
            {state.error}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px 20px' }}>
          {state.view === 'editor' && (
            <TeamEditor
              key={team === null ? 'new' : `edit:${team.id}`}
              initial={team}
              config={state.config}
              onCancel={() => patch({ view: team !== null ? 'detail' : 'gallery' })}
              onSaved={() => { patch({ view: 'gallery', teamId: null }); void load() }}
            />
          )}

          {state.view === 'gallery' && (
            <Gallery
              state={state}
              onOpenTeam={id => patch({ view: 'detail', teamId: id })}
              onCreate={() => patch({ view: 'editor', teamId: null })}
              onSort={sort => patch({ sort })}
              onCategory={category => patch({ category })}
            />
          )}

          {state.view === 'detail' && team !== null && (
            <Detail
              key={team.id}
              team={team}
              state={state}
              onBack={() => patch({ view: 'gallery', teamId: null })}
              onEdit={() => patch({ view: 'editor' })}
              onSummoned={onSummoned}
              onRefresh={load}
              onOpenCase={caseIndex => patch({ caseView: { teamId: team.id, index: caseIndex } })}
            />
          )}

          {state.view === 'detail' && team === null && (
            <div style={{ padding: 30, textAlign: 'center', color: S.muted }}>
              团队不存在（可能已被删除）。
              <div style={{ marginTop: 12 }}>
                <button type="button" style={btn()} onClick={() => patch({ view: 'gallery', teamId: null })}>返回画廊</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {caseNode}
    </div>,
  )
}

/* ------------------------------------------------------------------ *
 *  插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  /*
   * 入口 chip 注册在工具行的左侧槽，但组件自己会在空会话态把节点 portal 到
   * 「工作区 | Agent 预设」那一行（紧挨「标准模式」）。
   *
   * 「已召唤」标签也由它渲染（`ActiveTeamChip`）—— **只在两个槽位注册**。
   * 别把标签改回 `conversation.input.dock`：那是给 todo / 队列这类「卡片上方的整行信息块」
   * 准备的槽，一个状态胶囊塞进去会独占一行、悬在输入框上方，正是被改掉的那个观感；
   * 也别改回 `conversation.input.overlay` —— 那是 `position: absolute; height: 0` 的浮层锚
   * （命令菜单 / @ 引用菜单的位置），静态元素进去会被编辑区盖住。
   */
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PLUGIN_ID,
    order: 40,
  }, Trigger))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: PLUGIN_ID,
    order: 40,
  }, Modal))
}
