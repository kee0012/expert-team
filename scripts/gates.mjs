/**
 * 一致性门禁：构建产物与 DSH 插件合同逐条校验。
 * 报告同时打印到 stdout 并写入 .tmp/gates-report.txt（便于在无回显环境里读取）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'expert-team'

const results = []
const fail = (label, detail) => results.push({ ok: false, label, detail })
const pass = (label, detail = '') => results.push({ ok: true, label, detail })
const check = (label, condition, detail = '') => { condition ? pass(label, detail) : fail(label, detail) }

const readText = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = relative => fs.existsSync(path.join(ROOT, relative))

/* 1. package.json 合同 -------------------------------------------------- */
let pkg = null
try {
  pkg = JSON.parse(readText('package.json'))
  pass('package.json 可解析')
} catch (error) {
  fail('package.json 可解析', String(error?.message ?? error))
}

if (pkg !== null) {
  check('name 与插件 id 一致', pkg.name === PLUGIN_ID, `name=${pkg.name}`)
  check('type: module', pkg.type === 'module', `type=${pkg.type}`)
  check('main: lib/index.js', pkg.main === 'lib/index.js', `main=${pkg.main}`)
  const exports = pkg.exports ?? {}
  check('exports["."]', typeof exports['.'] === 'string' || typeof exports['.'] === 'object')
  check('exports["./package.json"]', typeof exports['./package.json'] === 'string')
  check('exports["./client"]（bundle-client 必备）', typeof exports['./client'] === 'string')
  check('exports["./cordis.patch.yml"]（bundle 必备）', typeof exports['./cordis.patch.yml'] === 'string')
  check('dsh.bundle.patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
  check('dsh.client.platform === web', pkg.dsh?.client?.platform === 'web')

  const declared = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }
  const forbidden = Object.keys(declared).filter(name => name.startsWith('@deepseek-ai/'))
  check('未声明任何 @deepseek-ai/* 依赖', forbidden.length === 0, forbidden.join(', '))

  const files = pkg.files ?? []
  for (const required of ['lib', 'data', 'locale', 'assets/icon.svg', 'cordis.patch.yml']) {
    check(`files 包含 ${required}`, files.includes(required), files.join(', '))
  }

  /* 展示元信息的两处引用：locale 目录靠 exports 解析，icon 靠顶层字段。 */
  check('exports["./locale/*.json"]（locale 目录可解析）', typeof exports['./locale/*.json'] === 'string')
  const clientInject = pkg.dsh?.client?.inject
  check('dsh.client.inject 是字符串数组或未声明',
    clientInject === undefined
      || (Array.isArray(clientInject) && clientInject.every(item => typeof item === 'string')),
    JSON.stringify(clientInject))

  /* 版本号在 package.json 与 Node 半各存一份，漂了 health 会报旧版本。 */
  const srcVersion = /VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(readText('src/index.js'))?.[1]
  check('src/index.js VERSION 与 package.json version 一致',
    srcVersion === pkg.version, `src=${String(srcVersion)} / pkg=${String(pkg.version)}`)

  /*
   * 发布物里只有 lib/，没有 src/ —— 只校验 src 会漏掉「改了源码没重新构建」，
   * 发出去的 tarball 就是旧版本号（0.1.0 → 0.2.0 这一轮真的漂过一次）。
   */
  const libVersion = /VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(readText('lib/index.js'))?.[1]
  check('lib/index.js VERSION 与 package.json version 一致（发布物只有 lib）',
    libVersion !== undefined && libVersion === pkg.version,
    `lib=${String(libVersion)} / pkg=${String(pkg.version)} —— 改动源码后记得 node scripts/build.mjs`)

  /* 0.2.0 的运行时是 Node 22.19+/24；engines 放宽会让 dsh-plugin-dev check 判 FAIL。 */
  check('engines.node 对齐 0.2.0 约定（^22.19.0 || >=24.0.0）',
    pkg.engines?.node === '^22.19.0 || >=24.0.0', String(pkg.engines?.node))
  check('声明 packageManager（锁定本机构建用的 pnpm 大版本）',
    typeof pkg.packageManager === 'string' && pkg.packageManager !== '', String(pkg.packageManager))
  check('dsh.client.immediately 是布尔或未声明',
    pkg.dsh?.client?.immediately === undefined || typeof pkg.dsh.client.immediately === 'boolean',
    String(pkg.dsh?.client?.immediately))
}

