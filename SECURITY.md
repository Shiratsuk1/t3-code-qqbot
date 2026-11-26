# 安全策略（SECURITY）

## 核心安全设计边界

`t3-code-qqbot` 默认遵循最小权限与本地回环隔离原则：

1. **回环网络禁闭**：
   - 本地桥接 HTTP 服务仅允许监听回环地址（`127.0.0.1`、`localhost`、`::1`），拒绝公网监听配置；
   - T3 Code 通信仅允许连接本地回环 `t3.origin`；
   - 跨机分离场景推荐通过 SSH 加密本地端口转发，不直接暴露桥接端口。
2. **鉴权与凭据隔离**：
   - `gateway` $\to$ `bridge` 请求强制携带 `Authorization: Bearer <bridgeSecret>`，服务端使用 `crypto.timingSafeEqual` 进行常量时间比对；
   - 派生 `t3` CLI 子进程时自动剥离全部 `QQ_*` 环境变量（含 `QQ_APP_ID`、`QQ_APP_SECRET`、`QQ_BRIDGE_SECRET`、`QQ_CREDENTIALS_FILE`）；
   - T3 会话令牌按需短期签发，并在任务结束或进程退出时自动吊销；
   - 出站媒体 MCP（`dist/publish.mjs`）隔离运行，仅需 `appId` / `appSecret`，无法接触 `bridgeSecret`。
3. **附件与文件系统边界**：
   - 入站附件强制 HTTPS + 域名白名单 + 魔数文件头嗅探 + 单件 12 MiB / 单消息 10 件上限；
   - 出站 `qqbot_send_media` 拒绝 Windows UNC 路径与 `../` 越界，并经 `fs.realpath` 校验目标文件严格位于对应绑定的工作区目录内。
4. **隐私零提交**：
   - `.gitignore` 默认忽略 `config.json`、`credentials.json`、`state/` 与本地日志文件；发布包与源码仓库不包含任何私有账号或主机配置。

## 安全问题反馈

如发现潜在安全漏洞（如鉴权绕过、路径穿越、凭据泄漏等），请勿在公开 Issue 中披露利用细节，请通过 GitHub Security Advisories（仓库 **Security -> Advisories -> Report a vulnerability**）私下提交，维护者会第一时间响应并修复。
