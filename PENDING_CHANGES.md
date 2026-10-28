# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.1.44（2026-10-28），内容见 `CHANGELOG.md`。

## 待发

### 修：概览里「输入框图片放大」的「装上」按钮其实什么都没装（待 0.1.45，2026-10-28）

- 现象（玥儿实机）：点「装上」，卡片说「装好了。完全退出 Hana 再启动……」，完全退出并重启 Hana 以后，输入框里的缩略图还是点不开。实机复核：renderer 的 `index.html` 里没有注入行，`modules/draft-image-zoom.js` 不存在，连备份 `index.html.hdiz.bak` 都没有——**一次都没真装过**。
- 根因（不在 Hana，也不在这个功能）：`assets/install-input-zoom.ps1` 是没带 BOM 的 UTF-8 + LF 换行。Windows PowerShell 5.1（知意用 `powershell.exe` 拉起它）会按系统 ANSI 代码页读脚本，中文系统是 GBK：注释里最后一个汉字「。」的字节对会把后面的换行吃掉，于是下一行 `param([string]$Action = "status")` 被并进注释，**参数块整块消失**，`$Action` 恒为空 → `switch` 落到 `default` 分支 → 每次调用都在做「只读状态」。界面那边只检查「没抛错」，于是照样写上「装好了」。
  - 佐证：同一个脚本用 PowerShell 7 跑就完全正常（`justInstalled:true`，文件真的写进去），只有 5.1 会退化；5.1 的 AST 解析里 `ParamBlock` 为 `null`、零语法错误——因为那行已经被并进注释，不再是参数块了。
- 改法：
  - `assets/install-input-zoom.ps1` 重写：**纯 ASCII 注释 + UTF-8 with BOM + CRLF**，任何代码页下都不会再咬掉换行；动作除了命令行参数还通过环境变量 `HDIZ_ACTION` 再传一份，参数块哪天再被弄坏也不会退化成只读；不认识的动作直接报 `BAD_ACTION`，不再安静返回状态。
  - 安装/卸载都改成**写完读回来验**：`install` 后若 `index.html` 没有注入或 `modules/draft-image-zoom.js` 不在位，返回 `ok:false` + `INSTALL_FAILED`；`uninstall` 后若仍在位，返回 `UNINSTALL_FAILED`。脚本从此不说自己做不到的事。
  - `lib/input-zoom.js`：拉起脚本时带上 `HDIZ_ACTION` 环境变量；解析回包后核对 `payload.action` 与请求一致，不一致直接报错（这条专门防「请求 A 跑了 B」）。
  - `ui/assets/panel-layout.js`：只有 `payload.installed === true` 才写「装好了」，否则把安装器给的 `message`/`code` 原样显示（新增 `INSTALL_FAILED`、`UNINSTALL_FAILED`、`BAD_ACTION` 三条人话）。
- 验证：新增 `tests/input-zoom-install.test.js` 7 条（编码纪律、真实装、重复装不插第二行、卸载还原、命令不认识、环境变量兜底、界面不许假成功），直接调 `powershell.exe` 真跑；`node --test` **513 通过 / 0 失败 / 2 跳过**；实机对真实 renderer 目录跑「查→卸→装→查」，`installed` 依次 true→false→true→true。
- 未验：知意面板里那个按钮的端到端点击（面板 iframe 票据限制）；`lib/input-zoom.js` 的环境变量传递在 App 沙盒里是否被裁剪没单独验（5.1 下 `HDIZ_ACTION` 兜底已用真实 `powershell.exe` 验过）。
