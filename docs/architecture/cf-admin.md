# cf-admin 设计

Cloudflare 侧. Worker 入口 [cf-admin/worker/index.ts](../../cf-admin/worker/index.ts), HTTP 契约 [cf-admin.yaml](../reference/api/cf-admin.yaml). 总体架构见 [overview.md](overview.md).

## 接口

| 接口 | 鉴权 | 作用 |
|---|---|---|
| `GET /init` | Bearer HX_CTX_TOKEN | 配置下发: api_url, api_key, api 类型, finder/verifier 模型, 上下文窗口, last_sha, 抑制表 |
| `POST /runs` | Bearer HX_CTX_TOKEN | 入库: findings, 补丁, 耗时, token 用量, MD/JSON 报告, pi 会话 JSONL; 推进 last_sha 与预算 |
| `POST /feedback` | Bearer HX_CTX_TOKEN | 按指纹采纳或驳回; 驳回必须带原因 |
| `GET /api/overview` | Cloudflare Access | 部署信息, 所有仓库, provider (只含 key 是否存在), 最近 50 次运行, 最近 50 条待处理发现 |
| `GET /api/status` | Cloudflare Access | 部署的 commit, 时间, 运行链接, Access 是否配置 |
| `POST /api/repos` | Access | 登记仓库, 返回一次性明文 token |
| `PATCH /api/repos/{owner}/{repo}` | Access | 开关, 模式 (full/l0), provider, 模型分级, 月预算 |
| `POST /api/repos/{owner}/{repo}/rotate-token` | Access | 轮换 token |
| `PUT /api/providers/{name}` | Access | api_url, api 类型, key 所在 secret 名, 上下文窗口, 每百万 token 输入/输出价格 |
| `GET /api/findings/{id}/patch` | Access | 从 R2 取补丁 |
| `POST /api/findings/{id}/feedback` | Access | 总览页的采纳或驳回 |

## /init 的 L0-only 判定

按顺序检查, 命中任一条即只下发 L0 配置 (`l0Only: true`, 无 apiUrl 与 apiKey), 并在 `reason` 说明:

1. 仓库停用.
2. 模式为 `l0`.
3. 月预算大于 0 且本月花费已达到预算 (跨月自动归零).
4. provider 或 finder/verifier 模型未配置.
5. provider 指向的 Worker secret 不存在.
6. 月预算大于 0, 但已有一次并发运行持有本次预算的预留 (见下).

预算大于 0 的仓库在通过以上检查后, `/init` 会先原子预留本次运行的预算 (D1 条件 UPDATE, `repos.budget_claim` / `claim_group` / `claim_expires_at`), 再下发 key, 并把预留 id 作为 `budgetClaim` 返回. 没有这一步, 两个并发 PR/ref 会各自拿到同一份未花费余额, 在几分钟后上报成本时一起超支.

预留用 id 而不是布尔标记: runner 在 `POST /runs` 回传 `budgetClaim`, 计费时只释放自己的预留. 否则一次被拒绝预算、随后仍以 L0 结果上报的运行会把持有者的预留清掉, 让第三次运行拿到同一份余额. 计费永远记录花费, 只对预留做归属判断.

`claim_group` 是调用方的并发组 (`/init` 的 `group` 参数, 来自 workflow 的 concurrency group). GitHub 取消同组中较旧的那次运行, 而取消的运行永远不会走到 `POST /runs`, 所以同组的旧预留可被接管, 否则它会挡住正是取代它的那次运行; 空 group 表示未知, 永不匹配. 不同组之间是真正的并发, 仍然互斥. 预留超过 1 小时视为已放弃, 可由任何一次运行接管.

接管与结算在同一条 UPDATE 中完成 (`RETURNING claim_usd`), 所以预留一旦可见就带着自己的额度: 两个交错的 `/init` 不可能读到同一份余额而各自拿到额度. 接管旧预留时按其是否真正开始花费结算:

- 已经开过模型会话的预留 (`claim_started = 1`, 由 runner 在第一次会话前 `POST /spend` 标记): 把它的额度 (`claim_usd`) 全额计入花费. 被取消的运行不会上报真实花费, 不这样记账的话同一分支连续快速 push 每次都能拿到完整剩余预算, 而之前的开销一笔都没入账; 代价是按额度上限计入 (保守), 持有者正常上报时以真实花费覆盖.
- 在第一次会话前就被取消的预留 (安装, L0, scope 阶段): 实际花费为 0, 按 0 结算. 否则两次快速 push 就会各记一次整月剩余额, 当月预算直接清零.
- 预留记有自己所属的月份 (`claim_month`): 上月发放的额度结算进上月, 不会占用本月的预算.

## 数据

D1 结构见 [0001_init.sql](../../cf-admin/migrations/0001_init.sql), 预算预留列见 [0002_budget_reservation.sql](../../cf-admin/migrations/0002_budget_reservation.sql).

| 表 | 内容 |
|---|---|
| providers | 名称, api_url, api 类型, key_secret (Worker secret 名), 上下文窗口, 最大输出, 输入/输出单价 |
| repos | owner/repo (大小写不敏感, COLLATE NOCASE), token SHA-256, 开关, 模式, provider, 模型分级, 月预算, 本月花费, 预算月份, last_sha |
| runs | 每次运行: sha, base, 事件, PR 号, 状态, Error/Warning 数, token, 花费, 耗时, 补丁分支 |
| findings | 每条发现: 指纹, 规则, 等级, 位置, 说明, 证据, 补丁 R2 key, 状态 open/accepted/rejected |
| feedback | 每次采纳或驳回: 指纹, 结论, 原因, 来源 (token 或 Access 身份) |
| suppressions | 驳回的指纹与原因, 下一次 /init 下发给 finder |

