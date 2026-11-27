# T3 Code QQBot 运维、排障与发版手册

本文档面向日常运维人员与仓库维护者，提供守护服务管理、日志定位、断点补发、无窗口验收以及标准发版流程（SOP）。

---

## 1. 后台守护日常管理

Windows 与 Linux 统一通过 `t3-qqbot service` 管理（离线包用户将 `t3-qqbot` 替换为 `node dist/cli.mjs`）：

```bash
t3-qqbot service install     # 注册开机自启并立即后台启动
t3-qqbot service status      # 查看任务/服务状态与本地 /health 探测结果
t3-qqbot service restart     # 重启守护（Windows 自动迁移旧版 run-service.ps1）
t3-qqbot service stop        # 停止任务并清理全部宿主与子进程
t3-qqbot service uninstall   # 卸载开机自启并清理启动脚本
```

### 日志位置
- **Windows**：
  - `state\service.log`：监督进程与 `bridge` / `gateway` 合并带时间戳输出；
  - `state\bridge.log`：桥接结构化日志与计时打点（`QQ_T3_TIMING`）；
  - `state\gateway.log`：QQ 官方 WebSocket 连接、鉴权与心跳日志。
- **Linux（`systemd --user`）**：
  - `journalctl --user -u t3-code-qqbot.service -f`
  - 需退出 SSH 后持续保活时执行一次：`sudo loginctl enable-linger "$USER"`

---

## 2. Windows 零窗口实证验收命令

凡修改守护启动逻辑后，在真实桌面登录态 PowerShell 中执行以下核验：

```powershell
# 1. 确认计划任务入口为 GUI 子系统 wscript.exe（严禁出现 powershell.exe）
$task = Get-ScheduledTask -TaskName 'T3 Code QQBot'
$task.State
$task.Actions | Select-Object Execute, Arguments

# 2. 确认所有守护进程（wscript.exe + node.exe）的 MainWindowHandle 均为 0
Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 't3-code-qqbot|run-service' } |
  ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{ PID = $_.ProcessId; Name = $_.Name; HWND = $p.MainWindowHandle.ToInt64() }
  } | Format-Table -AutoSize

# 3. 探测本地就绪接口（将端口替换为你的 config.json 中 bridge.port）
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18773/ready'
```

预期标准：
- `Actions.Execute` 为 `C:\Windows\System32\wscript.exe`；
- 进程列表包含 `wscript.exe` + 3 个 `node.exe`（supervisor、bridge、gateway），零 `powershell.exe`，且所有进程 `HWND = 0`；
- `/ready` 返回 `HTTP 200` 且 `ok: true`。

---

## 3. 断点补发与全链路体检

- **6 步全链路体检**：
  ```bash
  t3-qqbot doctor --config ./config.json
  ```
- **面向本机真实 T3 Code 的无 Mock 契约实证（开发者/升级验收推荐）**：
  ```bash
  npm run verify:live
  ```
  验证内容覆盖 T3 MCP 能力发现、原生 WS 只读查询、10 MiB 图片 / 11 MiB 大图转文件 / 15 MiB & 50 MiB 视频流式上传边界、`50 MiB + 1 B` 拒收边界、流式入站落盘零 `.part` 残留及出站 `safeArtifact` 矩阵（全部上传后立即 `discard`，不污染现有线程）。
- **补发未送达的回复**（桥接在线时即可执行，不占端口、不重跑模型）：
  1. 从 `state/bridge.log` 的 `T3 accepted <key> <threadId> <runId>` 或最新 `state/*.run.json` 提取 `runId`；
  2. 执行：
     ```bash
     t3-qqbot recover <runId> --config ./config.json
     ```

---

## 4. 高频故障排查速查

| 现象 / 报错 | 根因定位 | 处理方法 |
|---|---|---|
| Windows 仍弹出 `run-service.ps1` 黑框 | 仍停留在 `v1.2.2` 或更早版本的计划任务 | 升级至 `>= v1.2.4`（QQ 发 `/update` 或 `npm i -g t3-code-qqbot@latest && t3-qqbot service restart`），新版会自动热迁移并关闭黑框 |
| `/model` 或 `/new` 报 `runtime_mode_escalation_denied` | 旧版走了 MCP 写接口被限制在 `approval-required` | 升级至 `>= v1.2.3`，控制指令已全量迁移至原生 T3 WebSocket（默认 `full-access`） |
| 网关日志报 `401` / IP 不在白名单 | 运行 `gateway` 机器的公网出口 IP 未登记 | 在 QQ 开放平台「开发设置 -> IP 白名单」补充当前公网 IP |
| 收到消息但日志显示 `[unbound]` | 当前 QQ 用户的 `scope` 未加入 `bindings` | 复制日志里的 `c2c:<openid>` 执行 `t3-qqbot bind --scope ... --workspace ...` 并重启 |
| `/update` 提示当前已是最新但 GitHub 已有新版本 | npm 仓库尚未同步推送该版本 | 按下文第 5 节执行 `npm publish --access public` 同步 npm |
| 私聊流式回复中途截断或出现异常气泡 | 模型回复包含 `t3-thread://` 等非公网内部协议链接，或 QQ 流式接口临时拒收 | 插件默认自动将非 `http(s)` 内部协议链接清洗为 `「标题」` 并在 `state\bridge.log` 记录完整 `httpStatus`/`bizCode`/`bizMessage`；如需临时关闭私聊流式直发普通消息，可在 `config.json` 设置 `bridge.enableStreaming: false`（或执行 `t3-qqbot config set bridge.enableStreaming false`） |

---

## 5. 标准发版流程（维护者 SOP）

### 5.1 版本号 5 处同步清单
升级版本（例如 `1.2.x`）时，必须同步更新以下 5 处 + 变更日志：
1. `package.json`（`"version"`）
2. `package-lock.json`（根级及 `packages[""]` 的 `"version"`）
3. `src/config.ts`（`export const APP_VERSION = '...'`）
4. `README.md`（离线发布包下载示例版本号）
5. `docs/SETUP.md`（Windows / Linux 离线包解压示例版本号）
6. `CHANGELOG.md`（新增简体中文版本条目）

### 5.2 校验、打包与发布命令
```bash
# 1. 全量验证闭环
npm run typecheck
npm test
npm run package
npm pack --dry-run

# 2. 提交并推送 Tag
git add -A
git commit -m "chore(release): v<版本号>"
git tag -a v<版本号> -m "v<版本号>"
git push origin main --follow-tags

# 3. 发布简体中文 GitHub Release（附带双平台离线包）
gh release create v<版本号> \
  release/t3-code-qqbot-v<版本号>.zip \
  release/t3-code-qqbot-v<版本号>.tar.gz \
  --title "v<版本号> — <简体中文一句话摘要>" \
  --notes-file <简体中文发布说明.md>

# 4. 同步发布到 npm（账号开启 2FA 时按终端提示完成浏览器或 --otp 验证）
npm publish --access public
npm view t3-code-qqbot version
```
