# 安卓浏览器局域网分享

此模块独立于 Gateway、WebUI 和语音 Provider，提供局域网 HTTPS 反向代理、安卓 CA 证书下载和设备配对入口。不改变模型配置，不关闭认证，不开放公网。

## 启动

使用项目要求的 Node 版本，先在项目根目录启动已有 Gateway：

```bash
source ~/.nvm/nvm.sh
nvm use
npm start
```

另一个终端在项目根目录运行（替换为电脑实际局域网 IPv4）：

```bash
node scripts/lan-share/server.mjs --host 192.168.1.10
```

终端输出 `setupUrl`，同一局域网的安卓手机在 Chrome 或系统浏览器中打开它。也可以扫描 `runtime/lan-share/share-qr.png`。

1. 下载页面提供的 `qwen-lan-root-ca.crt`。
2. 在安卓设置搜索“安装证书”，选择“CA 证书”并安装。此 CA 仅用于信任这台电脑的局域网 HTTPS，需要手动操作一次。它不改变证书颁发范围；只给自己的设备安装，不分发 CA 私钥。公司管理的手机可能禁止安装用户 CA。
3. 安装后回到当前浏览器的分享页面，点击“证书已安装，在当前页继续对话”，再点击“进入语音对话”；首次在配对页点击 `Connect`，然后允许麦克风权限。无需退出或重新启动浏览器。

若浏览器仍提示证书错误，先完成 CA 安装和信任，再重开页面。绕过证书错误不能替代建立可信 HTTPS。不要使用微信内置浏览器。首次安装可能需要手机锁屏密码。

## 端口和状态

- Gateway 保持监听 `127.0.0.1:3101`，电脑本机仍可访问。
- HTTP `3080` 仅提供证书和引导页；HTTPS `8443` 代理现有页面和 WebSocket。
- 两个分享端口只监听 `--host` 指定的本机私网 IP。
- 所有证书、私钥、设备连接码、分享路径及二维码均保存在已被 Git 忽略的 `runtime/lan-share/`。私钥和连接码仅供本机读取，不通过下载接口提供。
- 设备连接码只出现在带随机分享路径的 HTTPS 引导页；配对仍由项目原有认证处理。每次启动复用该设备，撤销后下次启动会生成新设备。
- 如需额外允许的 Origin，可为 Gateway 设置 `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://电脑IP:8443`；现有 Gateway 已支持认证后的同源 HTTPS 浏览器。
- 根证书有效期一年，站点证书有效期 90 天；模块重启时自动更新临近到期的站点证书。根证书到期需重新生成并在手机重新安装。
- 电脑换 IP 后重新运行模块并打开新 `setupUrl`；如更换网络，确认手机与电脑互通，且路由器未开启客户端隔离。

`--prepare` 仅生成或刷新配置、配对与二维码，不启动监听。`--help` 显示用法。

## 停止与撤销

前台运行时按 Ctrl-C 停止分享；Gateway 单独运行，继续按它自己的方式管理。

如自行将两个进程配置为 systemd 用户服务，可按实际服务名查看或停止。以下以 `qwen-audio-phone-gateway` 和 `qwen-audio-phone-share` 为例；本脚本不会自动安装这些服务：

```bash
systemctl --user status qwen-audio-phone-gateway qwen-audio-phone-share
systemctl --user stop qwen-audio-phone-share qwen-audio-phone-gateway
```

未配置用户服务时，使用前文的两个前台命令启动。已配置对应服务时，只修改分享模块后可执行 `systemctl --user restart qwen-audio-phone-share`；若模型配置改变，重启 Gateway。

分享模块输出设备 ID，可撤销该手机连接：

```bash
node cli/bin/qwenaudio.mjs gateway devices
node cli/bin/qwenaudio.mjs gateway revoke 设备ID
```

不用此分享时，可在手机的用户凭据列表删除 `Qwen LAN Share Root CA`。分享入口和二维码只给自己的手机使用。

## 页面二维码邀请

上文的随机 `setupUrl` 为电脑主人自己的设备初始化入口。向其他人发出邀请时，在 WebUI 右上角设置中点击“分享”，使用 5 分钟有效、一次性配对的二维码，并可在分享授权列表撤销。

启用页面邀请前，在 Gateway 的环境配置中设置（替换为电脑实际私网 IP）：

```dotenv
QWEN_AUDIO_GATEWAY_SHARE_ORIGIN=https://192.168.1.10:8443
QWEN_AUDIO_GATEWAY_SHARE_SETUP_ORIGIN=http://192.168.1.10:3080
QWEN_AUDIO_REALTIME_IDLE_TIMEOUT_SECONDS=30
```

修改配置后重启 Gateway。二维码会打开证书安装指引，安装后在当前页继续至 HTTPS 配对页；已信任此电脑证书的设备可直接使用 HTTPS 邀请链接。电脑需保持运行，访问者需位于同一可信局域网。