R2 键: `runs/<owner>/<repo>/<runId>/report.md`, `report.json`, `sessions.jsonl`, `patches/<fingerprint>.diff`.

## last_sha 与预算

`POST /runs` 先完整校验请求 (findings 必须是对象数组, 等级合法), 校验失败不写任何对象; 校验通过后写 R2 再写 D1, 中途失败会删除本次已写的 R2 对象再返回错误 (补偿清理是尽力而为). status 与 counts 缺省时由 findings 推导; `complete: false` 且没有阻断 Error 时 status 为 `incomplete`, 不会显示为 passed. baseline 认可的 historical 发现只留在 R2 报告里, 不进入待处理列表.

每次运行 (包括 PR) 都计入本月花费: 费用取 runner 上报值与 `输入/输出/缓存读/缓存写 token 数 x provider 对应单价` 的较大值; 预算月份不同则先归零. last_sha 只在 `event` 为 push, 没有 PR 编号且 `complete` 不为 false 时推进, 因为该游标代表已完整审核过的被 push 历史.

provider 名只允许字母, 数字, `.`, `_`, `-`; 新建 provider 必须显式给出输入/输出单价 (免费填 0), 更新时省略的字段 (包括 API 协议) 保留原值; 未知协议, 负数或非整数的 token 上限返回 400. 仓库的 enabled, mode, provider, 模型名, budgetUsd 同理: 省略不改, 出现但类型或取值不对返回 400, 不会被静默忽略. `POST /runs` 同样严格: complete, l0Only 必须是布尔, usage 各项与 durationMs 必须是非负数且为整数 (usage.cost 例外, 单价按百万 token 计, 允许小数), prNumber 与 finding 行号必须是正整数, 字符串字段必须是字符串, 否则 400. 显式 `null` 一律按非法值处理而不是省略: 只有字段缺失才表示不提供. patches 里缺字段或类型不对的条目同样 400, 只有字段合法且 `applies: false` 的补丁才被跳过. status 一律由服务端推导 (failed, incomplete, warned, passed), runner 只能在没有发现时标 skipped; runner 发 incomplete 时同样不推进 last_sha.

`POST /spend` 只接受 `budgetClaim`, 把该预留标记为已开始花费 (幂等, 未知预留是 no-op), 供接管时判断是否结算. `/init` 的 `limits.maxRunUsd` 是本次运行的可用额度 (无上限时为 null), runner 达到它就不再开新的模型会话; 有上限的仓库同时按上节的预留规则独占本次额度. 只下发 L0 时附带 `l0Cause`: disabled, mode (主动选择), budget, config (区间未审, runner 报 incomplete). 旧数据里 contextWindow 或 maxTokens 不是正整数的 provider 也按 config 降级, 不会把非法上限发给模型. 同名仓库 (大小写不敏感) 重复登记返回 409, 并发创建撞唯一约束同样映射为 409.

## 分层

路由 (`cf-admin/worker/routes/`) 只依赖 `cf-admin/worker/store/port.ts` 的 `Store` 与 `BlobStore`. `cf-admin/worker/store/d1.ts` 是 D1/R2 适配器, `cf-admin/test/fake-store.ts` 是同语义的内存实现. Worker 的依赖 (`Deps`) 包括 store, blobs, secret 读取, Access 校验, 时钟与 ID 生成, 都可在测试中替换.

## 总览页

`cf-admin/pages` 是 React + TS + Vite 单页, 部署到 Pages 并由 Access 保护. 页面同源请求 `/api/*`, 由 Pages Function `cf-admin/pages/functions/api/[[path]].ts` 经 service binding 转给 Worker, Access 在边缘加上的 JWT 头随请求传递, Worker 再次校验. 页面功能:

- 部署状态: 当前 commit, 部署时间, 部署运行日志, Access 是否已配置, 重新部署入口.
- 仓库: 登记 (token 只显示一次), 轮换 token, 开关, 模式, 模型分级, 本月花费/预算 (清空预算框不会被当成 0, 会恢复原值), last_sha.
- Model providers: 列表 (key 只显示是否存在) 与新增/修改表单.
- 待处理发现: 查看补丁, 采纳, 驳回 (必须填写原因, 原因回流抑制表).
- 最近运行: 状态, Error/Warning 数, 花费, 耗时, 补丁分支的 compare 链接 (一键开 PR 合入补丁).

## 部署与 Access

- 部署用手动触发的 [deploy-cf.yml](../../.github/workflows/deploy-cf.yml), 步骤见 [deploy-cf.md](../tutorials/deploy-cf.md).
- Access 应用只需覆盖总览页域名; Worker 的 `/init`, `/runs`, `/feedback` 用 HX_CTX_TOKEN 鉴权, `/api/*` 自己校验 Access JWT (格式错误的 JWT 同样按未认证处理, 返回 403).
- Worker 变量 `ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD` 由部署工作流从仓库变量写入, 未配置时 /api/* 一律 403.
