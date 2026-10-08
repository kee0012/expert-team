/**
 * 浏览器半冒烟：加载 **构建产物 lib/client.js**，用假的 window.__ModuleLoader__ /
 * React hooks 运行时 / fetch，同步渲染 JSX 树并模拟点击，走完
 * 「开面板 → 团队画廊 → 详情 → 召唤 → 注入简报」整条链路。
 *
 * 这里的 React 不是 stub —— 它实现了真正的 hook 语义：
 *   · useState      跨渲染持久化，setter 触发重渲染（同值 bail-out）
 *   · useEffect     按 deps 比较决定是否重跑，带 cleanup
 *   · useMemo / useCallback 按 deps 缓存
 *   · 组件按渲染路径定位实例；本次没渲染到的实例会被**卸载**（跑 cleanup + 清状态），
 *     所以「关闭面板再打开」不会残留上一次的草稿 —— 与真实 React 一致
 *   · 「渲染 → 跑副作用 → 若脏则再渲染」的收敛循环（带次数上限）
 * 所以点击后拿到的树是**更新后的**树，而不是初始值的重复。
 *
 * 它不能替代真浏览器验收（CSS/布局/真实 DSH 环境），但能抓住所有会抛异常的
 * 渲染与逻辑错误，包括「组件订阅错数据源」「字段名取错」这类只在真环境才炸的问题。
 *
 * 用法：node scripts/client-smoke.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const results = []
const check = (label, condition, detail = '') => {
  results.push({ ok: Boolean(condition), label, detail: String(detail) })
}

/* ================================================================== *
 *  1. React hook 运行时
 * ================================================================== */

/** 每个组件实例（按渲染路径定位）一个 hook 槽数组。 */
const instances = new Map()
/** 当前正在渲染的组件实例。 */
let current = null
/** 本轮渲染之后是否有状态变化（决定要不要再渲染一遍）。 */
let dirty = false
/** 待执行的副作用。 */
const effectQueue = []
/** 渲染 / 副作用里抛出的异常。 */
const renderErrors = []
/** 累计渲染遍数，用来证明「不会死循环」。 */
let renderPasses = 0
/** useMemo 被真正重算的次数，用来证明 deps 生效。 */
let memoComputes = 0

const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

/** 取当前组件第 index 个 hook 槽。 */
function slotAt(index) {
  const inst = current
  if (inst === null) throw new Error('hook 在组件外被调用')
  if (inst.hooks[index] === undefined) inst.hooks[index] = {}
  return inst.hooks[index]
}

const React = {
  // 源码里用了 `<>…</>`（Fragment）；渲染器把非函数 type 当透明容器，
  // 所以只需要给它一个稳定标识，children 会被正常递归。
  Fragment: Symbol.for('react.fragment'),

  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },

  useState(initial) {
    const inst = current
    const index = inst.cursor++
    const slot = slotAt(index)
    if (!Object.prototype.hasOwnProperty.call(slot, 'value')) {
      slot.value = typeof initial === 'function' ? initial() : initial
    }
    return [slot.value, next => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return // React 的同值 bail-out
      slot.value = value
      dirty = true
    }]
  },

  useEffect(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const slot = slotAt(index)
    slot.nextFn = fn
    slot.nextDeps = deps
    // deps 为 undefined ⇒ 每次渲染都跑（React 语义）
    if (!sameDeps(slot.deps, deps)) effectQueue.push({ inst, index })
    return undefined
  },

  useMemo(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const slot = slotAt(index)
    if (!sameDeps(slot.deps, deps)) {
      slot.value = fn()
      slot.deps = deps
      memoComputes += 1
    }
    return slot.value
  },

  useCallback(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const slot = slotAt(index)
    if (!sameDeps(slot.deps, deps)) {
      slot.value = fn
      slot.deps = deps
    }
    return slot.value
  },

  useRef(initial) {
    const inst = current
    const index = inst.cursor++
    const slot = slotAt(index)
    // 真实 React 的 ref 对象跨渲染稳定；这里冒烟环境没有真 DOM，
    // 所以 current 始终停在初值（组件必须自己容忍拿不到布局）。
    if (!Object.prototype.hasOwnProperty.call(slot, 'ref')) slot.ref = { current: initial }
    return slot.ref
  },
}

/* ================================================================== *
 *  2. 同步渲染器（路径化组件实例 + 卸载语义）
 * ================================================================== */

const isUnder = (key, rootPath) => key === rootPath || key.startsWith(`${rootPath}/`) || key.startsWith(`${rootPath}@`)

function runCleanups(inst) {
  for (const hook of inst.hooks) {
    if (typeof hook?.cleanup === 'function') {
      const cleanup = hook.cleanup
      hook.cleanup = undefined
      try { cleanup() } catch (error) { renderErrors.push(`cleanup 抛出：${error?.message ?? error}`) }
    }
  }
}

/** 卸载一整棵根的实例（例如会话切换后触发按钮被移除）。 */
function unmountRoot(rootPath) {
  for (const [key, inst] of [...instances]) {
    if (!isUnder(key, rootPath)) continue
    runCleanups(inst)
    instances.delete(key)
  }
}

/** 卸载本次渲染没有覆盖到的实例 —— 等价于 React 卸载子树。 */
function unmountUnseen(rootPath, seen) {
  for (const [key, inst] of [...instances]) {
    if (!isUnder(key, rootPath) || seen.has(key)) continue
    runCleanups(inst)
    instances.delete(key)
  }
}

