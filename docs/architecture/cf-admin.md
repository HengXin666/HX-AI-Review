# cf-admin 设计

Cloudflare 侧. Worker 入口 [cf-admin/worker/index.ts](../../cf-admin/worker/index.ts), HTTP 契约 [cf-admin.yaml](../reference/api/cf-admin.yaml). 总体架构见 [overview.md](overview.md).

Worker 服务两种 CR: 一次运行带一个 `kind` (`context` 或 `code`), 仓库登记时声明服务哪种 (`context`, `code` 或 `both`). Worker 不知道也不关心两种 CR 怎么审, 它只按 kind 校验, 分存, 聚合. 取舍原因见 [双模式决策](../decisions/2026-10-25-dual-cr-kind.md).

## 接口

| 接口 | 鉴权 | 作用 |
|---|---|---|
| `GET /healthz` | 无 | 部署存活探针, 返回 `{"status":"ok"}`; 真实测试层用它验证后端可达 |
| `GET /init` | Bearer HX_CTX_TOKEN | 配置下发: kind, api_url, api_key, api 类型, finder/verifier 模型, 上下文窗口, last_sha (仅 context), 抑制表, 当前 prompt 附录 |
| `POST /spend` | Bearer HX_CTX_TOKEN | 把本次运行的预算预留标为已开始花费; 只有标记过的预留被接管时才按额度结算 |
| `POST /runs` | Bearer HX_CTX_TOKEN | 入库: kind, findings, 补丁, 耗时, token 用量, MD/JSON 报告, pi 会话 JSONL; 推进 last_sha (仅 context) 与预算; 同一 PR 上未再出现的发现标 resolved |
| `POST /feedback` | Bearer HX_CTX_TOKEN | 按指纹采纳或驳回; 驳回必须带原因, 并写入 prompt_notes |
| `GET /api/overview` | Access 或会话 cookie | 部署信息, 所有仓库, provider (只含 key 是否存在), 最近 50 次运行, 待处理与已解决发现, prompt 版本与驳回笔记 |
| `POST /api/session` | 无 (登录本身) | 用 Worker 变量里的用户名密码换 hxctx_admin cookie; 未配置凭证时 403 |
| `DELETE /api/session` | 无 | 清除会话 cookie |
| `GET /api/prompts`, `POST /api/prompts`, `POST /api/prompts/fold` | Access 或会话 | 列出, 发布或把未折叠的驳回笔记折进下一版附录 |
| `GET /api/rules` | Access 或会话 cookie | 按规则 id 与严重级聚合 rule_results; `repo`, `severity`, `kind`, `limit` 四个查询参数分别限定仓库, 等级, CR 种类与返回条数 |
| `GET /api/status` | Cloudflare Access | 部署的 commit, 时间, 运行链接, Access 是否配置 |
| `POST /api/repos` | Access | 登记仓库, 返回一次性明文 token |
| `PATCH /api/repos/{owner}/{repo}` | Access | 开关, 模式 (full/l0), provider, 模型分级, 月预算 |
| `POST /api/repos/{owner}/{repo}/rotate-token` | Access | 轮换 token |
| `PUT /api/providers/{name}` | Access | api_url, api 类型, key 所在 secret 名, 上下文窗口, 每百万 token 输入/输出价格 |
| `GET /api/findings/{id}/patch` | Access | 从 R2 取补丁 |
| `POST /api/findings/{id}/feedback` | Access | 总览页的采纳或驳回 |

## kind 的校验

`kind` 出现在 `/init`, `POST /runs` 与 `PATCH /api/repos` 三处, 规则一致:

