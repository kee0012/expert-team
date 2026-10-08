/**
 * 宿主半运行时冒烟：用假的 Cordis ctx 真跑一遍 apply()，
 * 覆盖 HTTP 路由、斜杠命令、召唤链路与输入校验。
 *
 * 用法：node scripts/smoke.mjs
 * 报告写入 .tmp/smoke-report.txt（便于无回显环境读取）。
 */

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = path.join(ROOT, '.tmp', 'smoke-home')

// 内置团队数从数据文件**实时读**，不在断言里写死数字：
// 往 data/teams.json 加团队是常规迭代，不该让冒烟脚本跟着变红。
const BUILTIN_COUNT = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'teams.json'), 'utf8'),
).teams.length

// 必须在 import lib/index.js 之前设置：模块加载时就会算 USER_DIR。
fs.rmSync(SANDBOX_HOME, { recursive: true, force: true })
fs.mkdirSync(SANDBOX_HOME, { recursive: true })
process.env.DSH_HOME = SANDBOX_HOME

const results = []
const check = (label, condition, detail = '') => {
  results.push({ ok: Boolean(condition), label, detail: String(detail) })
}

/* ---------------------------------------------------------------- *
 *  假 ctx
 * ---------------------------------------------------------------- */

const calls = { continuable: [], registeredTools: [], events: [], toolDefinitions: {}, pending: [] }

function makeProvider({ name, persona, extraCapabilities }) {
  return {
    name,
    capabilities: { ...persona ? { persona: true } : {}, ...extraCapabilities },
    // 方法存在即「支持 continuable 子会话」的能力标记
    prepareContinuable: request => request,
  }
}

function makeFakes({ personaCapable, extraCapabilities, startFails }) {
  const childSessions = new Map()
  const agents = {
    list: () => [{
      id: 'root-session',
      session: { id: 'root-session' },
      ctx: {
        tools: {
          register: definition => {
            calls.registeredTools.push(definition.name)
            // 存下定义体：下面要用它的真实 output schema 校验返回值。
            // 假环境不照抄真契约，正是「工具返回值与 schema 不匹配」这类
            // 只在真机炸的问题一路全绿的根源。
            calls.toolDefinitions[definition.name] = definition
            return () => {}
          },
        },
      },
    }],
  }
  const subagents = {
    list: () => ['spawn', 'some-other'],
    getProvider: name => (name === 'spawn' ? makeProvider({ name, persona: personaCapable, extraCapabilities }) : undefined),
    startContinuable: spec => {
      // 让「整批派遣全挂」这条路径可控：宿主真实报错可能极长
      // （`tools.restrict()` 会把整张全局工具表列一遍）。
      if (startFails !== undefined) throw new Error(startFails)
      // 契约校验（照抄真实 DSH 的行为）：`dsh-subagent` 的 startContinuable 内部直接
      // 调用 `spec.signal.throwIfAborted()`，**没有 undefined 保护**。
      // 这里的 stub 以前不校验，于是「HTTP 路径漏传 signal」这个致命 bug
      // 在冒烟里一路全绿，直到用户在真机上点「确认派遣」才炸成 500。
      if (spec?.signal === undefined || typeof spec.signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      // 已取消的 signal 必须显式拒绝，而不是继续建子会话
      spec.signal.throwIfAborted()
      calls.continuable.push(spec)
      const snapshot = { childId: spec.childId, messageId: `msg-${spec.childId.slice(0, 8)}` }
      childSessions.set(spec.childId, snapshot)
      return Promise.resolve(snapshot)
    },
  }
  const commands = {
    register: definition => {
      calls.commands = definition
      return () => {}
    },
  }
  const tools = { register: definition => definition }

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      register: options => {
        calls.http = options
        return () => { calls.http = undefined }
      },
    },
    effect: fn => fn(),
    on: (name, handler) => { calls.events.push(name) },
    get: (service) => {
      if (service === 'agents') return agents
      if (service === 'subagents') return subagents
      if (service === 'commands') return commands
      if (service === 'tools') return tools
      return undefined
    },
    /*
     * cordis 的 `ctx.inject(['a','b'], cb)`：依赖服务就绪时，用一个「作用域 ctx」
     * 执行 cb（作用域卸载会连带回收里面注册的东西），服务重启后自动重跑。
     * 这里照抄最小等价语义：依赖全部可解析就执行；解析不出来的记进 calls.pending，
     * 冒烟末尾断言它为空 —— 这正是真机上「工具/命令静默消失」的症状。
     */
    inject: (deps, callback) => {
      const missing = deps.filter(dep => ctx.get(dep) === undefined)
      if (missing.length > 0) {
        calls.pending.push({ deps, missing })
        return undefined
      }
      return callback({ ...ctx, ...Object.fromEntries(deps.map(dep => [dep, ctx.get(dep)])) })
    },
  }
  return { ctx, agents, subagents }
}

/* ---------------------------------------------------------------- *
 *  假 req / res
 * ---------------------------------------------------------------- */