function renderNode(node, nodePath, seen) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${nodePath}[${index}]`, seen))

  if (typeof node.type === 'function') {
    const key = node.props?.key
    const childPath = key === undefined ? nodePath : `${nodePath}@${String(key)}`
    let inst = instances.get(childPath)
    if (inst === undefined) {
      inst = { key: childPath, hooks: [], cursor: 0 }
      instances.set(childPath, inst)
    }
    seen.add(childPath)
    inst.cursor = 0
    const previous = current
    current = inst
    let output = null
    try {
      output = node.type(node.props)
    } catch (error) {
      renderErrors.push(`渲染 ${node.type.name || '(匿名组件)'} 抛出：${error?.message ?? error}`)
      output = null
    } finally {
      current = previous
    }
    return renderNode(output, childPath, seen)
  }

  const raw = node.props?.children
  const children = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  return {
    type: node.type,
    props: node.props,
    children: children.map((child, index) => renderNode(child, `${nodePath}/${String(node.type)}[${index}]`, seen)),
  }
}

function flushEffects() {
  let guard = 0
  while (effectQueue.length > 0) {
    if ((guard += 1) > 500) throw new Error('副作用队列未收敛（疑似 effect 里无条件 setState）')
    const { inst, index } = effectQueue.shift()
    const hook = inst.hooks[index]
    if (hook?.nextFn === undefined) continue
    if (typeof hook.cleanup === 'function') {
      const cleanup = hook.cleanup
      hook.cleanup = undefined
      try { cleanup() } catch (error) { renderErrors.push(`cleanup 抛出：${error?.message ?? error}`) }
    }
    hook.deps = hook.nextDeps
    let cleanup
    try {
      cleanup = hook.nextFn()
    } catch (error) {
      renderErrors.push(`useEffect 抛出：${error?.message ?? error}`)
    }
    hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  }
}

/** 同步渲染直到不再脏。 */
function syncTree(component, props, rootPath) {
  let tree = null
  for (let pass = 0; pass < 40; pass += 1) {
    renderPasses += 1
    dirty = false
    const seen = new Set()
    tree = renderNode(React.createElement(component, props), rootPath, seen)
    unmountUnseen(rootPath, seen)
    flushEffects()
    if (!dirty) return tree
  }
  throw new Error(`渲染在 40 遍内未收敛（root=${rootPath}）`)
}

/* ================================================================== *
 *  3. 假 window / fetch
 * ================================================================== */

const SESSION_ID = 'session-aaa'

const PRODUCT_TEAM = {
  id: 'product-strategy',
  name: '产品战略团队',
  tagline: '功能规格书 / 竞品分析 / 产品路线图',
  emoji: '🎯',
  accent: '#4F46E5',
  source: 'builtin',
  publisher: 'DSH 官方团队',
  category: '产品设计',
  tags: ['需求分析', '竞品对标', '路线图'],
  createdAt: '2026-01-01T00:00:00+08:00',
  usageCount: 534512,
  presets: ['帮我写一份功能规格书', '做一次竞品分析'],
  cases: [{
    emoji: '📄',
    title: '季度产品战略一页纸',
    desc: '一页纸讲清季度战略',
    delivery: '季度产品战略一页纸 — 交付结果\n\n### 战略主张\n本季度只押一个支点。\n\n### 取舍\n| 取舍 | 选择 |\n| --- | --- |\n| 广度 vs 深度 | 砍掉 4 个 P2 功能 |\n\n- W3：改版上线\n- W6：回看数据',
  }],
  members: [
    {
      id: 'product-helmsman',
      name: '产品舵手',
      alias: '方向明',
      role: 'lead',
      emoji: '🧭',
      focus: '产品方向与取舍',
      // 刻意写成内置团队那样的完整结构：成员详情要按这些标记拆成
      // 「职责 / 工作方式 / 交付物 / 纪律」几块来展示。
      persona: '你是产品舵手。你的职责是把住产品方向。你的工作方式是先访谈再定方案。你的交付物是一页纸。你的纪律是不堆功能。',
    },
    { id: 'competitive-analyst', name: '竞品分析师', alias: '竞析', role: 'member', emoji: '🔎', focus: '竞品对标与差异化', persona: '你是竞品分析师。' },
    { id: 'data-analyst', name: '数据分析师', alias: '数析', role: 'member', emoji: '📊', focus: '指标口径', persona: '你是数据分析师。' },
  ],
}

const CUSTOM_TEAM = {
  id: 'my-team',
  name: '我的专家团',
  tagline: '',
  emoji: '🧪',
  accent: '#123456',
  source: 'custom',
  publisher: '我的团队',
  category: '技术工程',
  tags: ['代码评审'],
  createdAt: '2026-08-01T00:00:00+08:00',
  usageCount: 880000,
  presets: [],
  cases: [],
  members: [{ id: 'chief', name: '主理', alias: '', role: 'lead', emoji: '🙂', focus: '统筹', persona: '你是主理人。' }],
}

const fetchLog = []
let summonMode = 'ok'
let teamsPostMode = 'ok'

const ok = payload => ({ ok: true, status: 200, json: async () => payload })
const fail = (status, error) => ({ ok: false, status, json: async () => ({ ok: false, error }) })

globalThis.window = {
  __ModuleLoader__: { load(registration) { globalThis.__loaded = registration } },
  addEventListener: () => {},
  removeEventListener: () => {},
  // 触发按钮的 hero 行订阅用轮询（见 src/client/index.jsx）。冒烟环境里不真跑定时器：
  // 组件挂载时会先同步 resolve 一次，够了 —— 后面要测轮询之外的路径用重新挂载即可。
  setInterval: () => 0,
  clearInterval: () => {},
}

/**
 * 服务端下发的运行配置（`GET /api/teams` 响应里的 `config` 字段）。
 *
 * 默认**未锁定** —— 这正是开发阶段的默认态：内置团队与自定义团队一样可编辑。
 * 锁定态（定稿后的形态）在报告前那一段把 `lockBuiltinTeams` 置 true、重开面板再验。
 */
let lockBuiltinTeams = false
const serverConfig = () => ({
  lockBuiltinTeams,
  limits: { maxMembers: 13, maxTags: 4, maxCategory: 12, maxTagLabel: 10 },
})

globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET'
  fetchLog.push({ url, method, body: options.body })
  if (url.endsWith('/api/teams') && method === 'GET') {
    return ok({ ok: true, teams: [PRODUCT_TEAM, CUSTOM_TEAM], config: serverConfig() })
  }
  if (url.endsWith('/api/teams') && method === 'POST') {
    if (teamsPostMode === 'fail') return fail(400, '成员 chief 缺少 persona')
    return ok({ ok: true, team: CUSTOM_TEAM })
  }
  if (url.endsWith('/api/summon') && method === 'POST') {
    if (summonMode === 'fail') return fail(409, '找不到对应的会话（会话可能已关闭，请刷新页面后重试）')
    return ok({
      ok: true,
      teamId: 'product-strategy',
      provider: 'spawn',
      personaNative: true,
      dispatched: [
        { memberId: 'product-helmsman', name: '产品舵手', alias: '方向明', childSessionId: 'child-1' },
        { memberId: 'competitive-analyst', name: '竞品分析师', alias: '竞析', childSessionId: 'child-2' },
      ],
      skipped: [{ memberId: 'data-analyst', name: '数据分析师', reason: 'provider 拒绝' }],
    })
  }
  return fail(404, 'unknown endpoint')
}

/* ================================================================== *
 *  4. 树查询工具
 * ================================================================== */

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  collectText(node.children, out)
  if (node.type === 'textarea' || node.type === 'input') out.push(node.props?.value ?? '')
  return out
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (typeof node === 'string') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

const text = node => collectText(node).join(' ')
/** 断言用：JSX 会在文本节点之间插空白（`{n} 位专家` → `3  位专家`），比较前先全部抹掉。 */
const flat = node => collectText(node).join('').replace(/\s+/gu, '')
const buttons = node => findAll(node, el => el.type === 'button' && typeof el.props?.onClick === 'function')
const buttonTexts = node => buttons(node).map(b => collectText(b).join('').trim())

function buttonByText(node, needle) {
  const hit = buttons(node).find(el => collectText(el).join('').includes(needle))
  if (hit === undefined) throw new Error(`找不到按钮「${needle}」｜现有按钮：${buttonTexts(node).join(' / ')}`)
  return hit
}

/** 按 aria-label 取按钮：图标按钮（如右上角 ✕）没有可读文案。 */
function buttonByLabel(node, label) {
  const hit = buttons(node).find(el => el.props?.['aria-label'] === label)
  if (hit === undefined) {
    throw new Error(`找不到 aria-label="${label}" 的按钮｜现有：${
      buttons(node).map(el => String(el.props?.['aria-label'] ?? '')).join(' / ')}`)
  }
  return hit
}

const TEAM_NAMES = ['产品战略团队', '我的专家团']

/**
 * 画廊里团队卡片的**渲染顺序** —— 用来验证排序 / 分类筛选真的改变了输出，
 * 而不只是「页面上还能找到这些字」。
 */
function cardOrder(tree) {
  return buttons(tree)
    .map(el => collectText(el).join(''))
    .map(text => TEAM_NAMES.find(name => text.includes(name)))
    .filter(name => name !== undefined)
}

/** 取某个带 label 的字段控件（input / textarea / select）。 */
function fieldOf(tree, needle) {
  const label = findAll(tree, el => el.type === 'label').find(el =>
    el.children.some(child => typeof child === 'string' && child.includes(needle)))
  if (label === undefined) throw new Error(`找不到字段「${needle}」`)
  const control = findAll(label, el => ['input', 'textarea', 'select'].includes(el.type))[0]
  if (control === undefined) throw new Error(`字段「${needle}」没有控件`)
  return control
}

const typeInto = (tree, needle, value) => fieldOf(tree, needle).props.onChange({ target: { value } })

/* ================================================================== *
 *  5. 加载产物 + 装配插件
 * ================================================================== */

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

await import(new URL('../lib/client.js', import.meta.url).href)

const registration = globalThis.__loaded
check('client.js 调用了 window.__ModuleLoader__.load', registration !== undefined && typeof registration?.factory === 'function')
check('ModuleLoader id 为 expert-team', registration?.id === 'expert-team', registration?.id)

const portals = []
const ReactDom = {
  createPortal(children, container) {
    portals.push({ children, container })
    // 冒烟环境没有真实 DOM。把子节点直接交回去，渲染树与 inline 分支保持同构 ——
    // 于是既能断言「确实发生了 portal」，又不必实现一整套 DOM。
    return children
  },
}

const requiredSpecifiers = []
const client = registration.factory(specifier => {
  requiredSpecifiers.push(specifier)
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return ReactDom
  throw new Error(`未预期的 require(${specifier})`)
})

check('导出 inject / apply', Array.isArray(client.inject) && typeof client.apply === 'function', JSON.stringify(client.inject))
check('client inject 只含 slots', client.inject.length === 1 && client.inject[0] === 'slots', JSON.stringify(client.inject))
check('从平台模块表取 react-dom（hero 行落位靠它的 createPortal）',
  requiredSpecifiers.includes('react-dom'), requiredSpecifiers.join(', '))

const slots = new Map()
const fakeCtx = {
  slots: {
    inject(name, callback) { callback() },
    register(options, component) {
      slots.set(`${options.name}#${options.id}`, { options, component })
      return () => slots.delete(`${options.name}#${options.id}`)
    },
  },
  effect: fn => fn(),
}
client.apply(fakeCtx)

const triggerEntry = slots.get('conversation.input.left#expert-team')
const overlayEntry = slots.get('shell.overlay#expert-team')
check('注册了 conversation.input.left', triggerEntry !== undefined, [...slots.keys()].join(' , '))
check('注册了 shell.overlay', overlayEntry !== undefined, [...slots.keys()].join(' , '))
// 回归护栏：曾经的「已召唤」标签单独注册在 conversation.input.dock（输入卡片上方那条
// 独占一行的区域），在空会话里就是一个悬在输入框上方的孤立胶囊 —— 用户反馈难看。
// 现在它由 Trigger 就地渲染；这条断言保证不会有人再把那个槽加回来。
check('只注册两个槽位（不再往 conversation.input.dock 另挂「已召唤」标签）',
  slots.size === 2, [...slots.keys()].join(' , '))
check('两个槽位共用 expert-team 作为 id',
  triggerEntry?.options.id === 'expert-team'
  && overlayEntry?.options.id === 'expert-team')
check('两个槽位都带 order',
  typeof triggerEntry?.options.order === 'number'
  && typeof overlayEntry?.options.order === 'number',
  `${triggerEntry?.options.order} / ${overlayEntry?.options.order}`)

const Trigger = triggerEntry.component
const Modal = overlayEntry.component

/* ================================================================== *
 *  6. 会话输入接口 + 渲染驱动
 * ================================================================== */

const injected = { draft: null, submits: 0, setDrafts: 0 }
const inputActions = {
  setDraft(value) { injected.draft = value; injected.setDrafts += 1 },
  submit() { injected.submits += 1 },
  addAttachments: () => false,
  removeAttachment: () => {},
  pruneAttachments: () => {},
}

/**
 * 与真实契约一致：`conversation.input.left` 的 owner 传的是**空对象**
 * （`renderSlot('conversation.input.left', {})`），
 * 组件拿到的一切都来自 `uiSession.provide` 注入的标准 props。
 * 这里刻意不提供 `session` 快照 —— 触发按钮必须靠 `sessionId` 自己活下来。
 */
const triggerProps = {
  sessionId: SESSION_ID,
  inputActions,
  useSession: () => ({}),
  useConversation: () => ({}),
  useInput: () => ({}),
}

let triggerMounted = true

/**
 * 「已召唤」标签不再单独占一个槽位，而是由 Trigger 就地渲染（召唤后原地替换入口 chip）。
 * 激活时 Trigger 整棵树就是那块 Fragment（[:chip 根 div, 成员菜单]），所以直接把它整棵返回 ——
 * 成员菜单是 portal 到 body 的那部分，只有拿整棵树才能在 text/flat 里看到。
 */
const activeChipIn = tree => (tree !== null
  && findAll(tree, el => el.props?.['data-expert-team-active-chip'] !== undefined).length > 0
  ? tree
  : null)

/** 渲染两个槽位，并等到异步副作用落地。 */
async function repaint() {
  let trees = null
  for (let round = 0; round < 30; round += 1) {
    if (!triggerMounted) unmountRoot('root:trigger')
    const triggerTree = triggerMounted ? syncTree(Trigger, triggerProps, 'root:trigger') : null
    const modalTree = syncTree(Modal, {}, 'root:overlay')
    trees = { triggerTree, modalTree, chipTree: activeChipIn(triggerTree) }
    await tick()
    await tick()
    if (!dirty) return trees
  }
  throw new Error('repaint 未收敛（30 轮）')
}

/*
 * 按 aria-label 而不是文本定位入口：召唤之后那个位置渲染的是团队名（如「产品战略团队」），
 * 按钮文案里不再有「专家团」三个字 —— 但 aria-label 始终是它，换团队时锚点不该消失。
 */
const openPanel = async () => {
  const { triggerTree } = await repaint()
  buttonByLabel(triggerTree, '专家团').props.onClick()
  return repaint()
}

const openTeam = async (teamName) => {
  const { modalTree } = await openPanel()
  buttonByText(modalTree, teamName).props.onClick()
  return repaint()
}

/** 新语义：点「召唤专家团」= 激活该团队并关闭面板，不再展开「填任务 + 确认派遣」面板。 */
const summonTeam = async (teamName) => {
  const { modalTree } = await openTeam(teamName)
  buttonByText(modalTree, '召唤专家团').props.onClick()
  return repaint()
}

/* ================================================================== *
 *  7. 触发按钮 + 不死循环
 * ================================================================== */

renderPasses = 0
let { triggerTree, modalTree, chipTree } = await repaint()

