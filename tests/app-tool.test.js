import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import app from "../index.js";
import { permissionPresentation } from "../ui/assets/permission-status.js";

function createContext({ answer, askError, capabilityError, modelText = '{"mustAsk":false,"reason":""}', storageSeed = {}, sessionList = null, updateError = null, sendError = null, historyMessages = null } = {}) {
  const registrations = new Map();
  const hooks = new Map();
  const routes = new Map();
  const storage = new Map(Object.entries(storageSeed));
  const modelCalls = [];
  const questions = [];
  const stagedFiles = [];
  const capabilityCalls = [];
  const historyCalls = [];
  const updateCalls = [];
  const sendCalls = [];
  const sessionListCalls = [];
  const inputStatusCalls = [];
  const panelShows = [];
  const panelDismisses = [];
  const logs = { info: [], warn: [], debug: [] };
  let busHandler = null;
  const context = {
    dataDir: "C:/isolated-test/app-data",
    bus: {
      subscribe: async (handler) => { busHandler = handler; return { ready: Promise.resolve(), dispose() {} }; },
      request: async (type, input) => {
      if (type === "app:capabilities") {
        capabilityCalls.push(input);
        if (capabilityError) throw capabilityError;
        return { capabilities: [
          { capability: "app/tools.expose-to-model", status: "always", enforcement: "hard" },
          { capability: "app/process.spawn", status: "not_asked", enforcement: "hard" },
        ] };
      }
      if (type === "session:context") return { model: { provider: "test-provider", modelId: "test-model" } };
      if (type === "session:history") { historyCalls.push(input); return { messages: historyMessages || [
        { role: "user", content: "帮我想想怎么给花浇水。", entryId: "e1" },
        { role: "assistant", content: "先看土壤干湿，再沿盆边慢慢浇。", entryId: "e2" },
      ] }; }
      if (type === "session:list") {
        sessionListCalls.push(input);
        // 数组给固定名单；函数形式每次现取，既能换数据也能在函数里抛错模拟读不到。
        if (typeof sessionList === "function") return { sessions: sessionList() };
        if (sessionList === null) throw new Error("测试里没有给会话名单");
        return { sessions: sessionList };
      }
      if (type === "session:update") {
        updateCalls.push(input);
        if (updateError) throw updateError;
        return { ok: true, sessionId: input?.sessionId };
      }
      if (type === "session:send") {
        sendCalls.push(input);
        if (sendError) throw sendError;
        return { ok: true, accepted: true, sessionId: input?.sessionId };
      }
      return null;
    } },
    logger: {
      info: async (message, detail) => { logs.info.push({ message, detail }); },
      warn: async (message, detail) => { logs.warn.push({ message, detail }); },
      debug: async (message, detail) => { logs.debug.push({ message, detail }); },
    },
    tools: {
      register: async (spec) => {
        registrations.set(spec.name, spec);
        return { ready: Promise.resolve() };
      },
    },
    routes: { register: async (registrar) => {
      registrar({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
        put: (path, handler) => routes.set(`PUT ${path}`, handler),
      });
      return { ready: Promise.resolve(), dispose() {} };
    } },
    process: { resolveExecutable: async () => null },
    sessions: {
      context: async () => ({ model: { provider: "test-provider", modelId: "test-model" } }),
      history: async (options) => {
        historyCalls.push(options);
        return { messages: [
          { role: "user", content: "帮我想想怎么给花浇水。" },
          { role: "assistant", content: "先看土壤干湿，再沿盆边慢慢浇。", thinking: "隐藏思考不应进入推荐提示词" },
        ] };
      },
    },
    inputStatus: { set: async (input) => { inputStatusCalls.push({ ...input }); } },
    resources: {
      stage: async (input) => {
        stagedFiles.push({ ...input, content: await readFile(input.path, "utf8") });
        return { resource: { kind: "session-file", fileId: "sf_recommendation_card" } };
      },
    },
    network: { fetch: async () => { throw new Error("unexpected network request"); } },
    models: {
      list: async () => ({ models: [{ provider: "test-provider", model: "test-model", name: "测试模型", isCurrent: true }] }),
      stream: async (request) => {
        modelCalls.push(request);
        const delta = JSON.stringify({ type: "text-delta", delta: modelText });
        const done = JSON.stringify({ type: "done", assistant: { content: [{ type: "text", text: modelText }] } });
        return new Response(`${delta}\n${done}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
      },
      cancel: async () => {},
    },
    media: {},
    providers: {},
    hooks: {
      onDecision: async (word, handler) => {
        hooks.set(word, handler);
        return { ready: Promise.resolve(), dispose() { hooks.delete(word); } };
      },
    },
    userInteraction: {
      ask: async (question) => {
        questions.push(question);
        if (askError) throw askError;
        return answer ?? { action: "confirmed", value: { choice: "先做校验" } };
      },
      show: async (value) => { panelShows.push(value); return { panelId: "panel-test" }; },
      dismiss: async (value) => { panelDismisses.push(value); return { ok: true }; },
    },
    storage: {
      global: {
        get: (key, fallback = undefined) => storage.has(key) ? storage.get(key) : fallback,
        set: (key, value) => { storage.set(key, value); },
      },
      agent: () => ({}),
    },
  };
  return {
    context,
    questions,
    modelCalls,
    stagedFiles,
    capabilityCalls,
    historyCalls,
    updateCalls,
    sendCalls,
    sessionListCalls,
    inputStatusCalls,
    panelShows,
    panelDismisses,
    logs,
    /** 把一条宿主事件喂给 App 的订阅处理器。 */
    emitBus(event, sessionPath = "") {
      return busHandler ? busHandler(event, sessionPath) : Promise.resolve(null);
    },
    get registration() { return registrations.get('jiegehua_zhiyi_ask'); },
    tool(name) { return registrations.get(name); },
    hook(word) { return hooks.get(word); },
    route(method, path) { return routes.get(`${method} ${path}`); },
    stored(key) { return storage.get(key); },
  };
}

const args = {
  title: "决定先做什么",
  question: "先处理哪项？",
  recommendation: "先做校验",
  reason: "可以早点发现输入问题。",
  options: ["先做校验", "先改界面"],
  selectionMode: "single",
  context: { sessionPath: "sessions/current.jsonl" },
};
const multipleArgs = {
  ...args,
  question: "哪些设置都需要？",
  recommendation: "加密",
  selectionMode: "multiple",
  minSelections: 1,
  maxSelections: 2,
};

async function registeredTool(mock) {
  await app.apply(mock.context);
  assert.ok(mock.registration, "app should register its Ask tool");
  return mock.registration;
}

test("no longer declares a chat-selection context menu or a read-aloud status item", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.contributes.ui.contextMenus, undefined, "聊天区右键朗读已撤掉");
  assert.equal(manifest.contributes.ui.messageActions, undefined, "朗读入口已从回复末尾移入输入框面板");
  assert.equal(manifest.contributes.ui.inputStatus.some((item) => item.id === "read-aloud-status"), false, "输入栏不再摆「就绪」状态位");
  assert.ok(manifest.contributes.ui.inputStatus.some((item) => item.id === "zhiyi-suggest"), "知意按钮要留着");
});

test("panel ES module parses as a whole without duplicate bindings", { skip: !vm.SourceTextModule }, async () => {
  const source = await readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new vm.SourceTextModule(source));
  assert.equal((source.match(/async function refreshResumeStatus\(/g) || []).length, 1);
  assert.doesNotMatch(source, /loadResumeConfig|saveResumeConfig|startResumePolling|resumeCooldownGroup|resumeSessionId/);
});

test("panel full-module resume initialization and DOM interactions", { skip: !vm.SourceTextModule }, async (t) => {
  class Element {
    constructor(tag = "div") {
      Object.assign(this, { tagName: tag.toUpperCase(), dataset: {}, disabled: false, hidden: false,
        checked: false, value: "", textContent: "", children: [], listeners: new Map(), attributes: new Map(),
        style: {}, classList: { toggle() {}, add() {}, remove() {} } });
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelectorAll(selector) { return selector.includes("button") ? this.children.filter(child => child.tagName === "BUTTON") : []; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    closest() { return this; }
    contains(node) { return this === node || this.children.includes(node); }
    focus() {}
    pause() {}
  }
  const [source, html] = await Promise.all([
    readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
  ]);
  const elements = new Map();
  // All real page IDs are present, including the IDs that used to wake the legacy controller.
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    assert.ok(!elements.has(match[2]), `duplicate HTML id: ${match[2]}`);
    const element = new Element(match[1]);
    // 认一下标签上的 hidden：不然构造器默认的 false 会把“这一段本来就该藏起来”掩盖掉。
    if (/\shidden(\s|>|$)/.test(match[0])) element.hidden = true;
    elements.set(match[2], element);
  }
  for (const match of html.matchAll(/<div\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)) {
    const group = elements.get(match[1]);
    if (!group) continue;
    for (const buttonMatch of match[2].matchAll(/<button\b[^>]*data-value="([^"]+)"[^>]*>/g)) {
      const button = new Element("button");
      button.dataset.value = buttonMatch[1];
      group.append(button);
    }
  }
  const document = new Element();
  document.head = new Element("head");
  document.body = new Element("body");
  document.documentElement = new Element("html");
  document.querySelector = selector => elements.get(selector.replace(/^#/, "")) || null;
  document.querySelectorAll = () => [];
  document.createElement = tag => new Element(tag);
  let config = { enabled: false, autoResume: false, maxConsecutive: 3 };
  // 断点续接默认冻结（2026-10-19）：设置页不显示、不读设置、不读结果。
  let frozen = true;
  const FREEZE_PHRASE = "面板测试暗号";
  let failPut = false;
  let legacyResults = false;
  let recommendationConfig = { display: "ball", count: 3, styles: [], selectedByCount: {} };
  let fastTestResult = { ok: true, modelName: "openai-codex/gpt-6-luna", effort: "", reasoningTokens: 0, elapsedMs: 3595, sample: "短任务正文" };
  const recommendationPuts = [];
  const puts = [], calls = [], intervals = [];
  const items = [
    { agentName: "测试伙伴A", title: "测试窗口A", attempt: 1, maxConsecutive: 3, status: "waiting" },
    { agentName: "测试伙伴B", title: "测试窗口B", attempt: 3, maxConsecutive: 3, status: "limit" },
  ];
  const hana = {
    ready: async () => {}, theme: { getSnapshot: () => ({ appearance: "light" }), subscribe() {} },
    api: { fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (url === "/resume-config" && options.method === "PUT") {
        const body = JSON.parse(options.body);
        puts.push(body);
        if (failPut) return { ok: false, json: async () => ({ ok: false, error: "测试失败" }) };
        config = { ...config, ...body.config };
      }
      if (url === "/resume-freeze" && options.method === "POST") {
        const body = JSON.parse(options.body);
        if (body.phrase !== FREEZE_PHRASE) {
          return { ok: false, json: async () => ({ ok: false, error: "暗号不对，冻结状态没变。" }) };
        }
        frozen = body.frozen === true;
        return { ok: true, json: async () => ({ ok: true, frozen }) };
      }
      if (url === "/recommendation-config" && options.method === "PUT") {
        const body = JSON.parse(options.body);
        recommendationPuts.push(body);
        recommendationConfig = { ...recommendationConfig, ...body };
      }
      const payload = url === "/fast-model/test" ? fastTestResult
        : url === "/fast-model" ? { ok: true, models: [{ key: "openai-codex/gpt-6-luna", provider: "openai-codex", model: "gpt-6-luna", name: "6luna" }], modelRef: { provider: "openai-codex", model: "gpt-6-luna" } }
        : url === "/recommendation-config" ? { ok: true, ...recommendationConfig }
        : url === "/resume-config" ? { ok: true, config, frozen }
        : url === "/resume-status" ? { ok: true, config, ...(legacyResults ? { items } : { progress: items }) }
          : { ok: true, config: { enabled: false, minChars: 600 }, models: [], items: [], styles: [],
            display: "off", count: 3, selectedByCount: {}, partners: [], voices: [], presets: [], running: false };
      return { ok: true, json: async () => payload };
    } },
  };
  const context = vm.createContext({ document, HTMLElement: Element, hana, console,
    setTimeout, clearTimeout, setInterval: (...args) => { intervals.push(args); return intervals.length; },
    clearInterval() {}, URL, Blob, atob });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async specifier => {
    if (specifier === "./sdk.js") return new vm.SyntheticModule(["hana"], function () { this.setExport("hana", hana); }, { context });
    if (specifier === "./permission-status.js") return new vm.SyntheticModule(["initPermissionStatus"], function () {
      this.setExport("initPermissionStatus", () => {});
    }, { context });
    throw new Error(`unexpected import ${specifier}`);
  });
  await module.evaluate();
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  const get = id => elements.get(id);
  const click = async (id, value) => {
    const element = get(id);
    const target = value === undefined ? element : element.children.find(child => child.dataset.value === value);
    assert.ok(target);
    assert.equal(target.disabled, false, `click on disabled ${id}`);
    for (const handler of element.listeners.get("click") || []) await handler({ target });
    await flush();
  };
  // 不带 data-value 的普通元素（标题连点）走这条，不查 disabled。
  const fire = async (id) => {
    const element = get(id);
    for (const handler of element.listeners.get("click") || []) await handler({ target: element });
    await flush();
  };
  await t.test("fast test result clearly reports success and seconds without treating zero as proof of no thinking", async () => {
    await click("fast-model-test");
    const text = get("fast-model-status").textContent;
    assert.match(text, /测试通过/);
    assert.match(text, /3\.6 秒/);
    assert.match(text, /模型默认档/);
    assert.doesNotMatch(text, /思考用了 0|已关思考|已关闭思考/);
  });
  await t.test("fast test result distinguishes requested thinking level and reported positive usage", async () => {
    fastTestResult = { ...fastTestResult, effort: "low", reasoningTokens: 12 };
    await click("fast-model-test");
    const text = get("fast-model-status").textContent;
    assert.match(text, /低思考档/);
    assert.match(text, /思考用了 12 token/);
  });
  await t.test("recommendation ball mode loads with an enabled status instead of the removed card mode", () => {
    assert.equal(get("rec-display").children.find(button => button.dataset.value === "ball").getAttribute("aria-pressed"), "true");
    assert.match(get("rec-status").textContent, /^已开启/);
  });
  await t.test("recommendation off mode saves and renders the confirmed off response", async () => {
    await click("rec-display", "off");
    await new Promise(resolve => setTimeout(resolve, 400));
    await flush();
    assert.equal(recommendationPuts.length, 1);
    assert.equal(recommendationPuts.at(-1).display, "off");
    assert.equal(recommendationConfig.display, "off");
    assert.equal(get("rec-display").children.find(button => button.dataset.value === "off").getAttribute("aria-pressed"), "true");
    assert.match(get("rec-status").textContent, /^已关闭/);
  });
  await t.test("recommendation ball mode saves and renders the confirmed enabled response", async () => {
    await click("rec-display", "ball");
    await new Promise(resolve => setTimeout(resolve, 400));
    await flush();
    assert.equal(recommendationPuts.length, 2);
    assert.equal(recommendationPuts.at(-1).display, "ball");
    assert.equal(recommendationConfig.display, "ball");
    assert.equal(get("rec-display").children.find(button => button.dataset.value === "ball").getAttribute("aria-pressed"), "true");
    assert.match(get("rec-status").textContent, /^已开启/);
  });
  await t.test("startup executes the whole module with one resume controller", () => {
    assert.equal(document.documentElement.dataset.ready, "true");
    for (const id of ["resume-enabled", "resume-auto", "resume-max-down", "resume-max-up", "resume-save", "resume-refresh-status"]) {
      assert.equal(get(id).listeners.get("click")?.length, 1, `duplicate listener ${id}`);
    }
    assert.equal(intervals.length, 0, "legacy resume polling must not be started");
  });
  await t.test("冻结层拆了：设置区直接可见，进来就读设置与结果", async () => {
    await Promise.resolve();
    assert.notEqual(get("resume-section").hidden, true, "设置区必须直接露出来");
    assert.equal(calls.filter(call => call.url === "/resume-config").length, 1, "进来读一次设置");
    assert.equal(calls.filter(call => call.url === "/resume-status").length, 1, "进来读一次续接结果");
    assert.equal(calls.filter(call => call.url === "/resume-freeze").length, 0, "解冻入口已经拆掉");
  });
  await t.test("enabled toggle sends exactly one enabled-only PUT", async () => {
    const count = puts.length;
    await click("resume-enabled", "on");
    assert.equal(puts.length, count + 1);
    assert.deepEqual(puts.at(-1), { config: { enabled: true } });
  });
  await t.test("auto toggle sends exactly one auto-only PUT", async () => {
    const count = puts.length;
    await click("resume-auto", "on");
    assert.equal(puts.length, count + 1);
    assert.deepEqual(puts.at(-1), { config: { autoResume: true } });
  });
  await t.test("max-only save preserves concurrent ball auto change and redraws response", async () => {
    config.autoResume = false;
    await click("resume-max-up");
    await click("resume-save");
    assert.deepEqual(puts.at(-1), { config: { maxConsecutive: 4 } });
    assert.equal(config.autoResume, false);
    assert.equal(get("resume-auto").children.find(button => button.dataset.value === "off").getAttribute("aria-pressed"), "true");
  });
  await t.test("max stepper clamps to 1-10", async () => {
    for (let i = 0; i < 20 && !get("resume-max-up").disabled; i++) await click("resume-max-up");
    assert.equal(get("resume-max").textContent, "10");
    assert.equal(get("resume-max-up").disabled, true);
    for (let i = 0; i < 20 && !get("resume-max-down").disabled; i++) await click("resume-max-down");
    assert.equal(get("resume-max").textContent, "1");
    assert.equal(get("resume-max-down").disabled, true);
    await click("resume-save");
  });
  await t.test("failed PUT restores saved settings without legacy overwrite", async () => {
    failPut = true;
    const count = puts.length;
    await click("resume-enabled", "off");
    assert.equal(puts.length, count + 1);
    assert.equal(get("resume-enabled").children.find(button => button.dataset.value === "on").getAttribute("aria-pressed"), "true");
    assert.match(get("resume-status").textContent, /测试失败/);
  });
  await t.test("progress renders all windows from the no-session endpoint", async () => {
    const count = calls.filter(call => call.url === "/resume-status").length;
    await click("resume-refresh-status");
    assert.equal(calls.filter(call => call.url === "/resume-status").length, count + 1);
    assert.equal(get("resume-results").children.length, 2);
    assert.match(get("resume-results").children[0].children[1].textContent, /已发送 1\/3/);
    assert.match(get("resume-results").children[1].children[1].textContent, /达到上限/);
  });
  await t.test("items compatibility fallback still renders the full list", async () => {
    legacyResults = true;
    await click("resume-refresh-status");
    assert.equal(get("resume-results").children.length, 2);
  });
});

test("panel preserves running/stopping state when an API request fails", async () => {
  const panel = await readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8");
  assert.match(panel, /if\s*\(!response\.ok\)\s*\{/);
  assert.doesNotMatch(panel, /!response\.ok\s*\|\|\s*payload\?\.ok\s*===\s*false/);
  assert.match(panel, /:\s*\{\s*\.\.\.currentBallState,\s*error:\s*message\s*\}/);
  assert.doesNotMatch(panel, /setBallState\(\{\s*running:\s*false,\s*error:/);
});

test("permission status endpoint reads the current App ledger without changing it", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const response = await mock.route("GET", "/permission-status")({
    json: (data, status) => ({ data, status }),
  });
  assert.equal(response.data.ok, true);
  assert.deepEqual(mock.capabilityCalls, [{}]);
  assert.deepEqual(response.data.capabilities, [
    { capability: "app/tools.expose-to-model", status: "always", enforcement: "hard" },
    { capability: "app/process.spawn", status: "not_asked", enforcement: "hard" },
  ]);

  const failedMock = createContext({ capabilityError: new Error("private host detail") });
  await registeredTool(failedMock);
  const failed = await failedMock.route("GET", "/permission-status")({
    json: (data, status) => ({ data, status }),
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.data.ok, false);
  assert.doesNotMatch(JSON.stringify(failed.data), /private host detail/);
});

test("permission labels show scope accurately and unknown states fail closed", () => {
  assert.deepEqual(permissionPresentation("always"), ["始终允许", "allowed"]);
  assert.deepEqual(permissionPresentation("session"), ["会话范围授权", "session"]);
  assert.deepEqual(permissionPresentation("denied"), ["已拒绝", "denied"]);
  assert.deepEqual(permissionPresentation("not_asked"), ["尚未询问", "not-asked"]);
  assert.deepEqual(permissionPresentation("future-status"), ["无法确认", "unknown"]);
  assert.deepEqual(permissionPresentation(undefined), ["无法确认", "unknown"]);
});

test("permission state appears in settings and the host function panel", async () => {
  const [html, functionPanel, manifest] = await Promise.all([
    readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/permission-panel.html", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /permission-status-list/);
  assert.match(functionPanel, /permission-status-list/);
  assert.match(functionPanel, /只读取状态/);
  assert.equal(manifest.contributes.cards[0].fpFullPanel, true);
  assert.deepEqual(manifest.contributes.cards[0].functionPanel, {
    id: "permissions", label: "权限状态", route: "/permission-panel.html",
  });
});

test("summary settings use an accessible stepper and model picker without changing the original reply", async () => {
  const [html, panel] = await Promise.all([
    readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="summary-min-chars-down"/);
  assert.match(html, /id="summary-min-chars-up"/);
  assert.match(html, /<output id="summary-min-chars"/);
  assert.match(html, /id="summary-retry"[^>]*hidden/);
  assert.doesNotMatch(html, /<select\b|type="number"/);
  assert.match(html, /原文不会删改/);
  assert.match(html, /保留当前数值/);
  assert.match(panel, /let summaryLoaded = false;/);
  assert.match(panel, /if \(!summaryLoaded \|\| summarySaving \|\| !summarySettingsDirty\(\)\) return;/);
  assert.match(panel, /读取失败，设置已锁定/);
  assert.match(panel, /summaryRetry\?\.addEventListener/);
});

test("one content model serves recommendation, Ask precheck and summary", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const respond = (data, status = 200) => ({ data, status });
  const getResult = await mock.route("GET", "/content-model")({ json: (data, status) => respond(data, status) });
  assert.equal(getResult.data.models[0].key, "test-provider/test-model");
  assert.equal(getResult.data.modelRef, null);
  assert.equal(getResult.data.merged, false);

  const putResult = await mock.route("PUT", "/content-model")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(putResult.data.ok, true);
  // 一次写入，三个调用点同步；这是「只留一个内容模型」的全部含义。
  for (const key of ["recommendationModel", "askJudgeModel", "summaryModel"]) {
    assert.deepEqual(mock.stored(key), { provider: "test-provider", model: "test-model" }, key);
  }

  const cleared = await mock.route("PUT", "/content-model")({
    req: { json: async () => ({ modelRef: null }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(cleared.data.ok, true);
  for (const key of ["recommendationModel", "askJudgeModel", "summaryModel"]) {
    assert.equal(mock.stored(key), null, key);
  }

  const testResult = await mock.route("POST", "/content-model/test")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(testResult.data.ok, true);
});

test("content model picker is marked when the three call sites used different models", async () => {
  const mock = createContext({
    storageSeed: {
      recommendationModel: { provider: "test-provider", model: "test-model" },
      askJudgeModel: null,
      summaryModel: null,
    },
  });
  await registeredTool(mock);
  const getResult = await mock.route("GET", "/content-model")({
    json: (data, status) => ({ data, status }),
  });
  assert.deepEqual(getResult.data.modelRef, { provider: "test-provider", model: "test-model" });
  assert.equal(getResult.data.merged, false);
});

test("model settings expose a connection test and clear save feedback", async () => {
  const [html, panel] = await Promise.all([
    readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="content-model-test"[^>]*>测试连接/);
  assert.match(html, /id="content-model-save"[^>]*>已保存/);
  assert.match(html, /id="content-model-trigger"[^>]*aria-haspopup="listbox"/);
  assert.match(panel, /已保存 ✓/);
  assert.match(panel, /重试保存/);
  assert.match(panel, /状态未知/);
  assert.match(panel, /这次测试没有保存选择/);
  assert.match(panel, /content-model/);
});

test("settings page keeps common switches and moves the rest into one dialog", async () => {
  const [html, panel] = await Promise.all([
    readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/assets/panel.js", import.meta.url), "utf8"),
  ]);
  // 常用开关留在主页面
  for (const id of ["ask-display", "rec-display", "rec-count", "summary-enabled", "ball-toggle"]) {
    assert.ok(html.includes(`id="${id}"`), `主页面缺少 ${id}`);
  }
  // 传音樱不再占一张卡片：开关做成页头按钮，状态行紧跟页头
  assert.match(html, /class="head-actions"/);
  assert.match(html, /id="ball-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="ball-toggle-label"/);
  assert.match(html, /id="ball-status"[^>]*page-ball-status/);
  assert.doesNotMatch(html, /id="ball-start"/);
  assert.doesNotMatch(html, /id="ball-stop"/);
  assert.doesNotMatch(panel, /#ball-start|#ball-stop/);
  // 首次使用提醒提到页面开头（在第一个 settings-section 之前）
  assert.ok(html.indexOf("第一次使用") < html.indexOf('id="ask-display"'));
  // 不常用的一律进弹窗，弹窗本体有 head / body / foot 三段，关闭键常驻
  assert.match(html, /id="open-settings"/);
  assert.match(html, /id="settings-modal"[^>]*hidden/);
  assert.match(html, /class="modal-head"/);
  assert.match(html, /class="modal-body"/);
  assert.match(html, /class="modal-foot"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  for (const id of ["content-model-trigger", "custom-baseurl", "voice-section", "resume-section", "permission-status-list", "ball-modal-state"]) {
    assert.ok(html.includes(`id="${id}"`), `弹窗缺少 ${id}`);
  }
  // 起标题 / 捋一捋 / 排队 / 试听这些功能不再占设置页，代码也一并收干净
  for (const gone of ["polish-input", "title-run", "send-input", "voice-replies", "voice-speak"]) {
    assert.doesNotMatch(html, new RegExp(`id="${gone}"`));
    assert.doesNotMatch(panel, new RegExp(`#${gone}`));
  }
  assert.match(panel, /function openSettings\(\)/);
  assert.match(panel, /if \(event\.target === settingsModal\) closeSettings\(\);/);
});

test("registers a model-facing Ask tool and scoped card handoff tools", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  assert.equal(tool.name, "jiegehua_zhiyi_ask");
  assert.equal(tool.sessionPermission.readOnly, true);
  assert.match(tool.description, /该字段只表示答案形式，不表示执行授权/);
  assert.match(tool.description, /不授权外部或破坏性操作/);
  assert.match(tool.description, /高影响选项必须说明具体目标、实际后果、备份情况和替代方案/);
  assert.match(tool.description, /必须明确填写 selectionMode/);
  assert.deepEqual(tool.parameters.properties.selectionMode.enum, ['single', 'multiple']);
  assert.ok(tool.parameters.required.includes('selectionMode'));
  assert.ok(mock.tool('jiegehua_zhiyi_bind_card'));
  assert.ok(mock.tool('jiegehua_zhiyi_resolve_card'));
  assert.ok(mock.tool('jiegehua_zhiyi_native_fallback'));
  const recommendations = mock.tool('jiegehua_zhiyi_suggest_replies');
  assert.equal(recommendations, undefined, '推荐回复只活在传音樱里，主对话不再注册这个工具');
  assert.equal(mock.tool('jiegehua_zhiyi_send_recommendation'), undefined, '卡片直发工具随卡片一起下线');
});

test("adds Ask guidance to the system prompt before each agent turn without calling a model", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const hook = mock.hook("agent/before-start");
  assert.equal(typeof hook, "function");

  const result = await hook({
    prompt: "早上好呀",
    systemPrompt: "伙伴人格提示",
    session: { sessionId: "session-1", sessionPath: "sessions/current.jsonl" },
  });
  assert.equal(result.message, undefined);
  assert.match(result.systemPrompt, /^伙伴人格提示\n\n/);
  assert.match(result.systemPrompt, /实质改变行动、风险、成本或结果/);
  assert.match(result.systemPrompt, /不要只在普通回复里用文字问选项/);
  assert.match(result.systemPrompt, /没有收到有效选择前/);
  assert.match(result.systemPrompt, /本地目录 App 普通更新优先重新加载/);
  assert.match(result.systemPrompt, /不等于授权执行外部或不可逆操作/);
  assert.match(result.systemPrompt, /只有缺少授权时，才按正常边界另行确认/);
  assert.match(result.systemPrompt, /明确填写 selectionMode/);
  assert.match(result.systemPrompt, /发出待发卡后不得重调 Ask 工具/);
  assert.equal(mock.questions.length, 0);
  assert.equal(mock.modelCalls.length, 0);

  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.capabilities.includes("app/hooks.agent-before-start"));
  assert.ok(manifest.capabilities.includes("app/models.infer"));
  assert.ok(manifest.capabilities.includes("app/sessions.read"));
  // 标题写回 / 直发 / 排队 / 分支 共用这一扇门
  assert.ok(manifest.capabilities.includes("app/sessions.manage"));
});