- 一次运行只跑一种: 请求里的 kind 只能是 `context` 或 `code`, 仓库的 kind 可以是 `context`, `code` 或 `both`.
- 缺省: `/init` 不带 `kind` 时, 仓库只服务 `code` 就取 `code`, 否则取 `context`; `POST /runs` 不带 `kind` 时取 `context` (这是升级前所有 runner 发的东西).
- 拒绝而不是改默认: 仓库只服务一种时请求另一种返回 400 (`repository is registered for context reviews, not code`), 因为跑错一种却照常计费, 比直接报错更难发现. 非法取值同样 400.
- `last_sha` 只对 context 有意义: `/init` 只在 `kind=context` 时下发 `lastSha`, `POST /runs` 只在 `kind=context` 且是 push 且 `complete` 不为 false 时推进它. 代码 CR 不读也不写这个游标, 否则一次代码审查会把上下文覆盖率悄悄跳过一段.

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

D1 结构见 [0001_init.sql](../../cf-admin/migrations/0001_init.sql), 预算预留列见 [0002_budget_reservation.sql](../../cf-admin/migrations/0002_budget_reservation.sql), 多轮状态与提示词见 [0003_rounds_prompts.sql](../../cf-admin/migrations/0003_rounds_prompts.sql), 规则维度见 [0004_rule_results.sql](../../cf-admin/migrations/0004_rule_results.sql), kind 维度见 [0005_kind.sql](../../cf-admin/migrations/0005_kind.sql).

| 表 | 内容 |
|---|---|
| providers | 名称, api_url, api 类型, key_secret (Worker secret 名), 上下文窗口, 最大输出, 输入/输出单价 |
| repos | owner/repo (大小写不敏感, COLLATE NOCASE), token SHA-256, 开关, 模式, kind (context/code/both), provider, 模型分级, 月预算, 本月花费, 预算月份, last_sha |
| runs | 每次运行: kind (context/code), sha, base, 事件, PR 号, 状态, Error/Warning 数, token, 花费, 耗时, 补丁分支 |
| findings | 每条发现: kind (从运行继承), 指纹, 规则, 等级, 位置, 说明, 证据, 补丁 R2 key, 状态 open/accepted/rejected/resolved, resolved_by_run |
| feedback | 每次采纳或驳回: 指纹, 结论, 原因, 来源 (token 或 Access 身份) |
| suppressions | 驳回的指纹与原因, 下一次 /init 下发给 finder |
| prompt_versions | 操作者附录: role finder 或 verifier, 版本号, 正文, 说明, 是否当前生效. 追加到 runner 内置系统提示, 不替换 |
| prompt_notes | 驳回原因, 尚未折进附录时 folded_into 为空 |
| rule_results | 每个运行的每个规则命中一行: run_id, rule_id, severity, file, line, status, waived; 与 findings 同批写入, 迁移时从 findings 回填. 不存 kind: 命中属于某次运行, 而运行知道自己是哪一种, 聚合时 `JOIN runs` 过滤 |

`0005_kind.sql` 只加带默认值的列, 所以迁移与 Worker 的部署顺序可以任意: 迁移跑完前旧 Worker 照常服务, 跑完后旧 Worker 也能插入 (由 DEFAULT 填充). 既有行按默认值变成 context 运行, 发现再按所属运行回填. 回滚同样安全: 旧 Worker 读新 schema 时多出来的列不影响映射, 未知的 kind 值由 `rows.ts` 兜底成 `context`.

R2 键: `runs/<owner>/<repo>/<runId>/report.md`, `report.json`, `sessions.jsonl`, `patches/<fingerprint>.diff`.

`POST /runs` 在写入本次运行后, 若带 `prNumber`, 把同一仓库同一 PR 上、指纹未再次出现的 open 发现标为 resolved, 并记下 `resolved_by_run`. 没有 PR 编号的 push 不解决旧发现. `l0Only` 或 `complete: false` 时不解决 `CX-AI` (模型没有复查), L0 规则每次都会重跑所以仍可解决. accepted/rejected 保持人工结论. 响应带 `resolved` 计数.

## 提示词版本与登录

驳回同时写入 suppressions 与 prompt_notes. 管理员可 `POST /api/prompts` 发布最多 4000 字节的附录, 或 `POST /api/prompts/fold` 把未折叠笔记收成 "Do not repeat these rejected claims". 当前附录经 `/init` 的 `prompts` 下发. 附录不能把 AI 发现升成 Error.

