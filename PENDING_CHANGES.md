# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.3.0（2026-11-04），内容见 `CHANGELOG.md`。

## 待发

### 0.3.1-dev.1 审包六条落地

- **降级信息落到界面。** `lib/length-summary.js` 的 `buildSummaryBlock` 收第三个参数（脚注），换过模型时在速览卡底加一行 `> _这条是「X」（内容模型）拟的，原本那条没接住。_`；`index.js` 把它接上并把 `degraded` / `summaryModel` 写进日志。标题那边：`lib/session-title.js` 返回 `model` / `degraded`，面板结果行与球上的 `_apply_rename_result` 都改成「已改为：xxx（兜底标题，MiniMax M2 拟的）」这种写法。摘卡规则同步扩了 `SUMMARY_NOTE_RE`，脚注行跟着整块一起摘掉。
- **取消拿对了号。** `lib/fast-model.js` 每次真实调用把 `${基号}_aN` 登记进 `activeAttempts`，新增 `cancelFastModel(sdk, 基号)`：取消这些实际号，并把基号记进 `cancelledBases`，链发现被放弃就立刻停，不再拿后备模型烧额度。速览与标题的超时分支都改用它。
- **链有总预算。** `invokeFastTextModel` 接受 `budgetMs`，每次尝试前检查，用完抛 `MODEL_BUDGET_EXCEEDED`（带 `triedModels`）。速览传 `SUMMARY_TIMEOUT_MS - 2000`（10s），标题传 `TITLE_TIMEOUT_MS - 5000`（25s），给外层超时留余地。
- **自定义档进了链。** `resolveFastModelChain` 末尾补一条 `resolveTaskModel({hostModel:null})`，角色 `custom`（`modelRoleLabel` 里叫「自定义模型」）。只用自定义 HTTP 档的用户不会再直接撞「快速档没有可用模型」。
- **包内不再带 python 测试。** `发布小工坊/projects/jiegehua-zhiyi.json` 的 `excludeGlobs` 加 `python/test_*.py`（下个版本打包时生效，包内 6 个测试文件会消失）。
- 测试：`tests/fast-model.test.js` 新增 3 项（自定义档入链、预算到点认输、取消用 `_aN` 号并叫停链）、`tests/length-summary.test.js` 新增 1 项（脚注进卡且能整块摘掉）。

### 还留着的（没在本轮处理）

- 速览 12 秒预算与三层链叠加的实际收益，仍然只有推断没有实测；得看真机上慢模型的表现再决定要不要放宽预算。
- 真实额度耗尽下的降级链路没跑过（单元测试模拟的是限流、额度、服务商不可用三类错误）。
- 审包提到的主会话审计正则只覆盖 `^tests/`，那是本地脚本口径，不涉及产品，不跟着发版。