class FakeReq extends EventEmitter {
  constructor({ method, url, rawBody }) {
    super()
    this.method = method
    this.url = url
    this.rawBody = rawBody
  }

  /** 真实 IncomingMessage 有 destroy()；超限分支会调用它。 */
  destroy() { this.destroyed = true }
}

function request(handler, { method = 'GET', url, body, rawBody }) {
  return new Promise((resolve, reject) => {
    const req = new FakeReq({ method, url, rawBody })
    const chunks = []
    let status = 0
    let headers = null
    // 真实 http.ServerResponse 是 EventEmitter：插件用 `res.on('close')` 绑定请求生命周期，
    // 好在 HTTP 路径上造出 startContinuable 必填的那个 AbortSignal。
    // 假 res 以前是个裸对象，于是这条路径在冒烟里直接 "res.on is not a function"。
    const res = new EventEmitter()
    Object.assign(res, {
      writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks)
        let parsed = null
        try { parsed = JSON.parse(raw.toString('utf8')) } catch { parsed = null }
        resolve({ status, headers, body: parsed, raw })
      },
      destroy() {},
    })
    Promise.resolve(handler(req, res)).catch(reject)
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined
    if (payload !== undefined) req.emit('data', Buffer.from(payload))
    req.emit('end')
  })
}

/* ---------------------------------------------------------------- *
 *  跑
 * ---------------------------------------------------------------- */

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

check('inject 只含 webServer', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'webServer', JSON.stringify(mod.inject))
check('导出 name 正确', mod.name === 'expert-team', mod.name)

const { ctx } = makeFakes({ personaCapable: true })
mod.apply(ctx)

/* apply 之后不该有「依赖没就绪、注册体没跑」的可选服务：那意味着工具/命令静默消失。 */
check('apply 后没有未激活的可选服务（ctx.inject 全部执行）', calls.pending.length === 0, JSON.stringify(calls.pending))

check('注册了 HTTP 路由', calls.http !== undefined && calls.http.kind === 'prefix', calls.http?.path)
check('注册点 path 与包名一致', calls.http?.path === '/expert-team', calls.http?.path)
/*
 * 尾斜杠是致命陷阱：WebServer 的 prefix 匹配是
 * `pathname === p || pathname.startsWith(p + '/')`，
 * 写成 '/expert-team/' 会让 /expert-team/api/xxx 谁都匹配不到，
 * 落到静态兜底变成空 404（真机上踩过）。这条断言必须拦住它。
 */
check('注册点 path 不带尾斜杠', typeof calls.http?.path === 'string' && !calls.http.path.endsWith('/'), calls.http?.path)
check('注册点 path 以 / 开头', typeof calls.http?.path === 'string' && calls.http.path.startsWith('/'), calls.http?.path)

/*
 * 直接调 handler 会绕过路由匹配，所以下面用宿主**真实的** match() 规则
 * （webserver/src/index.ts：`pathname === prefix || pathname.startsWith(prefix + '/')`）
 * 再验一遍请求到底能不能走到我们的 handler。
 */
{
  const prefix = calls.http?.path ?? ''
  const reachable = pathname => pathname === prefix || pathname.startsWith(`${prefix}/`)
  check('路由可达 /<name>', reachable('/expert-team'), prefix)
  check('路由可达 /<name>/api/health', reachable('/expert-team/api/health'), prefix)
  check('路由可达 /<name>/api/teams', reachable('/expert-team/api/teams'), prefix)
  check('路由可达 /<name>/api/teams/<id>', reachable('/expert-team/api/teams/x'), prefix)
  check('路由不误吞同前缀的别的包', !reachable('/expert-team-extra/api/health'), prefix)
  check('路由不误吞别的包', !reachable('/other-plugin/api/health'), prefix)
}
check('注册了斜杠命令', calls.commands?.name === 'expert-team', calls.commands?.name)
check('注册了模型工具', calls.registeredTools.includes('expert_team_list') && calls.registeredTools.includes('expert_team_summon'), calls.registeredTools.join(','))
check('订阅了 agent 生命周期事件', calls.events.includes('agent/created') && calls.events.includes('agent/disposed'), calls.events.join(','))

const handler = calls.http.handler

/* 1. health */
{
  const res = await request(handler, { url: '/expert-team/api/health' })
  check('GET health → 200', res.status === 200, res.status)
  check(`GET health 报告团队数 = ${BUILTIN_COUNT}`, res.body?.teams === BUILTIN_COUNT, res.body?.teams)
  check('GET health 报告 subagent provider', res.body?.subagentProvider === 'spawn', res.body?.subagentProvider)
  check('GET health 报告 persona 原生支持', res.body?.personaNative === true, res.body?.personaNative)
}