check('渲染收敛且没有死循环（≤8 遍）', renderPasses <= 8, `renderPasses=${renderPasses}`)
check('渲染 / 副作用全程无异常', renderErrors.length === 0, renderErrors.join(' | '))
check('触发按钮渲染出「专家团」', text(triggerTree).includes('专家团'), text(triggerTree))
// 工具行 chip 的回归护栏：一旦重新套上块级容器，它就会独占一行（这正是被改掉的问题）。
check('触发按钮根节点直接是 button（不再套块级容器）', triggerTree?.type === 'button', String(triggerTree?.type))
check('触发按钮带 aria-label 供真实浏览器定位', triggerTree?.props?.['aria-label'] === '专家团',
  String(triggerTree?.props?.['aria-label']))
// 夹具本身不含 `session` 快照，所以后面「请求带上正确的 sessionId」一旦通过，
// 就证明 sessionId 走的是标准 prop 而不是快照。
check('夹具不含 session 快照（只靠标准 prop）', triggerProps.session === undefined)
check('面板未打开时 overlay 渲染为 null', modalTree === null)
check('未打开时没有发任何请求', fetchLog.length === 0, JSON.stringify(fetchLog))
// 没有 document（非浏览器 / 尚未挂载）时绝不 portal：chip 留在工具行，功能不丢。
check('无 DOM 时不 portal（chip 留在工具行）', portals.length === 0, `${portals.length} 次`)

/* ================================================================== *
 *  8. 画廊
 * ================================================================== */

;({ triggerTree, modalTree } = await openPanel())

check('打开面板后 overlay 渲染出内容', modalTree !== null)
check('模态拉取了团队列表', fetchLog.some(i => i.url.endsWith('/api/teams') && i.method === 'GET'))
check('画廊显示两支团队', flat(modalTree).includes('产品战略团队') && flat(modalTree).includes('我的专家团'), text(modalTree).slice(0, 120))
// 参考版式的卡片只放「名称 / 发布方 / 简介 / 标签」；使用次数挪到详情页头部。
check('画廊卡片显示「发布方 · 成员数」', flat(modalTree).includes('DSH官方团队·3位专家'), flat(modalTree).slice(0, 200))
check('画廊显示成员数', flat(modalTree).includes('3位专家') && flat(modalTree).includes('1位专家'), text(modalTree).slice(0, 200))
check('自定义团队带「自定义」标记', text(modalTree).includes('自定义'))
check('画廊显示团队简介', text(modalTree).includes('功能规格书'))
check('头部显示团队总数', text(modalTree).includes('2 支团队'))
check('画廊没有渲染详情区的「使用案例」', !text(modalTree).includes('使用案例'))
check('画廊每张卡片都是可点按钮',
  ['产品战略团队', '我的专家团'].every(name => buttonTexts(modalTree).some(t => t.includes(name))),
  buttonTexts(modalTree).join(' / '))

/* 参考版式的骨架：标题 + 排序 + 分类筛选 + 卡片标签。 */
check('画廊标题为「专家团」，且不再有独立的「专家」标签',
  findAll(modalTree, el => String(el.children) === '专家团').length > 0
  && findAll(modalTree, el => String(el.children) === '专家').length === 0,
  text(modalTree).slice(0, 120))
check('画廊有排序标签 综合/最热/最新',
  ['综合', '最热', '最新'].every(label => buttonTexts(modalTree).includes(label)),
  buttonTexts(modalTree).join(' / '))
check('画廊有分类筛选行（全部 + 数据里的分类）',
  ['全部', '产品设计', '技术工程'].every(name => buttonTexts(modalTree).includes(name)),
  buttonTexts(modalTree).join(' / '))
check('卡片显示发布方', flat(modalTree).includes('DSH官方团队') && flat(modalTree).includes('我的团队'), flat(modalTree).slice(0, 200))
check('卡片显示标签 chip',
  ['需求分析', '竞品对标', '路线图', '代码评审'].every(tag => text(modalTree).includes(tag)),
  text(modalTree).slice(0, 240))

/* 排序：必须是真的重新渲染了顺序，而不是文案还在。 */
check('默认顺序 = 服务端返回顺序', cardOrder(modalTree).join('>') === '产品战略团队>我的专家团',
  cardOrder(modalTree).join('>'))

buttonByText(modalTree, '最热').props.onClick()
;({ modalTree } = await repaint())
check('点「最热」按使用次数倒序', cardOrder(modalTree).join('>') === '我的专家团>产品战略团队',
  cardOrder(modalTree).join('>'))

buttonByText(modalTree, '最新').props.onClick()
;({ modalTree } = await repaint())
check('点「最新」按创建时间倒序', cardOrder(modalTree).join('>') === '我的专家团>产品战略团队',
  cardOrder(modalTree).join('>'))

buttonByText(modalTree, '综合').props.onClick()
;({ modalTree } = await repaint())
check('点「综合」回到服务端顺序', cardOrder(modalTree).join('>') === '产品战略团队>我的专家团',
  cardOrder(modalTree).join('>'))

/* 分类筛选：命中一个 / 排除另一个。 */
buttonByText(modalTree, '技术工程').props.onClick()
;({ modalTree } = await repaint())
check('点分类只剩该分类的团队', cardOrder(modalTree).join('>') === '我的专家团', cardOrder(modalTree).join('>'))
check('被筛掉的分类显示空态提示', text(modalTree).includes('暂时没有团队') === false || cardOrder(modalTree).length > 0)

buttonByText(modalTree, '产品设计').props.onClick()
;({ modalTree } = await repaint())
check('切到另一个分类只显示该分类', cardOrder(modalTree).join('>') === '产品战略团队', cardOrder(modalTree).join('>'))

buttonByText(modalTree, '全部').props.onClick()
;({ modalTree } = await repaint())
check('点「全部」恢复两支团队', cardOrder(modalTree).length === 2, cardOrder(modalTree).join('>'))

/* ================================================================== *
 *  9. 详情
 * ================================================================== */

;({ modalTree } = await openTeam('产品战略团队'))
const detailText = text(modalTree)

check('详情显示团队名与简介', detailText.includes('产品战略团队') && detailText.includes('功能规格书'))
// 这是自己重新开发的插件：不应出现 WorkBuddy 那种「XX 万次使用」的运营数字。
check('详情不再显示「万次使用」运营数字',
  !flat(modalTree).includes('万次使用'),
  flat(modalTree).slice(0, 200))
check('详情把预设提问渲染成引号快捷条',
  detailText.includes('“帮我写一份功能规格书”') && detailText.includes('“做一次竞品分析”'),
  detailText.slice(0, 220))
check('详情有「召唤专家团」按钮', buttonTexts(modalTree).some(t => t.includes('召唤专家团')), buttonTexts(modalTree).join(' / '))
check('详情有「使用案例」区', detailText.includes('使用案例') && detailText.includes('季度产品战略一页纸'))
check('详情有「团队成员」区', detailText.includes('团队成员'))
check('详情列出全部成员', ['产品舵手', '竞品分析师', '数据分析师'].every(n => detailText.includes(n)))
check('详情标出主理人', detailText.includes('主理人'))
check('详情显示成员昵称与职责', detailText.includes('方向明') && detailText.includes('产品方向与取舍'))
check('未锁定时内置团队详情也出「编辑」入口（开发阶段可直接改）',
  buttonTexts(modalTree).includes('编辑'), buttonTexts(modalTree).join(' / '))
check('详情有返回画廊的入口', buttonTexts(modalTree).some(t => t.includes('全部团队')))
check('内置团队详情不显示「自定义」标记', !detailText.includes('自定义'))

/* ================================================================== *
 *  10. 召唤 = 激活团队 + 把焦点交回输入框（不再有第二道确认）
 * ================================================================== */

const summonPaint = await summonTeam('产品战略团队')
modalTree = summonPaint.modalTree
chipTree = summonPaint.chipTree

check('点「召唤专家团」直接关掉面板（不再展开任务面板）', modalTree === null)
check('点「召唤专家团」不立刻派遣（派发发生在提交那一刻）',
  fetchLog.filter(i => i.url.endsWith('/api/summon')).length === 0,
  JSON.stringify(fetchLog.map(i => `${i.method} ${i.url}`)))
check('点「召唤专家团」不预填草稿（留给用户自己写需求）', injected.draft === null, String(injected.draft))
check('输入卡片内出现已召唤的团队标签', chipTree !== null && text(chipTree).includes('产品战略团队'), text(chipTree))
check('标签显示「已选 / 全部」成员计数', flat(chipTree).includes('3/3'), flat(chipTree))
check('标签静止态不显示关闭按钮（悬停才出现）',
  !findAll(chipTree, el => el.type === 'button').some(el => el.props?.['aria-label'] === '取消召唤专家团'))

/* 悬停 → 出现关闭按钮（激活态整块是 Fragment，真正的根 div 是它的第一个孩子） */
const chipRoot = chipTree.children?.[0] ?? chipTree
chipRoot.props.onMouseEnter()
const hoveredChip = (await repaint()).chipTree
check('鼠标移到团队名上出现关闭按钮',
  findAll(hoveredChip, el => el.type === 'button').some(el => el.props?.['aria-label'] === '取消召唤专家团'),
  buttonTexts(hoveredChip).join(' / '))

/* 名称右侧的小三角 → 展开成员勾选 */
const caret = findAll(hoveredChip, el => el.type === 'button')
  .find(el => el.props?.['aria-label'] === '选择派遣成员')
check('团队名右侧有成员下拉三角', caret !== undefined)
caret.props.onClick()
let openedChip = (await repaint()).chipTree
check('点三角展开成员列表',
  ['产品舵手', '竞品分析师', '数据分析师'].every(name => text(openedChip).includes(name)),
  text(openedChip).slice(0, 200))
check('下拉里显示「派遣成员（3/3）」',
  flat(openedChip).includes('派遣成员（3/3）'),
  flat(openedChip))

/* 取消勾选一位 → 计数变化 */
const memberBoxes = findAll(openedChip, el => el.type === 'input' && el.props?.type === 'checkbox')
check('下拉里每位成员一个勾选框', memberBoxes.length === 3, memberBoxes.length)
memberBoxes[1].props.onChange({ target: { checked: false } })
openedChip = (await repaint()).chipTree
check('取消勾选成员后计数变为 2/3', flat(openedChip).includes('2/3'), flat(openedChip))

/* 全选恢复 */
const selectAll = findAll(openedChip, el => el.type === 'button').find(el => flat(el).includes('全选'))
selectAll.props.onClick()
openedChip = (await repaint()).chipTree
check('点「全选」恢复 3/3', flat(openedChip).includes('3/3'), flat(openedChip))

/* 点 × → 取消召唤 */
const closer = findAll(openedChip, el => el.type === 'button')
  .find(el => el.props?.['aria-label'] === '取消召唤专家团')
closer.props.onClick()
const closedChip = await repaint()
check('点关闭按钮后标签消失', closedChip.chipTree === null, text(closedChip.chipTree))