test("candidate decision prompts receive a one-call model precheck and stronger Ask guidance", async () => {
  const mock = createContext({ modelText: '{"mustAsk":true,"reason":"云端与本地会改变隐私边界和使用方式"}' });
  await registeredTool(mock);
  const result = await mock.hook("agent/before-start")({
    prompt: "日记应用第一版只能选一种：云同步还是只在本地保存？我还没决定更看重哪边。",
    systemPrompt: "",
    session: { sessionId: "session-1", sessionPath: "sessions/current.jsonl" },
  });
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.modelCalls[0].provider, "test-provider");
  assert.equal(mock.modelCalls[0].model, "test-model");
  // 推理模型的思考和正文共用 maxTokens，给太少会出现「连上了但没有正文」。
  // 不该再传 reasoningEffort：模型不支持时宿主会直接拒掉整个请求。
  assert.equal(mock.modelCalls[0].maxTokens, 400);
  assert.equal("reasoningEffort" in mock.modelCalls[0], false);
  assert.match(mock.modelCalls[0].messages[0].content, /云同步还是只在本地保存/);
  assert.match(result.systemPrompt, /独立决策预检发现/);
});

test("model picker reads Hana catalog and persists a validated model choice", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const respond = (data, status = 200) => ({ data, status });
  const getResult = await mock.route("GET", "/ask-model")({ json: (data, status) => respond(data, status) });
  assert.equal(getResult.data.models[0].key, "test-provider/test-model");
  assert.equal(getResult.data.modelRef, null);
  const putResult = await mock.route("PUT", "/ask-model")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(putResult.data.ok, true);
  assert.deepEqual(mock.stored("askJudgeModel"), { provider: "test-provider", model: "test-model" });
});