/* 2. 团队列表：persona 随列表下发（面板「编辑团队」要回填人格提示词） */
{
  const res = await request(handler, { url: '/expert-team/api/teams' })
  check(`GET teams → 200 且 ${BUILTIN_COUNT} 支`,
    res.status === 200 && res.body?.teams?.length === BUILTIN_COUNT,
    res.body?.teams?.length)
  const raw = JSON.stringify(res.body)
  check('列表下发 persona 供面板编辑回填', raw.includes('你是「'), raw.slice(0, 120))
  const team = res.body?.teams?.find(item => item.id === 'product-strategy')
  check('product-strategy 6 位成员', team?.members?.length === 6, team?.members?.length)
  check('成员含主理人标记', team?.members?.some(member => member.role === 'lead'))
  check('每位成员都带 persona 字段',
    team?.members?.every(member => typeof member.persona === 'string' && member.persona !== ''),
    JSON.stringify(team?.members?.map(m => `${m.id}:${m.persona.length}`)))
  check('列表不下发 usage 原始映射', raw.includes('"usage":') === false)
}

/* 3. 未知路由 */
{
  const res = await request(handler, { url: '/expert-team/api/nope' })
  check('未知接口 → 404', res.status === 404, res.status)
  const res2 = await request(handler, { url: '/expert-team/not-api' })
  check('非 api 前缀 → 404', res2.status === 404, res2.status)
}

/* 3.5 成员头像：静态资源走宿主路由按需取（而不是内联进客户端 bundle） --- */
{
  const res = await request(handler, { url: '/expert-team/avatar/01.jpg' })
  check('GET avatar/01.jpg → 200', res.status === 200, res.status)
  check('头像 content-type 是 image/jpeg',
    res.headers?.['content-type'] === 'image/jpeg', res.headers?.['content-type'])
  check('头像返回真实 JPEG 字节（FFD8 开头、非空）',
    res.raw?.length > 500 && res.raw[0] === 0xFF && res.raw[1] === 0xD8,
    `${res.raw?.length} bytes, head=${res.raw?.subarray(0, 2).toString('hex')}`)
  check('头像不做长缓存（换素材后立刻生效）',
    res.headers?.['cache-control'] === 'no-cache', res.headers?.['cache-control'])

  // 名字不合规的一律 404：这是唯一一处直接按 URL 读文件的地方，白名单必须生效。
  const evil = await request(handler, { url: '/expert-team/avatar/%2e%2e%2fpackage.json' })
  check('头像路径不允许目录穿越 → 404', evil.status === 404, evil.status)
  const short = await request(handler, { url: '/expert-team/avatar/1.jpg' })
  check('头像文件名必须两位数字 → 404', short.status === 404, short.status)
  const missing = await request(handler, { url: '/expert-team/avatar/99.jpg' })
  check('不存在的序号 → 404', missing.status === 404, missing.status)
  const posted = await request(handler, { method: 'POST', url: '/expert-team/avatar/01.jpg' })
  check('头像只接受 GET → 405', posted.status === 405, posted.status)
}

/* 4. POST 新建自定义团队 + 校验 */
{
  const team = {
    id: 'my-team',
    name: '我的专家团',
    tagline: '测试用',
    emoji: '🧪',
    accent: '#123456',
    presets: ['先做这个'],
    cases: [{ emoji: '📄', title: '用例一', desc: '说明' }],
    members: [
      { id: 'chief', name: '主理', role: 'lead', focus: '统筹', persona: '你是主理，负责统筹并汇总所有结论。' },
      { id: 'worker', name: '干活', role: 'member', focus: '执行', persona: '你是执行者，负责产出可用的具体结果。' },
    ],
  }
  const res = await request(handler, { method: 'POST', url: '/expert-team/api/teams', body: { team } })
  check('POST teams 新建自定义团队 → 200', res.status === 200 && res.body?.ok === true, res.body?.error)
  check('自定义团队标记 source=custom', res.body?.team?.source === 'custom', res.body?.team?.source)
  check('自定义团队落盘', fs.existsSync(path.join(SANDBOX_HOME, 'expert-teams', 'teams.json')))

  const listed = await request(handler, { url: '/expert-team/api/teams' })
  check(`列表变 ${BUILTIN_COUNT + 1} 支`,
    listed.body?.teams?.length === BUILTIN_COUNT + 1,
    listed.body?.teams?.length)

  const bad = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: { team: { ...team, id: 'Bad_ID' } },
  })
  check('非法 id → 400', bad.status === 400, `${bad.status} ${bad.body?.error}`)

  const noPersona = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: { team: { ...team, id: 'no-persona', members: [{ id: 'a', name: 'A', persona: '' }] } },
  })
  check('缺 persona → 400', noPersona.status === 400, `${noPersona.status} ${noPersona.body?.error}`)

  const twoLeads = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: {
      team: {
        ...team,
        id: 'two-leads',
        members: [
          { id: 'a', name: 'A', role: 'lead', persona: '你是 A，负责统筹全部工作内容。' },
          { id: 'b', name: 'B', role: 'lead', persona: '你是 B，负责统筹全部工作内容。' },
        ],
      },
    },
  })
  check('两位主理人 → 400', twoLeads.status === 400, `${twoLeads.status} ${twoLeads.body?.error}`)

  const del = await request(handler, { method: 'DELETE', url: '/expert-team/api/teams/my-team' })
  check('DELETE 自定义团队 → ok', del.status === 200 && del.body?.removed === true, JSON.stringify(del.body))
  const after = await request(handler, { url: '/expert-team/api/teams' })
  check(`删除后回到 ${BUILTIN_COUNT} 支`,
    after.body?.teams?.length === BUILTIN_COUNT,
    after.body?.teams?.length)

  const delBuiltin = await request(handler, { method: 'DELETE', url: '/expert-team/api/teams/product-strategy' })
  check('内置团队删除后仍可见', delBuiltin.status === 200 && delBuiltin.body?.stillVisible === true, JSON.stringify(delBuiltin.body))
}

