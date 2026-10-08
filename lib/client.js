window.__ModuleLoader__.load({ id: "expert-team", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");

// src/client/team-icons.js
var AVATAR_COUNT = 36;
function hashSeed(text) {
  let value = 2166136261;
  const source = String(text ?? "");
  for (let index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
function avatarIndexOf(seed, explicit) {
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit >= 0) {
    return explicit % AVATAR_COUNT;
  }
  return hashSeed(seed) % AVATAR_COUNT;
}
function avatarFile(index) {
  const safe = ((Number(index) || 0) % AVATAR_COUNT + AVATAR_COUNT) % AVATAR_COUNT;
  return `${String(safe + 1).padStart(2, "0")}.jpg`;
}
function nextAvatar(current) {
  const value = typeof current === "number" && Number.isInteger(current) ? current : -1;
  return (value + 1 + AVATAR_COUNT) % AVATAR_COUNT;
}
function suggestAvatar(seedText) {
  return hashSeed(seedText) % AVATAR_COUNT;
}
function teamAvatarIndex(team) {
  return avatarIndexOf(team?.id, team?.avatar);
}

// src/client/index.jsx
var inject = ["slots"];
var PLUGIN_ID = "expert-team";
var API = "/expert-team/api";
var store = {
  open: false,
  view: "gallery",
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
  sessionId: void 0,
  sort: "default",
  category: "\u5168\u90E8",
  /**
   * 每个会话已「召唤」的专家团：`{ [sessionId]: { teamId, memberIds } }`。
   *
   * 按会话分桶而不是存一个全局单值：注册点虽然是 session 作用域，
   * 但这个 store 是模块级的，同时开着多个会话时不能互相串。
   */
  activeBySession: {},
  /** 点开的使用案例弹窗：`{ teamId, index }`；null = 未打开。 */
  caseView: null,
  version: 0
};
var listeners = /* @__PURE__ */ new Set();
function patch(next) {
  Object.assign(store, next);
  store.version += 1;
  for (const listener of listeners) listener();
}
function useStore() {
  const [, force] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const listener = () => force((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return store;
}
async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`\u63A5\u53E3\u8FD4\u56DE\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09`);
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
}
function sessionIdOf(props) {
  const candidates = [
    props?.sessionId,
    props?.session?.sessionId,
    props?.session?.id
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value !== "") return value;
  }
  return void 0;
}
var ROLE_LABEL = { lead: "\u4E3B\u7406\u4EBA", member: "\u6210\u5458" };
function summonBriefing(team, task, dispatched, stage) {
  const roster = dispatched.map((item) => `- ${item.name}${item.alias ? `\uFF08${item.alias}\uFF09` : ""} \xB7 \u5B50\u4F1A\u8BDD ${item.childSessionId}`).join("\n");
  const plan = Array.isArray(team.stages) ? team.stages : [];
  const staged = plan.length > 1;
  const nameOf = (id) => team.members.find((member) => member.id === id)?.name ?? id;
  const lines = [
    `\u3010\u4E13\u5BB6\u56E2\u5DF2\u5C31\u4F4D\u3011${team.name}`,
    "",
    `\u5DF2\u4E3A\u4EE5\u4E0B ${dispatched.length} \u4F4D\u4E13\u5BB6\u5404\u81EA\u5F00\u4E86\u4E00\u4E2A\u72EC\u7ACB\u5B50\u4F1A\u8BDD\uFF0C\u4ED6\u4EEC\u4F1A\u5E26\u7740\u5404\u81EA\u89D2\u8272\u8BBE\u5B9A\u5F00\u5DE5\uFF1A`,
    roster,
    "",
    `\u672C\u6B21\u4EFB\u52A1\uFF1A${task}`,
    ""
  ];
  if (staged) {
    lines.push(`\u8FD9\u662F\u4E00\u6761\u5206\u9636\u6BB5\u6D41\u6C34\u7EBF\uFF08\u5171 ${plan.length} \u4E2A\u9636\u6BB5\uFF09\uFF1A`);
    for (const item of plan) {
      const label = item.name !== void 0 && item.name !== "" ? `\uFF08${item.name}\uFF09` : "";
      lines.push(`- \u7B2C ${item.stage} \u9636\u6BB5${label}\uFF1A${item.members.map(nameOf).join("\u3001")}`);
    }
    lines.push("");
  }
  const currentStage = Number.isInteger(stage) ? stage : null;
  const nextStage = currentStage !== null && plan.some((item) => item.stage === currentStage + 1) ? currentStage + 1 : null;
  if (nextStage !== null) {
    lines.push(
      `\u672C\u6B21\u53EA\u6D3E\u4E86\u7B2C ${currentStage} \u9636\u6BB5\u3002\u8BF7\u4F60\u4F5C\u4E3A\u53EC\u96C6\u4EBA\uFF1A`,
      `1. \u7B49\u8FD9 ${dispatched.length} \u4F4D\u4E13\u5BB6\u5168\u90E8\u628A\u7ED3\u679C\u53D1\u56DE\u6765\uFF08\u4ED6\u4EEC\u4F1A\u4E3B\u52A8 send_message \u7ED9\u4F60\uFF09\uFF1B`,
      `2. \u628A\u4ED6\u4EEC\u7684\u4EA7\u51FA\u539F\u6587\u5408\u5E76\u6210 context\uFF0C\u8C03\u7528 expert_team_summon \u6D3E\u4E0B\u4E00\u9636\u6BB5\uFF1A`,
      `   { team_id: "${team.id}", stage: ${nextStage}, task: \u4E0E\u672C\u6B21\u76F8\u540C, context: \u4E0A\u4E00\u9636\u6BB5\u7684\u4EA7\u51FA\u539F\u6587 }\uFF1B`,
      "3. \u4E0D\u8981\u66FF\u4E13\u5BB6\u4EE3\u5199\u4EFB\u4F55\u4EA7\u51FA\uFF0C\u4E5F\u4E0D\u8981\u5728\u4E0A\u4E00\u9636\u6BB5\u6CA1\u6536\u9F50\u524D\u5F80\u4E0B\u6D3E\u3002"
    );
  } else {
    lines.push(
      "\u8BF7\u4F60\u4F5C\u4E3A\u672C\u6B21\u4EFB\u52A1\u7684\u53EC\u96C6\u4EBA\uFF1A",
      "1. \u4E0D\u8981\u91CD\u590D\u4E13\u5BB6\u4EEC\u5DF2\u7ECF\u8D1F\u8D23\u7684\u5185\u5BB9\uFF1B",
      "2. \u7B49\u6240\u6709\u4E13\u5BB6\u8FD4\u56DE\u7ED3\u8BBA\u540E\u518D\u7EDF\u4E00\u6C47\u603B\uFF0C\u4E0D\u8981\u63D0\u524D\u6536\u5C3E\uFF1B",
      "3. \u6C47\u603B\u65F6\u6807\u6CE8\u54EA\u90E8\u5206\u7531\u54EA\u4F4D\u4E13\u5BB6\u8D21\u732E\uFF1B\u82E5\u4E13\u5BB6\u7ED3\u8BBA\u51B2\u7A81\uFF0C\u7ED9\u51FA\u4F60\u7684\u88C1\u51B3\u4E0E\u7406\u7531\uFF1B",
      "4. \u6700\u7EC8\u4EA4\u4ED8\u4E00\u4EFD\u7ED3\u6784\u5B8C\u6574\u3001\u89C2\u70B9\u4E00\u81F4\u7684\u6210\u679C\u3002"
    );
  }
  return lines.join("\n");
}
function fallbackBriefing(team, task, memberIds, reason, stage) {
  const roster = team.members.map((member) => `- ${member.id}\uFF5C${member.name}${member.alias ? `\uFF08${member.alias}\uFF09` : ""}\uFF5C${ROLE_LABEL[member.role] ?? member.role}\uFF5C${member.focus || "\u2014"}`).join("\n");
  const selected = Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length < team.members.length ? `

\u672C\u6B21\u53EA\u6D3E\u9063\u8FD9\u4E9B\u6210\u5458\uFF1A${memberIds.join(", ")}` : "";
  const whyText = typeof reason === "string" ? reason.replace(/\s+/gu, " ").trim() : "";
  const why = whyText === "" ? "" : `\uFF08\u9762\u677F\u76F4\u8FDE\u6D3E\u9063\u672A\u6210\u529F\uFF1A${whyText.length > 120 ? `${whyText.slice(0, 120)}\u2026\uFF08\u539F\u56E0\u8FC7\u957F\u5DF2\u622A\u65AD\uFF0C\u5B8C\u6574\u62A5\u9519\u89C1 DSH \u65E5\u5FD7\uFF09` : whyText}\uFF09`;
  const plan = Array.isArray(team.stages) ? team.stages : [];
  const stageHint = plan.length > 1 ? [
    "",
    `\u672C\u56E2\u662F\u4E00\u6761\u5206\u9636\u6BB5\u6D41\u6C34\u7EBF\uFF08\u5171 ${plan.length} \u4E2A\u9636\u6BB5\uFF09\uFF1A`,
    ...plan.map((item) => `- \u7B2C ${item.stage} \u9636\u6BB5${item.name !== void 0 && item.name !== "" ? `\uFF08${item.name}\uFF09` : ""}\uFF1A${item.members.join(", ")}`),
    Number.isInteger(stage) ? `\u8BF7\u5148\u53EA\u6D3E\u7B2C ${stage} \u9636\u6BB5\uFF08expert_team_summon \u4F20 stage: ${stage}\uFF09\uFF1B\u6536\u9F50\u8FD9\u51E0\u4F4D\u4E13\u5BB6\u7684\u56DE\u4F20\u540E\uFF0C\u628A\u4EA7\u51FA\u539F\u6587\u4F5C\u4E3A context\u3001\u5E26\u4E0A\u4E0B\u4E00\u4E2A stage \u518D\u8C03\u4E00\u6B21 expert_team_summon\uFF0C\u76F4\u5230\u6700\u540E\u4E00\u4E2A\u9636\u6BB5\u3002` : "\u8BF7\u5206\u6279\u63A8\u8FDB\uFF1A\u5148\u6D3E\u7B2C 1 \u9636\u6BB5\uFF0C\u6536\u9F50\u4EA7\u51FA\u540E\u628A\u4EA7\u51FA\u539F\u6587\u4F5C\u4E3A context \u6D3E\u7B2C 2 \u9636\u6BB5\uFF0C\u4F9D\u6B64\u7C7B\u63A8\u3002"
  ] : [];
  return [
    `\u3010\u53EC\u5524\u4E13\u5BB6\u56E2\u3011\u8BF7\u8C03\u7528 expert_team_summon \u5DE5\u5177\u7EC4\u5EFA\u300C${team.name}\u300D\u5E76\u5B8C\u6210\u4E0B\u9762\u7684\u4EFB\u52A1\u3002${why}`,
    "",
    `team_id\uFF1A${team.id}`,
    Number.isInteger(stage) ? `stage\uFF1A${stage}` : "",
    `\u4EFB\u52A1\uFF1A${task}${selected}`,
    ...stageHint,
    "",
    "\u56E2\u961F\u6210\u5458\uFF08\u4F9B\u4F60\u4E86\u89E3\u5206\u5DE5\uFF0C\u4E0D\u5FC5\u9010\u4E2A\u8F6C\u8FF0\uFF09\uFF1A",
    roster,
    "",
    "\u8C03\u7528\u540E\u8BF7\u7B49\u5F85\u6240\u6709\u4E13\u5BB6\u8FD4\u56DE\uFF0C\u518D\u6C47\u603B\u6210\u4E00\u4EFD\u7ED3\u6784\u5B8C\u6574\u3001\u89C2\u70B9\u4E00\u81F4\u7684\u4EA4\u4ED8\u7269\uFF0C\u5E76\u6807\u6CE8\u5404\u90E8\u5206\u7684\u8D21\u732E\u8005\u3002"
  ].filter((line) => line !== "").join("\n");
}
var S = {
  page: "var(--dsw-alias-bg-base, #f7f7f8)",
  surface: "var(--dsw-alias-bg-layer-1, #ffffff)",
  text: "var(--dsw-alias-label-primary, #1f2328)",
  strong: "var(--dsw-alias-label-primary, #111827)",
  muted: "var(--dsw-alias-label-tertiary, #8a8f98)",
  body: "var(--dsw-alias-label-secondary, #6b7280)",
  line: "var(--dsw-alias-border-l2, #ececee)",
  soft: "var(--dsw-alias-interactive-bg-hover, #f5f5f6)",
  radius: 12
};
function activeOf(state, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const entry = state.activeBySession?.[sessionId];
  if (entry === void 0 || entry === null) return null;
  const team = state.teams.find((item) => item.id === entry.teamId);
  if (team === void 0) return null;
  const valid = entry.memberIds.filter((id) => team.members.some((member) => member.id === id));
  return {
    team,
    memberIds: valid.length > 0 ? valid : team.members.map((member) => member.id),
    /** 分批派遣的当前阶段；null = 一次性派遣（默认）。 */
    stage: Number.isInteger(entry.stage) ? entry.stage : null
  };
}
function focusComposer() {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
  const grab = () => {
    const editor = document.querySelector("[data-input-scroll] [contenteditable]");
    if (editor !== null && editor !== void 0 && typeof editor.focus === "function") editor.focus();
  };
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    grab();
    return;
  }
  window.requestAnimationFrame(() => {
    grab();
    window.requestAnimationFrame(grab);
  });
}
function activateTeam(team, draftText, memberIds, stage) {
  const sessionId = store.sessionId;
  if (typeof sessionId === "string" && sessionId !== "") {
    const ids = Array.isArray(memberIds) && memberIds.length > 0 ? memberIds.filter((id) => team.members.some((member) => member.id === id)) : team.members.map((member) => member.id);
    const entry = {
      teamId: team.id,
      memberIds: ids.length > 0 ? ids : team.members.map((member) => member.id),
      ...Number.isInteger(stage) ? { stage } : {}
    };
    patch({ activeBySession: { ...store.activeBySession, [sessionId]: entry } });
  }
  const actions = store.input;
  if (actions !== void 0 && actions !== null && typeof draftText === "string" && draftText !== "") {
    actions.setDraft(draftText);
  }
  patch({ open: false, error: null });
  focusComposer();
}
function deactivateTeam(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  if (store.activeBySession?.[sessionId] === void 0) return;
  const next = { ...store.activeBySession };
  delete next[sessionId];
  patch({ activeBySession: next });
}
function setActiveMembers(sessionId, memberIds) {
  const entry = store.activeBySession?.[sessionId];
  if (entry === void 0 || memberIds.length === 0) return;
  patch({ activeBySession: { ...store.activeBySession, [sessionId]: { teamId: entry.teamId, memberIds } } });
}
function setActiveStage(sessionId, team, stage) {
  const entry = store.activeBySession?.[sessionId];
  if (entry === void 0) return;
  if (stage === null) {
    patch({
      activeBySession: {
        ...store.activeBySession,
        [sessionId]: { teamId: entry.teamId, memberIds: entry.memberIds }
      }
    });
    return;
  }
  const bucket = (Array.isArray(team.stages) ? team.stages : []).find((item) => item.stage === stage);
  if (bucket === void 0 || bucket.members.length === 0) return;
  patch({
    activeBySession: {
      ...store.activeBySession,
      [sessionId]: { teamId: entry.teamId, memberIds: [...bucket.members], stage }
    }
  });
}
function sameStylePrompt(team, item) {
  if (typeof item.prompt === "string" && item.prompt !== "") return item.prompt;
  return [
    `\u7528\u300C${team.name}\u300D\u505A\u540C\u6B3E\uFF1A${item.title}`,
    item.desc !== void 0 && item.desc !== "" ? `\u76EE\u6807\uFF1A${item.desc}` : "",
    "\u8BF7\u6309\u8BE5\u56E2\u961F\u7684\u5206\u5DE5\u65B9\u5F0F\u534F\u4F5C\u5B8C\u6210\uFF0C\u4E00\u6B21\u4EA4\u4ED8\u53EF\u76F4\u63A5\u4F7F\u7528\u7684\u5B8C\u6574\u6210\u679C\uFF1A\u542B\u5173\u952E\u4EA7\u7269\u6E05\u5355\u3001\u660E\u786E\u7ED3\u8BBA\u4E0E\u9A8C\u6536\u8981\u70B9\u3002"
  ].filter((part) => part !== "").join("\n");
}
function renderDelivery(text) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];
  let index = 0;
  let key = 0;
  const heading = { fontSize: 13.5, fontWeight: 700, color: S.text, marginTop: 6 };
  const body = { fontSize: 13.5, lineHeight: 1.75, color: S.body, margin: 0 };
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(/* @__PURE__ */ import_react.default.createElement("div", { key: key++, style: heading }, line.slice(4)));
      index += 1;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        const cells = lines[index].trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim());
        if (!cells.every((cell) => /^-+$/u.test(cell) || cell === "")) rows.push(cells);
        index += 1;
      }
      if (rows.length > 0) {
        blocks.push(
          /* @__PURE__ */ import_react.default.createElement("div", { key: key++, style: { border: `1px solid ${S.line}`, borderRadius: 8, overflow: "hidden" } }, rows.map((cells, rowIndex) => /* @__PURE__ */ import_react.default.createElement(
            "div",
            {
              key: rowIndex,
              style: {
                display: "flex",
                background: rowIndex === 0 ? S.soft : S.surface,
                borderTop: rowIndex === 0 ? "none" : `1px solid ${S.line}`
              }
            },
            cells.map((cell, cellIndex) => /* @__PURE__ */ import_react.default.createElement(
              "div",
              {
                key: cellIndex,
                style: {
                  flex: 1,
                  minWidth: 0,
                  padding: "7px 10px",
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: rowIndex === 0 ? S.text : S.body,
                  fontWeight: rowIndex === 0 ? 600 : 400
                }
              },
              cell
            ))
          )))
        );
      }
      continue;
    }
    if (line.startsWith("- ")) {
      const items = [];
      while (index < lines.length && lines[index].startsWith("- ")) {
        items.push(lines[index].slice(2));
        index += 1;
      }
      blocks.push(
        /* @__PURE__ */ import_react.default.createElement("div", { key: key++, style: { display: "flex", flexDirection: "column", gap: 5 } }, items.map((entry, entryIndex) => /* @__PURE__ */ import_react.default.createElement("div", { key: entryIndex, style: { display: "flex", gap: 8, fontSize: 13.5, lineHeight: 1.7, color: S.body } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { color: S.muted, flex: "none" } }, "\xB7"), /* @__PURE__ */ import_react.default.createElement("span", null, entry))))
      );
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== "" && !lines[index].startsWith("### ") && !lines[index].startsWith("- ") && !lines[index].trim().startsWith("|")) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(/* @__PURE__ */ import_react.default.createElement("p", { key: key++, style: body }, paragraph.join(" ")));
  }
  if (blocks.length === 0) {
    blocks.push(/* @__PURE__ */ import_react.default.createElement("p", { key: "empty", style: body }, "\u8FD9\u4E2A\u6848\u4F8B\u8FD8\u6CA1\u6709\u8865\u5145\u4EA4\u4ED8\u7ED3\u679C\u3002"));
  }
  return blocks;
}
function CaseDialog({ team, item, onClose, onSameStyle }) {
  const accent = team.accent || "#4F46E5";
  return portalToBody(
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        style: {
          position: "fixed",
          inset: 0,
          // 必须高于画廊模态（9999）：案例弹窗是从详情页里再叠一层打开的。
          zIndex: 1e4,
          background: "var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.5))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24
        }
      },
      /* @__PURE__ */ import_react.default.createElement(
        "div",
        {
          role: "dialog",
          "aria-label": item.title,
          style: {
            width: "min(880px, 100%)",
            maxHeight: "min(86vh, 860px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: S.surface,
            color: S.text,
            borderRadius: 16,
            border: `1px solid ${S.line}`,
            boxShadow: "var(--dsw-shadow-lv3, 0 24px 60px rgba(15, 23, 42, 0.28))",
            fontFamily: FONT
          }
        },
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, padding: "20px 24px 14px", borderBottom: `1px solid ${S.line}` } }, /* @__PURE__ */ import_react.default.createElement(
          "span",
          {
            style: {
              width: 34,
              height: 34,
              flex: "none",
              borderRadius: 10,
              background: `${accent}14`,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17
            }
          },
          item.emoji || "\u{1F4C4}"
        ), /* @__PURE__ */ import_react.default.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 19, fontWeight: 700, color: S.text, lineHeight: 1.35 } }, item.title), item.desc !== void 0 && item.desc !== "" && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 13.5, color: S.body, marginTop: 6, lineHeight: 1.6 } }, item.desc)), /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            "aria-label": "\u5173\u95ED",
            onClick: onClose,
            style: btn({ padding: "5px 10px", fontSize: 13 })
          },
          "\u2715"
        )),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { flex: 1, overflowY: "auto", padding: "18px 24px", background: S.page } }, /* @__PURE__ */ import_react.default.createElement(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: S.surface,
              border: `1px solid ${S.line}`,
              borderRadius: 12,
              padding: "18px 20px"
            }
          },
          renderDelivery(item.delivery)
        )),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 24px", borderTop: `1px solid ${S.line}` } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn(), onClick: onClose }, "\u5173\u95ED"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: primaryBtn(), onClick: onSameStyle }, /* @__PURE__ */ import_react.default.createElement(IconSend, { size: 16 }), "\u505A\u540C\u6B3E"))
      )
    )
  );
}
var FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
var btn = (extra) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: `1px solid ${S.line}`,
  background: S.surface,
  color: S.text,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 13,
  lineHeight: 1.4,
  cursor: "pointer",
  fontFamily: "inherit",
  ...extra
});
var primaryBtn = (extra) => btn({
  /* 主按钮必须是「填充 + 反色字」，不能拿正文色当底色：暗色主题下会变成白底白字。 */
  background: "var(--dsw-alias-button-primary-fill, #111827)",
  color: "var(--dsw-static-neutral-00, #ffffff)",
  border: "1px solid var(--dsw-alias-button-primary-fill, #111827)",
  fontWeight: 600,
  ...extra
});
var stageChip = (selected, accent) => btn({
  padding: "2px 8px",
  fontSize: 12,
  borderRadius: 999,
  border: `1px solid ${selected ? `${accent}59` : S.line}`,
  background: selected ? `${accent}1f` : S.surface,
  color: selected ? S.text : S.body,
  fontWeight: selected ? 600 : 400,
  whiteSpace: "nowrap"
});
function IconChat({ size = 20 }) {
  return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, /* @__PURE__ */ import_react.default.createElement(
    "path",
    {
      d: "M4 5.6A1.6 1.6 0 0 1 5.6 4h12.8A1.6 1.6 0 0 1 20 5.6v8.8a1.6 1.6 0 0 1-1.6 1.6H12l-4.6 3.4a.4.4 0 0 1-.64-.32V16H5.6A1.6 1.6 0 0 1 4 14.4V5.6Z",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinejoin: "round"
    }
  ), /* @__PURE__ */ import_react.default.createElement("path", { d: "M9.2 9.6c.5-.9 1.2-1.4 2.1-1.4 1 0 1.7.6 1.7 1.5 0 .7-.4 1.1-1 1.6-.5.4-.7.7-.7 1.2", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }), /* @__PURE__ */ import_react.default.createElement("circle", { cx: "11.3", cy: "14.2", r: "0.9", fill: "currentColor" }));
}
function IconGrid({ size = 18 }) {
  return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, [[4, 4], [13.5, 4], [4, 13.5], [13.5, 13.5]].map(([x, y]) => /* @__PURE__ */ import_react.default.createElement("rect", { key: `${x}-${y}`, x, y, width: "6.5", height: "6.5", rx: "1.8", stroke: "currentColor", strokeWidth: "1.7" })));
}
function IconUsers({ size = 18 }) {
  return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, /* @__PURE__ */ import_react.default.createElement("circle", { cx: "9", cy: "8.4", r: "3.1", stroke: "currentColor", strokeWidth: "1.7" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M3.4 19c0-2.9 2.5-4.8 5.6-4.8s5.6 1.9 5.6 4.8", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M16.4 6.2a2.7 2.7 0 0 1 0 5.2M17.6 14.6c1.9.4 3.2 1.8 3.2 3.9", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }));
}
function IconUsersInline({ size = 16 }) {
  return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, /* @__PURE__ */ import_react.default.createElement("circle", { cx: "6.1", cy: "5.7", r: "2.1", stroke: "currentColor", strokeWidth: "1" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.4 12.8c0-1.9 1.65-3.05 3.7-3.05s3.7 1.15 3.7 3.05", stroke: "currentColor", strokeWidth: "1", strokeLinecap: "round" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M10.9 4.3a1.75 1.75 0 0 1 0 3.4M11.8 9.85c1.2.28 2 1.2 2 2.55", stroke: "currentColor", strokeWidth: "1", strokeLinecap: "round" }));
}
function IconSend({ size = 17 }) {
  return /* @__PURE__ */ import_react.default.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true }, /* @__PURE__ */ import_react.default.createElement("path", { d: "M20.4 3.6 3.9 9.8c-.6.2-.6 1 0 1.2l5.4 1.9 1.9 5.4c.2.6 1 .6 1.2 0l6.2-16.5c.2-.5-.3-1-.8-.8Z", stroke: "currentColor", strokeWidth: "1.7", strokeLinejoin: "round" }));
}
var AVATAR_BASE = "/expert-team/avatar/";
function AvatarImage({ index, size = 40, title }) {
  return /* @__PURE__ */ import_react.default.createElement(
    "img",
    {
      src: `${AVATAR_BASE}${avatarFile(index)}`,
      width: size,
      height: size,
      alt: "",
      "aria-hidden": true,
      title,
      loading: "lazy",
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        objectPosition: "center",
        flex: "none",
        display: "block",
        background: "var(--dsw-alias-bg-layer-2, #f1f3f5)"
      }
    }
  );
}
function PersonAvatar({ seed, avatar, size = 40 }) {
  return /* @__PURE__ */ import_react.default.createElement(AvatarImage, { index: avatarIndexOf(seed, avatar), size });
}
function TeamAvatar({ team, size = 40 }) {
  return /* @__PURE__ */ import_react.default.createElement(AvatarImage, { index: teamAvatarIndex(team), size, title: team?.name });
}
var chip = (extra) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flex: "none",
  height: 28,
  padding: "0 10px",
  border: "none",
  borderRadius: 999,
  background: "var(--dsw-specific-selector, rgba(0, 0, 0, 0.04))",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  fontSize: 14,
  lineHeight: 1,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  cursor: "pointer",
  ...extra
});
var rowChip = (extra) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  flex: "none",
  order: 100,
  minHeight: 28,
  maxWidth: "100%",
  padding: "0 8px",
  border: "none",
  borderRadius: 16,
  background: "transparent",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  cursor: "pointer",
  ...extra
});
var HOVER_BG = "var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))";
function findHeroSeatRow() {
  if (typeof document === "undefined") return null;
  const card = document.querySelector("[data-composer-card]");
  if (card === null) return null;
  const rootEl = typeof card.closest === "function" ? card.closest("[data-phase]") : null;
  const phase = rootEl !== null && typeof rootEl.getAttribute === "function" ? rootEl.getAttribute("data-phase") : null;
  if (phase !== null && phase !== "hero") return null;
  const seatEl = typeof card.closest === "function" ? card.closest("[data-composer-seat]") : null;
  const scope = seatEl !== null && typeof seatEl.querySelectorAll === "function" ? seatEl : document;
  const seats = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]')).filter((seat2) => (card.compareDocumentPosition(seat2) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).filter((seat2) => typeof seat2.closest !== "function" || seat2.closest("[data-expert-team-active-chip]") === null);
  const seat = seats[seats.length - 1];
  if (seat === void 0) return null;
  const outletParent = (key) => {
    if (typeof scope.querySelector !== "function") return null;
    const outlet = scope.querySelector(`[data-slot="${key}"]`);
    const parent = outlet !== null && outlet !== void 0 ? outlet.parentElement : null;
    if (parent === null || parent === void 0 || parent === document.body || parent === seatEl) return null;
    if (typeof parent.contains === "function" && parent.contains(card)) return null;
    return parent;
  };
  for (const key of ["conversation.hero.agentPreset", "conversation.hero.workspace"]) {
    const row2 = outletParent(key);
    if (row2 !== null) return row2;
  }
  const elementChildren = (node) => node !== null && node.children !== void 0 ? node.children.length : 0;
  let row = seat.parentElement;
  for (let hops = 0; row !== null && row !== document.body && hops < 12; hops += 1) {
    if (getComputedStyle(row).display === "contents" || elementChildren(row) < 2) {
      row = row.parentElement;
      continue;
    }
    break;
  }
  return row === null || row === document.body ? null : row;
}
function useHeroSeatRow() {
  const [row, setRow] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (typeof document === "undefined") return void 0;
    const resolve = () => {
      const next = findHeroSeatRow();
      setRow((current) => current === next ? current : next);
    };
    resolve();
    const timer = window.setInterval(resolve, 400);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return row;
}
function Trigger(props) {
  const state = useStore();
  const actions = props?.inputActions;
  const sessionId = sessionIdOf(props);
  const seatRow = useHeroSeatRow();
  const [hover, setHover] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    if (store.input !== actions || store.sessionId !== sessionId) {
      patch({ input: actions ?? null, sessionId });
    }
    return () => {
      if (store.input === actions && store.sessionId === sessionId) patch({ input: null });
    };
  }, [actions, sessionId]);
  const open = (0, import_react.useCallback)(() => {
    patch({
      open: true,
      view: "gallery",
      teamId: null,
      error: null,
      category: "\u5168\u90E8",
      /* 即便面板已经开着，点入口也算一次「刷新」——见 store.loadToken。 */
      loadToken: (store.loadToken ?? 0) + 1
    });
  }, []);
  const host = seatRow !== null && seatRow.isConnected === true ? seatRow : null;
  const active = activeOf(state, sessionId);
  if (active !== null) {
    return /* @__PURE__ */ import_react.default.createElement(
      ActiveTeamChip,
      {
        sessionId,
        session: props?.session,
        host,
        onOpenPanel: open
      }
    );
  }
  const button = /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      "aria-label": "\u4E13\u5BB6\u56E2",
      onClick: open,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      title: "\u4ECE\u56E2\u961F\u753B\u5ECA\u91CC\u6311\u4E00\u652F\u4E13\u5BB6\u56E2\uFF0C\u4E3A\u6BCF\u4F4D\u4E13\u5BB6\u5F00\u72EC\u7ACB\u5B50\u4F1A\u8BDD",
      style: host !== null ? rowChip(state.open || hover ? { background: HOVER_BG } : {}) : chip(state.open ? {
        background: "var(--dsw-alias-button-primary-fill, #111827)",
        color: "var(--dsw-static-neutral-00, #ffffff)"
      } : hover ? { background: HOVER_BG } : {})
    },
    /* @__PURE__ */ import_react.default.createElement(IconUsersInline, { size: host !== null ? 16 : 14 }),
    "\u4E13\u5BB6\u56E2"
  );
  return host !== null ? (0, import_react_dom.createPortal)(button, host) : button;
}
var MENU_MAX_HEIGHT = 320;
function ActiveTeamChip(props) {
  const state = useStore();
  const sessionId = sessionIdOf(props);
  const active = activeOf(state, sessionId);
  const host = props?.host ?? null;
  const inline = host !== null;
  const onOpenPanel = props?.onOpenPanel;
  const [hover, setHover] = (0, import_react.useState)(false);
  const [menu, setMenu] = (0, import_react.useState)(false);
  const [menuRect, setMenuRect] = (0, import_react.useState)(null);
  const wrapRef = (0, import_react.useRef)(null);
  const busyRef = (0, import_react.useRef)(false);
  const activated = active !== null;
  const dispatchWith = (0, import_react.useCallback)(async (text) => {
    if (busyRef.current || active === null || typeof sessionId !== "string") return;
    busyRef.current = true;
    let direct = null;
    try {
      direct = await api("/summon", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          teamId: active.team.id,
          task: text,
          memberIds: active.memberIds,
          ...Number.isInteger(active.stage) ? { stage: active.stage } : {}
        })
      });
    } catch (error) {
      direct = { ok: false, error: String(error?.message ?? error) };
    }
    const actions = store.input;
    if (actions !== void 0 && actions !== null) {
      if (direct?.ok === true && Array.isArray(direct.dispatched) && direct.dispatched.length > 0) {
        actions.setDraft(summonBriefing(active.team, text, direct.dispatched, active.stage));
      } else {
        actions.setDraft(fallbackBriefing(active.team, text, active.memberIds, direct?.error, active.stage));
      }
      actions.submit();
    }
    busyRef.current = false;
    deactivateTeam(sessionId);
  }, [active, sessionId]);
  (0, import_react.useEffect)(() => {
    if (!activated) return void 0;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
    const readDraft = () => {
      if (typeof document.querySelector !== "function") return "";
      const editor = document.querySelector("[data-input-scroll] [contenteditable]");
      return String(editor?.innerText ?? editor?.textContent ?? "").trim();
    };
    const takeOver = () => {
      const text = readDraft();
      if (text === "") return false;
      void dispatchWith(text);
      return true;
    };
    const onKeyDown = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (typeof target?.closest !== "function") return;
      if (target.closest("[data-input-scroll]") === null) return;
      if (!takeOver()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onClick = (event) => {
      const target = event.target;
      if (typeof target?.closest !== "function") return;
      const card = target.closest("[data-composer-card]");
      if (card === null || typeof card.querySelectorAll !== "function") return;
      const button = target.closest("button");
      if (button === null || button.disabled === true) return;
      if (typeof button.hasAttribute === "function" && button.hasAttribute("aria-haspopup")) return;
      const usable = Array.from(card.querySelectorAll("button")).filter((item) => item.disabled !== true);
      if (usable[usable.length - 1] !== button) return;
      if (!takeOver()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      if (typeof document.removeEventListener !== "function") return;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [activated, dispatchWith]);
  (0, import_react.useEffect)(() => {
    if (!menu) return void 0;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
    const onDown = (event) => {
      const target = event.target;
      if (typeof target?.closest === "function" && target.closest("[data-expert-team-member-menu]") !== null) return;
      setMenu(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => {
      if (typeof document.removeEventListener !== "function") return;
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [menu]);
  const toggleMenu = (0, import_react.useCallback)(() => {
    const rect = wrapRef.current?.getBoundingClientRect?.();
    const viewportH = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
    const GAP = 6;
    if (rect !== void 0 && rect !== null && Number.isFinite(rect.top)) {
      const below = viewportH - rect.bottom - GAP;
      const above = rect.top - GAP;
      const openUp = below < Math.min(MENU_MAX_HEIGHT, above);
      setMenuRect(openUp ? {
        left: rect.left,
        fromTop: false,
        offset: viewportH - rect.top + GAP,
        maxHeight: Math.max(140, above - 8)
      } : {
        left: rect.left,
        fromTop: true,
        offset: rect.bottom + GAP,
        maxHeight: Math.max(140, below - 8)
      });
    } else {
      setMenuRect({ left: 16, fromTop: true, offset: 96, maxHeight: MENU_MAX_HEIGHT });
    }
    setMenu((value) => !value);
  }, []);
  if (active === null) return null;
  const { team, memberIds } = active;
  const plan = Array.isArray(team.stages) ? team.stages : [];
  const staged = plan.length > 1;
  const activeStage = Number.isInteger(active.stage) ? active.stage : null;
  const stageMembers = activeStage === null ? team.members : team.members.filter((member) => (plan.find((item) => item.stage === activeStage)?.members ?? []).includes(member.id));
  const accent = team.accent || "#4F46E5";
  const iconButton = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: S.muted,
    cursor: "pointer",
    fontFamily: "inherit",
    padding: 0,
    flex: "none"
  };
  const menuNode = menu && menuRect !== null ? portalToBody(
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        "data-expert-team-member-menu": true,
        style: {
          position: "fixed",
          left: Math.max(8, menuRect.left),
          /* 贴着 chip 的那一侧：向下开给 top，向上开给 bottom（见 toggleMenu）。 */
          ...menuRect.fromTop === true ? { top: menuRect.offset } : { bottom: menuRect.offset },
          zIndex: 9999,
          width: 288,
          maxHeight: menuRect.maxHeight ?? MENU_MAX_HEIGHT,
          overflowY: "auto",
          background: S.surface,
          border: `1px solid ${S.line}`,
          borderRadius: 12,
          boxShadow: "var(--dsw-shadow-lv2, 0 16px 40px rgba(15, 23, 42, 0.18))",
          padding: 10,
          fontFamily: FONT
        }
      },
      /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 8px" } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12.5, fontWeight: 600, color: S.text } }, activeStage === null ? `\u6D3E\u9063\u6210\u5458\uFF08${memberIds.length}/${team.members.length}\uFF09` : `\u7B2C ${activeStage} \u9636\u6BB5\uFF08${stageMembers.length} \u4F4D\uFF09`), /* @__PURE__ */ import_react.default.createElement(
        "button",
        {
          type: "button",
          style: btn({ padding: "2px 8px", fontSize: 12 }),
          onClick: () => setActiveMembers(sessionId, team.members.map((member) => member.id))
        },
        "\u5168\u9009"
      )),
      staged && /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 4px 8px" } }, /* @__PURE__ */ import_react.default.createElement(
        "button",
        {
          type: "button",
          style: stageChip(activeStage === null, accent),
          onClick: () => setActiveStage(sessionId, team, null)
        },
        "\u4E00\u6B21\u6027"
      ), plan.map((item) => /* @__PURE__ */ import_react.default.createElement(
        "button",
        {
          key: item.stage,
          type: "button",
          title: item.name !== void 0 && item.name !== "" ? item.name : `\u7B2C ${item.stage} \u9636\u6BB5`,
          style: stageChip(activeStage === item.stage, accent),
          onClick: () => setActiveStage(sessionId, team, item.stage)
        },
        `P${item.stage}${item.name !== void 0 && item.name !== "" ? ` ${item.name}` : ""}`
      ))),
      stageMembers.map((member) => {
        const on = stageMembers !== team.members ? true : memberIds.includes(member.id);
        return /* @__PURE__ */ import_react.default.createElement(
          "label",
          {
            key: member.id,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 6px",
              borderRadius: 8,
              cursor: "pointer",
              background: on ? `${accent}0f` : "transparent"
            }
          },
          /* @__PURE__ */ import_react.default.createElement(
            "input",
            {
              type: "checkbox",
              checked: on,
              disabled: activeStage !== null,
              onChange: () => setActiveMembers(
                sessionId,
                on ? memberIds.filter((id) => id !== member.id) : [...memberIds, member.id]
              )
            }
          ),
          /* @__PURE__ */ import_react.default.createElement(PersonAvatar, { seed: member.id, avatar: member.avatar, size: 24 }),
          /* @__PURE__ */ import_react.default.createElement("span", { style: { minWidth: 0, display: "flex", flexDirection: "column" } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 13, color: S.text } }, member.name), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 11.5, color: S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, member.focus || "\u2014"))
        );
      })
    )
  ) : null;
  const node = /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement(
    "div",
    {
      ref: wrapRef,
      "data-expert-team-active-chip": true,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        /*
         * 规格直接借入口 chip 的两套样式（hero 行 rowChip / 工具行 chip），
         * 差别只剩「淡色底 + 描边」这一层状态色 —— 它和同行邻居必须看起来是同一套控件。
         * 两个关键属性：
         * · `flex: none`（来自 rowChip / chip）挡住 flex 行把标签拉长；
         * · `boxSizing: border-box` 让这 1px 描边不把高度顶出 28px。
         */
        ...inline ? rowChip() : chip(),
        gap: 2,
        boxSizing: "border-box",
        maxWidth: "100%",
        background: `${accent}14`,
        border: `1px solid ${accent}2e`,
        // 悬停 / 菜单展开加深，与邻居 chip 的悬停反馈是同一语义。
        ...hover || menu ? { background: `${accent}24`, borderColor: `${accent}59` } : {}
      }
    },
    /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        "aria-label": "\u4E13\u5BB6\u56E2",
        title: "\u6253\u5F00\u56E2\u961F\u753B\u5ECA\uFF0C\u6362\u4E00\u652F\u4E13\u5BB6\u56E2",
        onClick: onOpenPanel,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          height: "100%",
          padding: "0 2px",
          border: "none",
          borderRadius: 8,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          fontFamily: FONT,
          fontSize: inline ? 13 : 14,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "pointer"
        }
      },
      /* @__PURE__ */ import_react.default.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: accent, flex: "none" } }),
      /* @__PURE__ */ import_react.default.createElement("span", { style: { minWidth: 0, maxWidth: 168, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, team.name),
      /* @__PURE__ */ import_react.default.createElement("span", { style: { color: S.muted, fontSize: 11.5, fontWeight: 400, flex: "none", fontVariantNumeric: "tabular-nums" } }, activeStage === null ? `${memberIds.length}/${team.members.length}` : `P${activeStage} ${stageMembers.length}/${team.members.length}`)
    ),
    (hover || menu) && /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        "aria-label": "\u53D6\u6D88\u53EC\u5524\u4E13\u5BB6\u56E2",
        title: "\u53D6\u6D88\u53EC\u5524",
        onClick: () => {
          setMenu(false);
          deactivateTeam(sessionId);
        },
        style: iconButton
      },
      /* @__PURE__ */ import_react.default.createElement("svg", { viewBox: "0 0 16 16", width: "11", height: "11", "aria-hidden": true }, /* @__PURE__ */ import_react.default.createElement("path", { d: "M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }))
    ),
    /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        "aria-label": "\u9009\u62E9\u6D3E\u9063\u6210\u5458",
        "aria-haspopup": "menu",
        "aria-expanded": menu,
        onClick: toggleMenu,
        style: iconButton
      },
      /* @__PURE__ */ import_react.default.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: "10",
          height: "10",
          "aria-hidden": true,
          style: { transform: menu ? "rotate(180deg)" : "none", transition: "transform .15s" }
        },
        /* @__PURE__ */ import_react.default.createElement("path", { d: "M4 6.5 L8 10.5 L12 6.5", stroke: "currentColor", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" })
      )
    )
  ), menuNode);
  return inline ? (0, import_react_dom.createPortal)(node, host) : node;
}
var SORTS = [["default", "\u7EFC\u5408"], ["hot", "\u6700\u70ED"], ["new", "\u6700\u65B0"]];
function categoriesOf(teams) {
  const seen = /* @__PURE__ */ new Set();
  const list = [];
  for (const team of teams) {
    const category = typeof team.category === "string" ? team.category.trim() : "";
    if (category !== "" && !seen.has(category)) {
      seen.add(category);
      list.push(category);
    }
  }
  return list;
}
function sortTeams(teams, sort) {
  const list = [...teams];
  if (sort === "hot") return list.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
  if (sort === "new") {
    return list.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  }
  return list;
}
function Tag({ children }) {
  return /* @__PURE__ */ import_react.default.createElement(
    "span",
    {
      style: {
        fontSize: 11.5,
        lineHeight: "18px",
        color: S.body,
        background: S.soft,
        borderRadius: 6,
        padding: "1px 7px",
        whiteSpace: "nowrap"
      }
    },
    children
  );
}
function TeamCard({ team, onOpen }) {
  const accent = team.accent || "#4F46E5";
  const plan = Array.isArray(team.stages) ? team.stages : [];
  const staged = plan.length > 1;
  const tags = [
    ...team.source === "custom" ? ["\u81EA\u5B9A\u4E49"] : [],
    ...Array.isArray(team.tags) ? team.tags : []
  ].slice(0, 3);
  return /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      onClick: () => onOpen(team.id),
      style: {
        textAlign: "left",
        fontFamily: "inherit",
        cursor: "pointer",
        border: `1px solid ${S.line}`,
        borderRadius: S.radius,
        background: S.surface,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 172
      }
    },
    /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } }, /* @__PURE__ */ import_react.default.createElement(TeamAvatar, { team, size: 44 }), /* @__PURE__ */ import_react.default.createElement("div", { style: { minWidth: 0 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, team.name), /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12, color: S.muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${team.publisher || "DSH \u5B98\u65B9\u56E2\u961F"} \xB7 ${team.members.length} \u4F4D\u4E13\u5BB6`))),
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        style: {
          fontSize: 12.5,
          lineHeight: "19px",
          color: S.body,
          height: 57,
          overflow: "hidden",
          flex: 1
        }
      },
      team.tagline
    ),
    /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, /* @__PURE__ */ import_react.default.createElement(
      "span",
      {
        title: staged ? plan.map((item) => `P${item.stage}${item.name !== void 0 && item.name !== "" ? ` ${item.name}` : ""}`).join(" \u2192 ") : "\u6BCF\u4F4D\u4E13\u5BB6\u72EC\u7ACB\u4EA7\u51FA\uFF0C\u7531\u53EC\u96C6\u4EBA\u6C47\u603B",
        style: {
          display: "inline-flex",
          alignItems: "center",
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 600,
          lineHeight: "18px",
          background: staged ? `${accent}1f` : "var(--dsw-alias-interactive-bg-hover, #f3f4f6)",
          color: staged ? accent : S.muted,
          border: `1px solid ${staged ? `${accent}33` : S.line}`
        }
      },
      staged ? `${plan.length} \u9636\u6BB5\u6D41\u6C34\u7EBF` : "\u5E76\u884C\u89C6\u89D2"
    ), tags.map((tag) => /* @__PURE__ */ import_react.default.createElement(Tag, { key: tag }, tag)))
  );
}
function Gallery({ state, onOpenTeam, onCreate, onSort, onCategory }) {
  const categories = (0, import_react.useMemo)(() => ["\u5168\u90E8", ...categoriesOf(state.teams)], [state.teams]);
  const visible = (0, import_react.useMemo)(() => {
    const filtered = state.category === "\u5168\u90E8" ? state.teams : state.teams.filter((team) => team.category === state.category);
    return sortTeams(filtered, state.sort);
  }, [state.teams, state.category, state.sort]);
  const total = `${state.teams.length} \u652F\u56E2\u961F`;
  return /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 20, fontWeight: 700, color: S.text } }, "\u4E13\u5BB6\u56E2"), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12.5, color: S.muted, marginLeft: 4 } }, state.teams.length > 0 ? total : ""), /* @__PURE__ */ import_react.default.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 } }, SORTS.map(([key, label]) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      key,
      type: "button",
      onClick: () => onSort(key),
      style: {
        border: "none",
        background: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 14,
        padding: "4px 10px",
        borderRadius: 8,
        color: state.sort === key ? S.strong : S.muted,
        fontWeight: state.sort === key ? 600 : 400
      }
    },
    label
  )))), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 } }, categories.map((category) => {
    const active = state.category === category;
    return /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        key: category,
        type: "button",
        onClick: () => onCategory(category),
        style: {
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13.5,
          padding: "6px 14px",
          borderRadius: 999,
          whiteSpace: "nowrap",
          background: active ? "var(--dsw-alias-interactive-bg-active, #eaeaec)" : "transparent",
          color: active ? S.strong : S.body,
          fontWeight: active ? 600 : 400
        }
      },
      category
    );
  })), !state.loaded && /* @__PURE__ */ import_react.default.createElement("div", { style: { padding: 40, textAlign: "center", color: S.muted } }, "\u6B63\u5728\u52A0\u8F7D\u4E13\u5BB6\u56E2\u2026"), state.loaded && state.teams.length === 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: { padding: 40, textAlign: "center", color: S.muted } }, "\u8FD8\u6CA1\u6709\u4EFB\u4F55\u4E13\u5BB6\u56E2\u3002", /* @__PURE__ */ import_react.default.createElement("div", { style: { marginTop: 12 } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: primaryBtn(), onClick: onCreate }, "\u65B0\u5EFA\u4E00\u652F\u4E13\u5BB6\u56E2"))), state.loaded && state.teams.length > 0 && visible.length === 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: { padding: 40, textAlign: "center", color: S.muted } }, `\u300C${state.category}\u300D\u5206\u7C7B\u4E0B\u6682\u65F6\u6CA1\u6709\u56E2\u961F\u3002`), visible.length > 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(236px, 1fr))", gap: 12 } }, visible.map((team) => /* @__PURE__ */ import_react.default.createElement(TeamCard, { key: team.id, team, onOpen: onOpenTeam }))));
}
function SectionTitle({ icon, children }) {
  return /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, color: S.strong } }, icon, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 16, fontWeight: 600 } }, children));
}
function Detail({ team, onBack, onEdit, onSummoned, onOpenCase, onRefresh, state }) {
  const [memberView, setMemberView] = (0, import_react.useState)(null);
  const summon = (0, import_react.useCallback)((draftText) => {
    activateTeam(team, draftText);
    onSummoned();
  }, [team, onSummoned]);
  const accent = team.accent || "#4F46E5";
  const locked = state?.config?.lockBuiltinTeams === true;
  const editable = team.source === "custom" || !locked;
  const caseTags = Array.isArray(team.tags) ? team.tags.slice(0, 3) : [];
  const viewedMember = memberView === null ? null : team.members.find((item) => item.id === memberView) ?? null;
  const plan = Array.isArray(team.stages) ? team.stages : [];
  const nameOfMember = (id) => team.members.find((item) => item.id === id)?.name ?? id;
  return /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 22 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn({ padding: "4px 10px" }), onClick: onBack }, "\u2190 \u5168\u90E8\u56E2\u961F"), editable && /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn({ padding: "4px 10px" }), onClick: () => onEdit(team) }, "\u7F16\u8F91")), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "flex-start", gap: 16 } }, /* @__PURE__ */ import_react.default.createElement(TeamAvatar, { team, size: 64 }), /* @__PURE__ */ import_react.default.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 24, fontWeight: 700, color: S.text } }, team.name)), team.tagline !== "" && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 13.5, color: S.body, marginTop: 6 } }, team.tagline), plan.length > 1 && /* @__PURE__ */ import_react.default.createElement("div", { style: { marginTop: 14, display: "flex", flexDirection: "column", gap: 6 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12.5, fontWeight: 600, color: S.muted } }, `\u5206\u9636\u6BB5\u6D41\u6C34\u7EBF \xB7 ${plan.length} \u4E2A\u9636\u6BB5\uFF08\u53EF\u9010\u9636\u6BB5\u6D3E\u9063\uFF0C\u4E0A\u4E00\u9636\u6BB5\u4EA7\u51FA\u4F1A\u6210\u4E3A\u4E0B\u4E00\u9636\u6BB5\u8F93\u5165\uFF09`), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, plan.map((item) => /* @__PURE__ */ import_react.default.createElement(
    "span",
    {
      key: item.stage,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12.5,
        background: "var(--dsw-alias-interactive-bg-hover, #f3f4f6)",
        border: `1px solid ${S.line}`,
        color: S.body
      }
    },
    /* @__PURE__ */ import_react.default.createElement("span", { style: { fontWeight: 600, color: S.text } }, `P${item.stage}${item.name !== void 0 && item.name !== "" ? ` ${item.name}` : ""}`),
    /* @__PURE__ */ import_react.default.createElement("span", { style: { color: S.muted } }, item.members.map(nameOfMember).join("\u3001"))
  )))), /* @__PURE__ */ import_react.default.createElement("div", { style: { marginTop: 16 } }, /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      onClick: () => summon(),
      style: { ...primaryBtn(), borderRadius: 999, padding: "0 22px", height: 44, fontSize: 15 }
    },
    /* @__PURE__ */ import_react.default.createElement(IconSend, null),
    "\u53EC\u5524\u4E13\u5BB6\u56E2"
  )))), team.presets.length > 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, team.presets.map((preset) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      key: preset,
      type: "button",
      onClick: () => summon(preset),
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        width: "100%",
        boxSizing: "border-box",
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        background: S.soft,
        borderRadius: S.radius,
        padding: "15px 18px",
        color: S.text
      }
    },
    /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 15 } }, `\u201C${preset}\u201D`),
    /* @__PURE__ */ import_react.default.createElement("span", { style: { color: S.muted, display: "inline-flex" } }, /* @__PURE__ */ import_react.default.createElement(IconChat, null))
  ))), team.cases.length > 0 && /* @__PURE__ */ import_react.default.createElement("section", { style: { display: "flex", flexDirection: "column", gap: 12 } }, /* @__PURE__ */ import_react.default.createElement(SectionTitle, { icon: /* @__PURE__ */ import_react.default.createElement(IconGrid, null) }, "\u4F7F\u7528\u6848\u4F8B"), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 } }, team.cases.map((item, caseIndex) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      key: item.title,
      type: "button",
      onClick: () => onOpenCase(caseIndex),
      style: {
        textAlign: "left",
        fontFamily: "inherit",
        cursor: "pointer",
        border: `1px solid ${S.line}`,
        borderRadius: 10,
        background: S.surface,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10
      }
    },
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        style: {
          height: 108,
          borderRadius: 8,
          background: `linear-gradient(135deg, ${accent}14, ${accent}05)`,
          border: `1px solid ${accent}1f`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 34
        }
      },
      item.emoji || "\u{1F4C4}"
    ),
    /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title),
    item.desc !== "" && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 13, color: S.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.desc),
    caseTags.length > 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, caseTags.map((tag) => /* @__PURE__ */ import_react.default.createElement(Tag, { key: tag }, tag)))
  )))), /* @__PURE__ */ import_react.default.createElement("section", { style: { display: "flex", flexDirection: "column", gap: 12 } }, /* @__PURE__ */ import_react.default.createElement(SectionTitle, { icon: /* @__PURE__ */ import_react.default.createElement(IconUsers, null) }, `\u56E2\u961F\u6210\u5458`), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "18px 12px" } }, team.members.map((member) => (
    /*
     * 整格是一个按钮：点开成员详情。
     * 视觉刻意保持原来的「无边框名册」—— 只是多了一个淡淡的 `›` 提示可点，
     * 免得把用户已经认可的那一栏改成一片卡片墙。
     */
    /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        key: member.id,
        type: "button",
        "aria-label": `\u67E5\u770B\u6210\u5458\u8BE6\u60C5\uFF1A${member.name}`,
        title: "\u67E5\u770B / \u7F16\u8F91\u8FD9\u4F4D\u4E13\u5BB6",
        onClick: () => setMemberView(member.id),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
          padding: "6px 8px",
          margin: "-6px -8px",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          borderRadius: 10,
          border: "1px solid transparent",
          background: "transparent"
        }
      },
      /* @__PURE__ */ import_react.default.createElement(PersonAvatar, { seed: member.id, avatar: member.avatar, size: 40 }),
      /* @__PURE__ */ import_react.default.createElement("div", { style: { minWidth: 0, flex: 1 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 15, fontWeight: 600, color: S.text } }, member.name), member.role === "lead" && /* @__PURE__ */ import_react.default.createElement(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 11,
            lineHeight: "18px",
            color: S.body,
            background: S.soft,
            borderRadius: 999,
            padding: "0 7px",
            whiteSpace: "nowrap"
          }
        },
        "\u{1F3C5} \u4E3B\u7406\u4EBA"
      )), /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 13, color: S.body, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, member.alias !== "" ? `${member.alias} \xB7 ${member.focus || "\u2014"}` : member.focus || "\u2014")),
      /* @__PURE__ */ import_react.default.createElement("span", { "aria-hidden": true, style: { flex: "none", fontSize: 15, color: S.muted } }, "\u203A")
    )
  )))), viewedMember !== null && /* @__PURE__ */ import_react.default.createElement(
    MemberDialog,
    {
      team,
      member: viewedMember,
      readOnly: !editable,
      onClose: () => setMemberView(null),
      onSaved: () => {
        setMemberView(null);
        void onRefresh?.();
      }
    }
  ));
}
function AvatarPicker({ value, suggested, onChange, compact = false, hint, name }) {
  const [open, setOpen] = (0, import_react.useState)(!compact);
  const active = typeof value === "number" ? value : typeof suggested === "number" ? suggested : 0;
  const recommendable = typeof suggested === "number" && suggested !== active;
  const triggerLabel = name === void 0 ? "\u9009\u62E9\u5934\u50CF" : `\u9009\u62E9\u5934\u50CF\uFF1A${name}`;
  const chip2 = (label, onClick, extra) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      key: label,
      type: "button",
      onClick,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flex: "none",
        padding: "2px 9px",
        fontSize: 12,
        lineHeight: "20px",
        fontFamily: "inherit",
        color: S.body,
        background: S.soft,
        border: `1px solid ${S.line}`,
        borderRadius: 999,
        cursor: "pointer",
        ...extra
      }
    },
    label
  );
  const grid = /* @__PURE__ */ import_react.default.createElement(
    "div",
    {
      role: "radiogroup",
      "aria-label": `${triggerLabel}\uFF1A\u7F51\u683C`,
      style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, maxWidth: 396 }
    },
    Array.from({ length: AVATAR_COUNT }, (unused, index) => {
      const on = index === active;
      return /* @__PURE__ */ import_react.default.createElement(
        "button",
        {
          key: index,
          type: "button",
          role: "radio",
          "aria-checked": on,
          "aria-label": `\u9009\u62E9\u5934\u50CF ${avatarFile(index)}`,
          title: avatarFile(index),
          onClick: () => onChange(index),
          style: {
            width: 38,
            height: 38,
            flex: "none",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            borderRadius: "50%",
            background: "transparent",
            border: `2px solid ${on ? "var(--dsw-alias-brand-primary, #6366f1)" : "transparent"}`,
            boxShadow: on ? "0 0 0 3px var(--dsw-alias-interactive-bg-hover-accent, rgba(99, 102, 241, 0.16))" : "none"
          }
        },
        /* @__PURE__ */ import_react.default.createElement(AvatarImage, { index, size: 32 })
      );
    })
  );
  return /* @__PURE__ */ import_react.default.createElement("div", { "data-avatar-picker": name ?? "", style: { display: "flex", flexDirection: "column" } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } }, /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      "aria-label": triggerLabel,
      "aria-expanded": open,
      title: "\u70B9\u8FD9\u91CC\u5C55\u5F00\u5934\u50CF\u7F51\u683C",
      onClick: () => setOpen((current) => !current),
      style: {
        width: compact ? 36 : 50,
        height: compact ? 36 : 50,
        flex: "none",
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        borderRadius: "50%",
        background: "transparent",
        border: `1px solid ${S.line}`
      }
    },
    /* @__PURE__ */ import_react.default.createElement(AvatarImage, { index: active, size: compact ? 30 : 44 })
  ), recommendable && chip2(
    "\u63A8\u8350\u8FD9\u5F20",
    () => onChange(suggested),
    { color: "var(--dsw-alias-state-business-primary, #4338ca)", background: "var(--dsw-alias-state-business-tertiary, #eef2ff)", borderColor: "var(--dsw-alias-border-l2, #c7d2fe)" }
  ), chip2("\u6362\u4E00\u4E2A", () => onChange(nextAvatar(active))), chip2(open ? "\u6536\u8D77" : "\u6362\u5934\u50CF", () => setOpen((current) => !current)), hint !== void 0 && /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 11.5, color: S.muted } }, hint)), open && grid);
}
var BLANK_MEMBER = { id: "", name: "", alias: "", emoji: "\u{1F642}", role: "member", focus: "", persona: "" };
function TeamEditor({ initial, onCancel, onSaved, config }) {
  const limits = config?.limits ?? {};
  const [form, setForm] = (0, import_react.useState)(() => ({
    id: initial?.id ?? "",
    name: initial?.name ?? "",
    tagline: initial?.tagline ?? "",
    // emoji 不再出现在表单里，但**原样透传**：老数据里存着它，别在一次编辑里把它弄丢。
    emoji: initial?.emoji ?? "\u{1F465}",
    avatar: typeof initial?.avatar === "number" ? initial.avatar : null,
    accent: initial?.accent ?? "#4F46E5",
    category: initial?.category ?? "",
    tagsText: (initial?.tags ?? []).join("\u3001"),
    presetsText: (initial?.presets ?? []).join("\n"),
    members: initial !== null && initial !== void 0 && initial.members.length > 0 ? initial.members.map((member) => ({ ...BLANK_MEMBER, ...member, persona: member.persona ?? "" })) : [{ ...BLANK_MEMBER, id: "expert-1", role: "lead" }, { ...BLANK_MEMBER, id: "expert-2" }]
  }));
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [avatarTouched, setAvatarTouched] = (0, import_react.useState)(initial !== null && initial !== void 0);
  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const pickAvatar = (value) => {
    setAvatarTouched(true);
    setField("avatar", value);
  };
  const setMember = (index, key, value) => setForm((current) => ({
    ...current,
    members: current.members.map((member, i) => i === index ? { ...member, [key]: value } : member)
  }));
  const addMember = () => setForm((current) => ({
    ...current,
    members: [...current.members, { ...BLANK_MEMBER, id: `expert-${current.members.length + 1}` }]
  }));
  const removeMember = (index) => setForm((current) => ({
    ...current,
    members: current.members.filter((_, i) => i !== index)
  }));
  const seed = form.id !== "" ? form.id : form.name;
  const recommendedAvatar = suggestAvatar(seed);
  (0, import_react.useEffect)(() => {
    if (avatarTouched || form.avatar !== null) return;
    setForm((current) => current.avatar === null ? { ...current, avatar: recommendedAvatar } : current);
  }, [avatarTouched, form.avatar, recommendedAvatar]);
  const save = async () => {
    setBusy(true);
    setError(null);
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      tagline: form.tagline.trim(),
      emoji: form.emoji.trim(),
      avatar: form.avatar,
      accent: form.accent,
      category: form.category.trim(),
      // 标签用中文顿号 / 逗号 / 空格分隔都接受，服务端会再截断到 4 个。
      tags: form.tagsText.split(/[、,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== ""),
      presets: form.presetsText.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
      members: form.members.map((member) => ({
        id: member.id.trim(),
        name: member.name.trim(),
        alias: member.alias.trim(),
        emoji: member.emoji.trim(),
        avatar: typeof member.avatar === "number" ? member.avatar : null,
        role: member.role,
        focus: member.focus.trim(),
        persona: member.persona.trim()
      }))
    };
    try {
      await api("/teams", { method: "POST", body: JSON.stringify({ team: payload }) });
      onSaved();
    } catch (caught) {
      setError(String(caught?.message ?? caught));
    }
    setBusy(false);
  };
  const field = (label, value, onChange, placeholder, mono = false) => /* @__PURE__ */ import_react.default.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: S.body } }, label, /* @__PURE__ */ import_react.default.createElement(
    "input",
    {
      value,
      onChange: (event) => onChange(event.target.value),
      placeholder,
      style: {
        border: `1px solid ${S.line}`,
        borderRadius: 8,
        padding: "7px 10px",
        fontSize: 13,
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
        color: S.text,
        background: S.surface
      }
    }
  ));
  return /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn({ padding: "4px 10px" }), onClick: onCancel }, "\u2190 \u8FD4\u56DE"), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 16, fontWeight: 600, color: S.text } }, initial !== null && initial !== void 0 ? "\u7F16\u8F91\u4E13\u5BB6\u56E2" : "\u65B0\u5EFA\u4E13\u5BB6\u56E2")), initial?.source === "builtin" && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12.5, lineHeight: 1.7, color: S.body, background: "var(--dsw-alias-state-business-tertiary, #eef2ff)", border: "1px solid var(--dsw-alias-border-l2, #c7d2fe)", borderRadius: 8, padding: 10 } }, "\u8FD9\u662F\u4E00\u652F\u5185\u7F6E\u56E2\u961F\u3002\u5F00\u53D1\u9636\u6BB5\u53EF\u4EE5\u76F4\u63A5\u6539\uFF1A\u4FDD\u5B58\u540E\u4F1A\u628A\u5B83\u5199\u8FDB\u7528\u6237\u76EE\u5F55 \uFF08$DSH_HOME/expert-teams/teams.json\uFF09\u4F5C\u4E3A\u540C id \u526F\u672C\u8986\u76D6\u5185\u7F6E\u57FA\u7EBF \u2014\u2014 \u6B64\u540E\u63D2\u4EF6\u5347\u7EA7\u5E26\u6765\u7684\u8FD9\u652F\u961F\u7684\u5185\u7F6E\u66F4\u65B0\u4E0D\u4F1A\u81EA\u52A8\u8986\u76D6\u4F60\u7684\u6539\u52A8\u3002"), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } }, field("\u56E2\u961F id\uFF08\u5C0F\u5199 kebab-case\uFF0C\u53EC\u5524\u65F6\u7528\uFF09", form.id, (value) => setField("id", value), "my-team", true), field("\u56E2\u961F\u540D\u79F0", form.name, (value) => setField("name", value), "\u6211\u7684\u4E13\u5BB6\u56E2"), field("\u4E00\u53E5\u8BDD\u7B80\u4ECB", form.tagline, (value) => setField("tagline", value), "\u7ADE\u54C1\u5206\u6790 / \u8DEF\u7EBF\u56FE / \u590D\u76D8"), field(`\u5206\u7C7B\uFF08\u753B\u5ECA\u7B5B\u9009\u884C\u7684\u5206\u7C7B\u540D\uFF0C\u2264${limits.maxCategory ?? 12} \u5B57\uFF09`, form.category, (value) => setField("category", value), "\u6280\u672F\u5DE5\u7A0B"), field(`\u6807\u7B7E\uFF08\u6700\u591A ${limits.maxTags ?? 4} \u4E2A\uFF0C\u7528\u987F\u53F7\u5206\u9694\uFF09`, form.tagsText, (value) => setField("tagsText", value), "\u4EE3\u7801\u8BC4\u5BA1\u3001\u5B89\u5168\u5BA1\u8BA1"), /* @__PURE__ */ import_react.default.createElement("div", { style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12, color: S.body } }, "\u56E2\u961F\u56FE\u6807\uFF08\u70B9\u683C\u5B50\u6311\u4E00\u5F20\uFF0C\u6216\u76F4\u63A5\u91C7\u7EB3\u63A8\u8350\uFF09"), /* @__PURE__ */ import_react.default.createElement(
    AvatarPicker,
    {
      value: form.avatar,
      suggested: recommendedAvatar,
      onChange: pickAvatar,
      name: "\u56E2\u961F\u56FE\u6807"
    }
  ))), /* @__PURE__ */ import_react.default.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: S.body } }, "\u9884\u8BBE\u63D0\u95EE\uFF08\u6BCF\u884C\u4E00\u6761\uFF0C\u663E\u793A\u4E3A\u8BE6\u60C5\u9875\u7684\u5FEB\u6377\u63D0\u95EE\u6761\uFF09", /* @__PURE__ */ import_react.default.createElement(
    "textarea",
    {
      value: form.presetsText,
      onChange: (event) => setField("presetsText", event.target.value),
      rows: 3,
      style: { border: `1px solid ${S.line}`, borderRadius: 8, padding: 10, fontSize: 13, fontFamily: "inherit", color: S.text, resize: "vertical", background: S.surface }
    }
  )), /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: S.text } }, `\u56E2\u961F\u6210\u5458\uFF08${form.members.length}\uFF09`), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn({ padding: "3px 10px", fontSize: 12 }), onClick: addMember }, "+ \u6DFB\u52A0\u4E13\u5BB6")), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } }, form.members.map((member, index) => /* @__PURE__ */ import_react.default.createElement("div", { key: index, style: { border: `1px solid ${S.line}`, borderRadius: 10, padding: 12, background: S.surface, display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 90px auto", gap: 8, alignItems: "end" } }, field("\u6210\u5458 id", member.id, (value) => setMember(index, "id", value), "analyst", true), field("\u79F0\u547C", member.name, (value) => setMember(index, "name", value), "\u7ADE\u54C1\u5206\u6790\u5E08"), /* @__PURE__ */ import_react.default.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: S.body } }, "\u89D2\u8272", /* @__PURE__ */ import_react.default.createElement(
    "select",
    {
      value: member.role,
      onChange: (event) => setMember(index, "role", event.target.value),
      style: { border: `1px solid ${S.line}`, borderRadius: 8, padding: "7px 8px", fontSize: 13, fontFamily: "inherit", color: S.text, background: S.surface }
    },
    /* @__PURE__ */ import_react.default.createElement("option", { value: "member" }, "\u6210\u5458"),
    /* @__PURE__ */ import_react.default.createElement("option", { value: "lead" }, "\u4E3B\u7406\u4EBA")
  )), /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      style: btn({ padding: "7px 10px", fontSize: 12 }),
      onClick: () => removeMember(index),
      disabled: form.members.length <= 1
    },
    "\u5220\u9664"
  )), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } }, field("\u6635\u79F0\uFF08\u53EF\u9009\uFF09", member.alias, (value) => setMember(index, "alias", value), "\u7ADE\u6790"), field("\u804C\u8D23\u8303\u56F4", member.focus, (value) => setMember(index, "focus", value), "\u7ADE\u54C1\u5BF9\u6807\u4E0E\u5DEE\u5F02\u5316")), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12, color: S.body } }, "\u6210\u5458\u5934\u50CF\uFF08\u540D\u518C\u4E0E\u6210\u5458\u8BE6\u60C5\u91CC\u663E\u793A\u7684\u90A3\u5F20\u56FE\uFF09"), /* @__PURE__ */ import_react.default.createElement(
    AvatarPicker,
    {
      compact: true,
      value: member.avatar,
      suggested: suggestAvatar(member.id !== "" ? member.id : member.name),
      onChange: (value) => setMember(index, "avatar", value),
      name: member.name !== "" ? member.name : `\u6210\u5458 ${index + 1}`
    }
  )), /* @__PURE__ */ import_react.default.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: S.body } }, "\u4EBA\u683C\u8BBE\u5B9A persona\uFF08\u8FD9\u4F4D\u4E13\u5BB6\u5728\u72EC\u7ACB\u5B50\u4F1A\u8BDD\u91CC\u7684\u89D2\u8272\u63D0\u793A\u8BCD\uFF0C\u5FC5\u586B\uFF09", /* @__PURE__ */ import_react.default.createElement(
    "textarea",
    {
      value: member.persona,
      onChange: (event) => setMember(index, "persona", event.target.value),
      rows: 4,
      placeholder: "\u4F60\u662F\u300C\u7ADE\u54C1\u5206\u6790\u5E08\u300D\u3002\u4F60\u7684\u804C\u8D23\u662F\u2026\u2026\u4F60\u7684\u5DE5\u4F5C\u65B9\u5F0F\u662F\u2026\u2026\u4F60\u7684\u4EA4\u4ED8\u7269\u662F\u2026\u2026\u4F60\u7684\u7EAA\u5F8B\u662F\u2026\u2026",
      style: { border: `1px solid ${S.line}`, borderRadius: 8, padding: 10, fontSize: 12.5, fontFamily: "inherit", color: S.text, resize: "vertical", background: S.soft }
    }
  )))))), error !== null && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12.5, color: "var(--dsw-alias-state-error-primary, #b42318)", background: "var(--dsw-alias-bg-layer-2, #fef3f2)", border: "1px solid var(--dsw-alias-state-error-secondary, #fecdca)", borderRadius: 8, padding: 10 } }, error), /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: primaryBtn({ opacity: busy ? 0.6 : 1 }), disabled: busy, onClick: save }, busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u56E2\u961F"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn(), onClick: onCancel }, "\u53D6\u6D88")), /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12, color: S.body, lineHeight: 1.6 } }, "\u81EA\u5B9A\u4E49\u56E2\u961F\u4FDD\u5B58\u5728 ", /* @__PURE__ */ import_react.default.createElement("code", null, "$DSH_HOME/expert-teams/teams.json"), "\u3002\u4E0E\u5185\u7F6E\u56E2\u961F\u540C id \u65F6\u4F1A\u8986\u76D6\u5185\u7F6E\u7248\u672C\uFF1B\u5220\u9664\u81EA\u5B9A\u4E49\u56E2\u961F\u540E\u4F1A\u6062\u590D\u5185\u7F6E\u7248\u672C\u3002"));
}
function splitPersona(persona) {
  const text = String(persona ?? "").trim();
  if (text === "") return [];
  const marks = [
    { label: "\u804C\u8D23", re: /你的职责是[：:]?/u },
    { label: "\u5DE5\u4F5C\u65B9\u5F0F", re: /你的工作方式是[：:]?/u },
    { label: "\u4EA4\u4ED8\u7269", re: /你的交付物是[：:]?/u },
    { label: "\u7EAA\u5F8B", re: /你的纪律是[：:]?/u }
  ];
  const hits = [];
  for (const mark of marks) {
    const found = mark.re.exec(text);
    if (found !== null) hits.push({ label: mark.label, start: found.index, end: found.index + found[0].length });
  }
  if (hits.length === 0) return [{ label: "\u89D2\u8272\u63D0\u793A\u8BCD", body: text }];
  hits.sort((a, b) => a.start - b.start);
  const blocks = [];
  const head = text.slice(0, hits[0].start).trim();
  if (head !== "") blocks.push({ label: "\u89D2\u8272", body: head });
  hits.forEach((hit, index) => {
    const stop = index + 1 < hits.length ? hits[index + 1].start : text.length;
    blocks.push({ label: hit.label, body: text.slice(hit.end, stop).trim() });
  });
  return blocks.filter((block) => block.body !== "");
}
var MEMBER_ROLE_LABEL = { lead: "\u{1F3C5} \u4E3B\u7406\u4EBA", member: "\u6210\u5458" };
function MemberDialog({ team, member, readOnly = false, onClose, onSaved }) {
  const [draft, setDraft] = (0, import_react.useState)(() => ({ ...member, persona: member.persona ?? "" }));
  const [personaEditing, setPersonaEditing] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const editable = readOnly !== true;
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const blocks = splitPersona(draft.persona);
  const inputStyle = {
    border: `1px solid ${S.line}`,
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    color: S.text,
    background: editable ? S.surface : S.soft
  };
  const line = (label, node) => /* @__PURE__ */ import_react.default.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: S.body } }, label, node);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const members = team.members.map((item) => item.id === member.id ? {
        ...item,
        name: draft.name.trim(),
        alias: draft.alias.trim(),
        emoji: draft.emoji.trim(),
        avatar: draft.avatar,
        role: draft.role,
        focus: draft.focus.trim(),
        persona: draft.persona.trim()
      } : item);
      await api("/teams", {
        method: "POST",
        body: JSON.stringify({ team: { ...team, members } })
      });
      onSaved();
    } catch (caught) {
      setError(String(caught?.message ?? caught));
    }
    setBusy(false);
  };
  return portalToBody(
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        style: {
          position: "fixed",
          inset: 0,
          // 压在画廊模态（9999）之上：成员详情是从详情页里再开的一层。
          zIndex: 1e4,
          background: "var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.42))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24
        }
      },
      /* @__PURE__ */ import_react.default.createElement(
        "div",
        {
          role: "dialog",
          "aria-label": `\u6210\u5458\u8BE6\u60C5\uFF1A${member.name}`,
          style: {
            width: "min(780px, 100%)",
            maxHeight: "min(88vh, 880px)",
            overflowY: "auto",
            background: S.surface,
            color: S.text,
            borderRadius: 16,
            border: `1px solid ${S.line}`,
            boxShadow: "var(--dsw-shadow-lv3, 0 24px 70px rgba(15, 23, 42, 0.3))",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            fontFamily: FONT
          }
        },
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ import_react.default.createElement(PersonAvatar, { seed: member.id, avatar: draft.avatar, size: 48 }), /* @__PURE__ */ import_react.default.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 17, fontWeight: 700 } }, draft.name !== "" ? draft.name : member.id), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 11.5, color: S.body, background: S.soft, borderRadius: 999, padding: "1px 8px" } }, MEMBER_ROLE_LABEL[draft.role] ?? draft.role), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12, color: S.muted } }, `${team.name} \xB7 ${member.id}`)), /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12.5, color: S.body, marginTop: 3 } }, `${draft.alias !== "" ? draft.alias : "\u2014"} \xB7 ${draft.focus !== "" ? draft.focus : "\u2014"}`)), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", "aria-label": "\u5173\u95ED", style: btn({ padding: "4px 10px" }), onClick: onClose }, "\u2715")),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } }, line("\u79F0\u547C", /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            value: draft.name,
            disabled: !editable,
            onChange: (event) => set("name", event.target.value),
            style: inputStyle
          }
        )), line("\u6635\u79F0\uFF08\u53EF\u9009\uFF09", /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            value: draft.alias,
            disabled: !editable,
            onChange: (event) => set("alias", event.target.value),
            style: inputStyle
          }
        )), line("\u804C\u8D23\u8303\u56F4", /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            value: draft.focus,
            disabled: !editable,
            onChange: (event) => set("focus", event.target.value),
            style: inputStyle
          }
        )), line("\u89D2\u8272", /* @__PURE__ */ import_react.default.createElement(
          "select",
          {
            value: draft.role,
            disabled: !editable,
            onChange: (event) => set("role", event.target.value),
            style: inputStyle
          },
          /* @__PURE__ */ import_react.default.createElement("option", { value: "member" }, "\u6210\u5458"),
          /* @__PURE__ */ import_react.default.createElement("option", { value: "lead" }, "\u4E3B\u7406\u4EBA")
        )), /* @__PURE__ */ import_react.default.createElement("div", { style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12, color: S.body } }, "\u6210\u5458\u5934\u50CF\uFF08\u540D\u518C / \u5361\u7247\u4E0A\u7684\u90A3\u5F20\u56FE\uFF09"), editable ? /* @__PURE__ */ import_react.default.createElement(
          AvatarPicker,
          {
            compact: true,
            value: draft.avatar,
            suggested: suggestAvatar(draft.id),
            onChange: (value) => set("avatar", value),
            name: "\u6210\u5458\u5934\u50CF"
          }
        ) : /* @__PURE__ */ import_react.default.createElement(AvatarImage, { index: avatarIndexOf(draft.id, draft.avatar), size: 40 }))),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, "\u4EBA\u683C\u8BBE\u5B9A persona\uFF08\u8FD9\u4F4D\u4E13\u5BB6\u5728\u72EC\u7ACB\u5B50\u4F1A\u8BDD\u91CC\u7684\u89D2\u8272\u63D0\u793A\u8BCD\uFF09"), editable && /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            style: btn({ padding: "3px 10px", fontSize: 12 }),
            onClick: () => setPersonaEditing((current) => !current)
          },
          personaEditing ? "\u770B\u7ED3\u6784\u5316\u89C6\u56FE" : "\u7F16\u8F91\u539F\u6587"
        )), personaEditing ? /* @__PURE__ */ import_react.default.createElement(
          "textarea",
          {
            value: draft.persona,
            onChange: (event) => set("persona", event.target.value),
            rows: 10,
            style: {
              border: `1px solid ${S.line}`,
              borderRadius: 8,
              padding: 10,
              fontSize: 12.5,
              lineHeight: 1.7,
              fontFamily: "inherit",
              color: S.text,
              resize: "vertical",
              background: S.soft
            }
          }
        ) : /* @__PURE__ */ import_react.default.createElement(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 9,
              background: S.soft,
              border: `1px solid ${S.line}`,
              borderRadius: 10,
              padding: "12px 14px"
            }
          },
          blocks.length === 0 && /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 12.5, color: S.muted } }, "\u8FD8\u6CA1\u6709\u5199\u4EBA\u683C\u63D0\u793A\u8BCD\u3002"),
          blocks.map((block) => /* @__PURE__ */ import_react.default.createElement("div", { key: block.label, style: { display: "flex", gap: 12 } }, /* @__PURE__ */ import_react.default.createElement("span", { style: { width: 62, flex: "none", fontSize: 12, color: S.muted, paddingTop: 3 } }, block.label), /* @__PURE__ */ import_react.default.createElement("span", { style: { fontSize: 13, lineHeight: 1.75, color: S.body, whiteSpace: "pre-wrap" } }, block.body)))
        )),
        !editable && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12.5, lineHeight: 1.7, color: "var(--dsw-alias-state-warn-label, #b45309)", background: "var(--dsw-alias-state-warn-tertiary, #fff7ed)", border: "1px solid var(--dsw-alias-state-warn-secondary, #fed7aa)", borderRadius: 8, padding: 10 } }, "\u5185\u7F6E\u56E2\u961F\u53EA\u8BFB\uFF08config.json \u91CC lockBuiltinTeams=true\uFF09\u3002\u56DE\u5199\u540C id \u4F1A\u628A\u6574\u652F\u56E2\u961F\u53D8\u6210\u4F60\u7684\u81EA\u5B9A\u4E49\u526F\u672C \u2014\u2014 \u5F00\u53D1\u9636\u6BB5\u60F3\u76F4\u63A5\u6539\u5B83\uFF0C\u628A $DSH_HOME/expert-teams/config.json \u7684 lockBuiltinTeams \u6539\u6210 false \u5373\u53EF\uFF1B \u5426\u5219\u8BF7\u4ECE\u8BE6\u60C5\u9875\u70B9\u300C\u7F16\u8F91\u300D\u628A\u5B83\u53E6\u5B58\u4E3A\u81EA\u5B9A\u4E49\u56E2\u961F\u540E\u518D\u6539\u3002"),
        error !== null && /* @__PURE__ */ import_react.default.createElement("div", { style: { fontSize: 12.5, color: "var(--dsw-alias-state-error-primary, #b42318)", background: "var(--dsw-alias-bg-layer-2, #fef3f2)", border: "1px solid var(--dsw-alias-state-error-secondary, #fecdca)", borderRadius: 8, padding: 10 } }, error),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", gap: 8 } }, editable && /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            style: primaryBtn({ opacity: busy ? 0.6 : 1 }),
            disabled: busy,
            onClick: save
          },
          busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u6210\u5458"
        ), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn(), onClick: onClose }, "\u5173\u95ED"))
      )
    )
  );
}
function portalToBody(node) {
  if (typeof document === "undefined") return node;
  const body = document.body;
  if (body === null || body === void 0) return node;
  return (0, import_react_dom.createPortal)(node, body);
}
function Modal() {
  const state = useStore();
  const team = (0, import_react.useMemo)(
    () => state.teams.find((item) => item.id === state.teamId) ?? null,
    [state.teams, state.teamId]
  );
  const close = (0, import_react.useCallback)(() => patch({ open: false, error: null }), []);
  const load = (0, import_react.useCallback)(async () => {
    try {
      const payload = await api("/teams");
      patch({
        teams: payload.teams ?? [],
        loaded: true,
        error: null,
        ...payload.config === void 0 || payload.config === null ? {} : { config: payload.config }
      });
    } catch (error) {
      patch({ loaded: true, error: String(error?.message ?? error) });
    }
  }, []);
  (0, import_react.useEffect)(() => {
    if (state.open) void load();
  }, [state.open, state.loadToken, load]);
  (0, import_react.useEffect)(() => {
    if (!state.open) return void 0;
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, close]);
  if (!state.open) return null;
  const onSummoned = () => {
    close();
    void load();
  };
  const page = state.view === "gallery" ? S.page : S.surface;
  const caseView = state.caseView;
  const caseTeam = caseView === null || caseView === void 0 ? null : state.teams.find((item) => item.id === caseView.teamId) ?? null;
  const caseItem = caseTeam === null ? null : (caseTeam.cases ?? [])[caseView.index] ?? null;
  const caseNode = caseTeam !== null && caseItem !== null ? /* @__PURE__ */ import_react.default.createElement(
    CaseDialog,
    {
      team: caseTeam,
      item: caseItem,
      onClose: () => patch({ caseView: null }),
      onSameStyle: () => {
        activateTeam(caseTeam, sameStylePrompt(caseTeam, caseItem));
        patch({ caseView: null });
      }
    }
  ) : null;
  return portalToBody(
    /* @__PURE__ */ import_react.default.createElement(
      "div",
      {
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close();
        },
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.42))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24
        }
      },
      /* @__PURE__ */ import_react.default.createElement(
        "div",
        {
          role: "dialog",
          "aria-label": "\u4E13\u5BB6\u56E2",
          style: {
            width: "min(1120px, 100%)",
            maxHeight: "min(88vh, 940px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: page,
            color: S.text,
            borderRadius: 16,
            border: `1px solid ${S.line}`,
            boxShadow: "var(--dsw-shadow-lv3, 0 24px 60px rgba(15, 23, 42, 0.24))",
            fontFamily: FONT
          }
        },
        /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "16px 20px 0" } }, /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "flex", gap: 8 } }, state.view !== "editor" && /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn({ padding: "5px 12px", fontSize: 12.5 }), onClick: () => patch({ view: "editor", teamId: null, error: null }) }, "+ \u65B0\u5EFA\u56E2\u961F")), /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            "aria-label": "\u5173\u95ED",
            title: "\u5173\u95ED",
            onClick: close,
            style: {
              marginLeft: "auto",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 18,
              lineHeight: 1,
              color: S.muted,
              padding: "4px 8px",
              borderRadius: 8
            }
          },
          "\u2715"
        )),
        state.error !== null && /* @__PURE__ */ import_react.default.createElement("div", { style: { margin: "12px 20px 0", fontSize: 12.5, color: "var(--dsw-alias-state-error-primary, #b42318)", background: "var(--dsw-alias-bg-layer-2, #fef3f2)", border: "1px solid var(--dsw-alias-state-error-secondary, #fecdca)", borderRadius: 8, padding: 10 } }, state.error),
        /* @__PURE__ */ import_react.default.createElement("div", { style: { flex: 1, overflow: "auto", padding: "14px 20px 20px" } }, state.view === "editor" && /* @__PURE__ */ import_react.default.createElement(
          TeamEditor,
          {
            key: team === null ? "new" : `edit:${team.id}`,
            initial: team,
            config: state.config,
            onCancel: () => patch({ view: team !== null ? "detail" : "gallery" }),
            onSaved: () => {
              patch({ view: "gallery", teamId: null });
              void load();
            }
          }
        ), state.view === "gallery" && /* @__PURE__ */ import_react.default.createElement(
          Gallery,
          {
            state,
            onOpenTeam: (id) => patch({ view: "detail", teamId: id }),
            onCreate: () => patch({ view: "editor", teamId: null }),
            onSort: (sort) => patch({ sort }),
            onCategory: (category) => patch({ category })
          }
        ), state.view === "detail" && team !== null && /* @__PURE__ */ import_react.default.createElement(
          Detail,
          {
            key: team.id,
            team,
            state,
            onBack: () => patch({ view: "gallery", teamId: null }),
            onEdit: () => patch({ view: "editor" }),
            onSummoned,
            onRefresh: load,
            onOpenCase: (caseIndex) => patch({ caseView: { teamId: team.id, index: caseIndex } })
          }
        ), state.view === "detail" && team === null && /* @__PURE__ */ import_react.default.createElement("div", { style: { padding: 30, textAlign: "center", color: S.muted } }, "\u56E2\u961F\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09\u3002", /* @__PURE__ */ import_react.default.createElement("div", { style: { marginTop: 12 } }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", style: btn(), onClick: () => patch({ view: "gallery", teamId: null }) }, "\u8FD4\u56DE\u753B\u5ECA"))))
      ),
      caseNode
    )
  );
}
function apply(ctx) {
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: PLUGIN_ID,
    order: 40
  }, Trigger));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: PLUGIN_ID,
    order: 40
  }, Modal));
}
  return module.exports;
} });
