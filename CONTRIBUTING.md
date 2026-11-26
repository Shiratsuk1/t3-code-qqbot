# 贡献指南（CONTRIBUTING）

欢迎向 `t3-code-qqbot` 提交 Issue 与 Pull Request！在开始前请花 1 分钟了解本项目的工程约定。

## 1. 环境准备

- **Node.js**：>= 24.0.0
- **操作系统**：Windows 10/11 或 Linux

```bash
git clone https://github.com/Shiratsuk1/t3-code-qqbot.git
cd t3-code-qqbot
npm ci
```

## 2. 开发与提交规范

1. **全简体中文文档与提示**：所有文档（`README.md`、`docs/*.md`、`CHANGELOG.md` 等）、Release 说明与面向用户的交互文案请统一使用简体中文（代码符号与协议专有名词保留英文）。
2. **原生协议优先**：涉及 T3 Code 会话与模型控制请优先通过 `src/t3-ws.ts` 原生 WebSocket 对接，避免依赖非官方补丁。
3. **Windows 无窗口铁律**：任何 Windows 后台守护脚本严禁直接以 `powershell.exe -WindowStyle Hidden` 或 `cmd.exe` 作为计划任务入口，必须使用 GUI 子系统宿主（如 `wscript.exe`）并在真实桌面会话验证 `MainWindowHandle === 0`。
4. **严禁提交隐私数据**：提交前检查 `git diff`，确保不包含真实 `appId`/`appSecret`/`openid`、私人路径、主机名或内网 IP。

## 3. 提交前必须通过的验证链

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

新功能与 Bug 修复请尽量在 `test/` 下补充对应的 `node:test` 单元测试用例。