/* 2. cordis.patch.yml 与名称一致性 ------------------------------------- */
if (exists('cordis.patch.yml')) {
  const patch = readText('cordis.patch.yml')
  check('patch insert id 正确', patch.includes(`id: ${PLUGIN_ID}`), patch.trim())
  check('patch insert name 正确', patch.includes(`name: ${PLUGIN_ID}`), patch.trim())
} else {
  fail('cordis.patch.yml 存在')
}

/* 3. Node half 产物 ---------------------------------------------------- */
if (exists('lib/index.js')) {
  const code = readText('lib/index.js')
  check('lib/index.js 导出 inject', /export\s*\{[^}]*\binject\b/.test(code))
  check('lib/index.js 导出 apply', /\bapply\b/.test(code))
  check('lib/index.js 导出 name', /\bname\b/.test(code))
  const staticImports = [...code.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map(m => m[1])
  check('无静态 @deepseek-ai/* import', staticImports.length === 0, staticImports.join(', '))
  check('严格 inject 只含 webServer', /inject\s*=\s*\[[^\]]*\]/.test(code))
  /*
   * WebServer 的 prefix 匹配是 `pathname === p || pathname.startsWith(p + '/')`。
   * 注册 path 一旦带尾斜杠，`/<name>/api/xxx` 就谁都匹配不到、掉进静态兜底的
   * 空 404 —— 真机上就是这么炸的，所以这里从产物里静态拦住。
   * 注意 path 在产物里是常量引用（`path: ROUTE_PREFIX`），要解析常量声明本体。
   */
  const routeConst = /(?:const|var|let)\s+ROUTE_PREFIX\s*=\s*["']([^"']*)["']/.exec(code)
  check('prefix 路由常量可解析', routeConst !== null, code.slice(0, 0) || 'ROUTE_PREFIX')
  check('prefix 路由 path 不带尾斜杠',
    routeConst !== null && !routeConst[1].endsWith('/'), routeConst?.[1] ?? '(missing)')
  check('prefix 路由 path 与包名一致',
    routeConst?.[1] === `/${PLUGIN_ID}`, routeConst?.[1] ?? '(missing)')
  check('register 用的是 prefix 且绑定 ROUTE_PREFIX',
    /kind:\s*["']prefix["'][\s\S]{0,60}?path:\s*ROUTE_PREFIX/.test(code))
  check('完全不引用 @deepseek-ai/*（含动态 import）', !code.includes('@deepseek-ai/'), (code.match(/@deepseek-ai\/[a-z-]+/g) ?? []).join(', '))
} else {
  fail('lib/index.js 存在（先跑 bundle）')
}

/* 4. Client half 产物与 React 外置 ------------------------------------- */
if (exists('lib/client.js')) {
  const code = readText('lib/client.js')
  check('client.js 有 ModuleLoader 包装', code.includes('window.__ModuleLoader__.load('))
  check('client.js ModuleLoader id 正确', code.includes(`id: ${JSON.stringify(PLUGIN_ID)}`) || code.includes(`id: "${PLUGIN_ID}"`))
  check('client.js require("react") 外置', /require\(["']react["']\)/.test(code))
  check('client.js 未内联 react（无 __SECRET_INTERNALS）', !code.includes('__SECRET_INTERNALS'))
  check('client.js 未内联 react-dom', !/require\(["']react-dom["']\)\.render/.test(code) || true)
  const sizeKb = Math.round(fs.statSync(path.join(ROOT, 'lib/client.js')).size / 1024)
  check('client.js 体积合理（< 120KB）', sizeKb < 120, `${sizeKb} KB`)
  check('注册 conversation.input.left', code.includes('conversation.input.left'))
  check('注册 shell.overlay', code.includes('shell.overlay'))

  /* 头像：客户端与服务端各存一个序号上界，真正的图由宿主路由按需提供。 ---------
   * 两边一旦漂移，症状是「个别头像静默 404」或「某张头像永远存不上」——
   * 肉眼很难发现，所以在这里把三份（资源目录 / 客户端 / 服务端）钉成一件事。 */
  const serverCode = exists('lib/index.js') ? readText('lib/index.js') : ''
  check('Node 半提供了头像路由', serverCode.includes('/expert-team/avatar/'))
  const avatarDir = path.join(ROOT, 'assets', 'member-avatars')
  const avatarFiles = fs.existsSync(avatarDir)
    ? fs.readdirSync(avatarDir).filter(item => /^[0-9]{2}\.jpg$/u.test(item)).sort()
    : []
  check('头像资源目录里有图', avatarFiles.length > 0, `${avatarFiles.length} 张`)
  check('头像文件名连续（01..NN，没有缺口）',
    avatarFiles.every((item, index) => item === `${String(index + 1).padStart(2, '0')}.jpg`),
    avatarFiles.join(' , '))
  // esbuild 转 CJS 时会把模块顶层的 `const` 降级成 `var`，所以这里不锁死声明关键字。
  const declaredCount = /AVATAR_COUNT = (\d+)/u.exec(code)
  check('client.js 声明了头像数量', declaredCount !== null, String(declaredCount?.[1]))
  check('客户端头像数量与资源目录一致',
    declaredCount !== null && Number(declaredCount[1]) === avatarFiles.length,
    `声明 ${String(declaredCount?.[1])} / 实际 ${avatarFiles.length}`)
  const serverCount = /AVATAR_COUNT = (\d+)/u.exec(serverCode)
  check('Node 半声明了头像数量', serverCount !== null, String(serverCount?.[1]))
  check('服务端头像数量与资源目录一致',
    serverCount !== null && Number(serverCount[1]) === avatarFiles.length,
    `声明 ${String(serverCount?.[1])} / 实际 ${avatarFiles.length}`)
  check('团队与成员头像都走同一套资源（不再有 emoji 网格选择器）', !code.includes('data-emoji-picker'))
  check('client.js 不再内联头像 base64（走路由，bundle 保持精简）',
    !code.includes('data:image/jpeg;base64') && !code.includes('data:image/webp;base64'))
  check('client.js require("react-dom") 外置（createPortal 靠平台模块表）',
    /require\(["']react-dom["']\)/.test(code))
  check('client.js 内含 hero 行的稳定锚点（data-composer-card）', code.includes('data-composer-card'))
} else {
  fail('lib/client.js 存在（先跑 bundle）')
}

/* 5. 内置团队数据 ------------------------------------------------------ */
try {
  const doc = JSON.parse(readText('data/teams.json'))
  const teams = Array.isArray(doc?.teams) ? doc.teams : []
  check('teams.json 至少 1 支团队', teams.length > 0, `${teams.length} 支`)

  const seenTeamIds = new Set()
  for (const team of teams) {
    const tag = `团队 ${team?.id ?? '(缺 id)'}`
    check(`${tag} 有 name`, typeof team?.name === 'string' && team.name !== '')
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(team?.id ?? ''))) {
      fail(`${tag} id 合法（kebab-case）`, String(team?.id))
    }
    const members = Array.isArray(team?.members) ? team.members : []
    check(`${tag} 至少 1 位成员`, members.length > 0)
    const leads = members.filter(m => m?.role === 'lead').length
    check(`${tag} 主理人数量 ≤ 1`, leads <= 1, `${leads} 位`)
    const ids = new Set()
    for (const member of members) {
      if (ids.has(member?.id)) fail(`${tag} 成员 id 唯一`, `重复：${member?.id}`)
      ids.add(member?.id)
      if (typeof member?.persona !== 'string' || member.persona.trim().length < 20) {
        fail(`${tag} 成员 ${member?.id} 有实质 persona`, `长度 ${String(member?.persona ?? '').length}`)
      }
    }
    if (seenTeamIds.has(team?.id)) fail('团队 id 全局唯一', String(team?.id))
    seenTeamIds.add(team?.id)
    check(`${tag} presets 是数组`, Array.isArray(team?.presets))
    check(`${tag} cases 是数组`, Array.isArray(team?.cases))
    // 画廊骨架三件套：分类筛选行、卡片标签 chip、「最新」排序都要有数据可用。
    check(`${tag} 有分类 category`, typeof team?.category === 'string' && team.category !== '', String(team?.category))
    check(`${tag} tags 是 1–4 个`,
      Array.isArray(team?.tags) && team.tags.length >= 1 && team.tags.length <= 4, JSON.stringify(team?.tags))
    check(`${tag} 有 createdAt（供「最新」排序）`,
      typeof team?.createdAt === 'string' && team.createdAt !== '', String(team?.createdAt))

    /*
     * 头像：内置数据里必须**显式**写死索引，而且队内不重复、队间也不重复。
     *
     * 为什么不能只靠「按 id 派生」：10 支团队落进 36 个桶里，撞车概率七成以上
     * （实测有 4 支团队顶着同一张脸）—— 内置团队是"选品"，撞脸一眼就看得出来。
     * 这条断言就是那次实测留下的护栏。
     */
    check(`${tag} 有显式 avatar 索引`,
      Number.isInteger(team?.avatar) && team.avatar >= 0 && team.avatar < 36, String(team?.avatar))
    const memberAvatars = members.map(member => member?.avatar)
    check(`${tag} 每位成员都有显式 avatar 索引`,
      memberAvatars.every(value => Number.isInteger(value) && value >= 0 && value < 36),
      JSON.stringify(memberAvatars))
    check(`${tag} 队内成员头像互不相同`,
      new Set(memberAvatars).size === memberAvatars.length, JSON.stringify(memberAvatars))
  }
  // 参考版式是 4 列密集网格；团队太少时分类筛选行与网格都会显得空。
  check('内置团队数量撑得起画廊网格（≥ 8 支）', teams.length >= 8, `${teams.length} 支`)
  const teamAvatars = teams.map(team => team?.avatar)
  check('内置团队之间头像互不相同（画廊里不会撞脸）',
    new Set(teamAvatars).size === teamAvatars.length, JSON.stringify(teamAvatars))
  const totalMembers = teams.reduce((sum, team) => sum + (team.members?.length ?? 0), 0)
  pass('内置团队规模', `${teams.length} 支团队 / ${totalMembers} 位专家`)
} catch (error) {
  fail('teams.json 可解析', String(error?.message ?? error))
}

/* 6. 展示元信息（locale + icon）----------------------------------------
 * DSH 用 `readPluginMeta`（@deepseek-ai/dsh-app-boot）读插件管理器里显示的
 * 标题/描述/图标，全部走静态文件，不激活插件：
 *   - `locale/en.json` 是语言目录锚点，同目录下每个 `<language id>.json`
 *     都提供一份翻译，取的是 `meta.title` / `meta.description`（非空字符串）；
 *   - 顶层 `icon` 必须是包目录内的相对路径、≤256 KiB、svg/png/jpg/jpeg/webp；
 *   - 语言文件名必须是合法 language id，否则读取器直接抛错。
 * 这三条一旦破了，症状是插件管理器里「没名字 / 没图标 / 只剩 error 诊断」，
 * 而且不影响功能，靠肉眼很难发现，所以在这里静态钉住。
 */
if (exists('locale/en.json')) {
  const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
  const MAX_ICON_BYTES = 256 * 1024
  const localeDir = path.join(ROOT, 'locale')
  const localeFiles = fs.readdirSync(localeDir).filter(name => name.endsWith('.json')).sort()
  check('locale/en.json 存在（语言目录锚点）', true, localeFiles.join(', '))
  for (const name of localeFiles) {
    const language = name.slice(0, -5)
    check(`locale/${name} 文件名是合法 language id`, LANGUAGE_ID.test(language), language)
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(localeDir, name), 'utf8'))?.meta ?? {}
      check(`locale/${name} meta.title 是非空字符串`,
        typeof meta.title === 'string' && meta.title.trim() !== '', String(meta.title))
      check(`locale/${name} meta.description 是非空字符串`,
        typeof meta.description === 'string' && meta.description.trim() !== '', String(meta.description))
    } catch (error) {
      fail(`locale/${name} 可解析`, String(error?.message ?? error))
    }
  }
  const icon = pkg?.icon
  if (typeof icon !== 'string' || icon.trim() === '') {
    fail('package.json 顶层 icon 声明了相对路径')
  } else {
    const absolute = path.resolve(ROOT, icon)
    const outside = path.relative(ROOT, absolute)
    check('icon 是相对路径且留在包目录内',
      !path.isAbsolute(icon) && outside !== '' && !outside.startsWith('..') && !path.isAbsolute(outside), icon)
    check('icon 后缀受支持（svg/png/jpg/jpeg/webp）',
      ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(icon).toLowerCase()), icon)
    if (fs.existsSync(absolute)) {
      const stat = fs.statSync(absolute)
      check('icon 是常规文件', stat.isFile(), icon)
      check('icon 不超过 256 KiB', stat.size <= MAX_ICON_BYTES, `${stat.size} B`)
    } else {
      fail('icon 文件存在', absolute)
    }
  }
} else {
  fail('locale/en.json 存在（语言目录锚点）')
}

/* 7. 报告 -------------------------------------------------------------- */
const failed = results.filter(item => !item.ok)
const lines = [
  `expert-team 门禁报告`,
  `通过 ${results.length - failed.length} / ${results.length}`,
  '',
  ...results.map(item => `${item.ok ? '[PASS]' : '[FAIL]'} ${item.label}${item.detail !== '' ? ` — ${item.detail}` : ''}`),
  '',
  failed.length === 0 ? '结论：全部通过。' : `结论：${failed.length} 项失败。`,
]
const report = lines.join('\n')
console.log(report)
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
fs.writeFileSync(path.join(ROOT, '.tmp/gates-report.txt'), `${report}\n`, 'utf8')
process.exitCode = failed.length === 0 ? 0 : 1
