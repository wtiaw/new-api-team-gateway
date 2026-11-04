# New API 团队版使用与部署

这是 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 的独立 fork，维护地址为 [wtiaw/new-api-team-gateway](https://github.com/wtiaw/new-api-team-gateway)。原生 New API 能力继续保留；本文描述新增团队功能和本仓库的 Docker 配置。基线版本、许可证及上游资料见 [README](README.md)。

## 角色与入口

| 角色 | 权限 |
| --- | --- |
| 系统管理员 | 管理全部团队、团队管理员、成员、共享余额、限额；调整用户个人余额；查看全站使用日志 |
| 团队管理员 | 管理本团队成员、邀请和成员日／周额度标准，查看团队概览、记录和额度流水；不能给钱包增加本金 |
| 普通成员 | 非系统管理员只加入一个有效团队，打开“团队”直达自己的团队；只查看本人用量与成员日／周额度，不可见团队共享余额 |

入口：`/teams` 团队；`/users` 用户和个人余额；`/channels` 上游渠道；`/keys` API 密钥与额度来源；`/usage-logs/common` 通用使用日志。普通成员从通用使用日志查看本人明细，团队页面不重复显示明细表。

## 团队分组授权

系统管理员在团队设置中从现有分组选择可用组，并指定一个默认选择。默认选择是“开发”等已授权的实际分组，不会新建或自动授予名为`default`的组。可清空全部授权，此时成员没有任何分组使用权限。

团队管理员和成员只读授权。每位普通用户的有效分组来自有效团队成员关系，个人余额、团队余额使用完全相同的分组范围；选择“仅个人”不能绕过授权。没有有效团队关系的普通用户看不到可用分组，也不能凭旧密钥或正的个人余额调用模型；登录、钱包和接受邀请仍可用。

团队用户的分组选择器只列出管理员实际授权的组，不自动添加`auto`。`auto`是旧版的自动路由模式，不是资源分组；已存在的Auto密钥仍只会在团队当前授权范围内路由，撤销授权后立即受限。

API密钥指定组必须在授权范围，留空则继承团队默认选择或唯一授权组。Auto及重试限定在授权组内；撤销组、移除成员或停用团队会阻止后续请求。付款策略切换只改变付款方，不改变所选组或该组适用的渠道／价格规则。全局系统管理员保留团队管理与分组配置能力；无团队关系的系统管理员保留原生测试通道。

## 资金与限额

个人余额由系统管理员操作，与团队钱包独立。团队没有向个人划拨、回收资金的功能；成员不能配置私人上游。

团队的每日、每周额度是**每位成员可消费的团队资金上限**。团队统一设置 `$5/日`、`$25/周`，意味着每位成员独立享有这个周期额度，共同消耗团队钱包。`0` 表示没有该周期额度，不限额要选择界面的不限额状态。周期按 `Asia/Shanghai` 计算，每日零点、每周一零点重置；历史消费不会因修改限额而删除。

团队请求采用请求后结算。开始时检查成员周期额度与团队钱包是否可用，成功请求按实际费用入账，不预占费用上界。最后一笔及已放行的并发请求可能超过余额／限额；允许结算为负，后续请求再停止团队付费或切换个人备用。失败与退款沿用已确定的资金来源。兼容客户端不代表 CPA 或供应商支持所有工具和多模态能力。

API 密钥表格直接显示额度策略，可快速切换：

| 策略 | 资金顺序 |
| --- | --- |
| 团队优先 | 团队不可用时尝试个人余额 |
| 个人优先 | 个人不可用时尝试团队余额 |
| 仅团队 | 不使用个人余额 |
| 仅个人 | 不使用团队资金 |

有效团队成员的未显式配置密钥默认团队优先；显式选择保留。系统管理员可禁止团队成员使用个人备用。个人钱包不受团队日／周额度约束，仍受余额、密钥限额、模型权限等原生限制。网页聊天测试采用登录用户的有效默认策略，不等同于任意某个 API 密钥的策略。

## 成员与邀请

系统管理员先创建普通用户，再创建团队并搜索选择团队管理员。团队管理员可邀请、禁用、移除成员或调整本团队管理员角色；系统管理员可统一管理。

邀请链接默认7天有效，可选1–30天，**一次只能接受一个成员**。接受后显示接受者和时间；多人加入需分别生成邀请。过期或撤销的链接不可再使用。移除成员后成员列表隐藏该关系，历史用量保留，个人余额不受影响。

## 概览与使用记录

管理员概览显示团队整体用量与共享钱包，可筛选成员；每日趋势支持多选成员的多条曲线对比，并切换请求数、实际费用或 Token、近7／30天。普通成员只看本人的团队用量、日／周已用与可用额度。

团队明细默认20条一页，成员与密钥、模型、输入／输出 Token、费用与额度来源分组展示，长请求 ID 在详情查看和复制。不显示预占金额；按当前条件导出全部匹配记录。系统管理员的通用日志明确区分团队、个人、订阅等实际资金来源。

## 渠道倍率与 CPA

渠道销售倍率叠加原生分组定价，在通常按 Token 定价场景下：

```text
最终费用 = 模型标准费用 × 渠道销售倍率 × 有效分组倍率
```

渠道 A 为0.3、B为0.5、C为1，同一分组倍率1时，分别为0.3、0.5、1倍。渠道倍率影响用户结算；它不是供应商成本记录。阶梯、表达式、固定价格和用户分组覆盖仍遵守 New API 对应规则，修改后先用模拟或受控小请求核对费用。

若 CPA 内多个资源都共用一个 New API 渠道，New API 无法仅凭该渠道为 CPA 内各个账号设置不同倍率。需要按定价边界拆成不同渠道／资源入口，并让请求实际选中对应渠道。配置模型权限和渠道模型清单后，同一分组可同时包含 GPT、DeepSeek 等供应商。

CPA 独立部署，管理凭据与调用密钥分开；New API 只保存对 CPA 的调用凭据。不要把管理密钥作为用户的模型调用密钥。配置渠道时使用能从 New API 容器访问到的 CPA 地址，按渠道界面要求填写基础地址，避免重复拼接 `/v1`。

## 本地开发

在 Windows PowerShell 中：

```powershell
.\scripts\team-gateway\start-local.ps1 -Build
# 仅生成首次本地配置，不启动服务
.\scripts\team-gateway\start-local.ps1 -ConfigureOnly
# 仅构建
.\scripts\team-gateway\build-local.ps1
```

启动 Docker Desktop 的 Linux 容器，打开 `http://localhost:18310`。首次随机生成被 Git 忽略的 `deploy/team-gateway/.env`；管理员用户名 `admin`，密码取 `ADMIN_PASSWORD`。脚本仅初始化空库，已有账户不会重置。构建可传 `-ProxyUrl http://host.docker.internal:7897`，端口按本机代理调整，代理不写入运行镜像。

本地独立 Compose 包含 PostgreSQL、Redis、模拟上游；它和服务器 Compose 分开。模拟模型 `team-local-mock` 不消耗真实供应商费用。修改代码后重新构建并启动应用；不要删除数据卷或更换现有数据库凭据。

```powershell
docker compose --env-file deploy/team-gateway/.env -f deploy/team-gateway/compose.yaml stop
```

## 服务器部署

下面使用通用路径、域名和占位配置，不包含维护者生产服务器资料。Linux 服务器需要 Docker Engine 与 Compose v2。

1. 在构建机检出需要发布的提交，从源码构建镜像：

   ```sh
   docker build -t new-api-team-gateway:team-v0.1.0 .
   docker save new-api-team-gateway:team-v0.1.0 -o team-gateway-image.tar
   ```

2. 将镜像包、`compose.server.yaml`、`server.env.example` 与备份脚本复制到独立部署目录。服务器加载镜像，把模板保存为 `.env` 并填好三个独立随机值：数据库密码、Redis密码、会话密钥。可以分别用 `openssl rand -hex 32` 生成；设置 `.env` 权限为600。

3. `SITE_URL` 和受信任Cookie来源使用真实 HTTPS 域名。`CADDY_NETWORK` 填已有反向代理的 Docker 网络；`TRUSTED_PROXIES` 只填写该代理的实际地址／网段。把 Caddy 与应用接入同一个网络，参考 [Caddyfile.example](deploy/team-gateway/Caddyfile.example) 配置 TLS 和转发。应用端口仅绑定127.0.0.1，不直接向公网暴露。

4. 在部署目录启动，首次访问站点完成 New API 原生初始化：

   ```sh
   docker load -i team-gateway-image.tar
   docker compose --env-file .env -f compose.server.yaml up -d --wait
   ```

5. 初始化管理员后配置渠道、模型价格、分组和团队，验证来源与实际扣费。服务器不会自动连接开发用模拟上游，也不会自动创建真实供应商渠道。

### 备份与更新

将 `scripts/team-gateway/backup-server.sh` 复制到服务器 Compose 同目录，运行 `sh backup-server.sh`。脚本生成 PostgreSQL 自定义格式备份并用 `pg_restore --list` 校验可读；需要将备份复制到异机保存，列表校验不等同于完整灾难恢复演练。

更新前备份数据库、`.env` 和代理配置，保存旧镜像引用，记录新镜像摘要与源码提交。先在测试环境验证新版本，再仅更新 `.env` 的 `NEW_API_IMAGE`：

```sh
docker compose --env-file .env -f compose.server.yaml up -d --no-deps --wait app
```

应用回滚可恢复旧镜像。若未来包含不兼容数据库迁移，必须先评估数据库回退方案；不要直接覆盖线上数据库来回滚应用。此仓库 CI 不保存生产 SSH 密钥、不自动部署服务器。

## 开发验证

前端：`cd web && bun install --frozen-lockfile && bun run typecheck && bun run test && bun run build`。后端：根目录 `make test`，以及分别在 `relaykit/`、`tokenkit/` 中用 `GOWORK=off go build ./...` 验证独立模块。所有构建也可使用本仓库的固定版本 Docker 工具镜像，见构建脚本。

数据库验收使用专用 `tgtest-*` 项目与模拟上游：

```powershell
.\scripts\team-gateway\test-databases.ps1
```

或在具备 Docker 的环境运行 `python tests/team-gateway/team_smoke.py --matrix --engine all --scenario all --image new-api-team-gateway:local`。该脚本覆盖三种数据库 fresh／upgrade，并保存脱敏证据到 `.artifacts/database-acceptance/`，不读取生产配置。

`native_smoke.py` 等本地开发验收脚本会创建测试用户、余额、渠道、密钥及配置，只应用于专用模拟环境，不作为线上健康探针。升级记录和协作流程见 [FORK_MAINTENANCE.md](FORK_MAINTENANCE.md)。
