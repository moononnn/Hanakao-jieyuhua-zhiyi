import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  const context = {
    dataDir: "C:/isolated-test/app-data",
    bus: { request: async (type, input) => {
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
    logger: { info: async () => {}, warn: async () => {}, debug: async () => {} },
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
  assert.match(noModel.data.error, /还没有选润色模型/);
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
