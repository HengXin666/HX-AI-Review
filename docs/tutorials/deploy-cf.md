# 部署 Cloudflare 侧 (一键部署)

Cloudflare 侧 (D1 + 迁移, R2, Worker, Pages 总览页) 用手动触发的工作流 [deploy-cf.yml](../../.github/workflows/deploy-cf.yml) 一键部署. 工作流调用 `cf-admin/scripts/deploy.ts`, 可重复执行: 资源不存在就创建, 已存在就复用.

## 1. 准备 Cloudflare API token

在 Cloudflare Dashboard -> My Profile -> API Tokens 创建 token, 权限:

| 权限 | 级别 |
|---|---|
| Workers Scripts | Edit |
| D1 | Edit |
| Workers R2 Storage | Edit |
| Workers Routes | Edit |
| Account Settings | Read |
| Zone | Read |

后两项只在用 `HX_OVERVIEW_DOMAIN` 绑自定义域名时需要: 查 zone 与注册 Worker route 都走 zone 级接口. 不需要 `DNS:Edit`, 因为 route 复用已有的代理 DNS 记录 (见第 4 步).

## 2. 在本仓库配置 secrets 与 variables

Settings -> Secrets and variables -> Actions.

| 名称 | 类型 | 必填 | 用途 |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | 是 | 上一步的 token |
| `CLOUDFLARE_ACCOUNT_ID` | secret | 是 | Cloudflare 账号 ID |
| `HX_PROVIDER_API_KEY` | secret | 否 | 模型 api_key, 部署时写成 Worker secret |
| `HX_ACCESS_AUD` | variable | 部署后 | Access 应用的 AUD tag |
| `HX_ACCESS_TEAM_DOMAIN` | variable | 部署后 | 例如 `myteam.cloudflareaccess.com` |
| `HX_ADMIN_USER` | variable | 否 | 总览页密码登录用户名, 默认 `admin` |
| `HX_ADMIN_PASSWORD` | secret | 否 | 总览页密码, 默认 `hx-context-review`. 写成 secret 而不是 variable, 因为 workflow 变量在运行页面上可见 |
| `HX_WORKER_NAME`, `HX_D1_NAME`, `HX_R2_BUCKET` | variable | 否 | 资源名, 默认都是 `hx-context-review` |
| `HX_OVERVIEW_DOMAIN` | variable | 否 | 总览页自定义域名, 例如 `cr.woa.qzz.io`. 部署时注册 zone route 让 Worker 接管该域名 (见第 4 步) |
| `HX_OVERVIEW_URL` | variable | 否 | 总览页地址, 用了 `HX_OVERVIEW_DOMAIN` 就填 `https://<域名>`, 写进 Worker 的 OVERVIEW_URL 与部署摘要. 不填时摘要只列 Worker 的 `*.workers.dev` 地址 |

## 3. 运行部署

Actions -> deploy-cf -> Run workflow:

- `target`: `all` (默认), 或只部署 `migrations`, `worker`. 三者都会先检查并在缺失时创建 D1 再应用迁移; 单独部署 `worker` 不会跳过迁移.
- `provider-key-name`: 填 Worker secret 名 (例如 `PROVIDER_DEFAULT_KEY`) 时, 用 `HX_PROVIDER_API_KEY` 设置该 secret; 只在 `target` 为 `all` 或 `worker` 时有效. 填了名字但 `HX_PROVIDER_API_KEY` 为空, 或 target 不部署 Worker, 部署直接失败, 不会静默跳过. 留空则不动 secret.

部署顺序: 先跑 typecheck 与测试; 创建或复用 D1, 生成带真实 database_id 与部署信息 (commit, 时间, 运行链接) 的 wrangler 配置; 应用 D1 迁移; 创建或复用 R2 bucket; 用 Vite 把总览页构建到 `cf-admin/.deploy/assets`; 部署 Worker (脚本 + 静态资源 + `workers_dev`); 再幂等重放一次 rule_results 回填 (补上迁移完成到新 Worker 生效之间旧 Worker 写入的命中); 最后按 `HX_OVERVIEW_DOMAIN` 注册 zone route. 运行摘要 (Summary) 会列出 Worker 地址 (即业务仓库的 `HX_CTX_ENDPOINT`) 与总览页地址.

### 升级期间不停服

迁移必须排在 Worker 之前, 这条顺序是服务可用的前提. 每个迁移只做加列 (带 DEFAULT) 或建表, 所以迁移跑完之前旧 Worker 照常服务, 迁移跑完之后旧 Worker 遇到新列也能插入 (由 DEFAULT 填充). 反过来先部署新 Worker 会让它查询还不存在的列, 这是唯一会中断的写法, 所以 `scripts/deploy.ts` 的 worker 与 all 都先应用迁移再部署.

