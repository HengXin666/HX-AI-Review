# cf-admin 设计

Cloudflare 侧. Worker 入口 [cf-admin/worker/index.ts](../../cf-admin/worker/index.ts), HTTP 契约 [cf-admin.yaml](../reference/api/cf-admin.yaml). 总体架构见 [overview.md](overview.md).

## 接口

| 接口 | 鉴权 | 作用 |
|---|---|---|
| `GET /init` | Bearer HX_CTX_TOKEN | 配置下发: api_url, api_key, api 类型, finder/verifier 模型, 上下文窗口, last_sha, 抑制表 |
| `POST /runs` | Bearer HX_CTX_TOKEN | 入库: findings, 补丁, 耗时, token 用量, MD/JSON 报告, pi 会话 JSONL; 推进 last_sha 与预算 |
| `POST /feedback` | Bearer HX_CTX_TOKEN | 按指纹采纳或驳回; 驳回必须带原因 |
| `GET /api/overview` | Cloudflare Access | 所有仓库, 最近 50 次运行, 最近 50 条待处理发现 |
| `POST /api/repos` | Access | 登记仓库, 返回一次性明文 token |
| `PATCH /api/repos/{owner}/{repo}` | Access | 开关, 模式 (full/l0), provider, 模型分级, 月预算 |
| `POST /api/repos/{owner}/{repo}/rotate-token` | Access | 轮换 token |
| `PUT /api/providers/{name}` | Access | api_url, api 类型, key 所在 secret 名, 上下文窗口 |
| `GET /api/findings/{id}/patch` | Access | 从 R2 取补丁 |
| `POST /api/findings/{id}/feedback` | Access | 总览页的采纳或驳回 |

## /init 的 L0-only 判定

按顺序检查, 命中任一条即只下发 L0 配置 (`l0Only: true`, 无 apiUrl 与 apiKey), 并在 `reason` 说明:

1. 仓库停用.
2. 模式为 `l0`.
3. 月预算大于 0 且本月花费已达到预算 (跨月自动归零).
4. provider 或 finder/verifier 模型未配置.
5. provider 指向的 Worker secret 不存在.

## 数据

D1 结构见 [0001_init.sql](../../cf-admin/migrations/0001_init.sql).

| 表 | 内容 |
|---|---|
| providers | 名称, api_url, api 类型, key_secret (Worker secret 名), 上下文窗口, 最大输出 |
| repos | owner/repo, token SHA-256, 开关, 模式, provider, 模型分级, 月预算, 本月花费, 预算月份, last_sha |
| runs | 每次运行: sha, base, 事件, PR 号, 状态, Error/Warning 数, token, 花费, 耗时, 补丁分支 |
| findings | 每条发现: 指纹, 规则, 等级, 位置, 说明, 证据, 补丁 R2 key, 状态 open/accepted/rejected |
| feedback | 每次采纳或驳回: 指纹, 结论, 原因, 来源 (token 或 Access 身份) |
| suppressions | 驳回的指纹与原因, 下一次 /init 下发给 finder |

R2 键: `runs/<owner>/<repo>/<runId>/report.md`, `report.json`, `sessions.jsonl`, `patches/<fingerprint>.diff`.

## last_sha 与预算

`POST /runs` 在写入运行与发现之后, 用一条 UPDATE 推进 last_sha 并累加本月花费; 预算月份不同则先归零. PR 运行不推进 last_sha, 因为该游标只代表被 push 的分支历史.

## 分层

路由 (`cf-admin/worker/routes/`) 只依赖 `cf-admin/worker/store/port.ts` 的 `Store` 与 `BlobStore`. `cf-admin/worker/store/d1.ts` 是 D1/R2 适配器, `cf-admin/test/fake-store.ts` 是同语义的内存实现. Worker 的依赖 (`Deps`) 包括 store, blobs, secret 读取, Access 校验, 时钟与 ID 生成, 都可在测试中替换.

## 总览页

`cf-admin/pages` 是 React + TS + Vite 单页, 部署到 Pages, 与 Worker 的 /api/* 路由挂在同一域名下, 由同一个 Access 应用保护. 页面功能:

- 所有仓库一屏: 开关, 模式, 模型分级, 本月花费/预算, last_sha.
- 待处理发现: 查看补丁, 采纳, 驳回 (必须填写原因, 原因回流抑制表).
- 最近运行: 状态, Error/Warning 数, 花费, 耗时, 补丁分支的 compare 链接 (一键开 PR 合入补丁).

## Access 配置要点

- Access 应用覆盖 Pages 域名与 `/api/*`.
- `/init`, `/runs`, `/feedback` 加 Bypass 策略, 它们由 HX_CTX_TOKEN 鉴权.
- Worker 变量 `ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD` 必须配置, 否则 /api/* 一律 403.