/* 4b. 运行配置 config.json：锁定开关 + 各项上限（开发阶段默认不锁定） */
{
  const probe = {
    id: 'cfg-probe',
    name: '配置探针',
    members: [
      { id: 'a', name: 'A', role: 'lead', persona: '你是 A，负责统筹全部工作内容。' },
      { id: 'b', name: 'B', persona: '你是 B，负责执行具体工作内容。' },
    ],
  }
  const configFile = path.join(SANDBOX_HOME, 'expert-teams', 'config.json')

  const initial = await request(handler, { url: '/expert-team/api/config' })
  check('GET config → 开发阶段默认不锁定内置团队',
    initial.body?.config?.lockBuiltinTeams === false, JSON.stringify(initial.body?.config))
  check('GET config → 带各项上限（默认 maxMembers=13）',
    initial.body?.config?.limits?.maxMembers === 13, JSON.stringify(initial.body?.config?.limits))

  const withConfig = await request(handler, { url: '/expert-team/api/teams' })
  check('GET teams 一并下发 config（少一次往返）',
    withConfig.body?.config?.lockBuiltinTeams === false, JSON.stringify(withConfig.body?.config))
  check('首次启动落了一份可直接改的配置模板', fs.existsSync(configFile))

  /* 上限可被配置覆盖：把成员数压到 1，两位成员的团队应当被拒 —— 证明上限不是写死的。 */
  fs.writeFileSync(configFile, JSON.stringify({ lockBuiltinTeams: false, limits: { maxMembers: 1 } }), 'utf8')
  const overLimit = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: { team: probe },
  })
  check('limits.maxMembers 覆盖生效 → 超限 400',
    overLimit.status === 400 && String(overLimit.body?.error ?? '').includes('最多 1 位'),
    `${overLimit.status} ${overLimit.body?.error}`)

  /* 锁定后：写入内置 id 被拒（403 LOCKED），自定义 id 照常 —— "不可更改"不能只靠藏 UI。 */
  fs.writeFileSync(configFile, JSON.stringify({ lockBuiltinTeams: true }), 'utf8')
  const lockedBuiltin = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: { team: { ...probe, id: 'product-strategy' } },
  })
  check('锁定时写入内置 id → 403 LOCKED',
    lockedBuiltin.status === 403 && lockedBuiltin.body?.code === 'LOCKED',
    `${lockedBuiltin.status} ${lockedBuiltin.body?.error}`)

  const lockedCustom = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    body: { team: { ...probe, id: 'still-mine' } },
  })
  check('锁定时自定义 id 仍可写（锁定只针对内置基线）',
    lockedCustom.status === 200, `${lockedCustom.status} ${lockedCustom.body?.error}`)

  /* 复位：后面的用例依赖「未锁定 + 默认上限」，且不能留下探针团队（团队总数会被断言）。 */
  fs.rmSync(configFile, { force: true })
  const cleanup = await request(handler, { method: 'DELETE', url: '/expert-team/api/teams/still-mine' })
  check('探针团队已清理（不污染后续用例的团队总数）',
    cleanup.status === 200 && cleanup.body?.removed === true, JSON.stringify(cleanup.body))
}

/* 5. 召唤：persona 原生通道 */
{
  const res = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'product-strategy', task: '帮我做一次竞品分析' },
  })
  check('POST summon → 200', res.status === 200 && res.body?.ok === true, `${res.status} ${res.body?.error}`)
  check('派出全部 6 位专家', res.body?.dispatched?.length === 6, res.body?.dispatched?.length)
  check('provider 为 spawn', res.body?.provider === 'spawn', res.body?.provider)
  check('personaNative 为 true', res.body?.personaNative === true, res.body?.personaNative)
  check('调用了 6 次 startContinuable', calls.continuable.length === 6, calls.continuable.length)

  const first = calls.continuable[0]
  check(
    'spec.signal 是真实 AbortSignal（startContinuable 的必填契约）',
    first?.signal !== undefined && typeof first.signal.throwIfAborted === 'function',
    typeof first?.signal,
  )
  check('request.prompt 是 ContentBlock[]', Array.isArray(first?.request?.prompt) && first.request.prompt[0]?.type === 'text')
  check('request.parent 是 root agent', first?.request?.parent?.id === 'root-session', first?.request?.parent?.id)
  check('persona 走原生通道', typeof first?.request?.persona === 'string' && first.request.persona.startsWith('你是「'), first?.request?.persona?.slice(0, 16))
  check('label 含团队名与专家名', first?.label === '产品战略团队 · 产品舵手', first?.label)
  check('prompt 含本次任务', first?.request?.prompt?.[0]?.text?.includes('帮我做一次竞品分析'))

  const status = await request(handler, { url: '/expert-team/api/status?teamId=product-strategy' })
  check('台账记录了本次派发', status.body?.dispatches?.length === 1, status.body?.dispatches?.length)
}