总览页鉴权是 Access 身份, 或 `ADMIN_USER` 与 `ADMIN_PASSWORD` (部署时来自 `HX_ADMIN_USER` / `HX_ADMIN_PASSWORD`, 默认 admin / hx-context-review) 签发的 cookie. 密码用 SHA-256("hxctx:"+口令) 比较. cookie 为 HMAC-SHA256, HttpOnly, SameSite=Lax, 12 小时, https 时带 Secure. `POST` 与 `DELETE /api/session` 在 `requireAdmin` 之前. 两者都没配则 403.

## last_sha 与预算

`POST /runs` 先完整校验请求 (findings 必须是对象数组, 等级合法), 校验失败不写任何对象; 校验通过后写 R2 再写 D1, 中途失败会删除本次已写的 R2 对象再返回错误 (补偿清理是尽力而为). status 与 counts 缺省时由 findings 推导; `complete: false` 且没有阻断 Error 时 status 为 `incomplete`, 不会显示为 passed. baseline 认可的 historical 发现只留在 R2 报告里, 不进入待处理列表.

每次运行 (包括 PR) 都计入本月花费: 费用取 runner 上报值与 `输入/输出/缓存读/缓存写 token 数 x provider 对应单价` 的较大值; 预算月份不同则先归零. last_sha 只在 `event` 为 push, 没有 PR 编号且 `complete` 不为 false 时推进, 因为该游标代表已完整审核过的被 push 历史.

provider 名只允许字母, 数字, `.`, `_`, `-`; 新建 provider 必须显式给出输入/输出单价 (免费填 0), 更新时省略的字段 (包括 API 协议) 保留原值; 未知协议, 负数或非整数的 token 上限返回 400. 仓库的 enabled, mode, provider, 模型名, budgetUsd 同理: 省略不改, 出现但类型或取值不对返回 400, 不会被静默忽略. `POST /runs` 同样严格: complete, l0Only 必须是布尔, usage 各项与 durationMs 必须是非负数且为整数 (usage.cost 例外, 单价按百万 token 计, 允许小数), prNumber 与 finding 行号必须是正整数, 字符串字段必须是字符串, 否则 400. 显式 `null` 一律按非法值处理而不是省略: 只有字段缺失才表示不提供. patches 里缺字段或类型不对的条目同样 400, 只有字段合法且 `applies: false` 的补丁才被跳过. status 一律由服务端推导 (failed, incomplete, warned, passed), runner 只能在没有发现时标 skipped; runner 发 incomplete 时同样不推进 last_sha.

`POST /spend` 只接受 `budgetClaim`, 把该预留标记为已开始花费, 供接管时判断是否结算. 重复标记本运行仍持有的预留是 no-op; 预留已被更新的运行接管时返回 409, 该运行必须停止而不是继续花费, 否则同一次运行会被结算一次, 又按真实花费记一次. 迟到的 `/runs` 上报真实花费时, `settled_claims` 里该预留的额度会被真实花费替换而不是叠加, 所以被接管后仍然跑完的运行不会让当月预算被重复扣减. `/init` 的 `limits.maxRunUsd` 是本次运行的可用额度 (无上限时为 null), runner 达到它就不再开新的模型会话; 有上限的仓库同时按上节的预留规则独占本次额度. 只下发 L0 时附带 `l0Cause`: disabled, mode (主动选择), budget, config (区间未审, runner 报 incomplete). 旧数据里 contextWindow 或 maxTokens 不是正整数的 provider 也按 config 降级, 不会把非法上限发给模型. 同名仓库 (大小写不敏感) 重复登记返回 409, 并发创建撞唯一约束同样映射为 409.

## 规则维度与聚合

