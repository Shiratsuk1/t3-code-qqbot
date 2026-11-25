# T3 Code QQBot 项目协作与文档规范

本文件为 `t3-code-qqbot` 仓库的长期工程与文档约定，所有贡献者与 AI 代理在本项目内工作时必须严格遵守。

## 1. 文档语言铁律（强制中文）

- **本项目所有文档必须统一使用简体中文编写**，包括但不限于：
  - `README.md`、`docs/*.md`、`AGENTS.md`、`CHANGELOG.md` 等全部 Markdown 文档；
  - GitHub Release 发布说明、仓库简介（Description）、Issue / PR 说明；
  - `package.json` 的 `description` 字段以及面向用户的 CLI 交互向导、菜单与 QQ 斜杠指令提示文案。
- 专有名词、命令行参数、代码符号、配置键名与底层协议字段（如 `T3 Code`、`checkpoint.rollback`、`--files`、`systemd --user`）保留英文原名，其余叙述、标题、步骤说明与变更日志一律使用清晰自然的简体中文。

## 2. 架构与协议原则

- **优先对接 T3 Code 原生协议**：所有会话控制、流式监听、附件上传、模型切换与回溯撤回，均应直接调用 T3 Code 原生 MCP 工具或原生 WebSocket（`/ws?orchestrationProtocol=2`），如 `message.dispatch`、`orchestration.subscribeThread`、`orchestration.getThreadProjection`、`checkpoint.rollback`；严禁将其他客户端（如 `agy-qqbot`）的旁路实现硬套到 T3 Code 上。
- **跨平台兼容**：所有核心逻辑与服务管理必须同时兼容 **Windows 10/11** 与 **Linux**。
- **隐私零泄漏**：严禁在代码、测试、文档或发布包中残留任何个人主机名、用户名、私有 IP、凭据或定制服务端补丁。

## 3. 构建、验证与发布闭环

在提交或发布前必须完整通过以下校验（需 Node.js >= 24.0.0）：

```bash
npm run typecheck
npm test
npm run package
npm pack --dry-run
```

- 每次对外发版时，GitHub Release 标题与变更说明必须使用简体中文，并附带 `release/` 下最新的 `.zip`（Windows）与 `.tar.gz`（Linux）离线包。