/* 预设提问与使用案例：带一句话回到输入框 */
const presetPaint = await summonTeam('产品战略团队')
check('（前置）面板已关闭', presetPaint.modalTree === null)
injected.draft = null
const detailAgain = await openTeam('产品战略团队')
buttonByText(detailAgain.modalTree, '做一次竞品分析').props.onClick()
let afterPreset = await repaint()
check('点预设提问：把这句话预填进输入框草稿',
  injected.draft === '做一次竞品分析', String(injected.draft))
check('点预设提问：面板关闭且团队已激活',
  afterPreset.modalTree === null && afterPreset.chipTree !== null)

injected.draft = null
const detailForCase = await openTeam('产品战略团队')
buttonByText(detailForCase.modalTree, '季度产品战略一页纸').props.onClick()
const casePaint = await repaint()
check('点使用案例：弹出交付结果弹窗（不跳页、不就地展开）',
  text(casePaint.modalTree).includes('做同款') && buttonTexts(casePaint.modalTree).includes('做同款'),
  buttonTexts(casePaint.modalTree).join(' / '))
check('弹窗里展示该案例的交付结果正文',
  text(casePaint.modalTree).includes('战略主张') && text(casePaint.modalTree).includes('砍掉 4 个 P2 功能'),
  text(casePaint.modalTree).slice(0, 220))
check('交付结果里的表格被渲染', text(casePaint.modalTree).includes('广度 vs 深度'))
check('点案例本身不改写草稿（草稿只由「做同款」填）', injected.draft === null, String(injected.draft))

/* 「做同款」→ 激活该团队 + 填入与案例匹配的提示词 */
buttonByText(casePaint.modalTree, '做同款').props.onClick()
const sameStylePaint = await repaint()
check('点「做同款」把提示词填进输入框',
  typeof injected.draft === 'string' && injected.draft.includes('季度产品战略一页纸'), String(injected.draft))
check('提示词与当前案例匹配（带上案例目标）',
  String(injected.draft).includes('一页纸讲清季度战略'), String(injected.draft))
check('点「做同款」后弹窗关闭', !text(sameStylePaint.modalTree).includes('做同款'))
check('点「做同款」后团队已激活（输入卡片上方出现标签）',
  sameStylePaint.chipTree !== null && flat(sameStylePaint.chipTree).includes('产品战略团队'),
  flat(sameStylePaint.chipTree))

/* ================================================================== *
 *  11. 提交拦截：在输入框按回车 = 派遣，而不是当普通消息发出去
 * ================================================================== */

/*
 * 拦截跑在 document 捕获阶段，所以先装一个最小 document：
 * 一个 `[data-input-scroll] [contenteditable]` 编辑器（草稿来源）+ 事件总线。
 * 真实环境里这两个锚点分别来自 InputBar.tsx 的 `data-input-scroll` 与编辑器自身。
 */
let focusCount = 0
const editorEl = { innerText: '', textContent: '', focus() { focusCount += 1 } }
const docListeners = { keydown: [], click: [], mousedown: [] }
globalThis.document = {
  querySelector: selector => (selector === '[data-input-scroll] [contenteditable]' ? editorEl : null),
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn) },
  removeEventListener: (type, fn) => {
    const list = docListeners[type] ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  },
  body: { appendChild() {}, removeChild() {} },
}

/** 模拟一次捕获阶段的 keydown，返回 DSH 是否被 preventDefault 拦下。 */
const fireKeydown = (key, overrides = {}) => {
  let prevented = false
  const event = {
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    target: { closest: selector => (selector === '[data-input-scroll]' ? {} : null) },
    preventDefault() { prevented = true },
    stopPropagation() {},
    ...overrides,
  }
  for (const fn of docListeners.keydown) fn(event)
  return prevented
}

focusCount = 0
const beforeFirstSummon = fetchLog.filter(i => i.url.endsWith('/api/summon')).length
const activated = await summonTeam('产品战略团队')
check('激活后输入卡片里挂着团队标签', activated.chipTree !== null)
check('激活时把焦点交给 DSH 输入框', focusCount > 0, `focusCount=${focusCount}`)

editorEl.innerText = ''
check('草稿为空时按回车不拦截（交回 DSH 默认行为）', fireKeydown('Enter') === false)

editorEl.innerText = '想做一次竞品分析'
check('Shift+Enter 不拦截（留给换行）', fireKeydown('Enter', { shiftKey: true }) === false)

editorEl.innerText = '做一次竞品分析'
injected.draft = null
injected.submits = 0
injected.setDrafts = 0
const intercepted = fireKeydown('Enter')
check('按回车被拦截（不会把需求当普通消息发出去）', intercepted === true)
for (let round = 0; round < 6; round += 1) { await tick(); await repaint() }

const summonCalls = fetchLog.filter(i => i.url.endsWith('/api/summon') && i.method === 'POST')
check('拦截后走 POST /api/summon', summonCalls.length === beforeFirstSummon + 1,
  JSON.stringify(fetchLog.map(i => `${i.method} ${i.url}`)))
const sentBody = JSON.parse(summonCalls[summonCalls.length - 1]?.body ?? '{}')
check('请求带上当前会话 sessionId', sentBody.sessionId === SESSION_ID, JSON.stringify(sentBody))
check('task 就是输入框里的需求', sentBody.task === '做一次竞品分析', JSON.stringify(sentBody))
check('memberIds 用激活时选中的成员',
  sentBody.teamId === 'product-strategy' && Array.isArray(sentBody.memberIds) && sentBody.memberIds.length === 3,
  JSON.stringify(sentBody))

check('派遣成功后写入「专家团已就位」简报',
  typeof injected.draft === 'string' && injected.draft.includes('专家团已就位'), String(injected.draft).slice(0, 60))
check('简报标题含团队名', String(injected.draft).includes('产品战略团队'))
check('简报含每位专家的子会话 id',
  String(injected.draft).includes('child-1') && String(injected.draft).includes('child-2'),
  String(injected.draft).slice(0, 240))
check('简报含专家昵称', String(injected.draft).includes('方向明') && String(injected.draft).includes('竞析'))
check('简报含「等所有专家返回再汇总」', String(injected.draft).includes('等所有专家返回'))
check('简报含冲突裁决要求', String(injected.draft).includes('裁决'))
check('简报含任务原文', String(injected.draft).includes('做一次竞品分析'))
check('简报只列实际就位的专家（2 位）', String(injected.draft).includes('已为以下 2 位专家'), String(injected.draft).slice(0, 120))
check('setDraft 只被调用一次（先写草稿再提交）', injected.setDrafts === 1, injected.setDrafts)
check('调用了 submit 提交会话消息', injected.submits === 1, injected.submits)
check('派遣后输入卡片里的团队标签自动收起', (await repaint()).chipTree === null)

/* 鼠标点发送按钮：同样要拦截（不能只认回车） */
await summonTeam('产品战略团队')
editorEl.innerText = '鼠标点发送也要走派遣'
injected.draft = null
injected.submits = 0
const summonButton = { disabled: false, hasAttribute: () => false }
const otherButton = { disabled: false, hasAttribute: () => false }
const cardEl = { querySelectorAll: () => [otherButton, summonButton] }
summonButton.closest = selector => (selector === '[data-composer-card]' ? cardEl : selector === 'button' ? summonButton : null)
let clickPrevented = false
for (const fn of docListeners.click) {
  fn({
    target: summonButton,
    preventDefault() { clickPrevented = true },
    stopPropagation() {},
  })
}
for (let round = 0; round < 6; round += 1) { await tick(); await repaint() }
check('点发送按钮也被拦截并派遣', clickPrevented === true && injected.submits === 1,
  `prevented=${clickPrevented} submits=${injected.submits}`)

/* ================================================================== *
 *  12. 回退路径：直连派遣失败 → 兜底简报交给模型
 * ================================================================== */

summonMode = 'fail'
injected.draft = null
injected.submits = 0

await summonTeam('产品战略团队')
editorEl.innerText = '做一次竞品分析'
fireKeydown('Enter')
for (let round = 0; round < 6; round += 1) { await tick(); await repaint() }

check('直连失败时改写为兜底简报', String(injected.draft).includes('expert_team_summon'), String(injected.draft).slice(0, 60))
check('兜底简报含 team_id', String(injected.draft).includes('team_id：product-strategy'))
check('兜底简报含失败原因', String(injected.draft).includes('找不到对应的会话'), String(injected.draft).slice(0, 110))
check('兜底简报列出成员 id 与角色',
  String(injected.draft).includes('product-helmsman') && String(injected.draft).includes('主理人'))
check('兜底简报含汇总要求', String(injected.draft).includes('等待所有专家返回'))
check('兜底路径仍提交会话消息', injected.submits === 1, injected.submits)
summonMode = 'ok'

/* ================================================================== *
 *  13. 会话输入接口不可用（触发按钮已卸载）
 * ================================================================== */

injected.draft = null
injected.submits = 0
await summonTeam('产品战略团队')
triggerMounted = false            // 模拟会话切换后触发按钮被卸载
await repaint()

editorEl.innerText = '做一次竞品分析'
fireKeydown('Enter')
for (let round = 0; round < 6; round += 1) { await tick(); await repaint() }

check('输入接口不可用时不会提交会话', injected.submits === 0, injected.submits)
check('输入接口不可用时不会改写草稿', injected.draft === null, String(injected.draft))
check('输入接口不可用时需求仍留在输入框里（不静默吞掉）', editorEl.innerText === '做一次竞品分析', editorEl.innerText)

triggerMounted = true
await repaint()

/* ================================================================== *
 *  14. 新建团队
 * ================================================================== */

injected.draft = null
injected.submits = 0
;({ modalTree } = await openPanel())
buttonByText(modalTree, '新建团队').props.onClick()
;({ modalTree } = await repaint())
const editorText = text(modalTree)

check('编辑器含全部团队字段',
  ['团队 id', '团队名称', '一句话简介', '团队图标', '预设提问'].every(k => editorText.includes(k)),
  editorText.slice(0, 160))
check('编辑器含 persona 输入且标注必填', editorText.includes('人格设定 persona') && editorText.includes('必填'))
check('编辑器默认给两位专家', findAll(modalTree, el => el.type === 'select').length === 2)
check('编辑器默认第一位是主理人',
  findAll(modalTree, el => el.type === 'select')[0]?.props?.value === 'lead',
  findAll(modalTree, el => el.type === 'select')[0]?.props?.value)
check('编辑器默认第二位是成员',
  findAll(modalTree, el => el.type === 'select')[1]?.props?.value === 'member',
  findAll(modalTree, el => el.type === 'select')[1]?.props?.value)
check('编辑器有保存 / 取消按钮',
  buttonTexts(modalTree).some(t => t.includes('保存团队')) && buttonTexts(modalTree).includes('取消'))