/* 6. 召唤：persona 非原生时的回退（persona 并入 prompt） */
{
  calls.continuable.length = 0
  const { ctx: ctx2 } = makeFakes({ personaCapable: false })
  mod.apply(ctx2)
  const handler2 = calls.http.handler
  const res = await request(handler2, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'product-strategy', task: '做一次复盘', memberIds: ['product-helmsman'] },
  })
  check('回退模式 → 只派 1 位（按 memberIds）', res.body?.dispatched?.length === 1, res.body?.dispatched?.length)
  check('回退模式 personaNative=false', res.body?.personaNative === false, res.body?.personaNative)
  const spec = calls.continuable[0]
  check('回退模式不传 request.persona', spec?.request?.persona === undefined, String(spec?.request?.persona))
  check('回退模式 persona 并入 prompt', spec?.request?.prompt?.[0]?.text?.includes('你的角色设定'))
}

/* 7. 召唤错误分支 */
{
  const noTeam = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'ghost', task: 'x' },
  })
  check('召唤不存在的团队 → 404', noTeam.status === 404, `${noTeam.status} ${noTeam.body?.error}`)

  const noTask = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'product-strategy', task: '   ' },
  })
  check('召唤缺任务 → 400', noTask.status === 400, `${noTask.status} ${noTask.body?.error}`)

  const noParent = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'ghost-session', teamId: 'product-strategy', task: 'x' },
  })
  check('找不到会话 → 409 NO_PARENT', noParent.status === 409 && noParent.body?.code === 'NO_PARENT', `${noParent.status} ${noParent.body?.code}`)
}

/* 8. body 上限 */
{
  const res = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/teams',
    rawBody: JSON.stringify({ team: { pad: 'x'.repeat(1_200_000) } }),
  })
  check('超大 body → 413', res.status === 413, res.status)
}

/* 9. 斜杠命令 */
{
  const list = await calls.commands.handler({ rawInput: '' })
  check('命令 list → kind=success', list?.kind === 'success', JSON.stringify(list)?.slice(0, 80))
  check(`命令 list 列出全部 ${BUILTIN_COUNT} 支团队`,
    (list?.text?.match(/·/g) ?? []).length >= BUILTIN_COUNT,
    list?.text?.slice(0, 60))
  check(`命令 list 报出团队总数 ${BUILTIN_COUNT}`,
    list?.text?.includes(`${BUILTIN_COUNT} 支`),
    list?.text?.slice(0, 30))

  const show = await calls.commands.handler({ rawInput: 'show product-strategy' })
  check('命令 show 含成员名册', show?.text?.includes('产品舵手') && show?.text?.includes('主理人'), show?.text?.slice(0, 40))

  const missing = await calls.commands.handler({ rawInput: 'show ghost' })
  check('命令 show 不存在 → kind=error', missing?.kind === 'error', JSON.stringify(missing))

  const swarm = await calls.commands.handler({ rawInput: 'summon ai-frontier-research 做个简报' })
  check('命令 summon → kind=success', swarm?.kind === 'success' && swarm.text.includes('ai-frontier-research'), swarm?.text?.slice(0, 60))

  const bogus = await calls.commands.handler({ rawInput: 'wat' })
  check('命令未知子命令 → kind=error', bogus?.kind === 'error', JSON.stringify(bogus))
}

/* ---------------------------------------------------------------- *
 *  10. 分批派遣：阶段计划、上游产出传递、子会话护栏
 * ---------------------------------------------------------------- */

/** 按 JSON Schema 校验对象（只覆盖本插件用到的那几个关键字）。 */
function schemaIssues(schema, value, at = '$') {
  const issues = []
  if (schema === undefined) return issues
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at} 应为对象`]
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push(`${at}.${key} 缺失（schema 要求必填）`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) issues.push(`${at}.${key} 未在 schema 中声明`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) issues.push(...schemaIssues(sub, value[key], `${at}.${key}`))
    }
    return issues
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${at} 应为数组`]
    return value.flatMap((item, index) => schemaIssues(schema.items, item, `${at}[${index}]`))
  }
  if (schema.type === 'number' && typeof value !== 'number') issues.push(`${at} 应为 number`)
  if (schema.type === 'string' && typeof value !== 'string') issues.push(`${at} 应为 string`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') issues.push(`${at} 应为 boolean`)
  return issues
}

