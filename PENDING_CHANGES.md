# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.1.48（2026-10-30），内容见 `CHANGELOG.md`。

## 待发

- 2026-10-30 模型下拉按模型商分组（0.1.48-dev.3）：知意面板「内容模型 / 备用模型 / 快速模型」三处下拉改成先列模型商、再列它家的模型。`lib/ask-model.js` 给每条模型补 `providerLabel`（模型商）与 `providerChannel`（通道）；新增 `ui/assets/model-groups.js` 负责分组、置顶「跟随 / 不设」与置底「已不在列表」，同一家名下有多条通道时再标通道名；`ui/assets/panel.css` 补组标题与通道副标样式，下拉高度 240→320px。起因：同一个模型名可能挂在好几家名下（各家转发的同名模型、官方接口与订阅通道并存），光看模型名挑不出是哪家，选下去才发现走错了通道。没收录的 provider 照原值显示（自建通道名常是中文或自取的，不替它猜）。新增 `tests/model-groups.test.js` 4 项，`tests/ask-model.test.js` 补 2 项；`node --test` 556 项 554 通过 / 0 失败 / 2 跳过。未做：实机重载后逐个面板入口复验（后端字段要重启知意应用才带上）。

- 2026-10-30 瞬态不再占全局账本（0.1.48-dev.1）：面板状态 `suggestPanelState` 与标题撤回 `titleUndo` 改存 `dataDir/runtime-state.json`（新增 `lib/runtime-state.js`）；`shutdownBannerTrace`、`shutdownBannerDebug`、`shutdownBannerRestoreDebug` 三个排查痕迹改走 `logger.debug`，不再写 app storage。起因：16:35 系统意外断电（Kernel-Power 41）时 `global.json` 正在被整本重写，24861 字节被写成全零，Hana 判定损坏后从空白重建，设置全丢。瞬态搬出后，账本只在真改设置时才动笔。`node --experimental-vm-modules --test` 564 通过 / 0 失败；`node --check` 三份文件通过。未做：实机重载后逐个面板入口复验。
