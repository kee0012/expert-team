/**
 * 团队 / 成员头像 —— 同一套 36 张插画（资源见 `assets/member-avatars/`）。
 *
 * 为什么不再用 emoji：
 * 1. emoji 网格在表单里铺出来就是一格格彩色小字，和插件的整体视觉不是一套东西；
 * 2. 成员头像（名册 / 下拉）早就是这套插画了，团队图标却还是 emoji，
 *    结果同一个界面里出现两套头像语言；
 * 3. 参考版式（专家团画廊）里，卡片左侧就是**圆形插画图标**。
 * 所以两边统一到同一个池子：团队图标、成员头像都从这里取。
 *
 * 本模块只有**纯函数**（索引怎么派生、推荐怎么算、下一个是谁），
 * 图片本身由宿主路由 `/expert-team/avatar/NN.jpg` 按需提供（见 `src/index.js` 的 `sendAvatar`）。
 */

/**
 * 头像总数 —— 必须与 `assets/member-avatars/*.jpg` 的数量一致，
 * 也和服务端 `src/index.js` 的 `AVATAR_COUNT` 一致（`scripts/gates.mjs` 会校验）。
 */
export const AVATAR_COUNT = 36

/** FNV-1a：稳定、无依赖，同一个 id 在任何机器上都得到同一个索引。 */
export function hashSeed(text) {
  let value = 2166136261
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/**
 * 取头像索引：**显式选过的优先**，否则按 seed（团队 id / 成员 id）稳定派生。
 *
 * 这条优先级是整个头像逻辑的地基：老数据与内置数据里都没有 `avatar` 字段，
 * 它们靠 seed 派生也永远得到同一张脸；用户一旦手动挑过，那次选择就压过派生值。
 */
export function avatarIndexOf(seed, explicit) {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0) {
    return explicit % AVATAR_COUNT
  }
  return hashSeed(seed) % AVATAR_COUNT
}

/** 索引 → 文件名（`01.jpg` … `36.jpg`）；越界自动回卷，绝不会拼出不存在的文件。 */
export function avatarFile(index) {
  const safe = ((Number(index) || 0) % AVATAR_COUNT + AVATAR_COUNT) % AVATAR_COUNT
  return `${String(safe + 1).padStart(2, '0')}.jpg`
}

/** 「换一个」：保证与当前不同（索引池是环形的）。 */
export function nextAvatar(current) {
  const value = typeof current === 'number' && Number.isInteger(current) ? current : -1
  return (value + 1 + AVATAR_COUNT) % AVATAR_COUNT
}

/** 推荐一张：按传入的文本（团队名称 / 成员称呼）稳定算 —— 同一段文字永远同一张。 */
export function suggestAvatar(seedText) {
  return hashSeed(seedText) % AVATAR_COUNT
}

/** 团队头像索引：显式 `avatar` 优先，否则按团队 id 派生。 */
export function teamAvatarIndex(team) {
  return avatarIndexOf(team?.id, team?.avatar)
}

/** 成员头像索引：显式 `avatar` 优先，否则按成员 id 派生。 */
export function memberAvatarIndex(member) {
  return avatarIndexOf(member?.id, member?.avatar)
}