const STAGED_TEAM = {
  id: 'staged-probe',
  name: '分批探针团',
  tagline: '阶段派遣冒烟探针',
  emoji: '🧪',
  accent: '#123456',
  category: '测试',
  tags: ['分批'],
  presets: ['跑一轮'],
  cases: [],
  members: [
    { id: 'p1-a', name: '甲', alias: '甲甲', role: 'lead', focus: '收集', persona: '你是甲的测试人格。' },
    { id: 'p1-b', name: '乙', alias: '乙乙', role: 'member', focus: '收集', persona: '你是乙的测试人格。' },
    { id: 'p2-a', name: '丙', alias: '丙丙', role: 'member', focus: '裁决', persona: '你是丙的测试人格。' },
  ],
  stages: [
    { stage: 1, name: '收集', members: ['p1-a', 'p1-b'] },
    { stage: 2, name: '裁决', members: ['p2-a'] },
  ],
}

/* 对照组：一支**没有** stages 的团队。
   内置团队现在全都带阶段计划了，所以「无阶段＝旧行为」这件事必须由测试自己造样本 ——
   拿任何一支内置团队当无阶段对照，都会在数据演进后变成假失败。 */
const PLAIN_TEAM = {
  id: 'plain-probe',
  name: '无阶段探针团',
  tagline: '对照：一次性并行派遣',
  emoji: '🧪',
  accent: '#654321',
  category: '测试',
  tags: ['对照'],
  presets: ['跑一轮'],
  cases: [],
  members: [
    { id: 'q1-a', name: '甲一', alias: '甲一', role: 'lead', focus: '做事', persona: '你是甲一的测试人格。' },
    { id: 'q1-b', name: '乙二', alias: '乙二', role: 'member', focus: '做事', persona: '你是乙二的测试人格。' },
  ],
}

/* 10.1 阶段数据的校验规则（不许静默漏派、不许引用幽灵成员） */
{
  const post = team => request(handler, { method: 'POST', url: '/expert-team/api/teams', body: { team } })

  const ok = await post(STAGED_TEAM)
  check('带 stages 的团队可以保存', ok.status === 200, `${ok.status} ${ok.body?.error}`)

  const plain = await post(PLAIN_TEAM)
  check('无 stages 的团队也可以保存（对照组）', plain.status === 200, `${plain.status} ${plain.body?.error}`)

  const detail = await request(handler, { url: '/expert-team/api/teams/staged-probe' })
  check('单团下发阶段计划', detail.body?.team?.stages?.length === 2, JSON.stringify(detail.body?.team?.stages))
  check('阶段带名字', detail.body?.team?.stages?.[0]?.name === '收集', detail.body?.team?.stages?.[0]?.name)

  const dropped = await post({ ...STAGED_TEAM, stages: [{ stage: 1, name: '收集', members: ['p1-a', 'p1-b'] }] })
  check('阶段漏掉成员 → 400（不许静默漏派）',
    dropped.status === 400 && String(dropped.body?.error ?? '').includes('没有被任何阶段引用'),
    `${dropped.status} ${dropped.body?.error}`)

  const ghost = await post({
    ...STAGED_TEAM,
    stages: [{ stage: 1, name: '收集', members: ['p1-a', 'p1-b', 'ghost'] }, { stage: 2, name: '裁决', members: ['p2-a'] }],
  })
  check('阶段引用不存在的成员 → 400',
    ghost.status === 400 && String(ghost.body?.error ?? '').includes('不存在的成员'),
    `${ghost.status} ${ghost.body?.error}`)

  const gaps = await post({
    ...STAGED_TEAM,
    stages: [{ stage: 1, name: '收集', members: ['p1-a', 'p1-b'] }, { stage: 3, name: '裁决', members: ['p2-a'] }],
  })
  check('阶段序号不连续 → 400',
    gaps.status === 400 && String(gaps.body?.error ?? '').includes('连续'),
    `${gaps.status} ${gaps.body?.error}`)
}

/* 10.2 分批派遣：只派该阶段，并把上游产出原文传给下游 */
{
  calls.continuable.length = 0
  const stage1 = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'staged-probe', task: '做一次分批测试', stage: 1 },
  })
  check('第 1 阶段只派该阶段成员', stage1.body?.dispatched?.length === 2, stage1.body?.dispatched?.length)
  check('返回当前阶段与总阶段数',
    stage1.body?.stage === 1 && stage1.body?.stageCount === 2,
    `${stage1.body?.stage}/${stage1.body?.stageCount}`)
  const firstPrompt = calls.continuable[0]?.request?.prompt?.[0]?.text ?? ''
  check('prompt 写明「第 1 / 2 阶段」', firstPrompt.includes('第 1 / 2 阶段'), firstPrompt.slice(0, 90))
  check('prompt 标出下游成员', firstPrompt.includes('丙'), '')
  check('label 带阶段前缀', calls.continuable[0]?.label === '分批探针团 · P1 · 甲', calls.continuable[0]?.label)

  calls.continuable.length = 0
  const UPSTREAM = '上游结论：甲认为需求 A 成立；乙补充了数据 B。'
  const stage2 = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'staged-probe', task: '做一次分批测试', stage: 2, context: UPSTREAM },
  })
  check('第 2 阶段只派该阶段成员', stage2.body?.dispatched?.length === 1, stage2.body?.dispatched?.length)
  const secondPrompt = calls.continuable[0]?.request?.prompt?.[0]?.text ?? ''
  check('上游产出原文进入 prompt', secondPrompt.includes(UPSTREAM), secondPrompt.slice(-160))
  check('prompt 有「上游产出」小节', secondPrompt.includes('上游产出'), '')
  check('prompt 标出上游成员', secondPrompt.includes('甲') && secondPrompt.includes('乙'), '')
  check('contextChars 如实回报', stage2.body?.contextChars === UPSTREAM.length, stage2.body?.contextChars)

  const beyond = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'staged-probe', task: 'x', stage: 9 },
  })
  check('派遣不存在的阶段 → 400 NO_STAGE',
    beyond.status === 400 && beyond.body?.code === 'NO_STAGE',
    `${beyond.status} ${beyond.body?.code}`)
}