check('编辑器有「+ 添加专家」', buttonTexts(modalTree).some(t => t.includes('添加专家')))
check('编辑器提示了存储路径', editorText.includes('$DSH_HOME/expert-teams/teams.json'))

/* 添加一位专家 → 3 位 */
buttonByText(modalTree, '添加专家').props.onClick()
;({ modalTree } = await repaint())
check('点「+ 添加专家」后变成 3 位', findAll(modalTree, el => el.type === 'select').length === 3)
check('第一位专家字段默认 id 为 expert-1', fieldOf(modalTree, '成员 id').props.value === 'expert-1', fieldOf(modalTree, '成员 id').props.value)

/* 删除一位 → 回到 2 位 */
const deleteButtons = buttons(modalTree).filter(b => collectText(b).join('').trim() === '删除')
deleteButtons[deleteButtons.length - 1].props.onClick()
;({ modalTree } = await repaint())
check('点「删除」减少一位专家', findAll(modalTree, el => el.type === 'select').length === 2)

/* 填表单 */
typeInto(modalTree, '团队 id', 'my-team')
typeInto(modalTree, '团队名称', '我的专家团')
typeInto(modalTree, '一句话简介', '竞品分析 / 路线图 / 复盘')
typeInto(modalTree, '预设提问', '第一问\n第二问')
typeInto(modalTree, '成员 id', 'chief')
typeInto(modalTree, '称呼', '主理')
typeInto(modalTree, '人格设定 persona', '你是主理人。')
;({ modalTree } = await repaint())
check('表单输入后团队名称回显', fieldOf(modalTree, '团队名称').props.value === '我的专家团')

const postsBefore = fetchLog.filter(i => i.url.endsWith('/api/teams') && i.method === 'POST').length
buttonByText(modalTree, '保存团队').props.onClick()
;({ modalTree } = await repaint())

const postCalls = fetchLog.filter(i => i.url.endsWith('/api/teams') && i.method === 'POST')
check('保存团队走 POST /api/teams', postCalls.length === postsBefore + 1)
const savedTeam = JSON.parse(postCalls[postCalls.length - 1]?.body ?? '{}')?.team ?? {}
check('保存体含 id / name / tagline',
  savedTeam.id === 'my-team' && savedTeam.name === '我的专家团' && savedTeam.tagline === '竞品分析 / 路线图 / 复盘',
  JSON.stringify({ id: savedTeam.id, name: savedTeam.name, tagline: savedTeam.tagline }))
check('保存体把预设提问按行切分',
  Array.isArray(savedTeam.presets) && savedTeam.presets.length === 2 && savedTeam.presets[1] === '第二问',
  JSON.stringify(savedTeam.presets))
check('保存体带 2 位成员且第一位是 lead 且有 persona',
  Array.isArray(savedTeam.members) && savedTeam.members.length === 2
  && savedTeam.members[0].role === 'lead' && savedTeam.members[0].persona === '你是主理人。',
  JSON.stringify(savedTeam.members?.map(m => ({ id: m.id, role: m.role, persona: m.persona }))))
check('保存成功后回到画廊', text(modalTree).includes('产品战略团队') && text(modalTree).includes('2 支团队'))

/* 服务端校验失败 → 红条提示，且停留在编辑器 */
teamsPostMode = 'fail'
;({ modalTree } = await openPanel())
buttonByText(modalTree, '新建团队').props.onClick()
;({ modalTree } = await repaint())
buttonByText(modalTree, '保存团队').props.onClick()
;({ modalTree } = await repaint())
check('服务端拒绝时显示错误信息', text(modalTree).includes('成员 chief 缺少 persona'), text(modalTree).slice(0, 200))
check('服务端拒绝时停留在编辑器', buttonTexts(modalTree).some(t => t.includes('保存团队')))
teamsPostMode = 'ok'

/* ================================================================== *
 *  15. 编辑已有自定义团队（persona 回填）
 * ================================================================== */

;({ modalTree } = await openTeam('我的专家团'))
check('自定义团队详情显示「编辑」按钮', buttonTexts(modalTree).includes('编辑'), buttonTexts(modalTree).join(' / '))
check('无预设提问 / 无使用案例的团队不报错', text(modalTree).includes('我的专家团'))

buttonByText(modalTree, '编辑').props.onClick()
;({ modalTree } = await repaint())
check('编辑视图标题为「编辑专家团」', text(modalTree).includes('编辑专家团'))
check('编辑视图回填团队 id', fieldOf(modalTree, '团队 id').props.value === 'my-team', fieldOf(modalTree, '团队 id').props.value)
check('编辑视图回填团队名称', fieldOf(modalTree, '团队名称').props.value === '我的专家团')
check('编辑视图回填成员 persona（不再丢人格提示词）',
  fieldOf(modalTree, '人格设定 persona').props.value === '你是主理人。',
  fieldOf(modalTree, '人格设定 persona').props.value)
check('编辑视图只带 1 位成员', findAll(modalTree, el => el.type === 'select').length === 1)

buttonByText(modalTree, '返回').props.onClick()
;({ modalTree } = await repaint())
check('从编辑器「返回」回到该团队详情',
  text(modalTree).includes('我的专家团') && buttonTexts(modalTree).some(t => t.includes('召唤专家团')))

/* ================================================================== *
 *  16. 关闭方式 + 切换团队不串状态
 * ================================================================== */

/* 切换团队：激活态按会话分桶，浏览别的团队不会把它串掉 */
const switched = await summonTeam('产品战略团队')
check('（前置）已激活产品战略团队', flat(switched.chipTree).includes('产品战略团队'), flat(switched.chipTree))

;({ modalTree } = await openTeam('我的专家团'))
check('浏览另一个团队不会顶掉已激活的团队',
  flat((await repaint()).chipTree).includes('产品战略团队'),
  flat((await repaint()).chipTree))
check('另一个团队的详情正常渲染', text(modalTree).includes('我的专家团'))

buttonByLabel(modalTree, '关闭').props.onClick()
;({ modalTree } = await repaint())
check('点「关闭」后 overlay 渲染为 null', modalTree === null)

/*
 * Esc 关闭。
 * 注意顺序：Modal 的键盘 effect 依赖 [state.open, close]，面板已经打开时再换 window
 * 不会触发重新绑定 —— 所以必须先安装捕获器，再打开面板。
 */
const captured = { count: 0, handlers: [] }
const originalWindow = globalThis.window
globalThis.window = {
  ...originalWindow,
  addEventListener: (type, handler) => {
    if (type !== 'keydown') return
    captured.count += 1
    captured.handlers.push(handler)
  },
  removeEventListener: (type, handler) => {
    if (type !== 'keydown') return
    captured.handlers = captured.handlers.filter(item => item !== handler)
  },
}

;({ modalTree } = await openPanel())
check('重新打开后 overlay 有内容', modalTree !== null)
check('挂载了 Escape 键监听', captured.count >= 1, `count=${captured.count}`)

/* 非 Escape 键不应该关闭面板 */
for (const handler of [...captured.handlers]) handler({ key: 'a' })
;({ modalTree } = await repaint())
check('非 Escape 键不关闭面板', modalTree !== null)

for (const handler of [...captured.handlers]) handler({ key: 'Escape' })
;({ modalTree } = await repaint())
check('Escape 关闭面板', modalTree === null)
check('关闭后解绑了键盘监听', captured.handlers.length === 0, `handlers=${captured.handlers.length}`)

globalThis.window = originalWindow

/* 点遮罩关闭 */
;({ modalTree } = await openPanel())
const backdrop = findAll(modalTree, el => el.props?.onMouseDown !== undefined)[0]
check('遮罩层绑定了点击关闭', backdrop !== undefined)
backdrop.props.onMouseDown({ target: 1, currentTarget: 1 })
;({ modalTree } = await repaint())
check('点遮罩关闭面板', modalTree === null)

/* 面板内点击不应该关掉面板 */
;({ modalTree } = await openPanel())
const backdrop2 = findAll(modalTree, el => el.props?.onMouseDown !== undefined)[0]
backdrop2.props.onMouseDown({ target: {}, currentTarget: {} })
;({ modalTree } = await repaint())
check('面板内部点击不关闭面板', modalTree !== null)

/* ================================================================== *
 *  17. hero 行落位：portal 到「工作区 | Agent 预设」那一行
 * ================================================================== */

/*
 * 这一节验的是**入口** chip 的版式，所以先把召唤取消掉：激活态下同一个控件会原地变成
 * 团队标签（那是 section 16 覆盖的行为），这里要的是那个「👥 专家团」入口。
 */
const chipBeforeClose = (await repaint()).chipTree
chipBeforeClose.children[0].props.onMouseEnter()
const chipClosing = (await repaint()).chipTree
buttonByLabel(chipClosing, '取消召唤专家团').props.onClick()
check('（前置）取消召唤后触发器回到入口态', (await repaint()).chipTree === null)

/*
 * 给冒烟环境装一个**最小假 DOM**，专门覆盖 findHeroSeatRow 的选择逻辑：
 * 「输入卡片之前的最后一个 aria-haspopup chip」→ 向上跳过 slot 的 display:contents
 * 包装层 → 拿到真正的那一行。这段逻辑决定 chip 在真机上长在哪，值得单独钉住。
 */
function fakeEl(tag, options = {}) {
  const el = {
    tag,
    display: options.display ?? 'block',
    attrs: options.attrs ?? {},
    children: [],
    parentElement: null,
    isConnected: options.isConnected ?? true,
    compareDocumentPosition: options.compareDocumentPosition ?? (() => 0),
  }
  return el
}

/** 把 child 挂到 parent 下，双向都连上。 */
function attach(parent, child) {
  parent.children.push(child)
  child.parentElement = parent
  return child
}

const seatRow = fakeEl('div', { display: 'flex' })
/*
 * slot 出口带稳定的 `data-slot="<slotKey>"` 属性（真机由 renderer 的 SlotOutlet 渲染，
 * 样式 display:contents）。实现的首选路径就是拿它的父节点当那一行 —— 所以这里必须照抄。
 */
