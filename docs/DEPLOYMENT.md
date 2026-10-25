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
mkdir -p data
docker compose up -d --build
```

浏览器打开配置的地址，直接用初始密码登录；网页不能设置初始密码。首次空数据目录缺失、为空或无效的 `INITIAL_PASSWORD` 会导致启动失败，错误不会输出密码。已有数据库密码保持不变，即使重启时设置了不同的初始密码也不会覆盖；改密使用账号安全页面。

密码包含 `$` 时，把 `.env` 的值用单引号包围。单引号值按原文读取，不把 `$变量` 或 `${变量}` 展开；不要使用未加引号或双引号的写法。写法为 `INITIAL_PASSWORD='…'`，其中省略号需要替换为自己的完整密码，不能直接使用。Shell 中已有的同名变量优先于 `.env`，排查时只核对配置来源，不输出值。规则见 [Compose 环境文件语法](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)。

初始化成功后可从 `.env` 移除 `INITIAL_PASSWORD`，已有完整数据卷再次启动不需要该变量。服务器入口会清除进程中的初始密码变量，但不会修改 `.env` 或容器配置；不要输出含秘密的完整环境或已展开的 Compose 配置。

Compose 使用镜像默认的 root 账号，不在启动时修改数据所有者或权限；保留只读根文件系统、临时 `/tmp` 和禁止提权，数据目录仍可写。默认限制 128 个进程及 2 GiB 内存，可用 `MEMORY_LIMIT` 调整内存。较大作品超出内存或恢复容量时使用停机后的完整服务迁移。配置字段见 [Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

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

自定义工具在“设置 → 工具与技能”配置。JavaScript 和本地 stdio MCP 运行在服务端，以服务账号权限执行；独立进程不是权限沙箱，应仅启用可信代码。使用 `DATA_DIR/extension-runtime` 为工作目录，不自动安装 MCP 程序或依赖；容器内必须具有相应可执行程序和资源路径。远程 Streamable HTTP MCP 共用 `OUTBOUND_ALLOWED_ORIGINS` 及 DNS／重定向限制，设置名单时同时列出模型与 MCP 来源。本地程序自行访问网络不经过该 HTTP 策略。

扩展配置加密保存在数据库，不包含在单作品备份中；完整停机备份须保留 `.encryption-key`。技能附件以数据保存，导入本身不执行脚本或安装命令。连接方法和限制见 [工具与技能](EXTENSIONS.md)。

权限由部署维护者管理。应用启动时只检查服务账号能否实际进入目录、读写文件，不再递归 `chmod`、重写 Windows ACL 或修改所有者；数据库及 `.encryption-key` 重开也不主动缩权，数据库日志由 SQLite 按数据库的访问规则创建。Windows 使用实际打开文件与创建／删除临时探针检查访问，避免仅凭访问检查接口误判；探针不修改原文件。符号链接与目录链接仍拒绝，访问失败会说明具体路径及处理方向。

普通数据文件和目录按 Node／操作系统的默认方式创建，不指定 `0700/0600`，不在创建后执行 `chmod`，也不根据父目录模式主动扩大组或其他用户的写权限。常见 Linux `umask 022` 下目录为 `0755`、文件为 `0644`，即所有者可写、其他普通账号可读不可写；系统采用其他 umask、默认 ACL 或 setgid 时按系统规则处理。临时删除暂存目录使用标准 `mkdtemp`，保留系统的临时目录权限。Windows 沿用父目录 ACL。

普通 rootful Docker 中，容器默认 root 可以访问由宿主机维护账号所有的 `data`，无需配置用户编号或另外授予服务账号权限。默认 Compose 只将宿主机的 `./data` 挂载到容器 `/app/data`，没有挂载 Docker socket，也没有启用 privileged；容器内 root 不会让未挂载的宿主机文件路径自动可见。这个范围以当前隔离和挂载配置为前提，不能作为容器绝对安全的保证。

要把现有数据手动改归当前登录账号，在项目目录执行：

```sh
docker compose stop ai-novel
sudo chown -R "$(id -u):$(id -g)" ./data
```

`chown` 只改变归属，不修改已有权限或文件内容。旧版本创建的 `0700/0600` 不会被应用自动改成普通权限；如果需要恢复普通可读、其他普通账号不可写的权限，在停机后额外执行：

```sh
sudo chmod -R u+rwX,go+rX,go-w ./data
```

这保留现有可执行文件的执行位，不给普通数据文件增加执行权限。完成后重建容器，使新的镜像运行方式生效：

```sh
docker compose up -d --build --force-recreate ai-novel
```

容器新建的文件仍归 root，不会因为父目录属于维护账号而自动归该账号。以后需要在宿主机直接修改这些文件时，可以再次停机并执行上面的 `chown`；应用不会在重启时把已有文件改回 root。Rootless、用户编号映射或自行添加挂载的部署须按实际配置核对访问范围与权限，不能照搬上述 rootful Docker 的结论；已有额外 ACL 也由维护者管理。

迁移已有本地数据时，先停止服务，复制完整 `data/` 或 Docker 卷，包括 `novel.sqlite`、原文件、`.encryption-key` 及仍存在的数据库附属文件，再设置目标数据目录与服务账号权限。启动后继续使用原密码、作品和独立 API 密钥；旧密码成功登录时升级哈希，不强制重新设置。不要使用空数据卷替换原数据，也不要删除 `.encryption-key`。

默认 Compose 现在使用项目旁的 `./data`，容器内仍是 `/app/data`。从旧命名卷迁移时，在旧容器仍存在、项目旁尚无 `data` 目录的情况下执行以下命令；若已有目录，先改用一个新的目标目录，避免混合两份数据：

```sh
docker compose stop ai-novel
docker compose cp -a ai-novel:/app/data ./data
```

复制包括隐藏密钥及数据库附属文件，原卷保留。确认 Compose 挂载为 `./data:/app/data`；需要由宿主机维护账号直接管理时，按上面的命令调整归属，再启动。若迁往其他服务器，停机后连同数据目录、项目配置及 `.env` 完整迁移，保留文件内容与必要的文件权限，按目标部署核对访问。用原密码登录，确认作品列表与供应商“已保存”状态；如果原密码不能登录、作品列表为空或提示未配置初始密码，先核对目录和挂载，不重新初始化，也不删除原数据卷。

作品备份未压缩 JSON、压缩下载、上传及外层解压分别最多 128 MiB，导出前先检查容量；最多恢复 5000 个历史版本，单状态最多解压 64 MiB，所有状态累计最多 256 MiB。备份下载、小说文件上传及作品恢复按可信客户端 IP 共享 5 分钟内 3 次的限额。恢复新建独立作品，超限返回错误，保留原作品。完整服务迁移不依赖这些单作品导入限制，适合长期累积的大作品。

账号安全页可验证当前密码后修改密码或撤销其他登录；两项操作都会为当前浏览器生成新会话并撤销所有旧会话，其他设备下次请求需重新登录。已打开的 SSE 在下次事件或心跳检查时关闭，不继续发送新内容。单次退出只撤销当前会话。
