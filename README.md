# dsh-phone-remote

Host-side plugin that pairs a phone to a DeepSeek Harness (`dsh`) instance through a self-hosted relay. One outbound connection from the
Host carries the session list, streaming chat, approvals, attachments and file
previews to a dedicated mobile web shell; the phone never needs an inbound port
on the Host machine.

一个包，两个半区：

- **Host 半区**（`lib/index.js`，Node）：cordis 插件。向 relay 注册本机、维持出站
  WebSocket、把手机 RPC 桥接到 DSH；并在 DSH web GUI 的 `/api/web-remote/*` 挂本地
  控制台路由（仅本机/同源可访问）。
- **Client 半区**（`lib/client.js`，浏览器）：注入 DSH web GUI 的侧栏入口。点开
  「📱 手机远程」面板即可配置中继、生成配对二维码、管理已配对设备——不需要改任何
  配置文件或敲命令。

## 安装

```sh
dsh plugin --profile web add dsh-phone-remote
```

重启 profile（`dsh web`），侧栏底部出现 📱 图标即安装成功。

## 前置：一个 relay

本包是 Host 半区；手机壳与 relay 服务需要单独部署（协议见本仓库 `src/` 与
`packages/protocol`）。relay 的最小环境变量：

| 变量 | 作用 |
|---|---|
| `HOST` / `PORT` | 监听地址（公网部署必须前置 TLS，例如 Caddy） |
| `RELAY_REGISTRATION_TOKEN` | 注册本插件的共享密钥（公网必设） |
| `RELAY_TRUST_PROXY=1` | 在反向代理后按真实客户端 IP 限速 |
| `RELAY_STORE_FILE` | 配对与令牌持久化，重启不丢设备 |
| `RELAY_STATIC_DIR` | 可选：由 relay 直接托管手机壳静态页 |

## 配对（服务器模式）

1. 在 DSH 网页里点 📱 → 「中继服务器」→ 填 relay 地址与注册令牌 →
   「保存并连接」。身份（hostId/hostSecret）首次自动生成并存入 storage domain，
   重启后保留。
2. 点「配对手机」生成一次性二维码（5 分钟有效、一次性、可随时重新生成），
   手机扫码打开手机壳页即完成配对。
3. 在「已配对设备」里随时撤销设备。

局域网模式相同：relay 跑在本机、中继地址填局域网地址即可。

## 从部署配置固定（可选）

不想用面板配置时，在 patch 行里带 config（面板修改会覆盖这里的值）：

```yaml
- insert:
    - id: dsh-phone-remote
      name: 'dsh-phone-remote'
      config:
        relayHttpUrl: https://relay.example.com
        hostId: <uuid>
        hostSecret: <secret>
        hostName: my-mac
        registrationToken: <RELAY_REGISTRATION_TOKEN>
```

## 开发

```sh
pnpm install
pnpm test        # 122 个单测
pnpm typecheck
pnpm build       # 产出 lib/index.js + lib/client.js
```

`packages/protocol` 是跨 relay/插件/手机壳的线上类型与编解码，构建时内联进
`lib/index.js`，不单独发布。

## 安全模型

- 配对是一次性 256-bit token（默认 5 分钟过期），claim 端点免鉴权但按 IP 限速；
  换取的 device token 只返回一次，relay 只存哈希。
- 控制台路由只接受本机回环或同源浏览器请求，跨源一律 403。
- 单 Host 单手机：第二台设备接管在 60 秒内升级为冲突，可在面板撤销后重新配对。
- 日志不出现 token、prompt、附件内容。

## 已知限制

- relay 与手机壳的部署（含 HTTPS、登录门）不在本包内。
- 审批/提问按 Session 路由；Host 进程重启后等待中的旧审批不可回答。
