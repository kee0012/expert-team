# 头像素材

36 张 `NN.jpg`（100×134，竖幅半身插画），**团队图标与成员头像共用这一套**：

- 画廊卡片、团队详情页的大圆头像、召唤标签 → 团队图标（`team.avatar`，缺省按团队 id 派生）；
- 团队详情页的「团队成员」名册、成员下拉、成员详情 → 成员头像（`member.avatar`，缺省按成员 id 派生）；
- 索引由 `src/client/team-icons.js` 的纯函数算：**显式挑过的优先，否则按 id 稳定派生** ——
  同一个团队 / 成员永远同一张脸，跨会话跨机器都稳定；
- 图片本身**不打进客户端 bundle**，而是由宿主路由按需提供：
  `GET /expert-team/avatar/NN.jpg`（`src/index.js` 的 `sendAvatar`）。
  36 张内联会把 `lib/client.js` 从 70KB 顶到 200KB，而这批图在页面里本来就有浏览器缓存；
- 圆形裁切取中心（`object-fit: cover`）：脸与肩都落在框内。

## 来源与许可

素材来自 **[@michengai/dsh-agency-agents](https://www.npmjs.com/package/@michengai/dsh-agency-agents)**
随包分发的品牌资源 `assets/branding/expert-cartoon-01..36.jpg`（原文件名序号一一对应本目录的 `01..36.jpg`）。

该项目的 TypeScript 源码、构建脚本与项目文档采用 **Apache License 2.0**，
其内置专家 persona 沿用上游 [The Agency](https://github.com/msitarzewski/agency-agents) 的 MIT 许可。
本插件按其许可条款复用这组图片，并把上游的许可与归属文件原样附在本目录：

- `LICENSE.upstream.txt` —— 上游 Apache-2.0 全文
- `NOTICE.upstream.txt` —— 上游归属说明

> 若这个来源在你的场景里不合适（比如要发布的插件不希望带上第三方品牌素材），
> 把本目录的图换成自有素材即可：文件名保持 `NN.jpg`，并把 `AVATAR_COUNT` 改成实际张数。

## 换素材 / 增删图片

1. 替换或增删本目录下的 `NN.jpg`（**文件名必须是两位数字 + `.jpg`**，序号连续）；
2. 同步修改 `src/client/index.jsx` 里的 `AVATAR_COUNT`；
3. 跑 `node scripts/gates.mjs` —— 它会校验「客户端声明的数量 == 本目录实际张数」，
   并对文件名连续性做检查，避免出现「个别成员头像静默 404」这种肉眼很难发现的坏味道。