`rule_results` 与 findings 同批写入, 每次运行每个规则命中一行. 人工驳回把对应行置 `rejected` 且 `waived = 1`; 同一 PR 的后续提交未再报告时置 `resolved`, 与 findings 的多轮语义一致. `waived` 只表示已判定不处理, 不影响命中计数, 所以聚合能回答"哪条规则最常触发".

`GET /api/rules` 按 rule_id 与 severity 聚合: `total` 与 `waived` 覆盖全部命中, `byRule` 按命中数降序 (最多 `limit` 条), `bySeverity` 给出每个等级的命中数与规则数, `topRule` 是最常触发的规则 id, `kind` 回显生效的过滤值 (未过滤时为 null). `repo` 未登记时返回 404 而不是空视图, `severity`, `kind` 与 `limit` 非法时返回 400. `kind` 过滤作用于 `runs.kind` (rule_results 不存 kind), 所以一次运行的所有命中作为一个整体被选中或排除. 规则 id 沿用统一命名空间: ARCH, STYLE, DOC, CTX, CI, TEST, META 前缀; 旧数据里的其他 id (如 CX-AI) 照常聚合, 不改写.

迁移文件可重复执行: 建表与索引用 `IF NOT EXISTS`, 回填用 `INSERT OR IGNORE`, 所以重新执行既不会报错也不会重复插入.

## 分层

路由 (`cf-admin/worker/routes/`) 只依赖 `cf-admin/worker/store/port.ts` 的 `Store` 与 `BlobStore`. `cf-admin/worker/store/d1.ts` 是 D1/R2 适配器, `cf-admin/test/fake-store.ts` 是同语义的内存实现. Worker 的依赖 (`Deps`) 包括 store, blobs, secret 读取, Access 校验, 时钟与 ID 生成, 都可在测试中替换.

## 总览页

`cf-admin/pages` 是 React + TS + Vite 单页, 组件来自 `@hx/ui` (open-vetta 设计语言). 构建产物作为 Worker 的静态资源 (`[assets]`) 一起部署, 与 `/api/*` 同域: Worker 先处理 API 路由, 其余 GET/HEAD 交给 assets binding, 未知路径按 single-page-application 回 `index.html`, 深链接也能直接打开. 所以整个站点是一个 Worker, 自定义域名用 zone route 接管, 不需要 Pages 项目. Access JWT 或会话 cookie 随请求传递, Worker 再次校验. 页面功能:

- 部署状态: 当前 commit, 部署时间, 部署运行日志, Access 是否已配置, 密码登录是否开启, 重新部署入口. 未登录且接口 403 时显示登录表单.
- 仓库: 登记 (token 只显示一次), 轮换 token, 开关, 模式, 模型分级, 本月花费/预算 (清空预算框不会被当成 0, 会恢复原值), last_sha.
- Model providers: 列表 (key 只显示是否存在) 与新增/修改表单. 新 provider 仍必须填写价格.
- 提示词附录: 发布 finder/verifier 附录, 或把驳回笔记折进下一版.
- 待处理发现: 查看补丁, 采纳, 驳回 (必须填写原因, 原因回流抑制表和 prompt_notes). 另列已被后续提交标为 resolved 的发现.
- 最近运行: 状态, Error/Warning 数, 花费, 耗时, 补丁分支的 compare 链接 (一键开 PR 合入补丁).

## 部署与 Access

- 部署用手动触发的 [deploy-cf.yml](../../.github/workflows/deploy-cf.yml), 步骤见 [deploy-cf.md](../tutorials/deploy-cf.md).
- Access 应用只需覆盖总览页域名; Worker 的 `/init`, `/runs`, `/feedback` 用 HX_CTX_TOKEN 鉴权. `/api/*` 校验 Access JWT, 没有身份时再认会话 cookie (格式错误的 JWT 同样按未认证处理).
- Worker 变量 `ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD` 由部署工作流从仓库变量写入. `ADMIN_USER` 与 `ADMIN_PASSWORD` 同样写入. Access 与密码都没配时 /api/* 一律 403.
