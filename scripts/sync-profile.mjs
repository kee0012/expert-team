/**
 * 把**开发版**的构建产物同步到 web profile 里那份**安装副本** —— 仅用于本机验证。
 *
 * 为什么需要它：profile 通过 `file:` 协议依赖本地目录，但 pnpm 是**复制**内容而不是软链，
 * 所以源码改了、profile 里仍旧是旧文件（表现为「浏览器里看不到改动」）。
 *
 * 同步范围刻意写死成「会变的那几样」，绝不跑 `pnpm install`（快、无网络、不动 lockfile）：
 *   lib/、assets/member-avatars/、data/teams.json、package.json、cordis.patch.yml、README.md
 * 其中 assets 是成员头像的运行时资源 —— 漏掉它，头像会静默 404。
 *
 * 用法：node scripts/sync-profile.mjs [--to <目标目录>] [--profile <profile 名>]
 * 目标目录默认从 DSH_HOME 推出来：`<DSH_HOME>/profiles/<profile>/node_modules/<包名>`；
 * 显式给 `--to` 时以它为准。源码里**不写死任何机器路径**（开源后换机器也能直接跑）。
 * 覆盖前会把 `lib/*.js` 备份成 `<名>.prev.js`（只留上一版，方便一键回滚）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const toIndex = args.indexOf('--to')
const profileIndex = args.indexOf('--profile')
const PROFILE = profileIndex >= 0 && args[profileIndex + 1] !== undefined ? args[profileIndex + 1] : 'web'

/** DSH 主目录：优先 $DSH_HOME，回落 ~/.dsh（与 src/index.js 的 dshHome() 同一口径）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

const TARGET = toIndex >= 0 && args[toIndex + 1] !== undefined
  ? args[toIndex + 1]
  : path.join(dshHome(), 'profiles', PROFILE, 'node_modules', pkg.name)

/** 同步清单：相对路径（文件）或目录（递归覆盖）。 */
const FILES = ['data/teams.json', 'package.json', 'cordis.patch.yml', 'README.md',
  'lib/index.js', 'lib/client.js']
const DIRS = ['assets/member-avatars']

/*
 * `link:` 安装时，profile 里那个 node_modules/<包名> 就是**指向本目录的软链** ——
 * 此时「同步」等于把文件往自己身上拷，必须直接劝退（旧版会在这种场景下原地覆盖）。
 */
if (fs.existsSync(TARGET)) {
  try {
    if (path.resolve(fs.realpathSync(TARGET)) === path.resolve(fs.realpathSync(ROOT))) {
      console.log(`[sync] 目标是软链、且指向本目录本身（\`link:\` 安装）：${TARGET}`)
      console.log('[sync] 无需同步 —— 改动已经在 profile 里生效了，只要 build + 重启/重载即可。')
      process.exit(0)
    }
  } catch { /* realpath 失败就按普通目录处理 */ }
}

if (!fs.existsSync(TARGET)) {
  console.error(`[sync] 目标不存在：${TARGET}`)
  console.error('       这脚本只服务于「`file:` 安装（pnpm 复制而非软链）」的场景；'
    + '用 `link:` 安装时不需要它（软链直接指向开发目录）。')
  console.error('       也可以显式指定：node scripts/sync-profile.mjs --to <profile>/node_modules/expert-team')
  process.exit(1)
}

const log = []
const backupDir = path.join(TARGET, 'lib')
for (const rel of ['lib/index.js', 'lib/client.js']) {
  const from = path.join(TARGET, rel)
  if (!fs.existsSync(from)) continue
  const previous = path.join(backupDir, `${path.basename(rel, '.js')}.prev.js`)
  fs.copyFileSync(from, previous)
  log.push(`[备份] ${rel} -> lib/${path.basename(previous)}`)
}

for (const rel of FILES) {
  const from = path.join(ROOT, rel)
  const to = path.join(TARGET, rel)
  if (!fs.existsSync(from)) { log.push(`[跳过] 源不存在：${rel}`); continue }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  log.push(`[文件] ${rel} -> ${fs.statSync(to).size} bytes`)
}

for (const rel of DIRS) {
  const from = path.join(ROOT, rel)
  const to = path.join(TARGET, rel)
  if (!fs.existsSync(from)) { log.push(`[跳过] 源目录不存在：${rel}`); continue }
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
  const count = fs.readdirSync(to).length
  log.push(`[目录] ${rel}/ -> ${count} 个条目`)
}

/* 自检：头像目录真到了，且客户端与资源对得上（漏同步的症状是"头像静默 404"）。 */
const client = fs.readFileSync(path.join(TARGET, 'lib/client.js'), 'utf8')
const avatarDir = path.join(TARGET, 'assets/member-avatars')
const avatars = fs.existsSync(avatarDir)
  ? fs.readdirSync(avatarDir).filter(item => /^[0-9]{2}\.jpg$/u.test(item)).length
  : 0
const declared = /AVATAR_COUNT = (\d+)/u.exec(client)?.[1]
log.push('')
log.push(`[自检] 客户端声明头像 ${declared} 张 / 安装副本实际 ${avatars} 张 —— `
  + (Number(declared) === avatars ? '一致' : '不一致，头像会 404！'))
log.push(`[自检] client.js 含头像路由前缀：${client.includes('/expert-team/avatar/')}`)

console.log(log.join('\n'))
console.log('\n提示：客户端 bundle 与宿主半都是进程启动时加载的 —— 改完要**重启 dsh web** 才生效。')