const slotWrapper = fakeEl('div', {
  display: 'contents',
  attrs: { 'data-slot': 'conversation.hero.agentPreset' },
})
const presetChip = attach(slotWrapper, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
attach(seatRow, slotWrapper)

/* 工作区 chip 和预设 chip 同属那一行（真机：heroWorkspaceRow 的第三个孩子是另一个出口）。 */
const workspaceChip = attach(seatRow, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
const card = fakeEl('div', { attrs: { 'data-composer-card': '' } })
const cardTools = fakeEl('div', { display: 'flex' })
const inCardChip = attach(cardTools, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
attach(card, cardTools)

// 只有真正位于卡片「之前」的两个 chip 才是候选；卡片里的那个必须被排除。
card.compareDocumentPosition = node => (node === workspaceChip || node === presetChip ? 2 : 0)

globalThis.Node = { DOCUMENT_POSITION_PRECEDING: 2 }
globalThis.getComputedStyle = el => ({ display: el.display })
globalThis.document = {
  querySelector: selector => {
    if (selector === '[data-composer-card]') return card
    if (selector === '[data-slot="conversation.hero.agentPreset"]') return slotWrapper
    return null
  },
  querySelectorAll: selector =>
    (selector === 'button[aria-haspopup="menu"]' ? [workspaceChip, presetChip, inCardChip] : []),
  body: fakeEl('body'),
}

const portalsBefore = portals.length
triggerMounted = false
await repaint()
triggerMounted = true
const seated = await repaint()

/*
 * 按**容器**挑出属于 chip 的那次 portal，不要取「最后一个」：
 * 此时面板是开着的，模态自己也会 portal（到 body），最后一个不一定是 chip。
 * 这个坑正是"模态改成 portal 到 body"之后暴露出来的。
 */
const chipPortals = portals.slice(portalsBefore).filter(item => item.container === seatRow)

check('空会话态：chip 被 portal 进 hero 行', chipPortals.length === 1,
  `${chipPortals.length} 次（本次共 ${portals.length - portalsBefore} 次 portal）`)
check('portal 容器就是「标准模式」所在的那一行', chipPortals[0]?.container === seatRow)
check('卡片内的下拉控件被排除，没被误判成行',
  portals.slice(portalsBefore).every(item => item.container !== cardTools))
check('行内 chip 用行版式（order 100，视觉上排在「标准模式」之后）',
  seated.triggerTree?.props?.style?.order === 100, String(seated.triggerTree?.props?.style?.order))
check('行内 chip 仍然是同一个 aria-label（真浏览器定位不变）',
  seated.triggerTree?.props?.['aria-label'] === '专家团')

/*
 * 版式回归。对应真机上出现过的视觉缺陷：
 *
 * 真实 bug：把「打开面板的函数」当布尔用（`open || hover`，useCallback 的返回值恒为真），
 * 于是 chip 在**静止态**也永久带着悬停底色 —— DSH 的 `--dsw-alias-interactive-bg-hover`
 * 在本主题下解析成 rgba(0,113,227,.1) 的淡蓝，混在一排透明 chip 里像个突兀的蓝色胶囊。
 *
 * 断言必须在**静止态**下做：面板打开时 chip 带高亮底色是预期行为，
 * 而上面 section 16 结束时面板正是开着的 —— 所以先关掉它再验。
 */
const HOVER_BG_LITERAL = 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))'

const backdropForResting = findAll(modalTree, el => el.props?.onMouseDown !== undefined)[0]
backdropForResting.props.onMouseDown({ target: 1, currentTarget: 1 })
const resting = await repaint()
check('（前置）断言版式前面板已关闭', resting.modalTree === null)

const restingStyle = resting.triggerTree?.props?.style ?? {}
check('行内 chip 静止态背景透明（不被恒真的 open 函数染上悬停底色）',
  restingStyle.background === 'transparent', String(restingStyle.background))

const seatedIcons = findAll(resting.triggerTree, el => el.type === 'svg')
check('行内 chip 用线性 svg 图标（不用彩色 emoji）', seatedIcons.length === 1,
  `svg=${seatedIcons.length}`)
check('行内图标按 hero 行的 16px 规格渲染',
  seatedIcons[0]?.props?.width === 16 && seatedIcons[0]?.props?.viewBox === '0 0 16 16',
  `w=${String(seatedIcons[0]?.props?.width)} vb=${String(seatedIcons[0]?.props?.viewBox)}`)
check('行内图标用 currentColor 描边，跟随文字色（与邻居图标一致）',
  seatedIcons[0]?.children?.some?.(child => child?.props?.stroke === 'currentColor') === true,
  JSON.stringify(seatedIcons[0]?.children?.map?.(c => c?.props?.stroke) ?? null))
check('行内 chip 文案里不再有 emoji 字形',
  !/\p{Extended_Pictographic}/u.test(text(resting.triggerTree)), text(resting.triggerTree))

/* 静止态透明 ≠ 没有反馈：悬停仍然要给出底色，否则控件会"点不动"。 */
resting.triggerTree.props.onMouseEnter()
const hovered = await repaint()
check('行内 chip 悬停时仍给到底色反馈',
  hovered.triggerTree?.props?.style?.background === HOVER_BG_LITERAL,
  String(hovered.triggerTree?.props?.style?.background))
hovered.triggerTree.props.onMouseLeave()
const unhovered = await repaint()
check('行内 chip 移开鼠标后底色收回（不粘住）',
  unhovered.triggerTree?.props?.style?.background === 'transparent',
  String(unhovered.triggerTree?.props?.style?.background))

/* 行被摘下后必须退回工具行，否则 chip 会跟着容器一起静默消失。 */
seatRow.isConnected = false
triggerMounted = false
await repaint()
triggerMounted = true
const fallen = await repaint()

check('hero 行失效后退回工具行（不会静默消失）',
  fallen.triggerTree?.type === 'button' && fallen.triggerTree?.props?.style?.order === undefined,
  `${String(fallen.triggerTree?.type)} / order=${String(fallen.triggerTree?.props?.style?.order)}`)
check('退回工具行后图标改为 14px（跟随那一行的规格）',
  findAll(fallen.triggerTree, el => el.type === 'svg')[0]?.props?.width === 14,
  `w=${String(findAll(fallen.triggerTree, el => el.type === 'svg')[0]?.props?.width)}`)
check('整个 portal 过程没有渲染 / 副作用异常', renderErrors.length === 0, renderErrors.join(' | '))

/*
 * 17a-2. 回退路径回归：**开启开发者工具**时 Agent 预设 chip 外面会多一层 `.menuAnchor`
 * （`min-width:54px;max-width:100%`，见 ui-agent-preset 的 AgentPresetSeat 菜单锚点包装）。
 * 它不是 `display: contents`，所以「只跳 contents」的旧逻辑会把 chip 塞进这 54px 宽的层里
 * 被挤压/换行 —— 真机上表现为入口 chip 变形。
 *
 * 这一例刻意**不提供** `data-slot` 出口（模拟旧版 DSH / 出口属性缺失），逼实现走
 * 「往上找第一个不止一个孩子的层」这条回退路径。
 */
const wrapRow = fakeEl('div', { display: 'flex' })
const wrapWorkspace = attach(wrapRow, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
const menuAnchor = fakeEl('span', { display: 'block' })
const wrapPreset = attach(menuAnchor, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
attach(wrapRow, menuAnchor)

const wrapCard = fakeEl('div', { attrs: { 'data-composer-card': '' } })
wrapCard.compareDocumentPosition = node => (node === wrapWorkspace || node === wrapPreset ? 2 : 0)
globalThis.document = {
  querySelector: selector => (selector === '[data-composer-card]' ? wrapCard : null),
  querySelectorAll: selector =>
    (selector === 'button[aria-haspopup="menu"]' ? [wrapWorkspace, wrapPreset] : []),
  body: fakeEl('body'),
}

const portalsBeforeWrap = portals.length
triggerMounted = false
await repaint()
triggerMounted = true
await repaint()
const wrapPortals = portals.slice(portalsBeforeWrap).filter(item => item.container === wrapRow)

check('开启开发者工具（多一层 .menuAnchor 包装）：chip 仍落在 hero 行上',
  wrapPortals.length === 1, `${wrapPortals.length} 次（本次共 ${portals.length - portalsBeforeWrap} 次 portal）`)
check('没有落进 54px 宽的 .menuAnchor 包装层里',
  portals.slice(portalsBeforeWrap).every(item => item.container !== menuAnchor),
  String(portals.slice(portalsBeforeWrap)[0]?.container?.tag))

/* ================================================================== *
 *  17b. 落位回归：有内容的会话里，消息流的下拉按钮不得冒充 hero 行
 * ================================================================== */

/*
 * 真机现象：在有内容的会话里召唤专家团后，「● 团队名 7/7」标签出现在
 * 「本轮文件改动」的文件卡片网格里（紧挨最后一张卡片），而不是留在输入卡片的工具行。
 *
 * 根因：原先的扫描只看「位于卡片之前 + `aria-haspopup="menu"`」，而 deliverables 的
 * 每个文件卡片右侧都有一个「打开 ▾」按钮，命中同一选择器、同样在卡片之前，
 * 于是它被当成 hero 行的 seat，chip 被 portal 进那一行。
 *
 * 假 DOM 照抄真机三件事：会话根带 `data-phase`、输入区容器带 `data-composer-seat`、
 * 消息流里有 deliverables 风格的「打开 ▾」。两个阶段各断言一次 ——
 * active 态必须不 portal，hero 态必须照旧 portal；只堵一半会把正确落位一起改坏。
 */
const docBeforeSeatGuard = globalThis.document

const heroRootEl = fakeEl('div')
const liveRootEl = fakeEl('div')
const composerSeatEl = fakeEl('div')
const heroRowEl = fakeEl('div', { display: 'flex' })
const heroSlotEl = fakeEl('div', { display: 'contents' })
const heroChipEl = attach(heroSlotEl, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
attach(heroRowEl, heroSlotEl)
attach(composerSeatEl, heroRowEl)

const guardCard = fakeEl('div', { attrs: { 'data-composer-card': '' } })
const guardToolsEl = fakeEl('div', { display: 'flex' })
const guardCardChip = attach(guardToolsEl, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))
attach(guardCard, guardToolsEl)
attach(composerSeatEl, guardCard)

/* 消息流里的「本轮文件改动」：在卡片之前，但**不在**输入区容器内。 */
const deliveredRowEl = fakeEl('div', { display: 'flex' })
const deliveredChipEl = attach(deliveredRowEl, fakeEl('button', { attrs: { 'aria-haspopup': 'menu' } }))

guardCard.compareDocumentPosition = node =>
  (node === heroChipEl || node === deliveredChipEl ? 2 : 0)

let guardPhase = 'active'
function setGuardPhase(value) {
  guardPhase = value
  const root = value === 'hero' ? heroRootEl : liveRootEl
  root.attrs['data-phase'] = value
  root.getAttribute = name => root.attrs[name] ?? null
  guardCard.closest = selector => {
    if (selector === '[data-phase]') return root
    if (selector === '[data-composer-seat]') return composerSeatEl
    return null
  }
  /* 真机里 hero 行只在 hero 态存在：active 态的输入区容器里没有那两个 chip。 */
  composerSeatEl.querySelectorAll = selector => {
    if (selector !== 'button[aria-haspopup="menu"]') return []
    return guardPhase === 'hero' ? [heroChipEl, guardCardChip] : [guardCardChip]
  }
  /* 真机的输入区容器里始终有 `data-slot` 出口（hero 态才有 hero 行那两个）。 */
  composerSeatEl.querySelector = selector =>
    (guardPhase === 'hero' && selector === '[data-slot="conversation.hero.agentPreset"]' ? heroSlotEl : null)
}

globalThis.document = {
  querySelector: selector => (selector === '[data-composer-card]' ? guardCard : null),
  /*
   * 这条 mock 是回归的保险丝：全文档扫描（被门禁收窄之前的路径）能看到消息流里
   * 那个「打开 ▾」。实现一旦退回全文档扫描，下面的断言立刻变红。
   */
  querySelectorAll: selector =>
    (selector === 'button[aria-haspopup="menu"]' ? [deliveredChipEl, heroChipEl, guardCardChip] : []),
  body: docBeforeSeatGuard.body,
}

/* —— active（有内容的会话）：不得 portal 到消息流里的那一行 —— */
setGuardPhase('active')
const portalsBeforeActiveGuard = portals.length
triggerMounted = false
await repaint()
triggerMounted = true
const activeGuardPaint = await repaint()

const activeGuardPortals = portals.slice(portalsBeforeActiveGuard)
check('有内容的会话：不 portal 到消息流里的「打开 ▾」那一行',
  activeGuardPortals.every(item => item.container !== deliveredRowEl),
  `容器=${String(activeGuardPortals[0]?.container?.tag)}`)
check('有内容的会话：chip 退回输入卡片工具行，不占 hero 行的版式',
  activeGuardPaint.triggerTree?.type === 'button'
    && activeGuardPaint.triggerTree?.props?.style?.order === undefined,
  `${String(activeGuardPaint.triggerTree?.type)} / order=${String(activeGuardPaint.triggerTree?.props?.style?.order)}`)

/* —— hero（空会话）：照旧 portal 进那一行 —— */
setGuardPhase('hero')
const portalsBeforeHeroGuard = portals.length
triggerMounted = false
await repaint()
triggerMounted = true
const heroGuardPaint = await repaint()

const heroGuardPortals = portals.slice(portalsBeforeHeroGuard)
  .filter(item => item.container === heroRowEl)
check('hero 态：chip 仍然 portal 进「工作区 | Agent 预设」那一行',
  heroGuardPortals.length === 1, `${heroGuardPortals.length} 次`)
check('hero 态：行内 chip 仍用行版式（order 100）',
  heroGuardPaint.triggerTree?.props?.style?.order === 100,
  String(heroGuardPaint.triggerTree?.props?.style?.order))

globalThis.document = docBeforeSeatGuard

/* ================================================================== *
 *  18. 模态挂到 body：绕开 shell.overlay 的 z-index:20 层叠上下文
 * ================================================================== */

/*
 * 真机现象：模态开着，右半边却被右侧文件树面板挡住。
 * 根因不是"我们的 z-index 写小了"，而是 **被关进了别人的层叠上下文**：
 * `shell.overlay` 的容器 `_overlayLayer` 自带 z-index:20，于是内部写多大都只是层内第一；
 * 而文件树面板是 z-index 25 / 40 的独立层，自然压在 20 之上。
 * 修法：模态 portal 到 document.body，回到根层叠上下文（9999 > 40 才真的成立）。
 */
seatRow.isConnected = true
const portalsBeforeModal = portals.length
let panelTree = await repaint()
panelTree.triggerTree.props.onClick()
panelTree = await repaint()
check('打开面板后模态确实渲染了', panelTree.modalTree !== null)

const modalPortal = portals[portals.length - 1]
check('模态 portal 到 document.body（脱离 shell.overlay 的 z-index:20 层叠上下文）',
  portals.length > portalsBeforeModal && modalPortal?.container === globalThis.document.body,
  `container=${modalPortal?.container === globalThis.document.body
    ? 'body'
    : String(modalPortal?.container?.tag)}`)

const dialogEl = findAll(panelTree.modalTree, el => el.props?.role === 'dialog')[0]
check('模态仍是 role=dialog + 同款 aria-label（真浏览器定位不变）',
  dialogEl?.props?.['aria-label'] === '专家团', String(dialogEl?.props?.['aria-label']))

/* 关掉之后不能有残留节点挂在 body 上 */
const closeBackdrop = findAll(panelTree.modalTree, el => el.props?.onMouseDown !== undefined)[0]
closeBackdrop.props.onMouseDown({ target: 1, currentTarget: 1 })
const closedTree = await repaint()
check('关闭后模态从 body 上摘掉（不留残影）', closedTree.modalTree === null)

/* ================================================================== *
 *  18. 头像：同一套插画 + 手选覆盖 + 不跟着输入乱跳
 * ================================================================== */

/** 按具名 data 属性取某个头像选择器（一个表单里团队级 + 每位成员各一个）。 */
const pickerOf = (tree, name) => findAll(tree, el => el.props?.['data-avatar-picker'] === name)[0] ?? null
/** 选择器当前值 = 展开按钮里那张图的文件名（`01.jpg`）。 */
const pickerValue = picker => {
  if (picker === null) return ''
  const trigger = findAll(picker, el => el.type === 'button'
    && typeof el.props?.['aria-label'] === 'string'
    && el.props['aria-label'].startsWith('选择头像')
    && el.props['aria-expanded'] !== undefined)[0]
  const image = trigger === undefined ? undefined : findAll(trigger, el => el.type === 'img')[0]
  return String(image?.props?.src ?? '').split('/').pop()
}
const cellOf = (picker, file) => findAll(picker, el => el.type === 'button'
  && el.props?.['aria-label'] === `选择头像 ${file}`)[0]

;({ modalTree } = await openPanel())
buttonByText(modalTree, '新建团队').props.onClick()
;({ modalTree } = await repaint())

check('新建表单里有头像选择器（团队图标）', pickerOf(modalTree, '团队图标') !== null)
check('每位成员各有自己的头像选择器',
  pickerOf(modalTree, '成员 1') !== null && pickerOf(modalTree, '成员 2') !== null)
check('表单里不再有 emoji 网格（图标改用插画，不再手打字符）',
  !text(modalTree).includes('头像 emoji'))

/* 打开表单时就自动落一张（不是空着等用户挑） */
const openedValue = pickerValue(pickerOf(modalTree, '团队图标'))
check('新建表单打开时团队头像已自动落一张', /^[0-9]{2}\.jpg$/u.test(openedValue), openedValue)

/* 改名称**不该**把头像换掉：索引是文本哈希来的，跟着输入走会「每敲一个字换张脸」 */
typeInto(modalTree, '团队名称', '竞品分析小分队')
;({ modalTree } = await repaint())
check('改名称不会让头像乱跳（要用户点头才换）',
  pickerValue(pickerOf(modalTree, '团队图标')) === openedValue,
  `${openedValue} -> ${pickerValue(pickerOf(modalTree, '团队图标'))}`)

/* 「推荐这张」用当前名称算一张，点了才采用 */
typeInto(modalTree, '团队 id', 'icon-demo')
;({ modalTree } = await repaint())
const recommendChip = findAll(pickerOf(modalTree, '团队图标'), el => el.type === 'button'
  && collectText(el).join('').includes('推荐这张'))[0]
check('出现了「推荐这张」的采纳入口', recommendChip !== undefined)
recommendChip.props.onClick()
;({ modalTree } = await repaint())
const recommendedValue = pickerValue(pickerOf(modalTree, '团队图标'))
check('点「推荐这张」后头像换成按名称算出来的那张',
  /^[0-9]{2}\.jpg$/u.test(recommendedValue), recommendedValue)

/* 手选：点网格里的另一张，覆盖推荐 */
const paintCell = cellOf(pickerOf(modalTree, '团队图标'), '07.jpg')
check('头像网格里有可点的候选', paintCell !== undefined)
paintCell.props.onClick()
;({ modalTree } = await repaint())
check('点候选后头像换成手选的那张',
  pickerValue(pickerOf(modalTree, '团队图标')) === '07.jpg',
  pickerValue(pickerOf(modalTree, '团队图标')))

/* 手选之后，继续改名称不该把它冲掉（否则用户会觉得「我选的不算数」） */
typeInto(modalTree, '团队名称', '数据看板小分队')
;({ modalTree } = await repaint())
check('手选之后不再被推荐覆盖',
  pickerValue(pickerOf(modalTree, '团队图标')) === '07.jpg',
  pickerValue(pickerOf(modalTree, '团队图标')))

/* 成员头像同样支持手选（成员那一个是折叠态的，先展开网格） */
const memberTrigger = findAll(pickerOf(modalTree, '成员 1'), el => el.type === 'button'
  && el.props?.['aria-label'] === '选择头像：成员 1')[0]
check('成员头像选择器默认折叠（不铺满表单）', memberTrigger !== undefined
  && memberTrigger.props['aria-expanded'] === false, String(memberTrigger?.props?.['aria-expanded']))
memberTrigger.props.onClick()
;({ modalTree } = await repaint())
const memberCell = cellOf(pickerOf(modalTree, '成员 1'), '21.jpg')
check('成员头像也能手选', memberCell !== undefined)
memberCell.props.onClick()
;({ modalTree } = await repaint())
check('成员头像换成手选的那张', pickerValue(pickerOf(modalTree, '成员 1')) === '21.jpg',
  pickerValue(pickerOf(modalTree, '成员 1')))

/* 保存时带上图标 */
typeInto(modalTree, '团队 id', 'icon-demo')
buttonByText(modalTree, '保存团队').props.onClick()
;({ modalTree } = await repaint())
const iconPost = fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'POST').pop()
const iconTeam = JSON.parse(iconPost?.body ?? '{}')?.team ?? {}
check('保存团队时一并保存了团队头像索引（07.jpg → 6）', iconTeam.avatar === 6, String(iconTeam.avatar))
check('保存团队时一并保存了成员头像索引（21.jpg → 20）',
  iconTeam.members?.[0]?.avatar === 20, String(iconTeam.members?.[0]?.avatar))

/* ================================================================== *
 *  19. 成员详情：点成员 → 结构化查看 → 编辑保存 → 团队数据同步
 * ================================================================== */

/* 内置团队：可查看（含 persona 结构化），但只读 */
;({ modalTree } = await openPanel())
;({ modalTree } = await openTeam('产品战略团队'))
const builtinMember = findAll(modalTree, el => el.type === 'button'
  && typeof el.props?.['aria-label'] === 'string'
  && el.props['aria-label'].startsWith('查看成员详情'))[0]
check('详情页的成员卡片可点（打开成员详情）', builtinMember !== undefined)
builtinMember.props.onClick()
;({ modalTree } = await repaint())

const memberDialogOf = tree => findAll(tree, el => el.props?.['role'] === 'dialog'
  && typeof el.props?.['aria-label'] === 'string'
  && el.props['aria-label'].startsWith('成员详情'))[0]
const builtinDialog = memberDialogOf(modalTree)
check('点成员后弹出成员详情', builtinDialog !== undefined)
const builtinText = text(builtinDialog)
check('详情里能看到完整人格提示词',
  builtinText.includes('你是产品舵手'), builtinText.slice(0, 120))
check('persona 被拆成结构化小节（含「工作方式」）',
  ['职责', '工作方式', '交付物', '纪律'].every(label => builtinText.includes(label)),
  builtinText.slice(0, 200))
check('未锁定时内置团队的成员详情可编辑（有保存按钮）',
  buttonTexts(builtinDialog).some(label => label.includes('保存成员')),
  buttonTexts(builtinDialog).join(' / '))
check('未锁定时不显示「内置团队只读」提示',
  !builtinText.includes('内置团队只读'), builtinText.slice(-160))
buttonByLabel(builtinDialog, '关闭').props.onClick()
;({ modalTree } = await repaint())
check('关闭成员详情后回到团队详情', memberDialogOf(modalTree) === undefined)

/* 自定义团队：可改可存，保存后团队数据同步 */
;({ modalTree } = await openPanel())
;({ modalTree } = await openTeam('我的专家团'))
const customMember = findAll(modalTree, el => el.type === 'button'
  && typeof el.props?.['aria-label'] === 'string'
  && el.props['aria-label'].startsWith('查看成员详情'))[0]
customMember.props.onClick()
;({ modalTree } = await repaint())
const customDialog = memberDialogOf(modalTree)
check('自定义团队的成员详情可编辑（有保存按钮）',
  buttonTexts(customDialog).some(label => label.includes('保存成员')),
  buttonTexts(customDialog).join(' / '))

const postsBeforeMember = fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'POST').length
const getsBeforeMember = fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'GET').length
typeInto(customDialog, '职责范围', '竞品对标 · 结论把关')
buttonByText(customDialog, '编辑原文').props.onClick()
;({ modalTree } = await repaint())
const personaBox = findAll(modalTree, el => el.type === 'textarea')[0]
check('切到「编辑原文」后 persona 变成整段可编辑',
  typeof personaBox?.props?.onChange === 'function')
