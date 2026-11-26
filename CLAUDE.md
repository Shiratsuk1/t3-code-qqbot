# CLAUDE.md — T3 Code QQBot 协作代理指南

本文件为 Claude Code 及其他 AI 编程代理接入 `t3-code-qqbot` 仓库时的快速上下文入口。完整工程契约与红线定义以根目录 **[AGENTS.md](AGENTS.md)** 为唯一权威基准。

---

## 1. 项目速览

- **定位**：跨平台（Windows 10/11 & Linux）官方 QQ 机器人（OpenAPI WebSocket）与本地 **T3 Code** 的零侵入桥接与富媒体 MCP 插件。
- **运行时与工具链**：Node.js >= 24.0.0（ESM）、TypeScript 5.8（`strict`）、`esbuild`（打包为 4 个独立入口 `dist/cli.mjs` / `dist/bridge.mjs` / `dist/gateway.mjs` / `dist/publish.mjs`）、原生 `node:test` 测试框架。
- **开源仓库与包名**：`https://github.com/Shiratsuk1/t3-code-qqbot` · npm 包 `t3-code-qqbot` · 全局命令 `t3-qqbot`。

---

## 2. 修改代码前必守红线

1. **全中文文档**：所有 Markdown 文档、Release 说明、CLI/QQ 交互提示必须使用简体中文（代码符号与协议专有名词保留英文）。
2. **原生 T3 协议优先**：会话控制（`/model`、`/think`、`/provider`、`/new`、`/stop`、`/rewind`、收纳）统一走 `src/t3-ws.ts` 原生 WebSocket，新建会话默认 `runtimeMode: 'full-access'`。
3. **Windows 零窗口守护**：严禁在 Windows 计划任务中使用 `powershell.exe -WindowStyle Hidden` 或 `cmd.exe`；必须通过 GUI 宿主 `wscript.exe //B //Nologo` + UTF-16 LE BOM `state\run-service.vbs` 直启 `node.exe --log-file`，且每次涉及守护修改必须在真实桌面会话实证 `MainWindowHandle === 0` 与零新增终端窗口。
4. **安全与隐私边界**：仅绑定回环地址、剥离 `QQ_*` 子进程环境变量、工作区 `realpath` 禁闭；严禁在仓库中写入任何个人主机名、用户名、私有 IP 或真实凭据。

---

## 3. 常用开发与验证命令

```bash
# 类型检查
npm run typecheck

# 运行全量单元测试（test/*.test.ts）
npm test

# 面向本机真实 T3 Code 运行无 Mock 端到端契约实证（需本机 T3 Code 已运行）
npm run verify:live

# 构建 dist/*.mjs 并执行 node --check 语法检验
npm run build

# 生成 Windows (.zip) 与 Linux (.tar.gz) 离线发布包到 release/
npm run package

# 预检 npm 发布包文件清单
npm pack --dry-run
```

> 改完任意源码后，至少执行 `npm run typecheck && npm test && npm run build` 确认全绿（`Exit Code 0`），并**自动 `git commit` + `git push origin main`**，确保所有 git 源码节点随时可通过 `/update` 立即拉取最新修复。

---

## 4. 模块与文档导航

| 关注领域 | 核心源码 | 对应文档 |
|---|---|---|
| 系统架构与 T3 原生 WS 协议 | `src/bridge.ts`、`src/t3-ws.ts`、`src/observe.ts` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 斜杠指令与 `/update` 自动更新 | `src/slash-commands.ts`、`src/cli.ts` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Windows 零窗口与 Linux 守护 | `src/service.ts`、`scripts/install-windows-task.ps1` | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 入站附件与出站 `qqbot_send_media` | `src/protocol.ts`、`src/publish.ts` | [SECURITY.md](SECURITY.md) |
| 首次安装、绑定与双机部署 | `src/menu.ts`、`src/qr-login.ts` | [docs/SETUP.md](docs/SETUP.md) |
| 版本演进与发布记录 | `package.json`、`src/config.ts` | [CHANGELOG.md](CHANGELOG.md) |