test("recommendation model picker validates and saves an independent model choice", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const respond = (data, status = 200) => ({ data, status });
  const getResult = await mock.route("GET", "/recommendation-model")({ json: (data, status) => respond(data, status) });
  assert.equal(getResult.data.models[0].key, "test-provider/test-model");
  assert.equal(getResult.data.modelRef, null);
  const putResult = await mock.route("PUT", "/recommendation-model")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(putResult.data.ok, true);
  assert.deepEqual(mock.stored("recommendationModel"), { provider: "test-provider", model: "test-model" });
  const testResult = await mock.route("POST", "/recommendation-model/test")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => respond(data, status),
  });
  assert.equal(testResult.data.ok, true);
  assert.equal(mock.modelCalls.length, 1);
  assert.deepEqual(mock.stored("recommendationModel"), { provider: "test-provider", model: "test-model" });
});

test("model connectivity test calls the selected model without saving its selection", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const result = await mock.route("POST", "/ask-model/test")({
    req: { json: async () => ({ modelRef: { provider: "test-provider", model: "test-model" } }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.name, "测试模型");
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.stored("askJudgeModel"), undefined);
});

test("fast-model test uses the current unsaved selection instead of stored fast model", async () => {
  const saved = { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" };
  const selected = { provider: "openai-codex", model: "gpt-6-luna" };
  const mock = createContext({ storageSeed: { fastTaskModel: saved } });
  mock.context.models.list = async () => ({ models: [saved, selected] });
  await registeredTool(mock);
  const result = await mock.route("POST", "/fast-model/test")({
    req: { json: async () => ({ modelRef: selected }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true);
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.modelCalls[0].provider, selected.provider);
  assert.equal(mock.modelCalls[0].model, selected.model);
  assert.deepEqual(mock.stored("fastTaskModel"), saved, "testing must not persist selection");
});

test("fast-model follow test bypasses saved fast model and uses Ask selection", async () => {
  const saved = { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" };
  const ask = { provider: "test-provider", model: "test-model" };
  const mock = createContext({ storageSeed: { fastTaskModel: saved, askJudgeModel: ask } });
  mock.context.models.list = async () => ({ models: [saved, ask] });
  await registeredTool(mock);
  const result = await mock.route("POST", "/fast-model/test")({
    req: { json: async () => ({ modelRef: null }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true);
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.modelCalls[0].provider, ask.provider);
  assert.equal(mock.modelCalls[0].model, ask.model);
  assert.deepEqual(mock.stored("fastTaskModel"), saved);
  assert.deepEqual(mock.stored("askJudgeModel"), ask);
});

test("fast-model test refuses a missing selected model without silently using saved one", async () => {
  const saved = { provider: "test-provider", model: "test-model" };
  const mock = createContext({ storageSeed: { fastTaskModel: saved } });
  await registeredTool(mock);
  const result = await mock.route("POST", "/fast-model/test")({
    req: { json: async () => ({ modelRef: { provider: "missing", model: "missing" } }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, false);
  assert.equal(mock.modelCalls.length, 0);
  assert.deepEqual(mock.stored("fastTaskModel"), saved);
});

test("the recommendation display setting only offers the ball and off", async () => {
  const mock = createContext();
  await registeredTool(mock);
  const respond = (data, status = 200) => ({ data, status });
  const getResult = await mock.route("GET", "/recommendation-config")({ json: (data, status) => respond(data, status) });
  assert.deepEqual(getResult.data.choices.display, ["ball", "off"]);
  assert.equal(getResult.data.choices.timing, undefined, '出卡时机只属于已下线的卡片');
  assert.equal(getResult.data.choices.sendMode, undefined, '卡片按钮行为随卡片一起下线');
  assert.equal(getResult.data.display, "ball", "默认应该是传音樱内展示");

  const legacy = await mock.route("PUT", "/recommendation-config")({
    req: { json: async () => ({ display: "card", count: 3 }) },
    json: (data) => ({ data }),
  });
  assert.equal(legacy.data.display, "ball", "旧设置存着 card，也不该把人静默关掉");
});

test("the Ask switch can register no Ask tools at all when it is off at load", async () => {
  const mock = createContext({ storageSeed: { askConfig: { enabled: false } } });
  await app.apply(mock.context);
  assert.equal(mock.registration, undefined, "关闭后不应注册 Ask 工具");
  assert.equal(mock.tool("jiegehua_zhiyi_bind_card"), undefined);
  assert.equal(mock.tool("jiegehua_zhiyi_resolve_card"), undefined);
  assert.equal(mock.tool("jiegehua_zhiyi_native_fallback"), undefined);
  assert.equal(mock.tool("jiegehua_zhiyi_suggest_replies"), undefined, "推荐卡片已下线，与 Ask 开关无关");

  const status = await mock.route("GET", "/ask-config")({ json: (data) => ({ data }) });
  assert.equal(status.data.enabled, false);
  assert.equal(status.data.registeredAtLoad, false);
});

test("switching Ask off takes effect on the next turn and never builds a pending Ask", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  const saved = await mock.route("PUT", "/ask-config")({
    req: { json: async () => ({ enabled: false }) },
    json: (data) => ({ data }),
  });
  assert.equal(saved.data.enabled, false);
  assert.equal(saved.data.registeredAtLoad, true, "当前进程里工具已经挂着，页面需要提示重新加载");
  assert.deepEqual(mock.stored("askConfig"), { enabled: false });

  const guidance = await mock.hook("agent/before-start")({
    prompt: "日记应用第一版只能选一种：云同步还是只在本地保存？我还没决定更看重哪边。",
    systemPrompt: "伙伴人格提示",
    session: { sessionId: "session-1", sessionPath: "sessions/current.jsonl" },
  });
  assert.ok(guidance.systemPrompt.startsWith("伙伴人格提示"));
  assert.doesNotMatch(guidance.systemPrompt, /知意 Ask 引导|实质改变行动、风险、成本或结果/, "关掉后不应再注入任何 Ask 引导");
  assert.equal(mock.modelCalls.length, 0, "不引导就不该再跑判断模型那一次调用");

  const result = await tool.execute(args);
  assert.equal(result.isError, undefined, "关掉不应把整轮调用变成错误");
  assert.deepEqual(result.details.ask, { created: false, reason: "disabled" });
  assert.match(result.content[0].text, /已在设置中关闭/);
  assert.match(result.content[0].text, /没有向用户提问/);
  assert.equal(mock.questions.length, 0, "不能真的去问用户");
});

test("polish route refuses empty input and a missing model instead of guessing one", async () => {
  const emptyMock = createContext();
  await registeredTool(emptyMock);
  const empty = await emptyMock.route("POST", "/polish")({
    req: { json: async () => ({ text: "   ", level: "standard" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(empty.data.ok, false);
  assert.match(empty.data.error, /先写点什么/);

  const noModelMock = createContext();
  await registeredTool(noModelMock);
  const noModel = await noModelMock.route("POST", "/polish")({
    req: { json: async () => ({ text: "帮我看看这个", level: "standard" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(noModel.data.ok, false);
  assert.match(noModel.data.error, /还没有选模型/);
  assert.equal(noModelMock.modelCalls.length, 0, "没选模型就不该调模型");
});

test("polish route rewrites through the configured model and reports a safety fallback", async () => {
  const mock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "帮我看看这个",
  });
  await registeredTool(mock);
  const ok = await mock.route("POST", "/polish")({
    req: { json: async () => ({ text: "帮我把这个看看", level: "standard" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(ok.data.ok, true, ok.data.error);
  assert.equal(ok.data.text, "帮我看看这个");
  assert.equal(ok.data.fellBack, false);
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.modelCalls[0].provider, "test-provider");
  assert.match(mock.modelCalls[0].messages[0].content, /<raw_text>\n帮我把这个看看\n<\/raw_text>/);

  const unsafeMock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "按之前的方案执行就行",
  });
  await registeredTool(unsafeMock);
  const unsafe = await unsafeMock.route("POST", "/polish")({
    req: { json: async () => ({ text: "就按那个来就行", level: "standard" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(unsafe.data.ok, true);
  assert.equal(unsafe.data.text, "就按那个来就行", "丢了指代的改写必须退回原文");
  assert.equal(unsafe.data.fellBack, true);
  assert.equal(unsafe.data.reason, "safety");
});

test("输入栏 🌸 按钮是开关：第二下收起，面板自己关掉后下次点又是打开", async () => {
  const mock = createContext({
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/s1.jsonl", sessionId: "sess_s1", agentId: "hanako", modified: 1 }],
  });
  await registeredTool(mock);
  const tool = mock.tool("jiegehua.zhiyi_suggest");
  assert.ok(tool, "应该有输入栏面板工具");
  const call = { context: { sessionPath: "D:/hana/agents/hanako/sessions/s1.jsonl" } };

  await tool.execute(call);
  assert.equal(mock.panelShows.length, 1, "第一下应该挂出面板");
  assert.equal(mock.panelDismisses.length, 0);

  await tool.execute(call);
  assert.equal(mock.panelDismisses.length, 1, "第二下应该收起面板");
  assert.equal(mock.panelDismisses[0].id, "zhiyi-suggest-panel");
  assert.equal(mock.panelDismisses[0].sessionId, "sess_s1");
  assert.equal(mock.panelShows.length, 1, "收起这一下不该再挂一遍");

  await tool.execute(call);
  assert.equal(mock.panelShows.length, 2, "第三下应该重新打开");

  // 面板自己被宿主关掉时前端会报一声，之后点按钮应该是打开而不是收起
  await mock.route("POST", "/suggest-panel/hidden")({
    req: { query: (key) => (key === "sessionId" ? "sess_s1" : "") },
    json: (data, status = 200) => ({ data, status }),
  });
  await tool.execute(call);
  assert.equal(mock.panelShows.length, 3, "面板已经关了，这一下应该打开");
  assert.equal(mock.panelDismisses.length, 1);
});

test("session title reads the most recently active session and cleans the model output", async () => {
  const mock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "「今天改代码。」",
    sessionList: [
      { path: "D:/hana/agents/hanako/sessions/old.jsonl", sessionId: "sess_old", agentId: "hanako", modified: 100 },
      { path: "D:/hana/agents/hanako/sessions/newest.jsonl", sessionId: "sess_newest", agentId: "hanako", agentName: "小花", modified: 900 },
    ],
  });
  await registeredTool(mock);
  const result = await mock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true, result.data.error);
  assert.equal(result.data.title, "今天改代码");
  assert.equal(result.data.fallback, false);
  assert.equal(result.data.session.sessionPath, "D:/hana/agents/hanako/sessions/newest.jsonl", "要挑最近有动静的那段");
  assert.equal(result.data.session.agentName, "小花");
  // 实机结论：光给 sessionPath 会被宿主拒（session_manifest_ref_required），必须用 sessionId。
  assert.equal(mock.historyCalls.length, 1);
  assert.equal(typeof mock.historyCalls[0].sessionId, "string");
  assert.ok(mock.historyCalls[0].sessionId.length > 0);
  assert.equal(mock.historyCalls[0].sessionPath, undefined, "不能只拿 sessionPath 去读历史");
  assert.equal(mock.modelCalls.length, 1);
  assert.match(mock.modelCalls[0].messages[0].content, /帮我想想怎么给花浇水/);
  assert.doesNotMatch(mock.modelCalls[0].messages[0].content, /隐藏思考不应进入标题上下文/);
});

test("session title falls back to the user's own words when the model gives nothing usable", async () => {
  const mock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "```text\n\n```",
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/s1.jsonl", sessionId: "sess_s1", agentId: "hanako", modified: 1 }],
  });
  await registeredTool(mock);
  const result = await mock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.title, "帮我想想怎么给花浇水");
  assert.equal(result.data.fallback, true, "走了兜底必须标出来，不能假装是模型起的");
});

test("writing the title back goes through session:update and explains a permission denial", async () => {
  const mock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "今天改代码。",
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/s1.jsonl", sessionId: "sess_s1", agentId: "hanako", modified: 1 }],
  });
  await registeredTool(mock);
  const generated = await mock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(generated.data.ok, true, generated.data.error);

  const applied = await mock.route("POST", "/session-title/apply")({
    req: { json: async () => ({ sessionId: generated.data.session.sessionId, title: generated.data.title }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(applied.data.ok, true, applied.data.error);
  assert.equal(applied.data.title, "今天改代码");
  assert.deepEqual(mock.updateCalls, [{ sessionId: "sess_s1", scope: "all", title: "今天改代码" }]);

  const denied = new Error("APP_CAPABILITY_DENIED: app/sessions.manage");
  denied.code = "APP_CAPABILITY_DENIED";
  const deniedMock = createContext({ updateError: denied });
  await registeredTool(deniedMock);
  const refused = await deniedMock.route("POST", "/session-title/apply")({
    req: { json: async () => ({ sessionId: "sess_s1", title: "今天改代码" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(refused.data.ok, false);
  assert.match(refused.data.error, /还没有.*管理会话.*权限/);
  assert.doesNotMatch(refused.data.error, /APP_CAPABILITY_DENIED/, "内部错误码不能原话扔给用户");

  // 没有编号或标题不合法时，一次都不该发出去。
  const guardMock = createContext();
  await registeredTool(guardMock);
  for (const body of [{ title: "今天改代码" }, { sessionId: "sess_s1", title: "   " }]) {
    const guarded = await guardMock.route("POST", "/session-title/apply")({
      req: { json: async () => body },
      json: (data, status) => ({ data, status }),
    });
    assert.equal(guarded.data.ok, false);
  }
  assert.equal(guardMock.updateCalls.length, 0);
});

test("面板「起名」只改面板所在那段对话，不用「最近活跃那段」现猜", async () => {
  const mock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    modelText: "给面板起个名字。",
    sessionList: [
      { path: "D:/hana/agents/hanako/sessions/a.jsonl", sessionId: "sess_this", agentId: "hanako", title: "旧名字", modified: 10 },
      { path: "D:/hana/agents/hanako/sessions/b.jsonl", sessionId: "sess_other", agentId: "hanako", modified: 999 },
    ],
  });
  await registeredTool(mock);
  const renamed = await mock.route("POST", "/suggest-panel/rename")({
    req: { json: async () => ({ sessionId: "sess_this" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(renamed.data.ok, true, renamed.data.error);
  assert.equal(renamed.data.title, "给面板起个名字");
  // 名单里 sess_other 更新，但面板就在 sess_this 上，绝不能去改另一段。
  assert.deepEqual(mock.updateCalls, [{ sessionId: "sess_this", scope: "all", title: "给面板起个名字" }]);
  assert.equal(mock.historyCalls[0].sessionId, "sess_this");
  // 旧标题要落在撤回记录里，不然「还原」只能退回「未命名对话」。
  assert.equal(mock.stored("titleUndo").sess_this.previousTitle, "旧名字");

  // 没带会话编号时一次都不该去动宿主。
  const guardMock = createContext({ sessionList: [] });
  await registeredTool(guardMock);
  const refused = await guardMock.route("POST", "/suggest-panel/rename")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(refused.data.ok, false);
  assert.match(refused.data.error, /哪段对话/);
  assert.equal(guardMock.updateCalls.length, 0);
  assert.equal(guardMock.modelCalls.length, 0, "不知道改哪段就不该先花一次模型钱");
});

test("面板里的排队发送：没会话、没内容都不往下走；状态查询不炸", async () => {
  const mock = createContext({ sessionList: [] });
  await registeredTool(mock);
  const jsonOf = (data, status) => ({ data, status });

  const noSession = await mock.route("POST", "/queue-plan/start")({
    req: { json: async () => ({ text: "在吗" }) },
    json: jsonOf,
  });
  assert.equal(noSession.data.ok, false);
  assert.match(noSession.data.error, /哪段对话/);

  const empty = await mock.route("POST", "/queue-plan/start")({
    req: { json: async () => ({ sessionId: "sess_this", text: "   " }) },
    json: jsonOf,
  });
  assert.equal(empty.data.ok, false);
  assert.match(empty.data.error, /先写一句/);

  const state = await mock.route("GET", "/queue-plan/state")({ json: jsonOf });
  assert.equal(state.data.ok, true);
  assert.equal(state.data.active, false);

  const stop = await mock.route("POST", "/queue-plan/stop")({
    req: { json: async () => ({ sessionId: "sess_this" }) },
    json: jsonOf,
  });
  assert.equal(stop.data.ok, true);
  assert.equal(stop.data.stopped, false, "本来就没在排，不该假装停成功");
});

test("queued send goes through session:send with followUp, no local queue state", async () => {
  const mock = createContext({
    sessionList: [
      { path: "D:/hana/agents/hanako/sessions/old.jsonl", sessionId: "sess_old", agentId: "hanako", modified: 1 },
      { path: "D:/hana/agents/hanako/sessions/new.jsonl", sessionId: "sess_new", agentId: "hanako", agentName: "小花", modified: 9 },
    ],
  });
  await registeredTool(mock);
  const result = await mock.route("POST", "/send")({
    req: { json: async () => ({ text: "  等你说完我有件事  ", mode: "followUp" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(result.data.ok, true, result.data.error);
  // 宿主自带排队语义：发一次就完，不落本地队列
  assert.deepEqual(mock.sendCalls, [{
    sessionId: "sess_new", scope: "all", text: "等你说完我有件事", deliverAs: "followUp",
  }]);
  assert.equal(result.data.mode, "followUp");
  assert.equal(result.data.agentName, "小花");

  const steer = await mock.route("POST", "/send")({
    req: { json: async () => ({ text: "插一句", mode: "steer" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(steer.data.ok, true);
  assert.equal(mock.sendCalls[1].deliverAs, "steer");
});

test("queued send refuses empty or overlong text before touching the host", async () => {
  const mock = createContext({ sessionList: [{ path: "D:/hana/x.jsonl", sessionId: "sess_x", modified: 1 }] });
  await registeredTool(mock);
  for (const text of ["   ", "字".repeat(501)]) {
    const result = await mock.route("POST", "/send")({
      req: { json: async () => ({ text }) },
      json: (data, status) => ({ data, status }),
    });
    assert.equal(result.data.ok, false);
    assert.match(result.data.error, /写点什么|精简到 500 字/);
  }
  assert.equal(mock.sendCalls.length, 0, "不合格的话一句都不该发出去");
});

test("queued send explains busy, permission denial and a rejected send", async () => {
  const denied = new Error("APP_CAPABILITY_DENIED: app/sessions.manage");
  denied.code = "APP_CAPABILITY_DENIED";
  const deniedMock = createContext({
    sessionList: [{ path: "D:/hana/x.jsonl", sessionId: "sess_x", modified: 1 }],
    sendError: denied,
  });
  await registeredTool(deniedMock);
  const refused = await deniedMock.route("POST", "/send")({
    req: { json: async () => ({ text: "在吗" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(refused.data.ok, false);
  assert.match(refused.data.error, /管理会话/);
  assert.doesNotMatch(refused.data.error, /APP_CAPABILITY_DENIED/);

  // 会话忙会退避重试三次；这里直接给一个一直忙的用例，确认最终报错是中文
  const busyMock = createContext({
    sessionList: [{ path: "D:/hana/x.jsonl", sessionId: "sess_x", modified: 1 }],
    sendError: new Error("session is busy"),
  });
  await registeredTool(busyMock);
  const busy = await busyMock.route("POST", "/send")({
    req: { json: async () => ({ text: "在吗" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(busy.data.ok, false);
  assert.match(busy.data.error, /还在回复/);
  assert.equal(busyMock.sendCalls.length, 4, "首发一次 + 三次退避重试");
});

test("session title reports an empty or unavailable session list instead of guessing", async () => {
  const emptyMock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    sessionList: [],
  });
  await registeredTool(emptyMock);
  const empty = await emptyMock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(empty.data.ok, false);
  assert.match(empty.data.error, /会话名单是空的/);
  assert.equal(emptyMock.modelCalls.length, 0);

  // 名单里没有 sessionId 的条目一律不选：拿不到编号就读不了历史，不能默默挑一条坏的。
  const noIdMock = createContext({
    storageSeed: { askJudgeModel: { provider: "test-provider", model: "test-model" } },
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/x.jsonl", agentId: "hanako", modified: 5 }],
  });
  await registeredTool(noIdMock);
  const noId = await noIdMock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(noId.data.ok, false);
  assert.match(noId.data.error, /没有带编号的对话/);
  assert.equal(noIdMock.modelCalls.length, 0);

  const brokenMock = createContext({ storageSeed: {}, sessionList: null });
  await registeredTool(brokenMock);
  const broken = await brokenMock.route("POST", "/session-title")({
    req: { json: async () => ({}) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(broken.data.ok, false);
  assert.match(broken.data.error, /读不到会话名单/);
});

test("rejects an omitted selection mode before creating a pending Ask", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  const omittedMode = { ...args };
  delete omittedMode.selectionMode;
  const result = await tool.execute(omittedMode);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /必须明确选择单选或多选/);
  assert.doesNotMatch(result.content[0].text, /知意待发卡/);
  assert.equal(mock.questions.length, 0);
});

test("no-ball Ask hands a card request to the Agent, then accepts one bound card answer", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  const result = await tool.execute(args);
  assert.equal(mock.questions.length, 0);
  assert.match(result.content[0].text, /知意待发卡/);
  const handoff = JSON.parse(result.content[0].text.match(/知意待发卡[^：]*：(\{[^\n]+\})/)[1]);
  assert.equal(handoff.question, '先处理哪项？');
  const bind = await mock.tool('jiegehua_zhiyi_bind_card').execute({ askId: handoff.askId, cardInstanceId: 'c_zhiyi_test_1', context: args.context });
  assert.equal(bind.isError, false);
  const resolved = await mock.tool('jiegehua_zhiyi_resolve_card').execute({ askId: handoff.askId,
    cardInstanceId: 'c_zhiyi_test_1', action: 'confirmed', choice: '先做校验', note: '先检查 CSV', context: args.context });
  assert.equal(resolved.isError, false);
  assert.match(resolved.content[0].text, /先检查 CSV/);
  const duplicate = await mock.tool('jiegehua_zhiyi_resolve_card').execute({ askId: handoff.askId,
    cardInstanceId: 'c_zhiyi_test_1', action: 'confirmed', choice: '先改界面', context: args.context });
  assert.equal(duplicate.isError, true);
});

test("no-ball multi-select handoff resolves a validated choice array", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  const handoff = JSON.parse((await tool.execute(multipleArgs)).content[0].text.match(/知意待发卡[^：]*：(\{[^\n]+\})/)[1]);
  assert.equal(handoff.selectionMode, "multiple");
  assert.equal(handoff.maxSelections, 2);
  await mock.tool('jiegehua_zhiyi_bind_card').execute({ askId: handoff.askId, cardInstanceId: 'c_zhiyi_multi_1', context: args.context });
  const resolved = await mock.tool('jiegehua_zhiyi_resolve_card').execute({ askId: handoff.askId,
    cardInstanceId: 'c_zhiyi_multi_1', action: 'confirmed', choice: ['先做校验', '先改界面'], context: args.context });
  assert.equal(resolved.isError, false);
  assert.match(resolved.content[0].text, /- 先做校验\n- 先改界面/);
});

test("card display failure can cancel the pending handoff and use native confirmation", async () => {
  const mock = createContext({ answer: { action: 'confirmed', value: { choice: '先做校验', note: '先检查 CSV' } } });
  const tool = await registeredTool(mock);
  const handoff = JSON.parse((await tool.execute(args)).content[0].text.match(/知意待发卡[^：]*：(\{[^\n]+\})/)[1]);
  const result = await mock.tool('jiegehua_zhiyi_native_fallback').execute({ askId: handoff.askId, context: args.context });
  assert.equal(mock.questions.length, 1);
  assert.equal(mock.questions[0].sessionPath, 'sessions/current.jsonl');
  assert.deepEqual(mock.questions[0].requestedSchema.properties.choice.enum, ['先做校验', '先改界面']);
  assert.match(result.content[0].text, /用户选择：先做校验/);
});

test("native fallback renders multi-select as bounded checkbox fields", async () => {
  const mock = createContext({ answer: { action: 'confirmed', value: { option_1: true, option_2: true, note: '都要' } } });
  const tool = await registeredTool(mock);
  const handoff = JSON.parse((await tool.execute(multipleArgs)).content[0].text.match(/知意待发卡[^：]*：(\{[^\n]+\})/)[1]);
  const result = await mock.tool('jiegehua_zhiyi_native_fallback').execute({ askId: handoff.askId, context: args.context });
  assert.equal(mock.questions[0].requestedSchema.properties.option_1.type, 'boolean');
  assert.equal(mock.questions[0].requestedSchema.properties.option_2.type, 'boolean');
  assert.match(result.content[0].text, /- 先做校验\n- 先改界面/);
});

test("does not ask without an originating session", async () => {
  const mock = createContext();
  const tool = await registeredTool(mock);
  const result = await tool.execute({ ...args, context: { sessionPath: "" } });
  assert.equal(mock.questions.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /没有可挂载提问的会话/);
});

test("does not treat a host display failure as consent and avoids echoing the error", async () => {
  const mock = createContext({ askError: new Error("private session details") });
  const tool = await registeredTool(mock);
  const handoff = JSON.parse((await tool.execute(args)).content[0].text.match(/知意待发卡[^：]*：(\{[^\n]+\})/)[1]);
  const result = await mock.tool('jiegehua_zhiyi_native_fallback').execute({ askId: handoff.askId, context: args.context });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /原生确认卡也未能确认结果/);
  assert.doesNotMatch(result.content[0].text, /private session details/);
});

// 下面两条走完整的 App 装配（registeredTool），把 hook、定时器、名单读取和状态机串起来跑。
// 构造数据是合成的：START 只是 mock timer 的起点，窗口名与伙伴名一律匿名，不对应任何实机记录。

function resumeCaseHarness(sessionList) {
  // 卡住阈值走合法下界 30 秒（默认是 90 秒），让 tick 能跨过它而不必真等。
  // 断点总开关现在默认关，这两条测的就是开启后的行为，所以显式 seed true。
  return createContext({ sessionList, storageSeed: { resumeConfig: { enabled: true, stuckTimeoutMs: 30_000 } } });
}

async function drainAsyncWork(times = 12) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("卡住复核：名单读不到时只能沿用旧索引，这一轮不记账也不推提醒", async (t) => {
  const START = 1_792_212_000_000;
  let modified = START + 60_000;
  let listFails = false;
  const mock = resumeCaseHarness(() => {
    if (listFails) { const error = new Error("会话名单超时了"); error.code = "APP_RPC_TIMEOUT"; throw error; }
    return [{
      path: "D:/hana/agents/hanako/sessions/case.jsonl",
      sessionId: "sess_case", agentId: "hanako", agentName: "测试伙伴", title: "测试窗口", modified,
    }];
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await registeredTool(mock);

  const startTurn = () => mock.hook("agent/before-start")({ session: { sessionId: "sess_case", agentId: "hanako" } });
  const status = async () => (await mock.route("GET", "/resume-status")({
    req: { query: () => "sess_case" }, json: (data) => data,
  })).session;

  // 一、名单新鲜、这份 modified 比本轮起点新：算有进展，同时把索引热起来。
  await startTurn();
  t.mock.timers.tick(31_000);
  await drainAsyncWork();
  assert.equal((await status()).pending, null, "有进展就不该记成待决");

  // 二、时间走过那份 modified 后再开一轮；这次名单读不到，沿用的旧快照比本轮起点还早。
  // 没有新鲜度判断时，这里会拿旧 modified 判「没进展」并 markStuck。
  t.mock.timers.tick(40_000);
  await startTurn();
  listFails = true;
  t.mock.timers.tick(31_000);
  await drainAsyncWork();

  assert.equal((await status()).pending, null, "旧快照证明不了没进展，这一轮不能记账");
  assert.ok(mock.logs.debug.some((entry) => String(entry.message).includes("stale-index")), "要明确走 stale-index 分支，而不是当成没进展");
  const reviewLog = mock.logs.debug.find((entry) => entry.detail?.indexStale === true);
  assert.ok(reviewLog, "复核日志要标出这份索引不新鲜");
  assert.equal(typeof reviewLog.detail.reviewedAt, "number", "复核日志要带 reviewedAt，便于下次对时");
  assert.ok(mock.sessionListCalls.length > 0);
  const failures = () => mock.logs.debug.filter((entry) => String(entry.message).includes("续接读不到会话名单"));
  assert.ok(failures().length > 0, "名单读失败要留一条 debug");
  const freshAt = failures()[0].detail.cacheFreshAt;
  assert.ok(freshAt > 0);
  t.mock.timers.tick(25_000);
  await drainAsyncWork();
  assert.ok(failures().length > 1, "持续超时要再次走复核");
  assert.equal(failures().at(-1).detail.cacheFreshAt, freshAt, "失败重试不能把旧缓存标成刚刚读取成功");
});

test("断点续接默认关着：不检测、不留进度，开关和上限只合并不改丢别的", async () => {
  const mock = createContext({
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/x.jsonl", sessionId: "sess_x", agentId: "hanako", modified: 1 }],
  });
  await registeredTool(mock);

  const status = await mock.route("GET", "/resume-status")({
    req: { query: () => "" }, json: (data, code) => ({ data, status: code }),
  });
  assert.equal(status.data.config.enabled, false, "默认不能替用户拿主意去插话");
  assert.deepEqual(status.data.progress, [], "关着的时候没有进度可查");

  // 只改自动：总开关和上限都不能被洗掉。
  const saved = await mock.route("PUT", "/resume-config")({
    req: { json: async () => ({ config: { enabled: true, autoResume: true, maxConsecutive: 4 } }) },
    json: (data, status2) => ({ data, status: status2 }),
  });
  assert.equal(saved.data.config.enabled, true);
  assert.equal(saved.data.config.autoResume, true);
  assert.equal(saved.data.config.maxConsecutive, 4);

  const partial = await mock.route("PUT", "/resume-config")({
    req: { json: async () => ({ config: { maxConsecutive: 6 } }) },
    json: (data, status2) => ({ data, status: status2 }),
  });
  assert.equal(partial.data.config.autoResume, true, "只改上限不该把自动洗成关");
  assert.equal(partial.data.config.maxConsecutive, 6);
});

test("续接没有会话编号时不发：空编号会回退到最近那几段对话", async () => {
  const mock = createContext({
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/x.jsonl", sessionId: "sess_x", agentId: "hanako", modified: 1 }],
    storageSeed: { resumeConfig: { enabled: true } },
  });
  await registeredTool(mock);
  const result = await mock.route("POST", "/resume/continue")({
    req: { json: async () => ({ sessionId: "" }) },
    json: (data, status) => ({ data, status }),
  });
  assert.equal(mock.sendCalls.length, 0, "没有编号就不能发，宁可不续也不能插错窗口");
  assert.equal(result.data.ok, false);
});

import { RESUME_TEXT } from "../lib/resume-watch.js";

test("自动续接：发到上限为止，等不到就安静停着并把结果记进进度", async (t) => {
  const START = 1_792_212_000_000;
  const SESSION_PATH = "D:/hana/agents/hanako/sessions/case.jsonl";
  const mock = createContext({
    sessionList: [{ path: SESSION_PATH, sessionId: "sess_case", agentId: "hanako", agentName: "测试伙伴", title: "测试窗口", modified: START + 600_000 }],
    storageSeed: { resumeConfig: { enabled: true, autoResume: true, maxConsecutive: 1, cooldownMs: 10_000, stuckTimeoutMs: 30_000 } },
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await registeredTool(mock);
  const status = async () => (await mock.route("GET", "/resume-status")({
    req: { query: () => "sess_case" }, json: (data, code) => ({ data, status: code }),
  })).data;

  // 宿主报一次异常 → 自动模式下自己发一句。
  await mock.emitBus({ type: "turn_end", message: { content: [], stopReason: "error" } }, SESSION_PATH);
  await drainAsyncWork();
  t.mock.timers.tick(6_000);
  await drainAsyncWork();
  assert.equal(mock.sendCalls.length, 1, "自动模式应该自己发一句「继续哈」");
  assert.equal(mock.sendCalls[0].deliverAs, "steer");

  const waiting = await status();
  assert.equal(waiting.progress[0].status, "waiting", "发出去之后要看得见 1/1 在等");
  assert.equal(waiting.progress[0].attempt, 1);
  assert.equal(waiting.progress[0].maxConsecutive, 1);

  // 宿主开始处理「继续哈」那一轮：进度不能被新一轮开始吃掉。
  await mock.hook("agent/before-start")({ session: { sessionId: "sess_case", agentId: "hanako" }, prompt: RESUME_TEXT });
  await drainAsyncWork();
  const stillThere = await status();
  assert.equal(stillThere.progress.length, 1, "故障轮没真结束前，1/N 的进度不能消失");
  assert.equal(stillThere.progress[0].status, "waiting");

  // 等不到回复：到上限，安静停着，不再发第二次。
  t.mock.timers.tick(35_000);
  await drainAsyncWork();
  assert.equal(mock.sendCalls.length, 1, "到了上限不该再发第二次");
  const limit = await status();
  assert.equal(limit.progress[0].status, "limit");
  assert.equal(limit.progress[0].attempt, 1);
});

test("卡住复核：名单恢复正常后，确证没进展的会话仍会被记成待决", async (t) => {
  const START = 1_792_212_000_000;
  let modified = START - 60_000;
  const mock = resumeCaseHarness(() => [{
    path: "D:/hana/agents/hanako/sessions/case.jsonl",
    sessionId: "sess_case", agentId: "hanako", agentName: "测试伙伴", title: "测试窗口", modified,
  }]);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await registeredTool(mock);

  await mock.hook("agent/before-start")({ session: { sessionId: "sess_case", agentId: "hanako" } });
  t.mock.timers.tick(31_000);
  await drainAsyncWork();

  const pendingFirst = (await mock.route("GET", "/resume-status")({
    req: { query: () => "sess_case" }, json: (data) => data,
  })).session;
  assert.equal(pendingFirst.pending, null, "第一次看到没进展只进观察窗，不立刻记账（长任务可能还在写盘）");

  // 再过一轮阈值仍然没进展：这才确证卡住。
  t.mock.timers.tick(31_000);
  await drainAsyncWork();
  const status = (await mock.route("GET", "/resume-status")({
    req: { query: () => "sess_case" }, json: (data) => data,
  })).session;
  assert.equal(status.pending, "stuck", "连续两轮都没进展时，不能因为加观察窗就把真卡住也放过");
});

test("子代理会话报错不进账本：事件没带路径时也要按 target 认得出来", async (t) => {
  const START = 1_792_212_000_000;
  const SUB_PATH = "D:/hana/agents/hanako/subagent-sessions/direct/case.jsonl";
  const mock = createContext({
    sessionList: [{
      path: SUB_PATH, sessionId: "sess_sub", agentId: "yuzuki", agentName: "柚月",
      kind: "subagent_child", modified: START,
    }],
    storageSeed: { resumeConfig: { enabled: true, autoResume: true, maxConsecutive: 3, stuckTimeoutMs: 30_000 } },
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await registeredTool(mock);

  // 事件回调的 sessionPath 有时是空的（实机就这样），入口那道正则挡不住；
  // 这条走的是异常信号分支，必须拿到 session:list 的条目再认一次。
  await mock.emitBus({ type: "turn_end", sessionId: "sess_sub", message: { content: [], stopReason: "error" } }, "");
  await drainAsyncWork();
  t.mock.timers.tick(6_000);
  await drainAsyncWork();

  assert.equal(mock.sendCalls.length, 0, "自动续接开着也不能往子代理会话里塞「继续哈」");
  const status = (await mock.route("GET", "/resume-status")({
    req: { query: () => "sess_sub" }, json: (data) => data,
  })).session;
  assert.equal(status.pending, null, "子代理会话不该被记成待决");
});

// 2026-10-22 实机：这份名单一天被拉了 3994 次（几乎卡着 20 秒的缓存期跑满），
// 每次要列三百多个会话、三四百毫秒、偶尔五秒，宿主的事件循环跟着一起等，
// 钩子在这段时间堆到 App RPC 并发上限，被拒的就当成「没有决策」。
// 两条闸门都得钉住：只列活跃会话；事件里的编号已经能对上时不再拉。
test("断点续接的会话名单：只列活跃会话，编号已对上就不再拉", async () => {
  const CASE_PATH = "D:/hana/agents/hanako/sessions/case.jsonl";
  const START = 1_792_212_000_000;
  const mock = createContext({
    sessionList: [{ path: CASE_PATH, sessionId: "sess_case", agentId: "hanako", title: "测试窗口", modified: START }],
    storageSeed: { resumeConfig: { enabled: true } },
  });
  await registeredTool(mock);

  // 一、App 刚重载完，本地还没有映射：这一轮必须问一次宿主。
  await mock.emitBus({ type: "turn_end", message: { content: [{ type: "text", text: "说完了" }], stopReason: "stop" } }, CASE_PATH);
  await drainAsyncWork();
  assert.equal(mock.sessionListCalls.length, 1, "本地对不上编号时还得问一次");
  assert.equal(mock.sessionListCalls[0].lifecycle, "active", "只列活跃会话：归档的不需要断点续接");
  assert.equal(mock.sessionListCalls[0].scope, "all", "会话归属仍然显式给全");

  // 二、钩子这一层同时握着 sessionId 与 path，映射就此建立，之后同一段对话不必再问。
  await mock.hook("agent/before-start")({
    session: { sessionId: "sess_case", agentId: "hanako", path: CASE_PATH },
  });
  const before = mock.sessionListCalls.length;
  await mock.emitBus({ type: "turn_end", message: { content: [{ type: "text", text: "又说完了" }], stopReason: "stop" } }, CASE_PATH);
  await drainAsyncWork();
  assert.equal(mock.sessionListCalls.length, before, "编号已经在本地对上，turn_end 不该再拉名单");
});

test("卡住复核的强制刷新也有节流：每 5 秒问一次比名单自己变还勤", async (t) => {
  const START = 1_792_212_000_000;
  const mock = createContext({
    sessionList: [{ path: "D:/hana/agents/hanako/sessions/case.jsonl", sessionId: "sess_case", agentId: "hanako", modified: START }],
    storageSeed: { resumeConfig: { enabled: true, stuckTimeoutMs: 30_000 } },
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await registeredTool(mock);
  // 只开一轮、不给正文：它会进卡住候选，pump 每 5 秒复核一次。
  await mock.hook("agent/before-start")({ session: { sessionId: "sess_case", agentId: "hanako" } });
  t.mock.timers.tick(31_000);
  await drainAsyncWork();
  const afterFirstReview = mock.sessionListCalls.length;
  assert.equal(afterFirstReview, 1, "第一次复核要问一次");
  // 再走三个 5 秒：名单还在缓存期，强制刷新也要等满节流才发第二发。
  t.mock.timers.tick(5_000);
  await drainAsyncWork();
  t.mock.timers.tick(5_000);
  await drainAsyncWork();
  assert.equal(mock.sessionListCalls.length, afterFirstReview, "节流期内不重复拉名单");
});