personaBox.props.onChange({ target: { value: '你是主理人。你的职责是定方向。' } })
;({ modalTree } = await repaint())
buttonByText(memberDialogOf(modalTree), '保存成员').props.onClick()
for (let round = 0; round < 4; round += 1) { await tick(); await repaint() }

const memberPost = fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'POST').pop()
const memberTeam = JSON.parse(memberPost?.body ?? '{}')?.team ?? {}
check('保存成员走 POST /api/teams（整体回写）',
  fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'POST').length === postsBeforeMember + 1)
check('回写的团队里带上了改过的职责',
  memberTeam.members?.some(member => member.focus === '竞品对标 · 结论把关'),
  JSON.stringify(memberTeam.members?.map(member => member.focus)))
check('回写的团队里带上了改过的 persona',
  memberTeam.members?.some(member => member.persona === '你是主理人。你的职责是定方向。'),
  JSON.stringify(memberTeam.members?.map(member => member.persona)))
check('回写没有丢掉团队级字段（名称 / 图标仍在）',
  memberTeam.name === '我的专家团' && typeof memberTeam.emoji === 'string' && memberTeam.emoji !== '',
  `${memberTeam.name} / ${memberTeam.emoji}`)
check('保存后重新拉取团队列表（列表与配置同步）',
  fetchLog.filter(item => item.url.endsWith('/api/teams') && item.method === 'GET').length > getsBeforeMember)
