# AGENTS.md — T3 Code QQBot 开发宪章

面向 AI 编码代理与开发者的顶层工程契约。`t3-code-qqbot` 是将**官方 QQ 机器人（OpenAPI WebSocket）**接入本地 **T3 Code** 的跨平台（Windows 10/11 & Linux）桥接与富媒体 MCP 插件，基于 **Node.js 24+ · TypeScript 5.8（strict）· esbuild · 原生 `node:test`**，无需修改或重编译 T3 Code 本体。

---

## 1. 不可违背的核心红线

### 1.1 文档与面向用户文案铁律（强制简体中文）
- **本项目所有文档必须统一使用简体中文编写**，包括 `README.md`、`AGENTS.md`、`CLAUDE.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`docs/*.md`、GitHub Release 发布说明、仓库简介、`package.json` 的 `description` 以及 CLI 交互向导/菜单/QQ 斜杠指令提示文案。
- 专有名词、命令行参数、代码符号、配置键名与底层协议字段（如 `T3 Code`、`checkpoint.rollback`、`--files`、`systemd --user`、`wscript.exe`）保留英文原名，其余叙述与步骤一律使用清晰自然的简体中文。

### 1.2 原生 T3 协议优先（禁止旁路魔改）
- 所有会话创建、消息投递、流式订阅、模型/思考强度切换、任务中断、侧边栏收纳与回溯撤回，**优先通过 T3 Code 原生 WebSocket（`/ws?orchestrationProtocol=2`）** 完成（如 `message.dispatch`、`orchestration.subscribeThread`、`orchestration.getThreadProjection`、`checkpoint.rollback`、`thread.create`、`thread.model-selection.set`、`thread.stop`、`thread.settle`），默认新建线程权限为 `runtimeMode: 'full-access'`，避免独立 MCP 客户端触发 `runtime_mode_escalation_denied`。
- 附件上传与只读能力发现通过官方 T3 MCP（`t3_attachment_prepare_upload`、`t3_attachment_discard`、`orchestrator_capabilities`、`t3_project_list`、`t3_thread_list`、`t3_thread_read`）调用。严禁将其他客户端（如 `agy-qqbot`）的旁路实现硬套到 T3 Code 上。

### 1.3 Windows 后台守护零窗口铁律
- Windows 计划任务（Scheduled Task）**绝对严禁**直接以 `powershell.exe -WindowStyle Hidden`、`pwsh.exe -WindowStyle Hidden` 或 `cmd.exe` 作为入口（CUI 子系统在 Windows 10 会闪黑框，在 Windows 11 默认 Windows Terminal 下会永久残留可见黑框）。
- 必须使用 **GUI 子系统宿主** `C:\Windows\System32\wscript.exe //B //Nologo` 配合 **UTF-16 LE BOM** 编码的 `state\run-service.vbs`（通过 `WScript.Shell.Run(cmd, 0, True)` 在 `CreateProcess` 阶段注入 `SW_HIDE` 并兼容中文路径）直启 `node.exe start --supervise --config ... --log-file ...`，所有子进程派生均须传 `windowsHide: true`。
- 凡涉及守护服务改动，**必须在真实 Windows 桌面交互会话下实证**：全部守护进程 `MainWindowHandle === 0`、桌面可见终端窗口零新增、`service stop / uninstall` 后零孤儿进程残留。严禁仅凭 `/health` 返回 200 宣称无窗口成功。

### 1.4 安全边界与隐私零泄漏
- 桥接 HTTP 服务仅允许监听回环地址（`127.0.0.1` / `localhost` / `::1`），鉴权强制使用 `timingSafeEqual` 校验 `Authorization: Bearer <bridgeSecret>`。
- T3 通信仅允许连接本地回环 `t3.origin`；派生 `t3` CLI 子进程时强制剥离全部 `QQ_*` 凭据环境变量；临时签发的 T3 会话令牌在任务结束或退出时自动吊销。
- 入站附件强制 HTTPS + 反 SSRF 校验（禁止本机/私网/链路本地/云元数据/CGNAT IP 与非常规端口，兼容 Clash `198.18.0.0/15` Fake-IP；默认不再硬卡静态 CDN 域名白名单，仅当用户主动填写 `attachmentHosts` 时启用限定白名单）+ 魔数文件头嗅探 + 流式落盘（默认单件 200 MiB / 单消息 10 件，可在 `config.json` 的 `attachments` 调整；单图 `≤ 10 MiB` 走 T3 原生 `image`、普通文件/视频/大图 `≤ 50 MiB` 走 T3 原生流式 `file`、超过 50 MiB 自动工作区落盘并附本地绝对路径交付）；出站媒体 MCP（`qqbot_send_media`）先拦截 UNC / 越界路径，再经 `realpath` 严格限定在绑定工作区内，并按 QQ 官方 SDK 分类型上限放行（图 30 MiB / 语音 20 MiB / `.mp4` 视频与文件 100 MiB，支持分片上传）。
- **隐私零泄漏**：严禁在代码、测试、文档、配置样例或发布包中提交任何个人主机名、用户名、私有 IP、真实 AppID/AppSecret、OpenID 或定制服务端补丁。

---

## 2. 目录骨架与模块职责

```text
src/
  cli.ts              CLI 总入口（init / login / config / start --supervise --log-file / service / bridge / gateway / bind / doctor / recover）
  bridge.ts           本地 HTTP 桥接服务、T3 调度、C2C 实时流式与 50s 打字状态保活、幂等状态落盘与断点恢复
  gateway.ts          QQ 官方 OpenAPI WebSocket 网关进程（含心跳重连与转发至 bridge）
  t3-ws.ts            T3 Code 原生 WebSocket 协议客户端（投递、流式订阅、模型切换、建线程、中断、收纳、原生 checkpoint.rollback）
  t3-cli.ts           跨平台 T3 CLI 自动解析（Windows t3.cmd Electron 包装 / 独立 t3.exe / Linux t3）与临时会话签发/吊销
  observe.ts          T3 MCP HTTP 客户端（会话自动续期、项目/线程读取、能力发现、原生附件上传）
  slash-commands.ts   QQ 聊天内全套斜杠指令面板（/model /think /provider /new /threads /use /rewind /compact /status /tasks /cancel /update /help）
  service.ts          跨平台守护服务管理（Windows wscript.exe 零窗口计划任务 + 旧 run-service.ps1 自动热迁移 / Linux systemd --user）
  publish.ts          出站媒体 MCP Server（qqbot_send_media，工作区路径安全禁闭 + OpenAPI /files 上传）
  menu.ts             交互式 init 安装向导与 config 配置菜单
  qr-login.ts         终端扫码一键登录 QQ 开放平台绑定机器人
  config.ts           APP_VERSION、SELF_UPDATE_EXIT_CODE(75)、配置与凭据加载校验、路径比较
  protocol.ts         摘要计算、MIME/文件头嗅探、入站附件落盘、出站安全路径校验
  types.ts            全局 TypeScript 类型定义
scripts/
  build.mjs           esbuild 构建 dist/*.mjs、语法检查与 --package 双平台离线归档（.zip / .tar.gz）
  verify-live.mjs     面向本机真实 T3 Code Server 的无 Mock 端到端契约实证脚本（npm run verify:live）
  install-windows-task.ps1 / start-windows.ps1 / t3-code-qqbot.service  手工部署脚本模板
test/                 11 套原生 node:test 单元测试套件（当前 44 项用例）
docs/                 完整中文文档（SETUP.md / ARCHITECTURE.md / OPERATIONS.md）
```

---

## 3. 子代理节制使用规范

- 常规检索、局部修改、单测与构建验证一律在主线程直接完成，严禁为轻量任务派发多余子代理浪费上下文与额度。
- 仅在跨模块大规模重构、需要独立隔离 `worktree` 并行落地或独立审查时，才按需委派最小数量的子任务，且严格划分不重叠的文件修改边界。

---

## 4. 构建、验证与发版闭环

所有提交或发版前必须完整通过以下校验（Node.js >= 24.0.0）：

```bash
npm run typecheck
npm test
npm run verify:live   # 本机已启动 T3 Code 时实测原生协议与大文件边界
npm run package
npm pack --dry-run
```

- **修复完成自动提交与推送铁律**：每次完成代码修复或功能改动并通过 `npm run typecheck && npm test && npm run build` 校验后，**必须自动执行 `git commit` 并推送到 `origin/main`**（无需等待用户额外催促），确保所有 git 源码部署节点随时可通过 `/update` 第一时间拉取最新修复；仅当明确需要正式发版（Tag / GitHub Release / npm）时同步更新版本号与离线归档。
- 发版时须同步更新版本号的 5 处位置：`package.json`、`package-lock.json`、`src/config.ts`（`APP_VERSION`）、`README.md`、`docs/SETUP.md`，并同步追加 `CHANGELOG.md`。
- GitHub Release 标题与变更说明必须使用简体中文，附带 `release/` 下最新的 `.zip`（Windows）与 `.tar.gz`（Linux）离线包，并保持与 npm（`t3-code-qqbot`）版本号一致。

---

## 5. 按需深入阅读索引（Progressive Disclosure）

修改特定模块前按需查阅，平时无需全量加载：

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**：系统架构、原生 T3 WebSocket 协议交互细节、C2C 流式与保活、`/update` 热重启与 Windows 零窗口迁移状态机。
- **[docs/SETUP.md](docs/SETUP.md)**：从零开始的 QQ 开放平台配置、安装、绑定、媒体 MCP 与双机分离完整教程。
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)**：后台守护运维、日志排障、断点补发（`recover`）、标准发版 SOP 与故障速查表。
- **[CHANGELOG.md](CHANGELOG.md)**：各版本完整中文变更记录。
- **[SECURITY.md](SECURITY.md)**：安全架构设计边界与漏洞披露指引。
