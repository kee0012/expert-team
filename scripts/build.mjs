/**
 * 构建脚本：产出 lib/index.js（Node half，ESM）与 lib/client.js（浏览器半，CJS + ModuleLoader 包装）。
 *
 * esbuild 解析顺序：项目内 node_modules → 本机其它工作区里既有的安装。
 * 这样即便不联网、不装依赖，也能构建。
 *
 * 两个「不许再退化」的约束：
 * 1. ModuleLoader 的注册 id 必须**等于包名**（客户端按 entry id 解析），所以 id 从
 *    package.json 读；旧版把 `expert-team` 硬编码在 banner 里，改包名时必然漂。
 * 2. 产物先写进 lib.tmp/，两半都成功后才原子替换 lib/。旧版一上来就
 *    `rmSync(lib)`，任何一次构建失败都会清空唯一的发布产物。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'lib')
const LIB_TMP = path.join(ROOT, 'lib.tmp')
const LIB_PREV = path.join(ROOT, 'lib.prev')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = pkg.name
if (typeof PLUGIN_ID !== 'string' || PLUGIN_ID === '') {
  throw new Error('package.json 缺少 name：ModuleLoader 的注册 id 取的就是包名')
}

/*
 * 项目内没有 node_modules 时，扫描本机其它已装好的 esbuild 复用。
 *
 * 源码里**不写任何本机绝对路径**（这条对开源很关键）：旧版把
 * `deepseek-harness/node_modules/.pnpm/esbuild@0.28.1/...` 和某台机器的 `C:/Users/Xkee/...`
 * 钉在候选数组里，换台机器就是一堆死路径、构建直接抛「找不到可用的 esbuild」。
 * 现在改成「环境变量 + 可推断的标准位置」：
 *   - `DSH_ESBUILD_SEARCH`：自定义目录，多个用系统路径分隔符（Windows `;` / 其它 `:`）
 *   - `$DSH_HOME/plugins`、`~/.dsh/plugins`：DSH 装插件的地方
 *   - 插件的上一级目录：同一个工作区里其它项目装过的 esbuild
 */
const ESBUILD_SEARCH_DIRS = [
  ...(process.env.DSH_ESBUILD_SEARCH ?? '').split(path.delimiter),
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'plugins') : '',
  path.join(os.homedir(), '.dsh', 'plugins'),
  path.resolve(ROOT, '..'),
].map(dir => dir.trim()).filter(dir => dir !== '')

/** 在给定目录下（≤3 层，不进入 node_modules）找 `node_modules/esbuild/lib/main.js`。 */
function scanForEsbuild(dir, depth) {
  if (depth > 3) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules') {
      const candidate = path.join(dir, entry.name, 'esbuild', 'lib', 'main.js')
      if (fs.existsSync(candidate)) hits.push(candidate)
      continue // 不再往依赖树里递归
    }
    if (entry.name.startsWith('.') || entry.name === 'dist' || entry.name === 'src') continue
    hits.push(...scanForEsbuild(path.join(dir, entry.name), depth + 1))
  }
  return hits
}

function collectEsbuildCandidates() {
  const found = []
  for (const base of ESBUILD_SEARCH_DIRS) {
    for (const hit of scanForEsbuild(base, 0)) if (!found.includes(hit)) found.push(hit)
  }
  return found
}

async function loadEsbuild() {
  const attempts = []
  try {
    const mod = await import('esbuild')
    if (typeof (mod.build ?? mod.default?.build) === 'function') return mod.build ?? mod.default.build
  } catch (error) {
    attempts.push(`import('esbuild') → ${String(error?.message ?? error)}`)
  }
  for (const candidate of collectEsbuildCandidates()) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      const build = mod.build ?? mod.default?.build
      if (typeof build === 'function') {
        console.log(`[build] 复用 esbuild: ${candidate}`)
        return build
      }
    } catch (error) {
      attempts.push(`${candidate} → ${String(error?.message ?? error)}`)
    }
  }
  throw new Error(
    '找不到可用的 esbuild。请在插件目录装依赖后重试（DSH 自带 pnpm 位于 '
    + 'resources/runtime/pnpm/bin/pnpm.cjs）：\n'
    + '  node "<DSH>/resources/runtime/pnpm/bin/pnpm.cjs" install\n'
    + `本次尝试记录：\n${attempts.join('\n')}`,
  )
}

const build = await loadEsbuild()

fs.rmSync(LIB_TMP, { recursive: true, force: true })
fs.mkdirSync(LIB_TMP, { recursive: true })

/* Node half：ESM，@deepseek-ai/* 保持 external（由 DSH profile 提供）。 */
await build({
  entryPoints: [path.join(ROOT, 'src/index.js')],
  outfile: path.join(LIB_TMP, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  external: ['@deepseek-ai/*'],
})

/* 浏览器半：CJS 经典脚本，包一层 DSH ModuleLoader；react 必须 external。 */
await build({
  entryPoints: [path.join(ROOT, 'src/client/index.jsx')],
  outfile: path.join(LIB_TMP, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  sourcemap: false,
  logLevel: 'info',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\n`
      + '  var module = { exports: {} };\n  var exports = module.exports;',
  },
  footer: {
    js: '  return module.exports;\n} });',
  },
})

/*
 * 两半都构建成功，才把 lib.tmp 换成 lib。
 * rename 是原子的：换成一半失败，lib/ 里仍是上一版的完整产物。
 */
fs.rmSync(LIB_PREV, { recursive: true, force: true })
if (fs.existsSync(LIB)) fs.renameSync(LIB, LIB_PREV)
fs.renameSync(LIB_TMP, LIB)
fs.rmSync(LIB_PREV, { recursive: true, force: true })

/* DSH_HOME 下的用户自定义团队目录不需要预建（首次写入时自动创建）。 */
console.log(`[build] 完成：lib/index.js, lib/client.js（ModuleLoader id = ${PLUGIN_ID}）`)