/* 10.3 无阶段团队：行为必须与旧版逐字一致 */
{
  calls.continuable.length = 0
  const res = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'plain-probe', task: '无阶段团队测试' },
  })
  const prompt = calls.continuable[0]?.request?.prompt?.[0]?.text ?? ''
  check('无阶段团队仍一次性派全部成员', res.body?.dispatched?.length === 2, res.body?.dispatched?.length)
  check('无阶段团队 prompt 不含阶段措辞', prompt.includes('在流程中的位置') === false, '')
  check('无阶段团队 label 不带阶段前缀', calls.continuable[0]?.label === '无阶段探针团 · 甲一', calls.continuable[0]?.label)

  const detail = await request(handler, { url: '/expert-team/api/teams/plain-probe' })
  check('无阶段团队下发空 stages',
    Array.isArray(detail.body?.team?.stages) && detail.body.team.stages.length === 0,
    JSON.stringify(detail.body?.team?.stages))
}

/* 10.4 子会话护栏：provider 不支持时如实降级；工具 deny 一律不做（宿主 restrict 只认全局工具名） */
{
  calls.continuable.length = 0
  const degraded = await request(handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'staged-probe', task: '护栏降级', stage: 2 },
  })
  const spec = calls.continuable[0]
  check('不支持时不下发 maxDepth（不假装已生效）', spec?.request?.maxDepth === undefined, String(spec?.request?.maxDepth))
  check('不支持时不下发 toolFilter',
    spec?.request?.toolFilter === undefined, String(spec?.request?.toolFilter))
  check('降级情况如实回报给调用方',
    Array.isArray(degraded.body?.guard?.degraded)
      && degraded.body.guard.degraded.length === 1
      && degraded.body.guard.degraded.includes('depthLimit'),
    JSON.stringify(degraded.body?.guard))

  calls.continuable.length = 0
  const { ctx: guardedCtx } = makeFakes({
    personaCapable: true,
    extraCapabilities: { depthLimit: true, toolFilter: true },
  })
  mod.apply(guardedCtx)
  const guardedHandler = calls.http.handler
  const guarded = await request(guardedHandler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'staged-probe', task: '护栏生效', stage: 1 },
  })
  const guardedSpec = calls.continuable[0]
  check('支持时下发 maxDepth=1（专家不能再往下派子代理）', guardedSpec?.request?.maxDepth === 1, String(guardedSpec?.request?.maxDepth))
  check('即使 provider 声称支持 toolFilter 也不下发（硬 deny 会触发 unknown global tools 让整批派遣失败）',
    guardedSpec?.request?.toolFilter === undefined, JSON.stringify(guardedSpec?.request?.toolFilter))
  check('护栏未降级',
    Array.isArray(guarded.body?.guard?.degraded) && guarded.body.guard.degraded.length === 0,
    JSON.stringify(guarded.body?.guard))
  check('防嵌套改为软约束并如实标注 nestedSoftOnly',
    guarded.body?.guard?.nestedSoftOnly === true, JSON.stringify(guarded.body?.guard))
  const guardedPrompt = guardedSpec?.request?.prompt?.[0]?.text ?? ''
  check('软约束确实写进了专家提示词', guardedPrompt.includes('不要再召唤'), '')
}

