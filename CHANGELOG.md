# 更新日志（CHANGELOG）

本项目遵循语义化版本规范，所有变更均以简体中文记录。

---

## [v1.2.5] — 2026-11-26

### 修复与增强
- **修复 QQ 语音消息因 CDN 域名不在白名单被拦截的问题（`Unrecognized QQ attachment origin: qqbot.ugcimg.cn`）**：
  - 将腾讯官方 QQ 机器人语音 WAV 转码 CDN 域名 `qqbot.ugcimg.cn` 加入默认附件域名白名单 `DEFAULT_ATTACHMENT_HOSTS` 及 `config.example.json`；
  - 对存量已由旧版 `init` 写入旧 4 个默认域名的 `config.json`，`parseConfig` 自动无感补齐 `qqbot.ugcimg.cn`（同时严格保留用户主动收紧的自定义子集白名单）。
- **语音入站链路全面加固**：
  - `gateway.ts` 补齐裸域名 URL 规范化，透传 QQ 自带语音转文字 `asr_refer_text`，并在 `voice_wav_url` 与原始 `url` 不同时保留 `fallback_url`；
  - `protocol.ts` 新增 `.amr`/`.ogg`/`.m4a`/`.aac`/`.flac`/`.webm` 音频 MIME 与 `AMR`/`MP3`/`OGG` 文件头魔数嗅探，并支持最多 2 次严格校验白名单与 HTTPS 的安全重定向；
  - `bridge.ts` 在继续上传原生 `.wav` 音频附件的同时，自动附带 `[语音转写参考]` 或纯语音兜底文本 `[语音消息]`（兼容不支持原生音频输入的后端），主链接拉取失败时依次自动回退 `fallback_url` 或转写文本。
- 新增配置升级、音频魔数、白名单重定向及语音文本组装测试（总计 40 项用例全通）。

---

## [v1.2.4] — 2026-11-25

### 新增与改进
- **旧版 Windows `run-service.ps1` 计划任务全自动无感热迁移**：
  - 在 `bridge.mjs` 启动就绪与 `t3-qqbot service start / restart` 时自动检测仍指向旧版 `state\run-service.ps1` 的 Windows 计划任务；
  - 自动生成 UTF-16 LE BOM 的 `state\run-service.vbs` 并原子替换任务入口为 `wscript.exe //B //Nologo`，清理旧 `run-service.ps1`；
  - 若旧版 PowerShell 黑框进程仍在运行，自动派生一次性无窗自毁脱壳脚本关闭旧黑框，并在约 3 秒内由零窗口 `wscript.exe` 守护无缝接管。
- 补齐 `renderWindowsHandoverVbs` 单元测试（总计 39 项用例全通）。

---

## [v1.2.3] — 2026-11-25

### 修复与架构升级
- **Windows 后台守护彻底零窗口（解决 Windows 11 黑框残留）**：
  - 彻底移除 `powershell.exe -WindowStyle Hidden` 包装层，`service install` 与 `scripts/install-windows-task.ps1` 全面切换至 GUI 子系统宿主 `C:\Windows\System32\wscript.exe` + UTF-16 LE BOM `state\run-service.vbs`（`WScript.Shell.Run(cmd, 0, True)`）；
  - `t3-qqbot start` 新增 `--log-file <路径>` 原生带时间戳落盘，子进程显式启用 `windowsHide: true`。
- **斜杠控制指令全量迁移至 T3 原生 WebSocket（默认 `full-access`）**：
  - `/model`、`/think`、`/provider`（新增 `/provide` 别名、`/model all` 与 `orchestrator_capabilities({ search })` 回退）、`/new`（默认 `full-access`）、`/stop`、`/cancel all` 与 `autoSettleThread` 改走原生 WS，彻底消除 `runtime_mode_escalation_denied` 权限拒绝。
- **`/update` 全模式自动更新与零等待热重启**：
  - 完整支持 `npm-global`（`npm-cli.js` 在 `tmpdir()` 执行避免 Windows `EBUSY`）、`standalone`（从官方 npm 拉取 `.tgz` 仅替换运行时文件并保留配置与状态）及 `git` 源码仓库模式；
  - 引入 `SELF_UPDATE_EXIT_CODE = 75` 优雅退出码，配合 `--supervise` 零等待热重启。
- **交互细节完善**：修复 `/compact` 透传静默结束问题，CLI `--help` 全面中文化。

---

## [v1.2.2] — 2026-11-25

### 修复与规范
- 修复 `/rewind` 回退至第 0 轮基线时，因 T3 裁剪第 1 轮导致 `lastRunOrdinal` 变为 `null` 触发的等待超时问题。
- 确立项目全简体中文文档约定（`AGENTS.md`），中文化 `package.json` 描述与仓库文档。

---

## [v1.2.1] — 2026-11-25

### 新增与修复
- `/rewind`（`/undo` / `/撤回`）切换至 T3 Code 原生原地回滚协议 `checkpoint.rollback`（支持 1-10 轮及可选 `--files` 还原工作树文件）。
- 私聊（C2C）新增「对方正在输入…」状态提示并每 50 秒自动续期保活直至回复完成。

---

## [v1.2.0] — 2026-11-25

### 新增功能
- 完整移植 QQ 聊天内斜杠指令面板（`/help`、`/model`、`/think`、`/provider`、`/new`、`/threads`、`/use`、`/rewind`、`/compact`、`/status`、`/tasks`、`/cancel`、`/update`）。
- 集成 `@tencent-connect/qqbot-connector`，新增 `t3-qqbot login` 终端扫码一键获取 `AppID`、`AppSecret` 与 `user_openid`。

---

## [v1.1.0] — 2026-11-25

### 新增功能
- 新增交互式安装向导（`t3-qqbot init`）与交互式配置菜单（`t3-qqbot config`）。
- 新增跨平台后台守护命令（`t3-qqbot service install/status/start/stop/restart/uninstall`），支持 Windows 计划任务与 Linux `systemd --user`。
- 新增可选侧边栏自动收纳（`bridge.autoSettleThread`）与补丁版静音线程配置支持。

---

## [v1.0.0] — 2026-11-25

### 首个正式版本
- 跨平台（Windows 10/11 & Linux）T3 Code 官方 QQ 机器人桥接与富媒体 MCP（`qqbot_send_media`）发布。
- 支持原生 T3 WebSocket 投递与流式回包、双向图片/语音/文件收发、幂等状态持久化与 `recover <runId>` 断点补发、6 步 `doctor` 体检及单机/双机分离部署。
