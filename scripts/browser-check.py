#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
expert-team 真浏览器验收。

用 Playwright(Chromium) 打开正在运行的 dsh web，验证：
  1. 页面能 boot（无致命 console error / pageerror）
  2. 「专家团」chip 出现在正确的位置：
     · 空会话态 → 在「工作区 | Agent 预设」那一行、紧挨「标准模式」右侧，且不独占一行；
     · 有内容的会话 → 在输入卡片工具行里（输入框下方），仍是紧凑控件。
  3. 点开后面板渲染出团队画廊（标题栏 / 排序 / 分类筛选 / 卡片网格）
  4. 点团队卡片进入详情：引号预设条、使用案例、团队成员名册与主理人徽章
  5. 点「召唤专家团」= 就地激活：面板关闭、原「专家团」入口原地变成团队标签
     （不真的派遣，避免消耗真实子会话）

用法：
  python scripts/browser-check.py --url "http://127.0.0.1:3080/?token=xxx"
  python scripts/browser-check.py --base http://127.0.0.1:3080 --token xxx
省略 --url 时，会在 --log 所在目录里收集所有日志里出现过的 "?token=" 候选，
逐个探测 HTTP 状态，取真正能登录的那个（旧的失效 token 会被自动跳过）。

注意：DSH 的 launch token 由 `randomBytes` 每进程随机生成、并且**不持久化**
（packages/client/connection/src/browser-auth.ts 的 processLaunchToken），
所以进程重启后旧 token 必然 401，只能从新进程 stdout 打印的那行 URL 取。
本脚本遇到 401 会立刻给出这一条明确失败并退出，而不是让后续断言连环误报。

退出码 0 = 全部通过。
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
SHOT_DIR = HERE.parent / ".tmp"

