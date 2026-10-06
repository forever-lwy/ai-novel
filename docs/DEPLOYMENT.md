# 安全部署

当前是单用户、单实例的私人工作台。公网入口使用 HTTPS 反向代理，后端 4317 端口只绑定服务器本机，数据库放在服务主机本地存储。这里提供配置参考；Docker、Nginx、目标 NAS 和实际公网环境仍需部署后核验，不能把本地程序测试当成部署验收。

## 启动与初始密码

新实例先复制 `.env.example` 为 `.env`，已有配置文件直接编辑并保留其他设置。填写自己的 `INITIAL_PASSWORD`，去除首尾空白后至少 12 位，不使用常见弱密码；项目没有默认密码。原生运行按 [README](../README.md) 安装和构建，公网配置示例为：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4317
DATA_DIR=./data
PUBLIC_ORIGIN=https://novel.example.com
# 首次无密码的数据目录必须填写自己的有效密码：
INITIAL_PASSWORD=
```

将示例域名替换为自己的域名，并补齐空的密码值后再启动。`PUBLIC_ORIGIN` 是 HTTPS 来源，不带子路径、查询参数、片段或用户名密码；设置后自动启用 Secure Cookie，不能再指定 `COOKIE_SECURE=false`。

Docker 使用项目的 [Compose](../compose.yaml)，默认只向主机本机开放端口：

```sh
docker compose up -d --build
```

浏览器打开配置的地址，直接用初始密码登录；网页不能设置初始密码。首次空数据目录缺失、为空或无效的 `INITIAL_PASSWORD` 会导致启动失败，错误不会输出密码。已有数据库密码保持不变，即使重启时设置了不同的初始密码也不会覆盖；改密使用账号安全页面。

密码包含 `$` 时，把 `.env` 的值用单引号包围。单引号值按原文读取，不把 `$变量` 或 `${变量}` 展开；不要使用未加引号或双引号的写法。写法为 `INITIAL_PASSWORD='…'`，其中省略号需要替换为自己的完整密码，不能直接使用。Shell 中已有的同名变量优先于 `.env`，排查时只核对配置来源，不输出值。规则见 [Compose 环境文件语法](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)。

初始化成功后可从 `.env` 移除 `INITIAL_PASSWORD`，已有完整数据卷再次启动不需要该变量。服务器入口会清除进程中的初始密码变量，但不会修改 `.env` 或容器配置；不要输出含秘密的完整环境或已展开的 Compose 配置。

Compose 使用非 root 用户、只读根文件系统、临时 `/tmp`、禁用额外能力与提权；数据卷仍可写。默认限制 128 个进程及 2 GiB 内存，可用 `MEMORY_LIMIT` 调整内存。较大作品超出内存或恢复容量时使用停机后的完整服务迁移。配置字段见 [Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

## 反向代理

准备有效 TLS 证书，在 Nginx 的 `http` 块加入以下配置。替换域名与证书路径；代理目标适用于原生进程或 Compose 默认映射到主机本机的端口。

```nginx
limit_req_zone $binary_remote_addr zone=novel_auth:10m rate=2r/m;
log_format novel_safe '$remote_addr [$time_local] "$request_method $uri" '
                      '$status $body_bytes_sent $request_time';

