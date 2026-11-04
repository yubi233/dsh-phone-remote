# dsh-phone-remote

[dsh-web-remote](https://github.com/) 的 DSH Host 插件：把一台运行 [DeepSeek
Harness](https://github.com/) 的电脑接入中继（relay），让手机通过专用移动壳远程
使用它——会话列表、流式对话、审批、附件、终端、文件浏览，全部经中继转发。

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

## 用法：装完即用（局域网模式，默认）

**不需要单独部署任何东西。** 插件内置 relay 与手机壳静态页：安装后自动在本机
启动中继（默认端口 8787，被占用时自动换端口），监听局域网。

1. 打开 DSH 网页，侧栏点 📱。面板状态卡直接显示**局域网地址**，例如
   `http://192.168.1.23:8787`。
2. 手机连同一个 Wi-Fi，打开该地址即可使用；或点「配对手机」扫码；把地址发给
   别人也行。
3. 已配对设备可在面板里随时撤销。

Host 进程重启后自动恢复本地中继；设备配对记录持久化在
`~/.dsh/storages/web_remote_local_relay.json`。

## 可选：接入外部 relay（服务器模式）

要让手机在局域网外也能访问（例如公网 VPS），在面板「中继服务器」里填外部
relay 地址与注册令牌 →「保存并连接」；随时可点「使用局域网模式」切回。
外部 relay 的最小环境变量：

| 变量 | 作用 |
|---|---|
| `HOST` / `PORT` | 监听地址（公网部署必须前置 TLS） |
| `RELAY_REGISTRATION_TOKEN` | 注册本插件的共享密钥（公网必设） |
| `RELAY_TRUST_PROXY=1` | 反向代理后按真实客户端 IP 限速 |
| `RELAY_STORE_FILE` | 配对与令牌持久化 |
| `RELAY_STATIC_DIR` | 可选：托管手机壳静态页（本包 `shell/` 目录） |

## 从部署配置固定（可选）

不想用面板配置时，在 patch 行里带 config（此时面板修改会覆盖这里的值）：

```yaml
- insert:
    - id: web-remote-host
      name: 'dsh-phone-remote'
      config:
        relayHttpUrl: https://relay.example.com
        hostId: <uuid>
        hostSecret: <secret>
        hostName: my-mac
        registrationToken: <RELAY_REGISTRATION_TOKEN>
```

## 安全模型

- 配对是一次性 256-bit token（默认 5 分钟过期），claim 端点免鉴权但按 IP 限速；
  换取的 device token 只返回一次，relay 只存哈希。
- 控制台路由只接受本机回环或同源浏览器请求，跨源一律 403。
- 单 Host 单手机：第二台设备接管在 60 秒内升级为冲突，可在面板撤销后重新配对。
- 日志不出现 token、prompt、附件内容。

## 已知限制

- 手机壳与 relay 的部署（含 HTTPS、登录门）不在本包内，见仓库 `deploy/README.md`。
- 审批/提问按 Session 路由；Host 进程重启后等待中的旧审批不可回答。