回滚同样安全: 旧 Worker 读新 schema 时, 多出来的列不影响 `SELECT *` 的映射, 未知的 kind 值由 `rows.ts` 兜底成 `context`.

## 4. 绑定自定义域名

总览页和 API 由同一个 Worker 提供, 所以自定义域名只要让 Worker 接管即可. 用 `HX_OVERVIEW_DOMAIN` 时, 部署在 Worker 上线后做两步, 都可重复执行:

1. 向上逐级查 zone (`/zones?name=`), 找不到所属 zone 直接失败, 不会静默跳过.
2. 在 zone 上注册 route `<域名>/* -> <worker>`. 已存在且指向同一个 Worker 就复用; 指向别的 Worker 则重新注册.

route 依赖该主机名上已有一条**开启代理的 DNS 记录**: 指向占位 IP 的 A 记录或 CNAME 都行, 这条记录同时就是优选 IP 的入口. 因此 token 只需要 `Zone:Read` 与 Workers Routes 的写权限, **不需要** `DNS:Edit`.

域名没有代理记录时, Cloudflare 会拒绝注册 route 并返回 `100117` (externally managed DNS records). 这时先加一条开启代理的占位记录, 再重跑部署.

zone 解析与 route 的三种结果 (复用 / 创建 / 替换) 由 `cf-admin/test/deploy.test.ts` 覆盖, 用替换 `fetch` 的方式跑, 不需要真实凭证.

## 5. 配置 Access (首次部署后做一次)

1. Zero Trust -> Access -> Applications 新建 Self-hosted 应用, 域名为总览页地址 (自定义域名, 或 `<worker>.<subdomain>.workers.dev`), 策略只允许管理员.
2. 把该应用的 AUD tag 与团队域名写进仓库变量 `HX_ACCESS_AUD`, `HX_ACCESS_TEAM_DOMAIN`.
3. 再运行一次 deploy-cf, `target` 选 `worker`.

没配 Access 时, 总览页也能用 `HX_ADMIN_USER` / `HX_ADMIN_PASSWORD` 登录, 但那只是单口令: 没有身份校验, 也没有 Access 的审计日志. 对公网域名建议把 Access 配上, 或至少把口令换成强口令.

业务接口不需要套 Access: `/init`, `/runs`, `/feedback` 用 HX_CTX_TOKEN 鉴权, 与总览页同域也不冲突, 因为它们在 Worker 里先于 assets 匹配. `/api/*` 优先校验 Access JWT; 没有 Access 身份时, 若 Worker 配置了 `ADMIN_USER` 与 `ADMIN_PASSWORD` (部署变量 `HX_ADMIN_USER` / `HX_ADMIN_PASSWORD`, 默认 `admin` / `hx-context-review`), 可用 `POST /api/session` 换取 HttpOnly cookie `hxctx_admin`. 两者都没有时 fail closed, 一律 403. 默认密码写在生成的 Worker vars 里, 生产环境请用上面的变量覆盖.

## 6. 在总览页完成配置

打开总览页:

- Deployment 区块显示当前运行的 commit, 部署时间, 部署运行日志链接, Access 是否已配置, 密码登录是否开启, 以及重新部署的入口. 未配置 Access 时, 密码登录仍可进入总览页.
- Model providers 区块登记 provider: 名称 (字母, 数字, `.`, `_`, `-`), api_url, API 类型, key 所在的 Worker secret 名, 每百万 token 的输入/输出 (必填, 免费填 0) 与缓存读/写价格, 上下文窗口与最大输出. 非法数字会被拒绝, 不会存成 0. key 只显示 "已设置/缺失".
- Repositories 区块登记业务仓库, 页面只显示一次 HX_CTX_TOKEN, 立刻存到业务仓库的 secret.

之后按 [onboard-repo.md](onboard-repo.md) 接入业务仓库.

## 本地部署

同样的脚本也可本地运行 (需要相同的环境变量):

```sh
cd cf-admin
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
HX_OVERVIEW_DOMAIN=cr.woa.qzz.io HX_OVERVIEW_URL=https://cr.woa.qzz.io \
HX_ADMIN_USER=... HX_ADMIN_PASSWORD=... \
pnpm run deploy
```

本地跑要注意两点: 生成的 `cf-admin/.deploy/wrangler.toml` 含明文 `ADMIN_PASSWORD` (已在 `.gitignore` 里), 用完删掉; `wrangler login` 的 OAuth 令牌没有 `DNS:Edit`, 也没有 Workers Routes 写权限时, route 那一步会失败, 此时用带权限的 API token.

## 7. 发布可复用 workflow 版本

调用方引用 `review.yml@v1`. 在本仓库 main 上打 tag:

```sh
git tag -f v1 && git push -f origin v1
```
