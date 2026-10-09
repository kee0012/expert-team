// src/index.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
var name = "expert-team";
var inject = ["webServer"];
var HERE = path.dirname(fileURLToPath(import.meta.url));
var BUILTIN_FILE = path.join(HERE, "..", "data", "teams.json");
var API_PREFIX = "/expert-team/api/";
var ROUTE_PREFIX = "/expert-team";
var AVATAR_PREFIX = "/expert-team/avatar/";
var AVATAR_DIR = path.join(HERE, "..", "assets", "member-avatars");
var AVATAR_NAME = /^[0-9]{2}\.jpg$/u;
var AVATAR_COUNT = 36;
function cleanAvatar(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= AVATAR_COUNT) return void 0;
  return parsed;
}
function cleanStage(value, maxStages) {
  const cap = Number.isInteger(maxStages) && maxStages > 0 ? maxStages : DEFAULT_LIMITS.maxStages;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) return void 0;
  return parsed;
}
var MAX_BODY_BYTES = 1024 * 1024;
var DEFAULT_LIMITS = {
  /** 成员数上限。 */
  maxMembers: 13,
  /** 画廊卡片上的标签 chip 数量上限（对齐参考版式的 3–4 个）。 */
  maxTags: 4,
  /** 团队预设条（引号句子）数量上限。 */
  maxPresets: 6,
  /** 使用案例数量上限。 */
  maxCases: 6,
  /* 文本字段长度上限。 */
  maxTeamName: 40,
  maxTagline: 90,
  maxCategory: 12,
  maxTagLabel: 10,
  maxMemberName: 30,
  maxMemberAlias: 20,
  maxMemberFocus: 40,
  maxPersona: 4e3,
  maxPresetText: 140,
  maxCaseTitle: 40,
  maxCaseDesc: 90,
  maxCaseDelivery: 8e3,
  maxCasePrompt: 1200,
  /*
   * 分批派遣与子代理护栏（2026-09 新增）。
   * 背景：过去只有「一次性并行同题派遣」一种语义，persona 里写死的多阶段流程
   * 在运行时没有对应机制。下面三项让阶段编排成为可选能力，并给递归派遣设闸门。
   */
  /** 一次派遣最多同时开多少个子会话（兜底闸门；与实际选中的成员数取小）。 */
  maxChildrenPerSummon: 13,
  /** 允许多少层子代理嵌套：1 = 专家不能再往下派（默认）；2 = 允许专家再派一层。 */
  maxDelegateDepth: 1,
  /** 阶段序号取值范围 1..maxStages（团队 `stages` 声明里的 `stage` 上界）。 */
  maxStages: 9,
  /** 阶段名（如「初步调研」「多空辩论」）长度上限。 */
  maxStageName: 16
};
var VERSION = "0.2.3";
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".dsh");
}
var USER_DIR = path.join(dshHome(), "expert-teams");
var USER_FILE = path.join(USER_DIR, "teams.json");
var CONFIG_FILE = path.join(USER_DIR, "config.json");
var STATS_FILE = path.join(USER_DIR, "stats.json");
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs.renameSync(tmp, file);
}
function readConfig() {
  const doc = readJson(CONFIG_FILE, null);
  const raw = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  const source = raw.limits !== null && typeof raw.limits === "object" && !Array.isArray(raw.limits) ? raw.limits : {};
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const parsed = Number.parseInt(String(source[key] ?? ""), 10);
    limits[key] = Number.isInteger(parsed) && parsed > 0 && parsed <= 1e6 ? parsed : fallback;
  }
  return { lockBuiltinTeams: raw.lockBuiltinTeams === true, limits };
}
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return;
  try {
    writeJsonAtomic(CONFIG_FILE, {
      schemaVersion: 1,
      _note: "\u5F00\u53D1\u9636\u6BB5\uFF1AlockBuiltinTeams=false \u65F6\u5185\u7F6E\u56E2\u961F\u53EF\u7F16\u8F91\u3001\u6210\u5458\u53EF\u6539\uFF1B\u5B9A\u7A3F\u540E\u6539\u6210 true \u5373\u9501\u5B9A\u4E3A\u53EA\u8BFB\u3002limits \u8986\u76D6\u5404\u9879\u4E0A\u9650\uFF0C\u5220\u6389\u67D0\u9879\u5373\u7528\u9ED8\u8BA4\u503C\u3002",
      lockBuiltinTeams: false,
      limits: DEFAULT_LIMITS
    });
  } catch {
  }
}
var KEBAB = /^[a-z0-9][a-z0-9-]{0,39}$/;
var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function clean(value, max) {
  if (typeof value !== "string") return void 0;
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (stripped === "") return void 0;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}
function normalizeTeam(input, limits = DEFAULT_LIMITS) {
  if (input === null || typeof input !== "object") return { error: "team \u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61" };
  const id = clean(input.id, 40);
  if (id === void 0 || !KEBAB.test(id)) {
    return { error: "id \u5FC5\u987B\u662F\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57/\u8FDE\u5B57\u7B26\uFF0C1\u201340 \u4F4D\uFF0C\u4E14\u4EE5\u5B57\u6BCD\u6216\u6570\u5B57\u5F00\u5934" };
  }
  const teamName = clean(input.name, limits.maxTeamName);
  if (teamName === void 0) return { error: "name \u4E0D\u80FD\u4E3A\u7A7A\uFF08\u226440 \u5B57\uFF09" };
  if (!Array.isArray(input.members) || input.members.length === 0) {
    return { error: "members \u81F3\u5C11\u9700\u8981 1 \u4F4D\u4E13\u5BB6" };
  }
  if (input.members.length > limits.maxMembers) return { error: `members \u6700\u591A ${limits.maxMembers} \u4F4D` };
  const members = [];
  const seen = /* @__PURE__ */ new Set();
  let leadCount = 0;
  for (const raw of input.members) {
    if (raw === null || typeof raw !== "object") return { error: "member \u5FC5\u987B\u662F\u5BF9\u8C61" };
    const memberId = clean(raw.id, 40);
    if (memberId === void 0 || !KEBAB.test(memberId)) {
      return { error: `\u6210\u5458 id\u300C${String(raw.id)}\u300D\u4E0D\u5408\u6CD5\uFF08\u9700\u5C0F\u5199 kebab-case\uFF09` };
    }
    if (seen.has(memberId)) return { error: `\u6210\u5458 id \u91CD\u590D\uFF1A${memberId}` };
    seen.add(memberId);
    const memberName = clean(raw.name, limits.maxMemberName);
    if (memberName === void 0) return { error: `\u6210\u5458 ${memberId} \u7F3A\u5C11 name` };
    const persona = clean(raw.persona, limits.maxPersona);
    if (persona === void 0) return { error: `\u6210\u5458 ${memberId} \u7F3A\u5C11 persona` };
    const alias = clean(raw.alias, limits.maxMemberAlias);
    const emoji2 = clean(raw.emoji, 8);
    const avatar2 = cleanAvatar(raw.avatar);
    const focus = clean(raw.focus, limits.maxMemberFocus);
    const role = raw.role === "lead" ? "lead" : "member";
    if (role === "lead") leadCount += 1;
    members.push({
      id: memberId,
      name: memberName,
      role,
      persona,
      ...alias === void 0 ? {} : { alias },
      ...emoji2 === void 0 ? {} : { emoji: emoji2 },
      ...avatar2 === void 0 ? {} : { avatar: avatar2 },
      ...focus === void 0 ? {} : { focus }
    });
  }
  if (leadCount > 1) return { error: '\u53EA\u80FD\u6709 1 \u4F4D\u4E3B\u7406\u4EBA\uFF08role: "lead"\uFF09' };
  const stages = [];
  if (Array.isArray(input.stages) && input.stages.length > 0) {
    const memberIds = members.map((member) => member.id);
    const known = new Set(memberIds);
    const seenStage = /* @__PURE__ */ new Set();
    const covered = /* @__PURE__ */ new Set();
    for (const raw of input.stages.slice(0, limits.maxStages)) {
      if (raw === null || typeof raw !== "object") return { error: "stages \u7684\u6BCF\u4E00\u9879\u5FC5\u987B\u662F\u5BF9\u8C61" };
      const stageNo = cleanStage(raw.stage, limits.maxStages);
      if (stageNo === void 0) return { error: `\u9636\u6BB5\u5E8F\u53F7\u5FC5\u987B\u662F 1\u2013${limits.maxStages} \u7684\u6574\u6570` };
      if (seenStage.has(stageNo)) return { error: `\u9636\u6BB5\u5E8F\u53F7\u91CD\u590D\uFF1A${stageNo}` };
      seenStage.add(stageNo);
      const picked = [];
      const seenLocal = /* @__PURE__ */ new Set();
      for (const id2 of Array.isArray(raw.members) ? raw.members.map(String) : []) {
        if (!known.has(id2)) return { error: `\u9636\u6BB5 ${stageNo} \u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u6210\u5458\uFF1A${id2}` };
        if (seenLocal.has(id2)) continue;
        seenLocal.add(id2);
        picked.push(id2);
        covered.add(id2);
      }
      if (picked.length === 0) return { error: `\u9636\u6BB5 ${stageNo} \u6CA1\u6709\u6307\u5B9A\u4EFB\u4F55\u6210\u5458` };
      const stageName = clean(raw.name, limits.maxStageName);
      stages.push({
        stage: stageNo,
        members: picked,
        ...stageName === void 0 ? {} : { name: stageName }
      });
    }
    stages.sort((a, b) => a.stage - b.stage);
    for (let index = 0; index < stages.length; index++) {
      if (stages[index].stage !== index + 1) {
        return { error: "\u9636\u6BB5\u5E8F\u53F7\u5FC5\u987B\u4ECE 1 \u5F00\u59CB\u4E14\u8FDE\u7EED\uFF081\u30012\u30013\u2026\uFF09" };
      }
    }
    const missing = memberIds.filter((id2) => !covered.has(id2));
    if (missing.length > 0) {
      return { error: `\u8FD9\u4E9B\u6210\u5458\u6CA1\u6709\u88AB\u4EFB\u4F55\u9636\u6BB5\u5F15\u7528\uFF1A${missing.join("\u3001")}\uFF08\u58F0\u660E\u4E86 stages \u5C31\u5FC5\u987B\u8986\u76D6\u5168\u90E8\u6210\u5458\uFF09` };
    }
  }
  const presets = [];
  if (Array.isArray(input.presets)) {
    for (const item of input.presets.slice(0, limits.maxPresets)) {
      const text = clean(item, limits.maxPresetText);
      if (text !== void 0) presets.push(text);
    }
  }
  const cases = [];
  if (Array.isArray(input.cases)) {
    for (const raw of input.cases.slice(0, limits.maxCases)) {
      if (raw === null || typeof raw !== "object") continue;
      const title = clean(raw.title, limits.maxCaseTitle);
      if (title === void 0) continue;
      const desc = clean(raw.desc, limits.maxCaseDesc);
      const emoji2 = clean(raw.emoji, 8);
      const delivery = clean(raw.delivery, limits.maxCaseDelivery);
      const prompt = clean(raw.prompt, limits.maxCasePrompt);
      cases.push({
        title,
        ...desc === void 0 ? {} : { desc },
        ...emoji2 === void 0 ? {} : { emoji: emoji2 },
        ...delivery === void 0 ? {} : { delivery },
        ...prompt === void 0 ? {} : { prompt }
      });
    }
  }
  const tags = [];
  if (Array.isArray(input.tags)) {
    for (const item of input.tags.slice(0, limits.maxTags)) {
      const label = clean(item, limits.maxTagLabel);
      if (label !== void 0 && !tags.includes(label)) tags.push(label);
    }
  }
  const category = clean(input.category, limits.maxCategory);
  const createdAt = clean(input.createdAt, 40);
  const tagline = clean(input.tagline, limits.maxTagline);
  const emoji = clean(input.emoji, 8);
  const avatar = cleanAvatar(input.avatar);
  return {
    team: {
      id,
      name: teamName,
      accent: HEX_COLOR.test(String(input.accent ?? "")) ? input.accent : "#4F46E5",
      presets,
      cases,
      members,
      ...stages.length === 0 ? {} : { stages },
      ...tagline === void 0 ? {} : { tagline },
      ...emoji === void 0 ? {} : { emoji },
      ...avatar === void 0 ? {} : { avatar },
      ...category === void 0 ? {} : { category },
      ...tags.length === 0 ? {} : { tags },
      ...createdAt === void 0 ? {} : { createdAt }
    }
  };
}
function publicView(team, usage) {
  const plan = stagePlan(team);
  return {
    id: team.id,
    name: team.name,
    tagline: team.tagline ?? "",
    emoji: team.emoji ?? "\u{1F465}",
    /** 头像索引；null 表示「没显式挑过」，由前端按团队 id 稳定派生一张。 */
    avatar: cleanAvatar(team.avatar) ?? null,
    accent: team.accent ?? "#4F46E5",
    source: team.source ?? "builtin",
    /** 卡片名称下方那一行（参考版式里是发布方）。派生而不是收字段，避免出现假来源。 */
    publisher: team.source === "custom" ? "\u6211\u7684\u56E2\u961F" : "DSH \u5B98\u65B9\u56E2\u961F",
    category: team.category ?? "",
    tags: Array.isArray(team.tags) ? team.tags : [],
    createdAt: team.createdAt ?? "",
    usageCount: (team.usageCount ?? 0) + (usage[team.id] ?? 0),
    presets: team.presets ?? [],
    cases: team.cases ?? [],
    members: (team.members ?? []).map((member) => ({
      id: member.id,
      name: member.name,
      alias: member.alias ?? "",
      role: member.role === "lead" ? "lead" : "member",
      emoji: member.emoji ?? "\u{1F642}",
      /** 头像索引；null 表示没显式挑过，由前端按成员 id 稳定派生。 */
      avatar: cleanAvatar(member.avatar) ?? null,
      focus: member.focus ?? "",
      /** 该成员参与哪些阶段；[] = 不参与阶段编排（整团一次性并行派遣）。 */
      stages: stagesOf(member.id, plan),
      persona: member.persona ?? ""
    })),
    /**
     * 阶段计划；空数组 = 这支团队没有阶段概念（面板据此隐藏「分批派遣」）。
     * 只下发阶段序号 / 名字 / 成员 id，不下发 persona。
     */
    stages: plan.staged ? plan.stages.map((item) => ({ stage: item.stage, name: item.name, members: item.ids })) : []
  };
}
var TeamRepository = class {
  constructor() {
    this.builtin = [];
    this.custom = [];
    this.usage = {};
    this.reload();
  }
  reload() {
    const builtinDoc = readJson(BUILTIN_FILE, { teams: [] });
    this.builtin = Array.isArray(builtinDoc?.teams) ? builtinDoc.teams : [];
    const customDoc = readJson(USER_FILE, { teams: [] });
    const rawCustom = Array.isArray(customDoc) ? customDoc : customDoc?.teams ?? [];
    const { limits } = readConfig();
    this.custom = [];
    for (const raw of Array.isArray(rawCustom) ? rawCustom : []) {
      const { team } = normalizeTeam(raw, limits);
      if (team !== void 0) this.custom.push({ ...team, source: "custom" });
    }
    this.usage = readJson(STATS_FILE, {}) ?? {};
  }
  all() {
    const byId = /* @__PURE__ */ new Map();
    for (const team of this.builtin) byId.set(team.id, { ...team, source: "builtin" });
    for (const team of this.custom) byId.set(team.id, team);
    return [...byId.values()];
  }
  get(id) {
    return this.all().find((team) => team.id === id);
  }
  /**
   * 该 id 是否来自内置基线（`data/teams.json`）。
   * 锁定模式（config.lockBuiltinTeams=true）下，命中它的写入会被拒绝 ——
   * 开发阶段这条分支不会触发，放开后内置团队就是普通的可编辑团队。
   */
  isBuiltin(id) {
    return this.builtin.some((team) => team.id === id);
  }
  list() {
    return this.all().map((team) => publicView(team, this.usage));
  }
  view(id) {
    const team = this.get(id);
    return team === void 0 ? void 0 : publicView(team, this.usage);
  }
  upsert(team) {
    const previous = this.custom.find((item) => item.id === team.id);
    const createdAt = team.createdAt ?? previous?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString();
    this.custom = [
      ...this.custom.filter((item) => item.id !== team.id),
      { ...team, source: "custom", createdAt }
    ];
    writeJsonAtomic(USER_FILE, { schemaVersion: 1, teams: this.custom });
  }
  /** 删除一个自定义团队；内置团队删不掉（会重新出现）。 */
  remove(id) {
    const before = this.custom.length;
    this.custom = this.custom.filter((item) => item.id !== id);
    writeJsonAtomic(USER_FILE, { schemaVersion: 1, teams: this.custom });
    return this.custom.length < before;
  }
  bumpUsage(id) {
    this.usage[id] = (this.usage[id] ?? 0) + 1;
    try {
      writeJsonAtomic(STATS_FILE, this.usage);
    } catch {
    }
  }
};
var DispatchLedger = class {
  constructor() {
    this.byTeam = /* @__PURE__ */ new Map();
  }
  record(teamId, task, result) {
    const list = this.byTeam.get(teamId) ?? [];
    list.unshift({
      teamId,
      task: task.length > 200 ? `${task.slice(0, 200)}\u2026` : task,
      /** 本次派遣的阶段；null = 一次性整团并行。 */
      stage: result.stage ?? null,
      stageCount: result.plan?.stageCount ?? 1,
      provider: result.provider,
      personaNative: result.personaNative,
      skipped: result.skipped,
      members: result.dispatched,
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.byTeam.set(teamId, list.slice(0, 20));
  }
  list(teamId) {
    if (teamId !== void 0) return this.byTeam.get(teamId) ?? [];
    return [...this.byTeam.values()].flat().sort((a, b) => a.at < b.at ? 1 : -1).slice(0, 40);
  }
};
function sessionIdOf(agent) {
  const session = agent?.session;
  return session?.id ?? session?.sessionId ?? agent?.id;
}
function findAgent(agents, sessionId) {
  if (sessionId === void 0 || sessionId === null || sessionId === "") return void 0;
  try {
    if (typeof agents.get === "function") {
      const direct = agents.get(sessionId);
      if (direct !== void 0 && direct !== null) return direct;
    }
  } catch {
  }
  if (typeof agents.list !== "function") return void 0;
  for (const agent of agents.list()) {
    if (String(sessionIdOf(agent)) === String(sessionId)) return agent;
  }
  return void 0;
}
function pickProvider(subagents) {
  if (subagents === void 0) return void 0;
  let names = [];
  try {
    names = subagents.list();
  } catch {
    return void 0;
  }
  const preferred = ["spawn", "fork", "default", "in-process"];
  const ordered = [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n))];
  for (const candidate of ordered) {
    let provider;
    try {
      provider = subagents.getProvider(candidate);
    } catch {
      provider = void 0;
    }
    if (provider !== void 0 && typeof provider.prepareContinuable === "function") {
      return { name: candidate, capabilities: provider.capabilities ?? {} };
    }
  }
  return void 0;
}
var CONTEXT_LIMIT = 2e4;
function stagePlan(team) {
  const members = Array.isArray(team.members) ? team.members : [];
  const whole = () => ({
    staged: false,
    stageCount: 1,
    stages: [{ stage: 1, name: "", members, ids: members.map((member) => member.id) }]
  });
  const declared = Array.isArray(team.stages) ? team.stages : [];
  if (declared.length === 0) return whole();
  const byId = new Map(members.map((member) => [member.id, member]));
  const stages = declared.map((item) => {
    const roster = (Array.isArray(item.members) ? item.members : []).map((id) => byId.get(id)).filter((member) => member !== void 0);
    return {
      stage: item.stage,
      name: item.name ?? "",
      members: roster,
      ids: roster.map((member) => member.id)
    };
  }).filter((item) => item.members.length > 0).sort((a, b) => a.stage - b.stage);
  if (stages.length === 0) return whole();
  return { staged: stages.length > 1, stageCount: stages.length, stages };
}
function stagesOf(memberId, plan) {
  if (!plan.staged) return [];
  return plan.stages.filter((item) => item.ids.includes(memberId)).map((item) => item.stage);
}
function buildMemberPrompt(team, member, task, personaInline, options = {}) {
  const parts = [];
  const alias = member.alias !== void 0 && member.alias !== "" ? `\uFF08${member.alias}\uFF09` : "";
  parts.push(`\u3010${team.name} \xB7 \u4E13\u5BB6\u56E2\u4EFB\u52A1\u3011\u4F60\u662F\u672C\u6B21\u4EFB\u52A1\u4E2D\u7684\u4E00\u4F4D\u4E13\u5BB6\uFF1A${member.name}${alias}\u3002`);
  if (personaInline) {
    parts.push("", "\u2014\u2014 \u4F60\u7684\u89D2\u8272\u8BBE\u5B9A \u2014\u2014", String(member.persona ?? ""));
  } else if (member.focus !== void 0 && member.focus !== "") {
    parts.push("", `\u2014\u2014 \u4F60\u7684\u804C\u8D23\u8303\u56F4 \u2014\u2014`, member.focus);
  }
  const stage = options.stage;
  const stageCount = Number.isInteger(options.stageCount) ? options.stageCount : 0;
  const staged = Number.isInteger(stage) && stageCount > 1;
  if (staged) {
    parts.push(
      "",
      "\u2014\u2014 \u4F60\u5728\u6D41\u7A0B\u4E2D\u7684\u4F4D\u7F6E \u2014\u2014",
      `\u672C\u6B21\u662F**\u7B2C ${stage} / ${stageCount} \u9636\u6BB5**\u7684\u5206\u6279\u6D3E\u9063\uFF1A\u4F60\u53EA\u505A\u672C\u9636\u6BB5\u7684\u4E8B\u3002`
    );
    const upstream = Array.isArray(options.upstream) ? options.upstream.filter(Boolean) : [];
    const downstream = Array.isArray(options.downstream) ? options.downstream.filter(Boolean) : [];
    if (upstream.length > 0) {
      parts.push(`\xB7 \u4F60\u7684\u8F93\u5165\u6765\u81EA\u4E0A\u6E38\u6210\u5458\uFF08${upstream.join("\u3001")}\uFF09\uFF1B\u82E5\u4E0A\u6E38\u4EA7\u51FA\u5DF2\u968F\u672C\u6307\u4EE4\u7ED9\u51FA\uFF0C\u4EE5\u5B83\u4E3A\u51C6\uFF0C\u4E0D\u8981\u91CD\u65B0\u9020\u4E00\u904D\u3002`);
    } else {
      parts.push("\xB7 \u4F60\u662F\u672C\u6D41\u7A0B\u7684\u8D77\u70B9\uFF0C\u6CA1\u6709\u4E0A\u6E38\u4EA7\u51FA\u53EF\u4F9D\u8D56\uFF1B\u7F3A\u4FE1\u606F\u5C31\u5199\u660E\u5047\u8BBE\u3002");
    }
    if (downstream.length > 0) {
      parts.push(`\xB7 \u4F60\u7684\u4EA7\u51FA\u4F1A\u88AB\u539F\u6587\u4EA4\u7ED9\u4E0B\u6E38\u6210\u5458\uFF08${downstream.join("\u3001")}\uFF09\uFF0C\u8BF7\u5199\u6210\u5BF9\u65B9\u80FD\u76F4\u63A5\u63A5\u7740\u505A\u7684\u5F62\u5F0F\u3002`);
    } else {
      parts.push("\xB7 \u4F60\u662F\u672C\u6D41\u7A0B\u7684\u6700\u540E\u4E00\u73AF\uFF0C\u6700\u7EC8\u4EA4\u4ED8\u7269\u7531\u4F60\u6240\u5728\u9636\u6BB5\u6536\u53E3\u3002");
    }
  }
  const context = typeof options.context === "string" ? options.context.trim() : "";
  if (context !== "") {
    const clipped = context.length > CONTEXT_LIMIT ? `${context.slice(0, CONTEXT_LIMIT)}

\uFF08\u4E0A\u6E38\u4EA7\u51FA\u8FC7\u957F\uFF0C\u5DF2\u5728\u6B64\u622A\u65AD\uFF09` : context;
    parts.push("", "\u2014\u2014 \u4E0A\u6E38\u4EA7\u51FA\uFF08\u672C\u9636\u6BB5\u7684\u8F93\u5165\uFF09\u2014\u2014", clipped);
  }
  parts.push("", "\u2014\u2014 \u672C\u6B21\u4EFB\u52A1 \u2014\u2014", task);
  parts.push(
    "",
    "\u2014\u2014 \u5DE5\u4F5C\u8981\u6C42 \u2014\u2014",
    "1. \u53EA\u4ECE\u4F60\u672C\u89D2\u8272\u7684\u89C6\u89D2\u5207\u5165\uFF0C\u4E0D\u8981\u8D8A\u754C\u5305\u529E\u5176\u4ED6\u4E13\u5BB6\u7684\u804C\u8D23\u3002",
    "2. \u76F4\u63A5\u7ED9\u51FA\u53EF\u7528\u7684\u4EA7\u51FA\uFF0C\u4E0D\u8981\u53EA\u5217\u63D0\u7EB2\u3001\u4E5F\u4E0D\u8981\u53CD\u95EE\u7D22\u53D6\u66F4\u591A\u4FE1\u606F\uFF1B\u7F3A\u4FE1\u606F\u5C31\u5199\u51FA\u4F60\u7684\u5047\u8BBE\u3002",
    "3. \u7ED3\u8BBA\u5148\u884C\u3001\u4F9D\u636E\u5728\u540E\uFF1B\u4E0D\u786E\u5B9A\u5904\u663E\u5F0F\u6807\u6CE8\u300C\u4E0D\u786E\u5B9A\u300D\u3002",
    "4. \u4E0D\u7F16\u9020\u6570\u636E\u4E0E\u6587\u732E\u3002",
    "5. \u6536\u5C3E\u65F6\u628A\u6210\u679C\u6574\u7406\u6210\u4E00\u6BB5\u53EF\u76F4\u63A5\u88AB\u53EC\u96C6\u4EBA\u62FC\u63A5\u8FDB\u7EC8\u7A3F\u7684\u4EA4\u4ED8\u5185\u5BB9\u3002"
  );
  if (staged) {
    parts.push("6. \u5206\u6279\u6D3E\u9063\uFF1A\u4F60\u7684\u4EA7\u51FA\u4F1A\u88AB\u539F\u6587\u4EA4\u7ED9\u4E0B\u6E38\uFF0C\u8BF7\u81EA\u5305\u542B\uFF0C\u4E0D\u8981\u7528\u300C\u89C1\u4E0A\u6587\u300D\u8FD9\u7C7B\u6307\u4EE3\u3002");
  }
  if (options.noNestedSummon === true) {
    const ruleNo = staged ? 7 : 6;
    parts.push(`${ruleNo}. \u4E0D\u8981\u518D\u53EC\u5524\u5176\u4ED6\u4E13\u5BB6\u56E2\u3001\u4E5F\u4E0D\u8981\u518D\u6D3E\u9063\u4E0B\u5C5E\u5B50\u4EE3\u7406\uFF1A\u8FD9\u6B21\u4EFB\u52A1\u7531\u4F60\u672C\u4EBA\u76F4\u63A5\u5B8C\u6210\u3002`);
  }
  return parts.join("\n");
}
function summarizeFailures(skipped) {
  const groups = /* @__PURE__ */ new Map();
  for (const item of skipped) {
    const sample = String(item?.reason ?? "").replace(/\s+/gu, " ").trim();
    const key = sample.slice(0, 160);
    const bucket = groups.get(key);
    if (bucket === void 0) groups.set(key, { names: [item.name], sample });
    else bucket.names.push(item.name);
  }
  return [...groups.values()].map((group) => {
    const heads = group.names.slice(0, 4).join("\u3001");
    const who = group.names.length > 4 ? `${heads} \u7B49 ${group.names.length} \u4F4D` : heads;
    const detail = group.sample === "" ? "\uFF08\u5BBF\u4E3B\u672A\u7ED9\u51FA\u9519\u8BEF\u4FE1\u606F\uFF09" : `${group.sample.length > 160 ? `${group.sample.slice(0, 160)}\u2026` : group.sample}`;
    return `${who}\uFF1A${detail}`;
  }).join("\uFF1B");
}
async function summonTeam(subagents, parentAgent, team, task, memberIds, signal, options = {}) {
  const effectiveSignal = signal ?? new AbortController().signal;
  const picked = pickProvider(subagents);
  if (picked === void 0) {
    const error = new Error("DSH \u5F53\u524D\u6CA1\u6709\u6CE8\u518C\u4EFB\u4F55\u652F\u6301 continuable \u5B50\u4F1A\u8BDD\u7684 subagent provider");
    error.code = "NO_PROVIDER";
    error.status = 503;
    throw error;
  }
  const capabilities = picked.capabilities ?? {};
  const personaNative = capabilities.persona === true;
  const { limits } = readConfig();
  const plan = stagePlan(team);
  const stage = Number.isInteger(options.stage) && options.stage >= 1 ? options.stage : void 0;
  const stageBucket = stage === void 0 ? void 0 : plan.stages.find((item) => item.stage === stage);
  if (stage !== void 0 && stageBucket === void 0) {
    const error = new Error(`\u672C\u56E2\u6CA1\u6709\u7B2C ${stage} \u9636\u6BB5\uFF08\u5171 ${plan.stageCount} \u4E2A\u9636\u6BB5\uFF09`);
    error.code = "NO_STAGE";
    error.status = 400;
    throw error;
  }
  const selected = Array.isArray(memberIds) && memberIds.length > 0 ? team.members.filter((member) => memberIds.includes(member.id)) : team.members;
  let wanted = stageBucket === void 0 ? selected : selected.filter((member) => stageBucket.ids.includes(member.id));
  if (wanted.length === 0) {
    const error = new Error(stage === void 0 ? "\u6CA1\u6709\u9009\u4E2D\u4EFB\u4F55\u4E13\u5BB6" : `\u7B2C ${stage} \u9636\u6BB5\u6CA1\u6709\u9009\u4E2D\u4EFB\u4F55\u4E13\u5BB6`);
    error.code = "NO_MEMBER";
    error.status = 400;
    throw error;
  }
  const cap = Math.max(1, Math.min(limits.maxChildrenPerSummon, limits.maxMembers));
  const overflow = wanted.length > cap ? wanted.slice(cap).map((member) => member.name) : [];
  if (overflow.length > 0) wanted = wanted.slice(0, cap);
  const upstreamNames = stage === void 0 ? [] : plan.stages.filter((item) => item.stage < stage).flatMap((item) => item.members.map((member) => member.name));
  const downstreamNames = stage === void 0 ? [] : plan.stages.filter((item) => item.stage > stage).flatMap((item) => item.members.map((member) => member.name));
  const context = typeof options.context === "string" ? options.context : void 0;
  const blockNested = options.blockNestedSummon !== false;
  const depthCap = Number.isInteger(limits.maxDelegateDepth) && limits.maxDelegateDepth >= 1 ? limits.maxDelegateDepth : 1;
  const guard = { depthLimited: false, toolsDenied: false, depthCap, nestedSoftOnly: false, degraded: [] };
  if (blockNested) {
    if (capabilities.depthLimit === true) guard.depthLimited = true;
    else guard.degraded.push("depthLimit");
    if (depthCap <= 1) guard.nestedSoftOnly = true;
  }
  const dispatched = [];
  const skipped = [];
  for (const member of wanted) {
    const childId = randomUUID();
    try {
      const started = await subagents.startContinuable({
        childId,
        provider: picked.name,
        label: stage === void 0 ? `${team.name} \xB7 ${member.name}` : `${team.name} \xB7 P${stage} \xB7 ${member.name}`,
        request: {
          prompt: [{
            type: "text",
            text: buildMemberPrompt(team, member, task, !personaNative, {
              stage,
              stageCount: plan.stageCount,
              upstream: upstreamNames,
              downstream: downstreamNames,
              context,
              noNestedSummon: guard.nestedSoftOnly
            })
          }],
          parent: parentAgent,
          ...personaNative && member.persona !== void 0 && member.persona !== "" ? { persona: member.persona } : {},
          ...guard.depthLimited ? { maxDepth: depthCap } : {}
        },
        signal: effectiveSignal
      });
      dispatched.push({
        memberId: member.id,
        name: member.name,
        alias: member.alias ?? "",
        /* 本次派遣所属阶段；0 = 一次性整团派遣。 */
        stage: stage ?? 0,
        childSessionId: started?.childId ?? childId,
        messageId: started?.messageId ?? null,
        dispatchedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (error) {
      skipped.push({ memberId: member.id, name: member.name, reason: String(error?.message ?? error) });
    }
  }
  if (dispatched.length === 0) {
    const error = new Error(`\u5168\u90E8 ${skipped.length} \u4F4D\u4E13\u5BB6\u6D3E\u53D1\u5931\u8D25\uFF1A${summarizeFailures(skipped)}`);
    error.code = "ALL_FAILED";
    error.status = 502;
    throw error;
  }
  return {
    dispatched,
    skipped,
    provider: picked.name,
    personaNative,
    stage: stage ?? null,
    plan,
    guard,
    overflow,
    contextChars: typeof context === "string" ? context.length : 0
  };
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}
function sendAvatar(res, name2) {
  if (!AVATAR_NAME.test(name2)) return sendJson(res, 404, { ok: false, error: "not found" });
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(AVATAR_DIR, name2));
  } catch {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
  res.writeHead(200, {
    "content-type": "image/jpeg",
    "content-length": buffer.length,
    "cache-control": "no-cache"
  });
  res.end(buffer);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927\uFF08\u4E0A\u9650 1MB\uFF09");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function mountHttp(ctx, repo, ledger) {
  return ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();
      if (route.startsWith(AVATAR_PREFIX)) {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return sendAvatar(res, route.slice(AVATAR_PREFIX.length));
      }
      if (!route.startsWith(API_PREFIX)) return sendJson(res, 404, { ok: false, error: "not found" });
      const endpoint = route.slice(API_PREFIX.length);
      const agents = ctx.get("agents");
      const subagents = ctx.get("subagents");
      try {
        if (endpoint === "health" && method === "GET") {
          const picked = pickProvider(subagents);
          return sendJson(res, 200, {
            ok: true,
            plugin: name,
            version: VERSION,
            teams: repo.all().length,
            subagentProvider: picked?.name ?? null,
            personaNative: picked?.capabilities?.persona === true
          });
        }
        if (endpoint === "config" && method === "GET") {
          return sendJson(res, 200, { ok: true, config: readConfig() });
        }
        if (endpoint === "teams" && method === "GET") {
          return sendJson(res, 200, { ok: true, teams: repo.list(), config: readConfig() });
        }
        if (endpoint === "teams" && method === "POST") {
          const body = await readBody(req);
          const config = readConfig();
          const { team, error } = normalizeTeam(body?.team ?? body, config.limits);
          if (team === void 0) return sendJson(res, 400, { ok: false, error });
          if (config.lockBuiltinTeams && repo.isBuiltin(team.id)) {
            return sendJson(res, 403, {
              ok: false,
              error: "\u5185\u7F6E\u56E2\u961F\u5DF2\u9501\u5B9A\uFF08config.json \u7684 lockBuiltinTeams=true\uFF09\u3002\u60F3\u6539\u5185\u7F6E\u56E2\u961F\uFF0C\u8BF7\u628A\u8BE5\u914D\u7F6E\u6539\u56DE false\uFF0C\u6216\u5148\u628A\u5B83\u300C\u53E6\u5B58\u4E3A\u300D\u4E00\u652F\u81EA\u5B9A\u4E49\u56E2\u961F\u3002",
              code: "LOCKED"
            });
          }
          repo.upsert(team);
          return sendJson(res, 200, { ok: true, team: repo.view(team.id) });
        }
        if (endpoint.startsWith("teams/")) {
          const id = decodeURIComponent(endpoint.slice("teams/".length));
          if (method === "GET") {
            const team = repo.view(id);
            if (team === void 0) return sendJson(res, 404, { ok: false, error: "\u56E2\u961F\u4E0D\u5B58\u5728" });
            return sendJson(res, 200, { ok: true, team });
          }
          if (method === "DELETE") {
            if (repo.get(id) === void 0) return sendJson(res, 404, { ok: false, error: "\u56E2\u961F\u4E0D\u5B58\u5728" });
            const removed = repo.remove(id);
            return sendJson(res, 200, { ok: true, removed, stillVisible: repo.get(id) !== void 0 });
          }
        }
        if (endpoint === "summon" && method === "POST") {
          const body = await readBody(req);
          if (agents === void 0 || subagents === void 0) {
            return sendJson(res, 503, {
              ok: false,
              error: "DSH \u672A\u63D0\u4F9B agents/subagents \u670D\u52A1\uFF0C\u65E0\u6CD5\u6D3E\u9063\u4E13\u5BB6",
              code: "NO_SERVICE"
            });
          }
          const team = repo.get(String(body?.teamId ?? ""));
          if (team === void 0) return sendJson(res, 404, { ok: false, error: "\u56E2\u961F\u4E0D\u5B58\u5728" });
          const task = clean(body?.task, 4e3);
          if (task === void 0) return sendJson(res, 400, { ok: false, error: "task \u4E0D\u80FD\u4E3A\u7A7A" });
          const context = clean(body?.context, CONTEXT_LIMIT);
          const stage = Number.isInteger(body?.stage) && body.stage >= 1 ? Number(body.stage) : void 0;
          const parent = findAgent(agents, body?.sessionId);
          if (parent === void 0) {
            return sendJson(res, 409, {
              ok: false,
              error: "\u627E\u4E0D\u5230\u5BF9\u5E94\u7684\u4F1A\u8BDD\uFF08\u4F1A\u8BDD\u53EF\u80FD\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF09",
              code: "NO_PARENT"
            });
          }
          const controller = new AbortController();
          const abortOnClose = () => controller.abort();
          res.on("close", abortOnClose);
          try {
            const result = await summonTeam(subagents, parent, team, task, body?.memberIds, controller.signal, {
              stage,
              context
            });
            repo.bumpUsage(team.id);
            ledger.record(team.id, task, result);
            return sendJson(res, 200, {
              ok: true,
              teamId: team.id,
              stage: result.stage,
              stageCount: result.plan.stageCount,
              plan: result.plan.stages.map((item) => ({
                stage: item.stage,
                name: item.name,
                members: item.members.map((member) => ({
                  id: member.id,
                  name: member.name,
                  alias: member.alias ?? ""
                }))
              })),
              provider: result.provider,
              personaNative: result.personaNative,
              dispatched: result.dispatched,
              skipped: result.skipped,
              guard: result.guard,
              overflow: result.overflow,
              contextChars: result.contextChars
            });
          } finally {
            res.off("close", abortOnClose);
          }
        }
        if (endpoint === "status" && method === "GET") {
          const teamId = url.searchParams.get("teamId") ?? void 0;
          return sendJson(res, 200, { ok: true, dispatches: ledger.list(teamId) });
        }
        return sendJson(res, 404, { ok: false, error: `\u672A\u77E5\u63A5\u53E3\uFF1A${method} ${route}` });
      } catch (error) {
        const status = typeof error?.status === "number" ? error.status : 500;
        const message = String(error?.message ?? error);
        ctx.logger?.warn?.(`expert-team: ${method} ${route} \u2192 ${status}\uFF1A${message}`);
        return sendJson(res, status, {
          ok: false,
          error: message,
          code: error?.code ?? null
        });
      }
    }
  });
}
function registerCommands(commands, repo) {
  const roster = (team) => team.members.map((member) => {
    const alias = member.alias !== void 0 && member.alias !== "" ? `\uFF08${member.alias}\uFF09` : "";
    const role = member.role === "lead" ? "\u4E3B\u7406\u4EBA" : "\u6210\u5458";
    return `${member.role === "lead" ? "\u2605" : "\xB7"} ${member.name}${alias}\uFF5C${role}\uFF5C${member.focus ?? ""}`;
  }).join("\n");
  return commands.register({
    name: "expert-team",
    description: "\u4E13\u5BB6\u56E2\uFF1Alist \u5217\u51FA\u5168\u90E8\u56E2\u961F / show <\u56E2\u961Fid> \u770B\u6210\u5458 / summon <\u56E2\u961Fid> \u770B\u6D3E\u9063\u65B9\u5F0F",
    /* 0.2.0 起命令可声明参数提示，斜杠命令面板会显示在名字后面。 */
    input: { hint: "list | show <\u56E2\u961Fid> | summon <\u56E2\u961Fid>" },
    handler: ({ rawInput }) => {
      const parts = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      if (sub === "list") {
        const teams = repo.list();
        return {
          kind: "success",
          text: `\u53EF\u7528\u4E13\u5BB6\u56E2\uFF08${teams.length} \u652F\uFF09\uFF1A
${teams.map((team) => `\xB7 ${team.id} \u2014 ${team.name}\uFF08${team.members.length} \u4F4D\u4E13\u5BB6\uFF09${team.tagline !== "" ? `\uFF5C${team.tagline}` : ""}`).join("\n")}`
        };
      }
      if (sub === "show") {
        const team = repo.get(parts[1] ?? "");
        if (team === void 0) {
          return { kind: "error", text: `\u627E\u4E0D\u5230\u56E2\u961F\uFF1A${parts[1] ?? "(\u7A7A)"}` };
        }
        return {
          kind: "success",
          text: `\u3010${team.name}\u3011${team.tagline ?? ""}
${roster(team)}`
        };
      }
      if (sub === "summon") {
        const team = repo.get(parts[1] ?? "");
        if (team === void 0) {
          return { kind: "error", text: `\u627E\u4E0D\u5230\u56E2\u961F\uFF1A${parts[1] ?? "(\u7A7A)"}` };
        }
        return {
          kind: "success",
          text: `\u56E2\u961F\u300C${team.name}\u300D\uFF08id: ${team.id}\uFF0C${team.members.length} \u4F4D\u4E13\u5BB6\uFF09
\u8BF7\u5728\u300C\u{1F465} \u4E13\u5BB6\u56E2\u300D\u9762\u677F\u91CC\u9009\u4E2D\u5B83\u5E76\u586B\u5199\u4EFB\u52A1\uFF0C\u9762\u677F\u4F1A\u76F4\u63A5\u4E3A\u6BCF\u4F4D\u4E13\u5BB6\u5F00\u4E00\u4E2A\u72EC\u7ACB\u5B50\u4F1A\u8BDD\uFF1B\uFF08\u5165\u53E3\u5728\u7A7A\u4F1A\u8BDD\u7684\u300C\u6807\u51C6\u6A21\u5F0F\u300D\u53F3\u4FA7\uFF0C\u53D1\u8FC7\u6D88\u606F\u540E\u5728\u8F93\u5165\u6846\u5DE5\u5177\u884C\u5DE6\u4FA7\uFF09\u4E5F\u53EF\u4EE5\u8BA9\u6A21\u578B\u8C03\u7528 expert_team_summon \u5DE5\u5177\u5B8C\u6210\u6D3E\u9063\u3002`
        };
      }
      return { kind: "error", text: "\u7528\u6CD5\uFF1A/expert-team list | show <\u56E2\u961Fid> | summon <\u56E2\u961Fid>" };
    }
  });
}
function registerTools(ctx, repo, ledger) {
  const agents = ctx.agents;
  const tools = ctx.tools;
  const asText = (value) => [{ type: "text", text: JSON.stringify(value) }];
  const installed = /* @__PURE__ */ new Map();
  const outputOf = (properties) => ({
    schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    render: (_args, value) => asText(value)
  });
  const BASE_MEMBER_PROPS = { id: { type: "string" }, name: { type: "string" }, alias: { type: "string" } };
  const itemSchema = (extra) => ({
    type: "object",
    properties: { ...BASE_MEMBER_PROPS, ...extra },
    required: [...Object.keys(BASE_MEMBER_PROPS), ...Object.keys(extra)],
    additionalProperties: false
  });
  const ROSTER_MEMBER_SCHEMA = itemSchema({
    role: { type: "string" },
    focus: { type: "string" },
    stages: { type: "array", items: { type: "number" } }
  });
  const DISPATCHED_SCHEMA = itemSchema({
    childSessionId: { type: "string" },
    dispatchedAt: { type: "string" },
    stage: { type: "number" }
  });
  const SKIPPED_SCHEMA = itemSchema({ reason: { type: "string" } });
  const STAGE_PLAN_SCHEMA = {
    type: "object",
    properties: {
      stage: { type: "number" },
      stageCount: { type: "number" },
      name: { type: "string" },
      members: { type: "array", items: { type: "string" } }
    },
    required: ["stage", "stageCount", "name", "members"],
    additionalProperties: false
  };
  const install = (agent) => {
    const scoped = agent.ctx;
    const disposers = [];
    try {
      disposers.push(scoped.tools.register({
        name: "expert_team_list",
        description: "\u5217\u51FA\u672C\u673A\u53EF\u7528\u7684\u4E13\u5BB6\u56E2\uFF1A\u56E2\u961F id\u3001\u540D\u79F0\u3001\u6210\u5458\u540D\u518C\u4E0E\u5404\u81EA\u804C\u8D23\u8303\u56F4\u3002\u53EC\u5524\u4E13\u5BB6\u56E2\u524D\u5FC5\u987B\u5148\u8C03\u7528\u5B83\u786E\u8BA4 team_id \u4E0E member_ids\u3002",
        parameters: { type: "object", properties: {} },
        output: outputOf({
          teams: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                tagline: { type: "string" },
                staged: { type: "boolean" },
                stageCount: { type: "number" },
                plan: { type: "array", items: STAGE_PLAN_SCHEMA },
                members: { type: "array", items: ROSTER_MEMBER_SCHEMA }
              },
              required: ["id", "name", "tagline", "staged", "stageCount", "plan", "members"],
              additionalProperties: false
            }
          }
        }),
        execute() {
          return Promise.resolve({
            teams: repo.all().map((team) => {
              const plan = stagePlan(team);
              return {
                id: team.id,
                name: team.name,
                tagline: team.tagline ?? "",
                staged: plan.staged,
                stageCount: plan.stageCount,
                plan: plan.stages.map((item) => ({
                  stage: item.stage,
                  stageCount: plan.stageCount,
                  name: item.name,
                  members: item.members.map((member) => member.name)
                })),
                members: (team.members ?? []).map((member) => ({
                  id: member.id,
                  name: member.name,
                  alias: member.alias ?? "",
                  role: member.role === "lead" ? "lead" : "member",
                  focus: member.focus ?? "",
                  /* 无阶段团队一律报空数组：别让模型以为它有流水线。 */
                  stages: stagesOf(member.id, plan)
                }))
              };
            })
          });
        }
      }));
      disposers.push(scoped.tools.register({
        name: "expert_team_summon",
        description: "\u53EC\u96C6\u4E00\u652F\u4E13\u5BB6\u56E2\uFF1A\u4E3A\u6BCF\u4F4D\u4E13\u5BB6\u5F00\u4E00\u4E2A\u72EC\u7ACB\u7684 DSH \u5B50\u4F1A\u8BDD\uFF08continuable subagent\uFF09\uFF0C\u5404\u81EA\u5E26\u7740\u672C\u89D2\u8272\u7684\u4EBA\u683C\u5F00\u5DE5\u3002\u4F20 stage \u65F6\u662F\u300C\u5206\u6279\u6D3E\u9063\u300D\u2014\u2014\u53EA\u6D3E\u8BE5\u9636\u6BB5\u7684\u6210\u5458\uFF0C\u5E76\u7528 context \u628A\u4E0A\u4E00\u9636\u6BB5\u7684\u4EA7\u51FA\u4F5C\u4E3A\u672C\u9636\u6BB5\u7684\u8F93\u5165\u4E0B\u53D1\uFF1B\u4E0D\u4F20 stage \u65F6\u6574\u56E2\u4E00\u6B21\u6027\u5E76\u884C\u6D3E\u51FA\u3001\u6240\u6709\u4EBA\u6536\u5230\u540C\u4E00\u4EFD\u4EFB\u52A1\u3002\u8C03\u7528\u4E4B\u540E\u4F60\uFF08\u53EC\u96C6\u4EBA\uFF09\u5FC5\u987B\u7B49\u8FD9\u4E9B\u4E13\u5BB6\u8FD4\u56DE\u518D\u63A8\u8FDB\uFF08\u4E0B\u4E00\u9636\u6BB5\u6216\u6C47\u603B\uFF09\uFF0C\u4E0D\u8981\u81EA\u5DF1\u4EE3\u52B3\u4ED6\u4EEC\u7684\u4E13\u4E1A\u4EA7\u51FA\u3002",
        parameters: {
          type: "object",
          properties: {
            team_id: { type: "string", description: "expert_team_list \u8FD4\u56DE\u7684\u56E2\u961F id\u3002" },
            task: { type: "string", description: "\u5B8C\u6574\u81EA\u5305\u542B\u7684\u4EFB\u52A1\u63CF\u8FF0\uFF1B\u540C\u4E00\u6B21\u6D3E\u9063\u7684\u6BCF\u4F4D\u4E13\u5BB6\u90FD\u6536\u5230\u540C\u4E00\u4EFD\u4EFB\u52A1\uFF0C\u4F46\u6309\u5404\u81EA\u89D2\u8272\u5206\u5DE5\u3002" },
            member_ids: {
              type: "array",
              items: { type: "string" },
              description: "\u53EF\u9009\uFF1A\u53EA\u6D3E\u9063\u8FD9\u4E9B\u6210\u5458 id\uFF0C\u7701\u7565\u5219\u6D3E\u9063\u8BE5\u9636\u6BB5\uFF08\u6216\u6574\u56E2\uFF09\u7684\u5168\u90E8\u6210\u5458\u3002"
            },
            stage: {
              type: "number",
              description: "\u53EF\u9009\uFF1A\u53EA\u6D3E\u9063\u8BE5\u9636\u6BB5\u7684\u6210\u5458\uFF08\u4ECE 1 \u5F00\u59CB\uFF09\u3002\u7528\u4E8E\u5206\u6279\u6D3E\u9063\u6709\u9636\u6BB5\u8BA1\u5212\u7684\u56E2\u961F\uFF1B\u7701\u7565\u5219\u4E00\u6B21\u6027\u6D3E\u51FA\u5168\u90E8\u9009\u4E2D\u6210\u5458\uFF08\u65E0\u9636\u6BB5\u56E2\u961F\u7684\u9ED8\u8BA4\u884C\u4E3A\uFF09\u3002"
            },
            context: {
              type: "string",
              description: "\u53EF\u9009\uFF1A\u4E0A\u4E00\u9636\u6BB5\u4E13\u5BB6\u7684\u4EA7\u51FA\u539F\u6587\uFF0C\u4F1A\u4F5C\u4E3A\u300C\u4E0A\u6E38\u4EA7\u51FA\u300D\u968F\u6307\u4EE4\u4E0B\u53D1\u7ED9\u672C\u9636\u6BB5\u6BCF\u4F4D\u4E13\u5BB6\u3002\u5206\u6279\u6D3E\u9063\u65F6\u52A1\u5FC5\u628A\u4E0A\u6E38\u7ED3\u8BBA\u539F\u6837\u4F20\u8FDB\u6765\uFF0C\u4E0D\u8981\u81EA\u5DF1\u538B\u7F29\u6210\u6458\u8981\u3002"
            }
          },
          required: ["team_id", "task"],
          additionalProperties: false
        },
        output: outputOf({
          team: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
            additionalProperties: false
          },
          provider: { type: "string" },
          personaNative: { type: "boolean" },
          stage: { type: "number" },
          stageCount: { type: "number" },
          nextStage: { type: "number" },
          plan: { type: "array", items: STAGE_PLAN_SCHEMA },
          dispatched: { type: "array", items: DISPATCHED_SCHEMA },
          skipped: { type: "array", items: SKIPPED_SCHEMA },
          guardNote: { type: "string" },
          guidance: { type: "string" }
        }),
        async execute(args, exec) {
          const subagents = ctx.get("subagents");
          if (subagents === void 0) throw new Error("DSH \u672A\u63D0\u4F9B subagents \u670D\u52A1\uFF0C\u65E0\u6CD5\u6D3E\u9063\u4E13\u5BB6");
          const team = repo.get(String(args?.team_id ?? ""));
          if (team === void 0) throw new Error(`\u627E\u4E0D\u5230\u4E13\u5BB6\u56E2\uFF1A${String(args?.team_id)}`);
          const task = String(args?.task ?? "");
          const memberIds = Array.isArray(args?.member_ids) ? args.member_ids.map(String) : void 0;
          const stage = Number.isInteger(args?.stage) ? Number(args.stage) : void 0;
          const context = typeof args?.context === "string" ? args.context : void 0;
          const result = await summonTeam(subagents, exec.agent, team, task, memberIds, exec.signal, {
            stage,
            context
          });
          repo.bumpUsage(team.id);
          ledger.record(team.id, task, result);
          const plan = result.plan;
          const planView = plan.stages.map((item) => ({
            stage: item.stage,
            stageCount: plan.stageCount,
            name: item.name,
            members: item.members.map((member) => member.name)
          }));
          const current = result.stage;
          const currentIndex = current === null ? -1 : plan.stages.findIndex((item) => item.stage === current);
          const nextStage = currentIndex >= 0 && currentIndex + 1 < plan.stages.length ? plan.stages[currentIndex + 1].stage : 0;
          const guardNote = result.guard.degraded.length === 0 ? `\u5DF2\u7ED9\u5B50\u4F1A\u8BDD\u8BBE\u4E0A\u9650\uFF1A\u6700\u591A\u518D\u5F80\u4E0B\u6D3E ${result.guard.depthCap} \u5C42\u5B50\u4EE3\u7406${result.guard.nestedSoftOnly ? "\uFF0C\u5E76\u5728\u4E13\u5BB6\u63D0\u793A\u8BCD\u91CC\u8981\u6C42\u5B83\u4EEC\u4E0D\u8981\u81EA\u5DF1\u53EC\u5524\u4E13\u5BB6\u56E2\uFF08\u8F6F\u7EA6\u675F\uFF0C\u975E\u786C\u6027\u7981\u7528\uFF09" : ""}\u3002` : `\u672C\u673A subagent provider \u4E0D\u652F\u6301 ${result.guard.degraded.join(" / ")}\uFF0C\u5B50\u4F1A\u8BDD\u62A4\u680F\u672A\u751F\u6548\uFF08\u4E13\u5BB6\u7406\u8BBA\u4E0A\u53EF\u518D\u6D3E\u5B50\u4EE3\u7406\uFF09\u3002`;
          let guidance;
          if (current === null) {
            guidance = plan.staged ? `\u5DF2\u4E00\u6B21\u6027\u5E76\u884C\u6D3E\u51FA\u5168\u90E8\u4E13\u5BB6\u3002\u6CE8\u610F\uFF1A\u672C\u56E2\u5E26 ${plan.stageCount} \u9636\u6BB5\u8BA1\u5212\uFF0C\u4E00\u6B21\u6027\u6D3E\u51FA\u65F6\u6240\u6709\u4EBA\u62FF\u5230\u7684\u662F\u540C\u4E00\u4EFD\u4EFB\u52A1\u3001\u62FF\u4E0D\u5230\u5F7C\u6B64\u4EA7\u51FA\uFF1B\u60F3\u8DD1\u771F\u6D41\u6C34\u7EBF\uFF0C\u8BF7\u6539\u6210\u5206\u6279\u6D3E\u9063\uFF08\u5148\u6D3E stage 1\uFF0C\u6536\u9F50\u540E\u7528 context \u6D3E stage 2\uFF09\u3002` : "\u4E13\u5BB6\u4EEC\u5DF2\u5728\u72EC\u7ACB\u5B50\u4F1A\u8BDD\u4E2D\u5E76\u884C\u5F00\u5DE5\u3002\u8BF7\u7B49\u5F85\u4ED6\u4EEC\u8FD4\u56DE\u7ED3\u8BBA\u540E\u518D\u6C47\u603B\uFF0C\u5E76\u660E\u786E\u6807\u6CE8\u54EA\u90E8\u5206\u7531\u54EA\u4F4D\u4E13\u5BB6\u8D21\u732E\u3001\u51B2\u7A81\u7ED3\u8BBA\u5982\u4F55\u88C1\u51B3\u3002\u4E0D\u8981\u91CD\u590D\u4E13\u5BB6\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002";
          } else if (nextStage !== 0) {
            guidance = `\u7B2C ${current}/${plan.stageCount} \u9636\u6BB5\u7684\u4E13\u5BB6\u5DF2\u5F00\u5DE5\u3002\u7B49\u8FD9 ${result.dispatched.length} \u4F4D\u5168\u90E8\u628A\u7ED3\u679C\u53D1\u56DE\u6765\u4E4B\u540E\uFF0C\u628A\u4ED6\u4EEC\u7684\u4EA7\u51FA\u539F\u6587\u5408\u5E76\u540E\u4F5C\u4E3A context\uFF0C\u518D\u8C03\u7528\u4E00\u6B21 expert_team_summon\uFF08stage=${nextStage}, task=\u540C\u4E00\u4E2A\u4EFB\u52A1, context=\u4E0A\u6E38\u4EA7\u51FA\uFF09\u6D3E\u7B2C ${nextStage} \u9636\u6BB5\u3002\u4E0D\u8981\u5728\u4E0A\u4E00\u9636\u6BB5\u6CA1\u6536\u9F50\u524D\u5C31\u5F80\u4E0B\u6D3E\u3002`;
          } else {
            guidance = `\u7B2C ${current}/${plan.stageCount} \u9636\u6BB5\uFF08\u6700\u540E\u4E00\u9636\u6BB5\uFF09\u7684\u4E13\u5BB6\u5DF2\u5F00\u5DE5\u3002\u7B49\u4ED6\u4EEC\u5168\u90E8\u8FD4\u56DE\u540E\uFF0C\u628A\u6240\u6709\u9636\u6BB5\u7684\u4EA7\u51FA\u6C47\u603B\u6210\u4E00\u4EFD\u7ED3\u6784\u5B8C\u6574\u3001\u89C2\u70B9\u4E00\u81F4\u7684\u7EC8\u7A3F\uFF0C\u6807\u6CE8\u5404\u90E8\u5206\u8D21\u732E\u8005\u5E76\u88C1\u51B3\u51B2\u7A81\u7ED3\u8BBA\u3002`;
          }
          if (result.overflow.length > 0) {
            guidance += ` \u672C\u6B21\u8D85\u51FA\u5355\u6B21\u6D3E\u9063\u4E0A\u9650\uFF0C\u4EE5\u4E0B\u6210\u5458\u672A\u6D3E\u51FA\uFF0C\u8BF7\u518D\u6D3E\u4E00\u6B21\uFF1A${result.overflow.join("\u3001")}\u3002`;
          }
          return {
            team: { id: team.id, name: team.name },
            provider: result.provider,
            personaNative: result.personaNative,
            /* 无阶段派遣报 0，避免让模型以为它是「第 0 阶段」。 */
            stage: current ?? 0,
            stageCount: plan.stageCount,
            nextStage,
            plan: planView,
            dispatched: result.dispatched.map((item) => ({
              id: item.memberId,
              name: item.name,
              alias: item.alias ?? "",
              childSessionId: item.childSessionId,
              dispatchedAt: item.dispatchedAt,
              stage: current === null ? 0 : item.stage
            })),
            skipped: result.skipped.map((item) => ({
              id: item.memberId,
              name: item.name,
              alias: team.members.find((member) => member.id === item.memberId)?.alias ?? "",
              reason: item.reason
            })),
            guardNote,
            guidance
          };
        }
      }));
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      ctx.logger?.warn?.(`expert-team: \u5B89\u88C5\u4E13\u5BB6\u56E2\u5DE5\u5177\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
      return void 0;
    }
  };
  for (const agent of agents.list()) {
    const dispose = install(agent);
    if (dispose !== void 0) installed.set(agent, dispose);
  }
  ctx.on("agent/created", ({ agent }) => {
    const dispose = install(agent);
    if (dispose !== void 0) installed.set(agent, dispose);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    installed.get(agent)?.();
    installed.delete(agent);
  });
  return () => {
    for (const dispose of installed.values()) dispose();
    installed.clear();
  };
}
function apply(ctx) {
  ensureConfigFile();
  const repo = new TeamRepository();
  const ledger = new DispatchLedger();
  ctx.effect(() => mountHttp(ctx, repo, ledger), "expert-team:http()");
  ctx.inject(["commands"], (scoped) => {
    const dispose = registerCommands(scoped.commands, repo);
    scoped.effect(() => () => {
      if (typeof dispose === "function") dispose();
    }, "expert-team:commands()");
  });
  ctx.inject(["agents", "tools"], (scoped) => {
    const disposeTools = registerTools(scoped, repo, ledger);
    if (disposeTools !== void 0) {
      scoped.effect(() => disposeTools, "expert-team:tools()");
    }
  });
  const { lockBuiltinTeams } = readConfig();
  ctx.logger?.info?.(`expert-team: \u5DF2\u52A0\u8F7D ${repo.all().length} \u652F\u4E13\u5BB6\u56E2\uFF08\u5185\u7F6E\u56E2\u961F\uFF1A${lockBuiltinTeams ? "\u53EA\u8BFB\u9501\u5B9A" : "\u5F00\u53D1\u9636\u6BB5\u53EF\u7F16\u8F91"}\uFF1B\u914D\u7F6E ${CONFIG_FILE}\uFF09`);
}
export {
  apply,
  inject,
  name
};
