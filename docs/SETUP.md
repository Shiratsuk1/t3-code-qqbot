# T3 Code QQBot 从 0 开始完整配置教程（Windows & Linux）

本教程带你从零完成 **QQ 开放平台建号 -> 本地环境准备 -> 插件安装 -> 绑定会话 -> 双向图片/文件收发 -> 后台开机自启** 的全流程。

---

## 目录

1. [环境前置要求](#1-环境前置要求)
2. [在 QQ 开放平台创建机器人](#2-在-qq-开放平台创建机器人)
3. [安装插件（Windows & Linux）](#3-安装插件windows--linux)
4. [初始化配置与填写凭据](#4-初始化配置与填写凭据)
5. [获取你的 QQ `user_openid` / `group_openid`](#5-获取你的-qq-user_openid--group_openid)
6. [绑定 T3 Code 工作区与会话](#6-绑定-t3-code-工作区与会话)
7. [（可选）启用 `qqbot_send_media` 让 AI 回传图片/文件](#7-可选启用-qqbot_send_media-让-ai-回传图片文件)
8. [体检与验收测试](#8-体检与验收测试)
9. [配置后台常驻与开机自启](#9-配置后台常驻与开机自启)
10. [进阶：Linux 网关 + Windows T3 双机分离部署](#10-进阶linux-网关--windows-t3-双机分离部署)
11. [配置项与环境变量速查](#11-配置项与环境变量速查)
12. [常见问题排查（FAQ）](#12-常见问题排查faq)

---

## 1. 环境前置要求

### 1.1 安装 Node.js 24+

本插件要求 **Node.js 24.0.0 或更高版本**。

- **Windows**：从 [Node.js 官网](https://nodejs.org/) 下载 Node.js 24 LTS 安装包，或使用 `winget`：
  ```powershell
  winget install OpenJS.NodeJS.24
  node -v
  ```
- **Linux（Ubuntu / Debian 示例）**：
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v
  ```

确认输出类似 `v24.x.x`。

### 1.2 安装并运行官方 T3 Code

1. 安装官方 T3 Code（Windows 桌面版或 Linux 桌面版 / CLI 服务版）。
2. 启动 T3 Code，并在 T3 Code 中**打开或新建至少一个项目工作区**（例如 Windows 的 `D:\Work\my-qq-workspace` 或 Linux 的 `/home/you/my-qq-workspace`）。
3. 确认 T3 Code 本地服务可访问（默认端口 `3773`）：
   - **Windows PowerShell**：
     ```powershell
     Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:3773 -Method Head
     ```
   - **Linux Bash**：
     ```bash
     curl -I http://127.0.0.1:3773
     ```

> **提示**：
> - Windows 桌面版 T3 Code 安装后即使 `%USERPROFILE%\.t3\bin` 未加入 `PATH`，插件的 `t3.executable: "auto"` 也会自动定位 `%USERPROFILE%\.t3\bin\t3.cmd` 并解析底层可执行文件。
> - 如果你的 T3 Code 监听在非 `3773` 端口，记下它的地址（例如 `http://127.0.0.1:4773`），稍后填入 `config.json` 的 `t3.origin`。

---

## 2. 在 QQ 开放平台创建机器人

1. 登录 [QQ 开放平台](https://q.qq.com/)，进入 **机器人** 控制台并创建一个新的 QQ 机器人。
2. 在 **开发管理 -> 开发设置** 页面获取以下两项凭据：
   - **AppID**（一串数字，如 `102xxxxxx`）
   - **AppSecret**（机器人密钥，点击重置/查看并妥善保管）
3. **配置 IP 白名单（关键步骤）**：
   - 在 **开发设置 -> IP 白名单** 中，添加运行 `gateway` 机器的**公网出口 IP**。
   - 查询本机公网 IP：
     - **Windows PowerShell**：`curl.exe https://ifconfig.me`
     - **Linux Bash**：`curl https://ifconfig.me`
   - 若公网 IP 未加入白名单，连接 QQ OpenAPI 获取 Token 时会报鉴权失败。
   - **家庭宽带提醒**：若家庭宽带公网 IP 频繁变动，建议把 `gateway` 部署在固定 IP 的 Linux 云主机，参考第 10 节做双机分离转发。
4. **开启沙箱 / 消息权限**：
   - 确认事件接收方式支持 **WebSocket** 模式。
   - 在 **开发管理 -> 沙箱配置** 中添加你自己的 QQ 号（以及需要测试的 QQ 群）。
   - 确保机器人拥有 **单聊消息（`C2C_MESSAGE_CREATE`）** 和/或 **群聊 @ 消息（`GROUP_AT_MESSAGE_CREATE`）** 权限。
5. 用手机 QQ 扫描机器人的测试二维码，将机器人添加到你的好友列表（或拉入测试群）。

---

## 3. 安装插件（Windows & Linux）

### 方式一：npm 全局安装（推荐，跨平台统一命令 `t3-qqbot`）

```bash
npm i -g t3-code-qqbot
mkdir -p ~/t3-qqbot && cd ~/t3-qqbot
```
（Windows PowerShell 下执行 `mkdir C:\Tools\t3-qqbot; cd C:\Tools\t3-qqbot`。）

### 方式二：下载 GitHub Release 离线发布包

- **Windows（PowerShell）**：
  ```powershell
  Expand-Archive -Path .\t3-code-qqbot-v1.1.0.zip -DestinationPath C:\Tools\
  cd C:\Tools\t3-code-qqbot-v1.1.0
  npm ci --omit=dev
  ```
- **Linux（Bash）**：
  ```bash
  mkdir -p ~/t3-code-qqbot
  tar -xzf t3-code-qqbot-v1.1.0.tar.gz -C ~/t3-code-qqbot --strip-components=1
  cd ~/t3-code-qqbot
  npm ci --omit=dev
  ```

> 下文命令以 `t3-qqbot` 为例；如果你使用离线发布包（未全局安装），将 `t3-qqbot` 替换为 `node dist/cli.mjs` 即可。

---

## 4. 交互式安装向导与配置菜单

直接运行初始化向导（会自动探测本机 T3 Code，并按步骤询问 QQ 凭据、端口、群聊 `@`、回复后自动收起侧边栏、可选补丁静音线程 ID、可选立即绑定以及**是否一键注册开机自启与后台自守护**）：

```bash
t3-qqbot init
```

- 自动化脚本或无需交互时，加 `--yes`（或 `-y`）直接生成默认配置：`t3-qqbot init --yes`。
- 以后随时想改任何一项配置，运行 `t3-qqbot config` 即可再次打开完整交互式配置菜单：
- `[1]` QQ Bot 凭据（`AppID` / `AppSecret` / 重新生成随机 `bridgeSecret`）
- `[2]` T3 Code 连接（`t3.origin` / `t3.executable` / `t3.home`）
- `[3]` 桥接与网关参数（端口 / 单条字数上限 / 群聊 `@` / 指令前缀）
- `[4]` QQ 会话绑定管理（自动读取 T3 已注册项目列表按编号选择）
- `[5]` 附件域名白名单
- `[6]` 一键安装与管理后台自守护服务
- `[7]` 可选主会话侧边栏收纳（`autoSettleThread`）与补丁版静音线程 ID 导出
- `[8]` 运行 6 步全链路体检（`doctor`）

也可使用非交互命令快捷修改单项配置：
```bash
t3-qqbot config show
t3-qqbot config set bridge.port 18774
t3-qqbot config set bridge.autoSettleThread true
```

若习惯直接手动编辑 `credentials.json`，填入第 2 步从 QQ 开放平台拿到的 `appId` 和 `appSecret`：

```json
{
  "appId": "你的QQ机器人AppID",
  "appSecret": "你的QQ机器人AppSecret",
  "bridgeSecret": "保留 init 自动生成的随机密钥"
}
```

> **Linux 权限建议**：确保凭据文件仅当前用户可读：
> ```bash
> chmod 600 credentials.json
> ```

> **环境变量替代方式（可选）**：如果你不希望把密钥落盘在 `credentials.json`，直接在环境中注入 `QQ_APP_ID`、`QQ_APP_SECRET`、`QQ_BRIDGE_SECRET` 即可（环境变量已完整提供时，即使未创建 `credentials.json` 也能直接运行）。

---

## 5. 获取你的 QQ `user_openid` / `group_openid`

QQ 开放平台后台不会直接显示你个人账号对应的 `user_openid`。最简单的获取方式是直接启动插件并给机器人发一条消息：

1. 启动插件：
   ```bash
   t3-qqbot start
   ```
   看到类似日志表示连接成功：
   ```text
   T3 QQBot bridge listening on http://127.0.0.1:18773 (0 binding(s))
   T3 QQBot gateway READY -> http://127.0.0.1:18773/events
   ```
2. 用你的 QQ 给机器人发一条私聊消息（例如 `hello`），或在群里 `@机器人 hello`。
3. 查看终端日志，桥接会打印一条带精确标识的提示：
   ```text
   [unbound] Ignored message from "c2c:ABC1234567890..." (sha256:...). Add this scope to "bindings" in .../config.json to enable it.
   ```
4. 复制引号内的 `c2c:ABC1234567890...`（群聊则为 `group:...`），然后按 `Ctrl+C` 暂时停止服务。

---

## 6. 绑定 T3 Code 工作区与会话

你有**两种绑定方式**可选，均通过 `bind` 命令一键校验并写入 `config.json`：

### 方式 A：绑定到工作区，首次聊天自动新建 T3 会话（最简单）

- **Windows**：
  ```powershell
  t3-qqbot bind --scope c2c:你的USER_OPENID --workspace "D:\Work\my-qq-workspace" --install-media-mcp
  ```
- **Linux**：
  ```bash
  t3-qqbot bind --scope c2c:你的USER_OPENID --workspace "/home/you/my-qq-workspace" --install-media-mcp
  ```

首次在 QQ 发消息时，插件会自动在 T3 Code 对应的项目中创建一条线程并持久化到 `state/bindings/<hash>.thread`，之后的所有消息都会持续在同一线程中续聊。

### 方式 B：绑定到 T3 Code 中已有的指定主会话（保留历史上下文）

1. 查询目标项目中的线程列表，记下目标 `threadId`（注意必须通过 `--project` 指定项目工作区路径）：
   ```bash
   t3 thread list --project "<T3项目工作区路径>"
   ```
2. 执行绑定：
   ```bash
   t3-qqbot bind --scope c2c:你的USER_OPENID --thread "你的T3_THREAD_ID" --install-media-mcp
   ```

> **多会话 / 群聊支持**：可对不同的 `c2c:<openid>` 或 `group:<openid>` 重复执行 `bind` 命令。若希望在多会话场景下使用 `qqbot_send_media` 回传文件，请为每个 QQ 对话绑定独立的工作区目录。

> **隐私加固（可选）**：如果你不希望 `config.json` 中明文出现 `openid`，也可以把 `scope` 替换为日志里给出的 `sha256:<64位十六进制哈希>`，桥接同样识别。

---

## 7. （可选）启用 `qqbot_send_media` 让 AI 回传图片/文件

加上 `--install-media-mcp` 参数后：

- **Antigravity Provider**：
  - 传入 `--thread <threadId>` 时（或本机仅存在单个 Antigravity Provider 实例时），`bind` 会自动把 `qqbot-media` 注册到 `~/.t3/userdata/providers/antigravity/<instanceHash>/config/mcp_config.json`（并自动备份原文件为 `.pre-t3-qqbot`）。
  - 若本机有多个 Antigravity 账号实例且未传 `--thread`，请按提示带上 `--thread <threadId>` 再执行一次 `bind` 即可精确定位对应实例。
- **Claude Code / 其他 JSON MCP 客户端**：将 `bind` 打印的 JSON 片段加入 MCP 配置：
  ```json
  {
    "mcpServers": {
      "qqbot-media": {
        "command": "/path/to/node",
        "args": [
          "/path/to/t3-code-qqbot/dist/publish.mjs",
          "/path/to/config.json"
        ]
      }
    }
  }
  ```
- **Codex CLI（`~/.codex/config.toml`）**：使用 TOML 格式：
  ```toml
  [mcp_servers.qqbot-media]
  command = "/path/to/node"
  args = ["/path/to/t3-code-qqbot/dist/publish.mjs", "/path/to/config.json"]
  ```

配置完成后重启对应 T3 会话或 Provider；之后你在 QQ 里让 AI「画张图发给我」或「把生成的报告发到 QQ」，AI 调用 `qqbot_send_media({ path: "output.png" })` 即可直接把工作区内的文件发回当前 QQ 对话。

> **安全边界**：`qqbot_send_media` 严格限制只能发送当前绑定工作区目录内的文件（最大 12 MiB），拒绝 `../` 越界及 Windows UNC 路径；且该 MCP 进程仅需 `appId`/`appSecret`，不需要 `bridgeSecret`。

---

## 8. 体检与验收测试

### 8.1 运行 6 项自动体检

```bash
t3-qqbot doctor
```

> 说明：`doctor` 的 `[3/6]` 仅校验本地凭据非空且非占位符，不向腾讯服务器发包；`AppID`/`AppSecret` 与公网 IP 白名单的有效性会在执行 `start` 连接 QQ 网关时校验。

预期全部通过：
```text
[1/6] Node.js: v24.x.x (...) OK
[2/6] Config loaded: .../config.json (1 binding(s))
[3/6] Credentials loaded: OK (local check only; QQ OpenAPI & IP whitelist verified on gateway connect)
[4/6] T3 CLI resolved: ...
[5/6] T3 Code server reachable: http://127.0.0.1:3773
      Binding c2c:... -> ... OK
[6/6] T3 native attachment upload & discard round-trip: OK

All checks passed.
```

### 8.2 启动并实机验收

```bash
t3-qqbot start
```

按以下顺序在 QQ 测试：
1. **私聊流式回包**：发一条中文消息（如「用三句话介绍你自己」），观察 QQ 内是否实时流式出字，同时打开 T3 Code 桌面端/手机端应能看到同一条对话实时同步。
2. **连续续聊**：在第一条正在回复或刚结束时紧接着发第二条消息，验证自动排队且上下文连续。
3. **附件入站**：在 QQ 发送一张图片或语音，检查 T3 会话中是否以原生附件形式干净收到，并能在 `<workspace>/attachments/` 找到落盘原件。
4. **（若已配 MCP）媒体回传**：让 AI 在工作区生成一张图片并调用 `qqbot_send_media` 发回 QQ。

---

## 9. 一键配置后台自守护与开机自启（推荐）

插件内置跨平台守护服务管理命令，**无需手动编写或修改服务文件**，Windows 与 Linux 统一执行同一条命令即可：

```bash
# 一键注册开机自启并立即在后台启动
t3-qqbot service install

# 常用管理命令
t3-qqbot service status
t3-qqbot service restart
t3-qqbot service stop
t3-qqbot service uninstall
```

底层行为：
- **Windows**：在当前用户下免管理员权限注册 Windows 计划任务（`T3 Code QQBot`），通过隐藏 PowerShell 包装启动 `t3-qqbot start --supervise`，无黑框弹窗、崩溃自动指数退避拉起，全部日志落盘至 `state\service.log`、`state\bridge.log` 与 `state\gateway.log`。执行 `t3-qqbot service stop` / `uninstall` 时会自动一并清理子进程，不留端口占用残留。
- **Linux**：自动生成并启用 `~/.config/systemd/user/t3-code-qqbot.service`（含 `Restart=always`、`RestartSec=5`、`KillMode=control-group`）。如需在退出 SSH 后持续运行，按安装完成时的提示执行一次 `sudo loginctl enable-linger "$USER"` 即可；日志通过 `journalctl --user -u t3-code-qqbot.service -f` 查看。

*(仓库 `scripts/` 目录下仍保留手工脚本模板 `install-windows-task.ps1` 与 `t3-code-qqbot.service` 供定制参考。)*

---

## 10. 进阶：Linux 网关 + Windows T3 双机分离部署

如果你的 QQ IP 白名单绑定在一台固定公网 IP 的 Linux 云主机（主机 A），而 T3 Code 运行在另一台 Windows / Linux 电脑（主机 B），可将 `gateway` 与 `bridge` 分开部署：

1. **在运行 T3 Code 的机器（主机 B）**：
   - 完成正常 `config.json` 与 `credentials.json` 配置，仅启动桥接：
     ```bash
     t3-qqbot bridge --config ./config.json
     ```
   - 桥接监听 `127.0.0.1:18773`。
2. **在具备白名单公网 IP 的 Linux 服务器（主机 A）**：
   - 建立 SSH 本地端口转发，将主机 A 的 `127.0.0.1:18773` 转发到主机 B 的 `127.0.0.1:18773`：
     ```bash
     ssh -NT -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
       -L 127.0.0.1:18773:127.0.0.1:18773 user@<主机B的IP>
     ```
   - 在主机 A 放置相同 `bridgeSecret` 的 `credentials.json` 与最小化 `gateway.json`（无需配置 `t3` 与 `bindings`）：
     ```json
     {
       "stateDir": "./state",
       "credentialsFile": "./credentials.json",
       "gateway": {
         "bridgeUrl": "http://127.0.0.1:18773/events",
         "requireMentionInGroup": true
       }
     }
     ```
   - 仅启动网关：
     ```bash
     t3-qqbot gateway --config ./gateway.json
     ```

这样既无需把 T3 桥接暴露到公网，又能通过 SSH 加密隧道稳定跨机转发。

---

## 11. 配置项与环境变量速查

### 可选配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `t3.home` | `$T3CODE_HOME` 或 `~/.t3` | 自定义 T3 Code 数据目录 |
| `bridge.maxMessageChars` | `1600` | 单条 QQ 回复最大字符数（范围 `100`~`4000`，超出自动分段） |
| `bridge.proactiveBackgroundReports` | `false` | 异步子任务超过 QQ 被动回复窗口时是否使用主动消息推送（需账号具备权限） |
| `bridge.autoSettleThread` | `false` | 每轮回复结束后自动调用 `t3_thread_organize(settle)` 收起 T3 侧边栏活跃状态（官方 T3 直接支持；不屏蔽手机完成推送） |
| `t3.muteMobileCompletionThreadId` | 省略 | 可选主会话 `threadId`，用于在配置菜单导出 `T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID`（需配合支持该环境变量的补丁/自编译 T3 服务端，官方原版暂未内置） |
| `gateway.requireMentionInGroup` | `true` | 群聊是否要求 `@机器人` 才转发 |
| `gateway.stripPrefix` | `""` | 可选指令前缀过滤（如设 `"/ai"` 则自动剥离消息开头的 `/ai`） |
| `bindings[].modelSelection` | 省略 | 自动新建线程时指定的默认模型，如 `{ "provider": "...", "model": "..." }` |

### 支持的环境变量

| 变量名 | 说明 |
|---|---|
| `T3_QQBOT_CONFIG` | 默认配置文件路径（可替代每次传 `--config`） |
| `QQ_CREDENTIALS_FILE` | 覆盖 `config.json` 中的 `credentialsFile` 路径 |
| `QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_BRIDGE_SECRET` | 环境变量注入凭据，优先级高于 `credentials.json` |
| `QQ_BRIDGE_URL` | 覆盖 `gateway.bridgeUrl` |
| `T3CODE_HOME` | 指定 T3 Code 主数据目录 |

---

## 12. 常见问题排查（FAQ）

| 现象 / 报错 | 原因 | 解决方法 |
|---|---|---|
| `T3 Code server is unreachable at http://127.0.0.1:3773` | T3 Code 未启动，或端口不是 `3773` | 先打开 T3 Code，或检查实际端口后修改 `config.json` 中的 `t3.origin` |
| Windows 下 `T3 CLI (...) failed` | 自定义安装路径导致自动探测未命中 `%USERPROFILE%\.t3\bin\t3.cmd` | 在 `config.json` 中手动填写 `t3.executable`（如 `T3 Code (Beta).exe`）、`t3.prefix`（`bin.mjs` 路径）与 `t3.env`（`ELECTRON_RUN_AS_NODE: "1"`） |
| 网关启动报 `401` / `IP not in whitelist` | 公网出口 IP 未加入 QQ 开放平台白名单，或 `appId`/`appSecret` 有误 | 在 QQ 开放平台更新 IP 白名单，核对 `credentials.json` |
| 发消息日志出现 `403` 与 `[unbound]` | 当前 QQ 用户的 `scope` 尚未写入 `config.json` 的 `bindings` | 使用日志里打印的 `c2c:<openid>` 执行 `t3-qqbot bind ...` 后重启 |
| 回复内容已经生成，但连发下一条卡顿几十秒 | 绑定的工作区目录下存在一个未提交任何 commit 的空 `.git` 目录，可能拖慢 T3 收尾检查点 | 初始化至少一次正常 commit，或移除不需要的空 `.git` 目录 |
| 桥接中途意外崩溃，T3 已完成回复但 QQ 没收到 | 进程中断导致订阅断开，但运行记录已持久化 | 从 `state/bridge.log` 的 `T3 accepted <key> <threadId> <runId>`（或最新 `state/*.run.json` 内的 `runId` 字段）获取 `runId`，执行 `t3-qqbot recover <runId>` 补发（可在桥接在线时直接运行，不会重跑模型） |
| 群聊里没有流式打字机效果 | QQ 官方 `stream_messages` 接口仅支持私聊（C2C） | 属腾讯平台限制；群聊会在正文完成后自动通过标准消息发出 |
| 图片/文件下载报 `Unrecognized QQ attachment origin` | 腾讯附件 CDN 域名更新，不在默认白名单内 | 从日志记下实际域名，追加到 `config.json` 的 `attachmentHosts` 数组中重启即可 |