check('保存后成员详情自动关闭', memberDialogOf((await repaint()).modalTree) === undefined)

/* ================================================================== *
 *  18. 锁定态回归：config.lockBuiltinTeams=true（定稿后的形态）
 * ================================================================== */

/*
 * 先关面板再重开 —— Modal 每次 open 都会重新拉 `/api/teams`，
 * 于是这一段拿到的是 locked=true 的那份 config，正是定稿后要退回的形态。
 */
const panelBeforeLock = (await repaint()).modalTree
if (panelBeforeLock !== null) {
  buttonByLabel(panelBeforeLock, '关闭').props.onClick()
  await repaint()
}
lockBuiltinTeams = true

const getsBeforeLock = fetchLog.filter(i => i.url.endsWith('/api/teams') && i.method === 'GET').length
;({ modalTree } = await openTeam('产品战略团队'))
check('锁定段重开面板确实重新拉了配置',
  fetchLog.filter(i => i.url.endsWith('/api/teams') && i.method === 'GET').length > getsBeforeLock,
  `${getsBeforeLock} → ${fetchLog.filter(i => i.url.endsWith('/api/teams') && i.method === 'GET').length}`)
check('锁定时内置团队详情不显示「编辑」按钮',
  !buttonTexts(modalTree).includes('编辑'), buttonTexts(modalTree).join(' / '))

const lockedMemberBtn = findAll(modalTree, el => el.type === 'button'
  && typeof el.props?.['aria-label'] === 'string'
  && el.props['aria-label'].startsWith('查看成员详情'))[0]
lockedMemberBtn.props.onClick()
;({ modalTree } = await repaint())
const lockedDialog = memberDialogOf(modalTree)
check('锁定时内置团队的成员详情是只读的（不提供保存按钮）',
  !buttonTexts(lockedDialog).some(label => label.includes('保存成员')),
  buttonTexts(lockedDialog).join(' / '))
check('锁定时说明了怎么解锁（config.json / 另存为自定义）',
  text(lockedDialog).includes('内置团队只读'), text(lockedDialog).slice(-200))
buttonByLabel(lockedDialog, '关闭').props.onClick()
;({ modalTree } = await repaint())

/* 锁定只针对内置基线：自定义团队任何时候都可改。 */
buttonByText(modalTree, '全部团队').props.onClick()
;({ modalTree } = await repaint())
;({ modalTree } = await openTeam('我的专家团'))
check('锁定时自定义团队仍显示「编辑」',
  buttonTexts(modalTree).includes('编辑'), buttonTexts(modalTree).join(' / '))

/* 复位，避免影响复跑时的默认态。 */
lockBuiltinTeams = false

/* ================================================================== *
 *  20. 成员下拉的方向自适应：贴着页面底部必须向上开
 * ================================================================== */

/*
 * 真机现象：chip 落进输入卡片工具行（页面最底部）之后，点小三角只看得见
 * 「派遣成员（4/4）」这一行标题，成员列表被输入卡片连同视口一起裁掉。
 * 根因是菜单坐标写死成 `top: rect.bottom + 6` —— 永远向下开。
 *
 * 假 DOM 没有布局引擎（useRef 的 current 永远停在初值），所以拦一道 createElement，
 * 把带 ref 的元素对象的 current 换成我们的假节点，模拟「chip 在视口里的位置」。
 * 只在本 section 生效（refStub 默认 null，不影响前面那些依赖「拿不到布局」的断言）。
 */
const baseCreateElement = React.createElement
let refStub = null
React.createElement = function (type, props, ...rest) {
  if (refStub !== null && props !== null && typeof props === 'object'
    && typeof props.ref === 'object' && props.ref !== null) {
    props.ref.current = refStub
  }
  return baseCreateElement.call(this, type, props, ...rest)
}

const savedWindow = globalThis.window
globalThis.window = {
  ...(savedWindow ?? {}),
  innerHeight: 600,
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** 从渲染树里取出成员下拉的 style（菜单是 portal 出去的，内容仍在树里）。 */
const menuStyleOf = paint => findAll(paint.chipTree,
  el => el.props?.['data-expert-team-member-menu'] !== undefined)[0]?.props?.style ?? null

await summonTeam('产品战略团队')
let placementPaint = await repaint()
const placementChipRoot = placementPaint.chipTree.children?.[0] ?? placementPaint.chipTree
placementChipRoot.props.onMouseEnter()
placementPaint = await repaint()
const placementCaret = findAll(placementPaint.chipTree, el => el.type === 'button')
  .find(el => el.props?.['aria-label'] === '选择派遣成员')
check('（前置）方向自适应用例拿得到成员下拉三角', placementCaret !== undefined)

/* 场景 A：chip 贴在视口底部（top 560 / bottom 588，视口 600）→ 必须向上开 */
refStub = { getBoundingClientRect: () => ({ left: 120, top: 560, bottom: 588, width: 200, height: 28 }) }
await repaint()
placementCaret.props.onClick()
const bottomOpenStyle = menuStyleOf(await repaint())
check('贴底时菜单向上开（用 bottom 定位，不再顶出视口）',
  bottomOpenStyle !== null && bottomOpenStyle.bottom === 46 && bottomOpenStyle.top === undefined,
  `bottom=${String(bottomOpenStyle?.bottom)} top=${String(bottomOpenStyle?.top)}`)
check('向上开时 maxHeight 收进上方可用空间',
  bottomOpenStyle !== null && bottomOpenStyle.maxHeight === 546, String(bottomOpenStyle?.maxHeight))

/* 场景 B：chip 在页面上方 → 仍然向下开（别把原本正确的情况改坏） */
placementCaret.props.onClick()
await repaint()
refStub = { getBoundingClientRect: () => ({ left: 120, top: 60, bottom: 88, width: 200, height: 28 }) }
await repaint()
placementCaret.props.onClick()
const topOpenStyle = menuStyleOf(await repaint())
check('靠上时菜单仍然向下开（top 定位）',
  topOpenStyle !== null && topOpenStyle.top === 94 && topOpenStyle.bottom === undefined,
  `bottom=${String(topOpenStyle?.bottom)} top=${String(topOpenStyle?.top)}`)
check('向下开时 maxHeight 收进下方可用空间',
  topOpenStyle !== null && topOpenStyle.maxHeight === 498, String(topOpenStyle?.maxHeight))

refStub = null
globalThis.window = savedWindow

delete globalThis.document
delete globalThis.getComputedStyle
delete globalThis.Node

/* ================================================================== *
 *  19. 报告
 * ================================================================== */

const failed = results.filter(item => !item.ok)
const report = [
  'expert-team 浏览器半冒烟报告',
  `通过 ${results.length - failed.length} / ${results.length}`,
  `渲染累计遍数：${renderPasses}（单次收敛上限 40 遍）`,
  `useMemo 实际重算次数：${memoComputes}`,
  `渲染 / 副作用异常：${renderErrors.length === 0 ? '无' : renderErrors.join(' | ')}`,
  '',
  ...results.map(item => `${item.ok ? '[PASS]' : '[FAIL]'} ${item.label}${item.detail !== '' ? ` — ${item.detail}` : ''}`),
  '',
  failed.length === 0 ? '结论：全部通过。' : `结论：${failed.length} 项失败。`,
].join('\n')

console.log(report)
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
fs.writeFileSync(path.join(ROOT, '.tmp/client-smoke-report.txt'), `${report}\n`, 'utf8')
process.exitCode = failed.length === 0 && renderErrors.length === 0 ? 0 : 1