results: list[tuple[bool, str, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((bool(ok), label, str(detail)))


TOKEN_RE = re.compile(r"https?://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_\-]+)")


def probe(url: str, timeout: float = 6.0) -> bool:
    """能拿到 2xx/3xx 才算这个 token 还有效（401 视为失效）。"""
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as resp:
            return 200 <= resp.status < 400
    except urllib.error.HTTPError as exc:
        return 200 <= exc.code < 400
    except Exception:  # noqa: BLE001 — 连不上/超时都算不可用
        return False


def find_url(url: str, base: str, token: str, log: pathlib.Path) -> str:
    if url:
        return url
    if base and token:
        return f"{base.rstrip('/')}/?token={token}"

    # 候选来源：指定日志 + 同目录兄弟日志。同一文件里越靠后的越新。
    candidates: list[str] = []
    logs = [log] + [p for p in sorted(log.parent.glob("*.log")) if p != log]
    for item in logs:
        if not item.exists():
            continue
        try:
            text = item.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        candidates.extend(f"http://127.0.0.1:{m.group(1)}/?token={m.group(2)}"
                          for m in TOKEN_RE.finditer(text))

    seen: set[str] = set()
    for cand in reversed(candidates):  # 新行优先，命中即用
        if cand in seen:
            continue
        seen.add(cand)
        if probe(cand):
            print(f"[info] 从日志解析到可用地址（已实测可通过鉴权）：{cand}")
            return cand

    if candidates:
        # 没有一个能过鉴权：仍然返回最新一条，让主流程给出那条明确的 401 失败。
        return candidates[-1]
    raise SystemExit("找不到 dsh web URL：请传 --url 或 --base/--token")


# 在页面里量真实几何。锚点与 src/client/index.jsx 的 findHeroSeatRow 完全一致
# （data-composer-card + aria-haspopup），不依赖构建哈希 class、也不依赖中文文案。
LAYOUT_JS = """
() => {
  const rect = el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
  }
  const card = document.querySelector('[data-composer-card]')
  const chip = document.querySelector("button[aria-label='专家团']")
  const editor = document.querySelector("textarea, [contenteditable='true']")
  const phaseEl = document.querySelector('[data-phase]')
  const seats = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
    .filter(s => card && (card.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_PRECEDING))
  const preset = seats[seats.length - 1]
  const row = chip ? chip.parentElement : null
  return {
    phase: phaseEl ? phaseEl.getAttribute('data-phase') : null,
    chip: chip ? rect(chip) : null,
    preset: preset ? rect(preset) : null,
    editor: editor ? rect(editor) : null,
    rowChildren: row ? row.children.length : 0,
    rowDisplay: row ? getComputedStyle(row).display : null,
    chipOrder: chip ? getComputedStyle(chip).order : null,
    // 版式统一性：静止底色 + 图标形态/尺寸。邻居（工作区/预设 chip）是
    // 透明底 + 16px 线性 svg；我们曾经是"恒带悬停淡蓝底 + 彩色 emoji"。
    chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
    chipSvgCount: chip ? chip.querySelectorAll('svg').length : 0,
    chipIconW: chip?.querySelector('svg') ? +chip.querySelector('svg').getBoundingClientRect().width.toFixed(1) : 0,
    presetIconW: preset?.querySelector('svg') ? +preset.querySelector('svg').getBoundingClientRect().width.toFixed(1) : 0,
    // 行内是否真的还住着「标准模式」——用来证明 chip 是"并排"而非"独占"。
    // 不数子节点个数：本机 hero 行的「工作区选择器」可能不渲染，数量随环境变，
    // 但"这一行同时装着预设 chip 和我们的 chip"是恒定的结构事实。
    presetInRow: row !== null && preset !== undefined ? row.contains(preset) : false,
  }
}
"""

# 取某个控件的实时背景色（用于比较「悬停时我们和邻居是不是同一套视觉」）。
BG_JS = """
(selector) => {
  const el = document.querySelector(selector)
  return el ? getComputedStyle(el).backgroundColor : null
}
"""

# 「标准模式」chip 的中心点 + 当前背景色。用与 findHeroSeatRow 完全相同的过滤逻辑，
# 而不是 Playwright 的 :last-of-type / .last —— 卡片内部的「工作区内修改」等控件
# 同样带 aria-haspopup="menu"，用文档顺序取 last 会打偏。
NEIGHBOR_JS = """
() => {
  const card = document.querySelector('[data-composer-card]')
  const seats = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
    .filter(s => card && (card.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_PRECEDING))
  const preset = seats[seats.length - 1]
  if (!preset) return null
  const r = preset.getBoundingClientRect()
  return {
    cx: r.x + r.width / 2, cy: r.y + r.height / 2,
    bg: getComputedStyle(preset).backgroundColor,
    label: (preset.innerText || '').trim().slice(0, 20),
  }
}
"""


# 谁在最上面？用命中测试直接回答，不去比 z-index 数字
# （z-index 只在同一个层叠上下文里可比，跨上下文比数字是错的）。
#
# 背景：`shell.overlay` 的容器自带 z-index:20 → 形成层叠上下文，
# 在里面写多大都只是层内第一；右侧文件树面板是 25/40 的独立层，会盖住模态。
# 所以模态必须 portal 到 body。这里就在「模态与文件面板的重叠区」取一点 hit-test。
OVERLAP_JS = """
() => {
  const dialog = document.querySelector("[role='dialog'][aria-label='专家团']")
  if (!dialog) return { error: '找不到专家团模态' }
  const d = dialog.getBoundingClientRect()

  const bare = dialog.parentElement
  const inBody = bare !== null && (bare.parentElement === document.body || bare === document.body)

  const input = Array.from(document.querySelectorAll('input'))
    .find(i => (i.placeholder || '').includes('文件名'))
  if (!input) return { skipped: '右侧文件树面板没打开', inBody, dialogZ: bare ? getComputedStyle(bare).zIndex : null }
  let panel = input.parentElement
  for (let i = 0; i < 10 && panel && panel.getBoundingClientRect().height < 300; i += 1) {
    panel = panel.parentElement
  }
  if (!panel) return { skipped: '找不到文件面板容器', inBody }
  const p = panel.getBoundingClientRect()

  const x1 = Math.max(d.x, p.x)
  const x2 = Math.min(d.right, p.right)
  const y1 = Math.max(d.y, p.y)
  const y2 = Math.min(d.bottom, p.bottom)
  if (x2 - x1 < 4 || y2 - y1 < 4) return { skipped: '模态与文件面板没有重叠', inBody }

  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const top = document.elementFromPoint(cx, cy)
  return {
    inBody,
    dialogZ: bare ? getComputedStyle(bare).zIndex : null,
    panelZ: getComputedStyle(panel).zIndex,
    overlap: { w: Math.round(x2 - x1), h: Math.round(y2 - y1) },
    probe: { x: Math.round(cx), y: Math.round(cy) },
    topTag: top === null ? null : top.tagName.toLowerCase(),
    topInsideDialog: top === null ? false : dialog.contains(top),
  }
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="")
    ap.add_argument("--base", default="http://127.0.0.1:3080")
    ap.add_argument("--token", default="")
    ap.add_argument("--log", default=os.environ.get("DSH_WEB_LOG", ""),
                    help="dsh web 的 stdout 日志（用来抓带 token 的 URL）；"
                         "默认取环境变量 DSH_WEB_LOG，留空则只能靠 --url 直接指定")
    ap.add_argument("--timeout", type=int, default=45000)
    args = ap.parse_args()

    # 默认在插件自己的 .tmp/ 下找日志（同目录的兄弟 *.log 会被一并扫描），
    # 不写死任何机器路径；也可以用环境变量 DSH_WEB_LOG 指到别处。
    log_path = pathlib.Path(args.log) if args.log else SHOT_DIR / "dsh.out.log"
    url = find_url(args.url, args.base, args.token, log_path)
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 1000})
        page.on("console", lambda m: console_errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.goto(url, wait_until="domcontentloaded", timeout=args.timeout)

        # ---- 鉴权门禁：token 失效时只报这一条，别让下面所有断言连环误报 ----
        # DSH 的 launch token 每进程随机生成、不落盘；进程重启后旧 URL 必然 401。
        body_text = ""
        if page.locator("body").count():
            body_text = page.inner_text("body")
        authed = "authentication required" not in body_text
        check("鉴权通过（token 有效，未返回 401）", authed, body_text.strip()[:120])
        if not authed:
            code = print_report(url, console_errors, page_errors)
            print("\n提示：token 已失效（DSH 的 launch token 每进程随机、不持久化）。")
            print("      请重启 dsh web，并把它新打印的那行 URL 传给 --url 重跑：")
            print("      node <dsh>/bin.js web --no-open")
            browser.close()
            return code

        # 等应用外壳渲染出来（输入框/会话区出现任一即可）
        try:
            page.wait_for_selector("textarea, [contenteditable='true'], [role='dialog']", timeout=args.timeout)
        except Exception as exc:  # noqa: BLE001
            check("应用外壳渲染", False, f"等待超时：{exc}")

        page.wait_for_timeout(2500)  # 让槽位完成首轮渲染

        body_text = page.inner_text("body") if page.locator("body").count() else ""
        check("页面 boot 无 pageerror", len(page_errors) == 0, " | ".join(page_errors[:3]))
        check("应用渲染出正文", len(body_text.strip()) > 40, body_text.strip()[:120])

        # 用 aria-label 定位，避免 has_text 子串匹配把模态里的按钮也一起算进来。
        trigger = page.locator("button[aria-label='专家团']")
        trigger_count = trigger.count()
        check("页面出现「专家团」chip", trigger_count >= 1, f"count={trigger_count}")
        page.screenshot(path=str(SHOT_DIR / "browser-1-trigger.png"), full_page=False)

        # ---- 位置回归护栏 -------------------------------------------------
        # 曾经它挂在 conversation.input.dock（输入卡片上方的整行区），会独占一行；
        # 现在应当与同行控件并排，且空会话态要落在「标准模式」右边。
        layout = page.evaluate(LAYOUT_JS) if trigger_count >= 1 else None
        if layout is None or layout.get("chip") is None:
            check("chip 是紧凑控件（高 ≤ 34px）", False, "拿不到 chip 的 bounding box")
        else:
            chip = layout["chip"]
            check("chip 是紧凑控件（高 ≤ 34px、宽 ≤ 220px）",
                  chip["h"] <= 34 and chip["w"] <= 220,
                  f"w={chip['w']:.0f} h={chip['h']:.0f}")

            preset = layout.get("preset")
            if layout.get("phase") == "hero" and preset is not None:
                check("空会话：chip 与「标准模式」在同一行",
                      abs(chip["cy"] - preset["cy"]) <= 6,
                      f"chip.cy={chip['cy']:.0f} preset.cy={preset['cy']:.0f}")
                check("空会话：chip 在「标准模式」右侧（紧挨其后）",
                      chip["x"] >= preset["x"] + preset["w"] - 2,
                      f"chip.x={chip['x']:.0f} preset.right={preset['x'] + preset['w']:.0f}")
                check("空会话：chip 不独占一行（与「标准模式」共享同一 flex 行）",
                      layout["rowDisplay"] == "flex"
                      and layout["presetInRow"]
                      and layout["rowChildren"] >= 2,
                      f"rowDisplay={layout['rowDisplay']} "
                      f"presetInRow={layout['presetInRow']} "
                      f"rowChildren={layout['rowChildren']}")
                check("空会话：chip 用 order 排在「标准模式」之后",
                      layout["chipOrder"] == "100", f"order={layout['chipOrder']}")

                # ---- 版式统一性（与同一行的邻居 chip 对齐）----------------
                # 静止态底色：邻居是透明（rgba(0,0,0,0)）。曾经因为把「打开面板的函数」
                # 当布尔用（恒真）而永久带上悬停底色，真机上表现为一个突兀的蓝色胶囊。
                check("空会话：chip 静止态背景透明（与邻居 chip 同款）",
                      layout["chipBg"] in ("rgba(0, 0, 0, 0)", "transparent"),
                      f"background={layout['chipBg']}")
                check("空会话：chip 用线性图标（svg），不是彩色 emoji",
                      layout["chipSvgCount"] >= 1, f"svg={layout['chipSvgCount']}")
                check("空会话：chip 图标尺寸与邻居一致",
                      layout["chipIconW"] == layout["presetIconW"] > 0,
                      f"chip={layout['chipIconW']} preset={layout['presetIconW']}")

                # 悬停色也要一致：挨着放的两个控件若悬停反馈不同，仍会被一眼看出是"两套设计"。
                trigger.first.hover()
                page.wait_for_timeout(250)
                mine_hover = page.evaluate(BG_JS, "button[aria-label='专家团']")

                neighbor = page.evaluate(NEIGHBOR_JS)
                if neighbor is None:
                    check("空会话：chip 悬停底色与邻居一致", False, "找不到邻居 chip")
                else:
                    page.mouse.move(neighbor["cx"], neighbor["cy"])
                    page.wait_for_timeout(250)
                    neighbor_hover = page.evaluate(NEIGHBOR_JS)["bg"]
                    check("空会话：chip 悬停底色与邻居一致",
                          mine_hover is not None and mine_hover == neighbor_hover,
                          f"chip={mine_hover} "
                          f"邻居「{neighbor['label']}」={neighbor_hover}")
                page.mouse.move(0, 0)
                page.wait_for_timeout(150)
            else:
                editor = layout.get("editor")
                if editor is None:
                    check("有内容的会话：chip 在输入框下方的工具行", False, "找不到输入框")
                else:
                    check("有内容的会话：chip 在输入框下方的工具行",
                          chip["y"] > editor["y"],
                          f"chip.y={chip['y']:.0f} editor.y={editor['y']:.0f}")

        if trigger_count >= 1:
            trigger.first.click()
            page.wait_for_timeout(1200)

            dialog = page.locator("[role='dialog'][aria-label='专家团']")
            check("点按钮后弹出专家团面板", dialog.count() == 1, f"count={dialog.count()}")
            page.screenshot(path=str(SHOT_DIR / "browser-2-gallery.png"), full_page=False)

            # ---- 层级：模态不能被右侧文件树面板压住 -----------------------
            # 真机曾出现：模态开着，右半边被文件树挡住 —— 因为 shell.overlay 的容器
            # z-index:20 形成层叠上下文，我们的 9999 在其中只是层内第一。
            if dialog.count() == 1:
                layers = page.evaluate(OVERLAP_JS)
                if layers.get("skipped"):
                    check("模态未被右侧文件面板遮挡", True, f"跳过：{layers['skipped']}")
                else:
                    check("模态挂在 document.body 下（逃出 shell.overlay 的 20 层叠上下文）",
                          layers.get("inBody") is True,
                          f"zIndex={layers.get('dialogZ')} inBody={layers.get('inBody')}")
                    overlap = layers.get("overlap") or {}
                    check("模态与右侧文件面板确实重叠（这条断言才有意义）",
                          overlap.get("w", 0) >= 4 and overlap.get("h", 0) >= 4,
                          f"重叠 {overlap.get('w')}×{overlap.get('h')}，"
                          f"面板 z={layers.get('panelZ')}，模态 z={layers.get('dialogZ')}")
                    check("重叠区最上层是专家团模态（没被文件面板盖住）",
                          layers.get("topInsideDialog") is True,
                          f"该点最上层=<{layers.get('topTag')}>，"
                          f"是否落在模态内={layers.get('topInsideDialog')}，"
                          f"探针点={layers.get('probe')}")

            if dialog.count() == 1:
                dtext = dialog.inner_text()
                check("面板列出内置团队", "产品战略团队" in dtext, dtext[:160])
                check("面板显示成员数量", "位专家" in dtext, dtext[:160])
                check("面板有「新建团队」入口", "新建团队" in dtext, dtext[:160])
                # 团队图标与成员头像统一成同一套插画（走宿主路由按需取），
                # 所以画廊里就该看到真实的 <img>，而不是一串 emoji 字符。
                gallery_icons = page.locator("img[src*='/expert-team/avatar/']")
                check("画廊卡片上的团队图标是插画（img 走 /avatar/ 路由）",
                      gallery_icons.count() >= 1, f"count={gallery_icons.count()}")
                # 参考版式的三件套：标题栏 / 排序标签 / 分类筛选行。
                check("画廊有排序标签 综合/最热/最新",
                      all(label in dtext for label in ("综合", "最热", "最新")), dtext[:160])
                check("画廊有分类筛选行（含「全部」）",
                      "全部" in dtext and "产品设计" in dtext, dtext[:200])
                check("画廊卡片显示发布方与标签",
                      "DSH 官方团队" in dtext, dtext[:260])

                card = dialog.locator("button", has_text="产品战略团队")
                check("画廊团队卡片可点", card.count() >= 1, f"count={card.count()}")
                if card.count() >= 1:
                    card.first.click()
                    page.wait_for_timeout(800)
                    detail = dialog.inner_text()
                    check("详情不再显示「万次使用」运营数字", "万次使用" not in detail, detail[:200])
                    check("详情把预设提问渲染成引号快捷条", "“" in detail and "”" in detail, detail[:220])
                    check("进入详情显示成员名册", "团队成员" in detail and "主理人" in detail, detail[:200])
                    check("详情显示使用案例", "使用案例" in detail, detail[:200])
                    check("详情显示预设能力简介", "功能规格书" in detail, detail[:200])
                    # 团队图标与成员头像现在都是插画，名册里不该再有成员那些彩色 emoji 字形。
                    check("成员头像不再用 emoji 字形", "🧭" not in detail, detail[:200])
                    # 成员头像换成随包分发的插画后，真正的护栏是「图真的加载出来了」：
                    # 路由没注册 / assets 没同步到安装副本，症状都是破图 —— 而这批头像底色很浅，
                    # 破图肉眼几乎看不出来，只有 naturalWidth 会说真话。
                    avatar_probe = page.evaluate(
                        "() => { const im = document.querySelector(\"img[src*='/expert-team/avatar/']\");"
                        " if (!im) return null;"
                        " return { src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight }; }")
                    check("成员头像是图片且走宿主路由（/expert-team/avatar/）",
                          avatar_probe is not None
                          and "/expert-team/avatar/" in avatar_probe["src"],
                          str(avatar_probe))
                    check("成员头像真的加载成功（naturalWidth > 0，不是 404 破图）",
                          avatar_probe is not None and avatar_probe["w"] > 0,
                          f"{avatar_probe['w']}×{avatar_probe['h']}" if avatar_probe else "找不到头像 img")
                    page.screenshot(path=str(SHOT_DIR / "browser-3-detail.png"), full_page=False)

                    summon = dialog.locator("button", has_text="召唤专家团")
                    if summon.count() >= 1:
                        summon.first.click()
                        page.wait_for_timeout(900)
                        check("点「召唤专家团」后面板自动关闭（没有第二道确认）",
                              dialog.count() == 0, f"count={dialog.count()}")
                        chip_text = page.evaluate(
                            "() => { const el = document.querySelector('[data-expert-team-active-chip]');"
                            " return el === null ? '' : el.innerText; }")
                        # 语义变了：不再往输入卡片上方另挂一个标签，而是**入口 chip 就地变成**团队标签。
                        check("召唤后原「专家团」入口就地变成团队标签（同一个控件）",
                              "产品战略团队" in chip_text, chip_text[:200])
                        check("标签显示已选成员计数",
                              "3/3" in chip_text.replace(" ", ""), chip_text[:200])
                        check("标签带成员下拉三角",
                              page.locator("[data-expert-team-active-chip] [aria-label='选择派遣成员']").count() >= 1,
                              chip_text[:200])
                        # 团队名那块按钮沿用入口的 aria-label，换团队时真机锚点不该消失。
                        check("标签仍带入口的 aria-label（换团队时锚点不消失）",
                              page.locator("button[aria-label='专家团']").count() >= 1)
                        # 位置回归：它必须和召唤前在同一行，而不是跑到输入卡片上方独占一行 ——
                        # 后者（挂在 conversation.input.dock）正是被改掉的观感。
                        active_layout = page.evaluate(LAYOUT_JS)
                        active_chip = active_layout.get("chip")
                        active_preset = active_layout.get("preset")
                        if active_layout.get("phase") == "hero" and active_chip and active_preset:
                            check("召唤后标签仍与「标准模式」同一行（不独占一行）",
                                  abs(active_chip["cy"] - active_preset["cy"]) <= 6
                                  and active_chip["h"] <= 34 and active_chip["w"] <= 280,
                                  f"chip={active_chip['w']:.0f}×{active_chip['h']:.0f} "
                                  f"cy={active_chip['cy']:.0f} preset.cy={active_preset['cy']:.0f}")
                        page.screenshot(path=str(SHOT_DIR / "browser-4-active-team.png"), full_page=False)
                    else:
                        check("详情有「召唤专家团」按钮", False, "找不到详情页的「召唤专家团」按钮")

        browser.close()

    return print_report(url, console_errors, page_errors)


def print_report(url: str, console_errors: list[str], page_errors: list[str]) -> int:
    failed = [r for r in results if not r[0]]
    report = [
        "expert-team 真浏览器验收报告",
        f"URL: {url}",
        f"通过 {len(results) - len(failed)} / {len(results)}",
        f"console.error 条数：{len(console_errors)}",
        f"pageerror 条数：{len(page_errors)}",
        "",
        *[f"{'[PASS]' if ok else '[FAIL]'} {label}" + (f" — {detail}" if detail else "") for ok, label, detail in results],
        "",
        "console.error 前 8 条：" if console_errors else "console.error：无",
        *[f"  {line[:200]}" for line in console_errors[:8]],
        "",
        "结论：全部通过。" if not failed else f"结论：{len(failed)} 项失败。",
    ]
    text = "\n".join(report)
    print(text)
    (SHOT_DIR / "browser-check-report.txt").write_text(text + "\n", encoding="utf-8")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