/* 10.5 整批派遣全挂：报错必须是「一行人话」，不能把宿主整张工具表灌回面板草稿 */
{
  calls.continuable.length = 0
  const long = 'tools.restrict() names unknown global tools "expert_team_list", "expert_team_summon"; '
    + 'known global tools: ' + Array.from({ length: 120 }, (_, i) => `tool_${i}`).join(', ')
  const { ctx: failCtx } = makeFakes({ personaCapable: true, startFails: long })
  mod.apply(failCtx)
  const failed = await request(calls.http.handler, {
    method: 'POST',
    url: '/expert-team/api/summon',
    body: { sessionId: 'root-session', teamId: 'plain-probe', task: '全部失败' },
  })
  const message = String(failed.body?.error ?? '')
  check('全部失败 → 502 且给出可读摘要',
    failed.status === 502 && /^全部 2 位专家派发失败：/.test(message),
    `${failed.status} ${message.slice(0, 90)}`)
  check('同因合并 + 截断：宿主长报错不再复读 N 遍', message.length < 600, String(message.length))
  check('整张工具表只出现一次（截断到 160 字内）',
    // 注意别用 `known global tools` 去数：`unknown global tools` 里也含这串。
    (message.match(/known global tools:/g) ?? []).length === 1,
    String((message.match(/known global tools:/g) ?? []).length))

  // 本段用的是「必然失败」的假 provider，而后面几段还要读工具定义体与 HTTP handler，
  // 所以这里换回一个正常的 ctx（register 按同名键覆盖）。
  mod.apply(makeFakes({ personaCapable: true }).ctx)
}

/* 10.6 模型工具：返回值必须与声明的 output schema 一致 */
{
  const listDef = calls.toolDefinitions['expert_team_list']
  const summonDef = calls.toolDefinitions['expert_team_summon']
  check('两个模型工具都存下了定义体',
    listDef !== undefined && summonDef !== undefined,
    Object.keys(calls.toolDefinitions).join(','))

  if (listDef !== undefined && summonDef !== undefined) {
    const exec = {
      agent: { id: 'root-session', session: { id: 'root-session' } },
      signal: new AbortController().signal,
    }

    const listed = await listDef.execute({}, exec)
    const listIssues = schemaIssues(listDef.output.schema, listed)
    check('expert_team_list 返回值符合 output schema', listIssues.length === 0, listIssues.slice(0, 3).join(' / '))

    const stagedEntry = listed.teams.find(team => team.id === 'staged-probe')
    check('list 报出阶段团队 staged=true / stageCount=2',
      stagedEntry?.staged === true && stagedEntry?.stageCount === 2,
      `${stagedEntry?.staged} ${stagedEntry?.stageCount}`)
    check('list 报出成员所属阶段',
      JSON.stringify(stagedEntry?.members?.[0]?.stages) === '[1]',
      JSON.stringify(stagedEntry?.members?.[0]?.stages))

    const plainEntry = listed.teams.find(team => team.id === 'plain-probe')
    check('无阶段团队 staged=false 且成员 stages 为空数组',
      plainEntry?.staged === false && JSON.stringify(plainEntry?.members?.[0]?.stages) === '[]',
      `${plainEntry?.staged} ${JSON.stringify(plainEntry?.members?.[0]?.stages)}`)

    calls.continuable.length = 0
    const summoned = await summonDef.execute(
      { team_id: 'staged-probe', task: '工具侧分批', stage: 2, context: '工具侧上游产出' },
      exec,
    )
    const summonIssues = schemaIssues(summonDef.output.schema, summoned)
    check('expert_team_summon 返回值符合 output schema', summonIssues.length === 0, summonIssues.slice(0, 3).join(' / '))
    check('工具侧最后一阶段 → nextStage=0', summoned.nextStage === 0 && summoned.stage === 2, `${summoned.stage}→${summoned.nextStage}`)
    check('工具侧 guidance 给出汇总指令', String(summoned.guidance ?? '').includes('最后一阶段'), String(summoned.guidance).slice(0, 60))

    calls.continuable.length = 0
    const staged = await summonDef.execute({ team_id: 'staged-probe', task: '工具侧分批', stage: 1 }, exec)
    check('工具侧第 1 阶段 → nextStage=2 并提示传 context',
      staged.nextStage === 2 && String(staged.guidance ?? '').includes('context'),
      `${staged.nextStage} ${String(staged.guidance).slice(0, 60)}`)
  }
}

/* 10.6 清理探针团队 */
{
  const cleanup = await request(handler, { method: 'DELETE', url: '/expert-team/api/teams/staged-probe' })
  check('分批探针团已清理', cleanup.status === 200 && cleanup.body?.removed === true, JSON.stringify(cleanup.body))

  const cleanupPlain = await request(handler, { method: 'DELETE', url: '/expert-team/api/teams/plain-probe' })
  check('无阶段探针团已清理', cleanupPlain.status === 200 && cleanupPlain.body?.removed === true, JSON.stringify(cleanupPlain.body))
}

/* ---------------------------------------------------------------- *
 *  报告
 * ---------------------------------------------------------------- */

const failed = results.filter(item => !item.ok)
const report = [
  'expert-team 宿主半冒烟报告',
  `通过 ${results.length - failed.length} / ${results.length}`,
  '',
  ...results.map(item => `${item.ok ? '[PASS]' : '[FAIL]'} ${item.label}${item.detail !== '' ? ` — ${item.detail}` : ''}`),
  '',
  failed.length === 0 ? '结论：全部通过。' : `结论：${failed.length} 项失败。`,
].join('\n')

console.log(report)
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
fs.writeFileSync(path.join(ROOT, '.tmp/smoke-report.txt'), `${report}\n`, 'utf8')
process.exitCode = failed.length === 0 ? 0 : 1