server {
    listen 80;
    server_name novel.example.com;
    access_log /var/log/nginx/access.log novel_safe;
    return 301 https://novel.example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name novel.example.com;
    ssl_certificate     /etc/letsencrypt/live/novel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/novel.example.com/privkey.pem;
    access_log /var/log/nginx/access.log novel_safe;

    client_max_body_size 128m;
    client_body_timeout 120s;
    proxy_http_version 1.1;
    proxy_set_header Host novel.example.com;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Forwarded "";
    proxy_set_header Connection "";
    proxy_connect_timeout 10s;
    proxy_send_timeout 120s;
    proxy_read_timeout 3600s;
    proxy_buffering off;

    location ~ ^/api/auth/(login|password|sessions/revoke|logout)$ {
        client_max_body_size 4k;
        limit_req zone=novel_auth burst=4 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:4317;
    }

    location / {
        proxy_pass http://127.0.0.1:4317;
    }
}
```

代理固定应用 Host，并用自身看到的客户端地址覆盖 `X-Forwarded-For`，不能拼接浏览器提供的任意转发链。示例直接面向客户端；如果前面还有 CDN 或其他代理，先按该服务的真实来源配置 Nginx，再按实际链路调整。长 `proxy_read_timeout` 和关闭缓冲用于保留 SSE 流式输出；服务端接收请求的超时为 120 秒。参数说明见 Nginx 的 [代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) 与 [限速模块](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)。

在设置 `TRUSTED_PROXIES` 前，通过一次经代理的请求与服务请求日志，核实后端实际看到的连接来源地址。只信任该代理的明确 IP 或最小必要 CIDR，多个值用逗号分隔。原生 Nginx 和 Docker 端口转发的实际地址可能不同，不能照抄某个 Docker 网段；禁止用任意来源或 `0.0.0.0/0`。默认不信任代理头，会把代理后的登录请求统计到同一地址，因此必须在上线前完成这项核对。

防火墙只开放代理入口，后端 4317 不直接向公网开放。使用 `nginx -t` 检查配置后再加载；部署后验证 HTTPS、Cookie 的 Secure 属性、登录限速与退出失效、未经登录的 API 返回 401、SSE 持续输出，以及上传和恢复边界。服务日志不记录请求查询参数、正文、Cookie 或 Authorization，代理也不要额外记录敏感头或请求体。

## 模型网关与外部请求

生产模式默认只连接 HTTPS 全球公网地址。服务会检查 DNS 解析结果，并把连接绑定到已检查的地址；所有模型调用拒绝重定向。HTTP 或私网自建网关需要在 `.env` 的 `OUTBOUND_ALLOWED_ORIGINS` 明确允许其来源：

```dotenv
# 仅按实际网关填写协议、主机、端口，不填写 /v1 等路径。
OUTBOUND_ALLOWED_ORIGINS=https://gateway.example.com
```

多个来源以逗号分隔，不支持通配符；设置后名单覆盖全部模型连接，正常 HTTPS 供应商也须列入。放行 HTTP 意味着该服务器到网关之间不加密，优先为网关提供 HTTPS。链路本地及已知云元数据地址始终禁止，允许列表不能覆盖该禁令。本机开发模式保留本地模拟模型接口能力。

服务地址不能携带用户名、密码或 `key`、`token` 等凭据查询参数。API 密钥填入独立密钥字段；只接受 URL 查询凭据的网关需要先调整鉴权接口。旧配置中的 URL 凭据在启动时加密保留并清理 SQLite 的旧明文记录，页面仅显示去除凭据的地址和迁移提示；须填写独立密钥或勾选清除密钥后才能保存处理结果。只保存其他设置会拒绝并保留原密文；处理完成前，相关模型请求会明确报错。迁移保留原配置供服务器端恢复，不会把原凭据回传网页。

## 数据权限与迁移

启动会收紧数据权限：Linux 数据目录为仅账号可访问的 `0700`，数据文件为 `0600`；Windows 使用当前账号、原所有者、Administrators 和 SYSTEM 的访问权限，只更新文件和目录的访问规则，保留原所有者及审计设置，重复启动也会检查。服务账号须能读写数据并修改其访问权限；权限调整失败需要处理账号或挂载权限后重试，不能把数据目录设为所有人可读写。备份副本也保存到受保护位置。

迁移已有本地数据时，先停止服务，复制完整 `data/` 或 Docker 卷，包括 `novel.sqlite`、原文件、`.encryption-key` 及仍存在的数据库附属文件，再设置目标数据目录与服务账号权限。启动后继续使用原密码、作品和独立 API 密钥；旧密码成功登录时升级哈希，不强制重新设置。不要使用空数据卷替换原数据，也不要删除 `.encryption-key`。

默认 Compose 的 `novel-data` 卷不会自动复制原生运行的 `./data`。改用 Docker 前，先将完整停机备份放入目标卷，或将 Compose 的数据挂载明确改为目标主机的受保护本地目录，并使容器运行账号有访问权限。启动后用原密码登录，确认作品列表与供应商“已保存”状态；如果原密码不能登录、作品列表为空或提示未配置初始密码，先核对 `DATA_DIR` 和卷映射，保留原目录后再处理。

作品备份未压缩 JSON、压缩下载、上传及外层解压分别最多 128 MiB，导出前先检查容量；最多恢复 5000 个历史版本，单状态最多解压 64 MiB，所有状态累计最多 256 MiB。备份下载、小说文件上传及作品恢复按可信客户端 IP 共享 5 分钟内 3 次的限额。恢复新建独立作品，超限返回错误，保留原作品。完整服务迁移不依赖这些单作品导入限制，适合长期累积的大作品。

账号安全页可验证当前密码后修改密码或撤销其他登录；两项操作都会为当前浏览器生成新会话并撤销所有旧会话，其他设备下次请求需重新登录。已打开的 SSE 在下次事件或心跳检查时关闭，不继续发送新内容。单次退出只撤销当前会话。
