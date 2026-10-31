# hx-context-review v0.3 架构

init 取配置 -> pi 直连模型 -> 结果入库 CF. 模型请求不经过 CF; CF 只做配置下发 (api_url + api_key), 存储 (D1/R2) 与总览页 (Pages + Access).

一次运行跑一种 CR: context CR 审上下文文件是否还和代码一致, code CR 审 diff 本身. 两者共用同一条流水线与同一份报告契约, 只在 scope, 提示词, 规则命名空间与产物上分叉.

![architecture](../../assets/context-review-arch.webp)

## 要解决的问题

业务仓库里的 AGENTS.md, README.md, SKILL.md 与 docs 是 Agent 的 "事实来源". 代码一改, 这些文件很容易悄悄过时: 路径改名了, 命令换了, 模块边界变了, 但上下文还在描述旧世界. hx-context-review 在每次 push / PR 时回答两个问题:

- context CR: 这次 diff 让哪些上下文变成了错的?
- code CR: 这次 diff 新增或修改的行里, 哪些是错的? (逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界, 与既有设计相悖)

一个仓库可以只跑一种, 也可以两种都跑. 两者共享 budget, provider, 模型分级, 提示词附录与驳回抑制表, 所以不拆成两个服务; 原因见 [双模式决策](../decisions/2026-10-25-dual-cr-kind.md).

## 组件

```
GitHub (计算)                                       Cloudflare (配置 / 存储 / 总览)
+------------------------------+                    +-----------------------------+
| 业务仓库: 10 行调用方 workflow |                    | Worker /init  配置下发        |
| uses: .../review.yml@v1      |   (1) GET /init     |  校验 HX_CTX_TOKEN            |
| secrets: HX_CTX_TOKEN        | -----------------> |  按仓返回 api_url + api_key   |
+--------------+---------------+                    |  + 模型分级 + last_sha + 抑制表 |
               v                                    +-----------------------------+
+------------------------------+                    | Worker 入库 API               |
| Actions runner (一次运行)     |   (3) POST /runs    |  POST /runs  POST /feedback   |
| 1 checkout fetch-depth 0     | -----------------> |  更新 last_sha 与预算          |
| 2 init  (mask api_key)       |                    +------+--------------+-------+
| 3 L0 (仅 context, Error)     |                           v              v
| 4 scope (context/code)       |                    +-----------+  +--------------+
| 5 pi finder -> verifier ------+--(2) 直连 api_url   | D1 rows   |  | R2 报告/会话   |
| 6 入库 + 回写                 |       |             +-----------+  | /补丁          |
+------------------------------+       v             总览页 Pages + Access         |
                              模型 API (OpenAI / Anthropic 兼容)
```

| 组件 | 代码 | 职责 |
|---|---|---|
| 调用方 workflow | 业务仓库 `.github/workflows/*.yml` | 约 10 行, 只声明触发事件, 引用可复用 workflow, 传 HX_CTX_TOKEN |
| 可复用 workflow | [.github/workflows/review.yml](../../.github/workflows/review.yml) | 6 个步骤, 3 个输入 (`endpoint`, `tool-ref`, `kind`), concurrency 串行与防抖, 权限 contents/pull-requests write |
| runner CLI | [context-cr/](../../context-cr/README.md) | init, l0, rules, scope, review, publish 六个流水线子命令 (另有 local, test, run); scope 与 review 按 kind 分派 |
| 配置与入库 Worker | [cf-admin/worker/](../../cf-admin/worker/index.ts) | /init, /spend, /runs, /feedback, /api/*; 按 kind 过滤运行, 发现与规则聚合 |
| 存储 | D1 + R2 | D1: repos, runs, findings (三者都带 kind), feedback, budget, suppressions; R2: MD/JSON 报告, pi 会话 JSONL, 补丁 |
| 总览页 | [cf-admin/pages/](../../cf-admin/pages/src/App.tsx) | 部署状态, 仓库登记与开关/模式/kind/预算, provider 管理, 最近运行, 待处理发现, 一键合入补丁, 驳回原因回流, context / code 切换. 构建产物作为 Worker 静态资源一起部署, 与 API 同域 |
| 一键部署 | [.github/workflows/deploy-cf.yml](../../.github/workflows/deploy-cf.yml) | 手动触发: D1 + 迁移, R2, Worker (含总览页静态资源与自定义域名路由), 可选写入模型 key secret |

详细设计: [context-cr.md](context-cr.md) 与 [cf-admin.md](cf-admin.md).

## 一次运行

两种 kind 的差别写在每一步的括号里.

1. checkout: `fetch-depth: 0`, 拿到完整历史, 以便计算 last_sha 到 head 的区间和 merge-base.
2. init: `GET /init?repo=owner/name&kind=context|code&group=<concurrency group>`, Bearer HX_CTX_TOKEN. `kind` 来自调用方 workflow 的输入, 缺省 `context`; 仓库只服务另一种时返回 400. 返回 api_url, api_key, finder/verifier 模型, last_sha, 抑制表. runner 立刻 `::add-mask::` api_key, 写入 RUNNER_TEMP 下权限 0600 的文件, review 步骤读取后立即删除, publish 步骤兜底删除; key 不进 `$GITHUB_ENV`, 因此后续步骤与第三方 Action 看不到它. `init.json` 不含 key. 返回值必须是不含空白与控制字符的单行, 否则 init 失败. 仓库停用, 模式为 l0 或超预算时只下发 L0 配置, 没有 key.
3. L0 确定性检查 (仅 context): HC-CONTEXT, HC-BUDGET, HC-DOCNAME, CX-DEADREF, CX-SKILL, CX-ORPHAN. 新 Error 让 job 失败, check 变红; 但后续步骤照常执行, 结果照常入库. code 运行直接写空的 `l0.json`, 不跑这些规则: 它们判的是上下文, 不是 diff.
4. scope: 按 kind 分派. context 下是区间 diff -> 每个变更路径的祖先 AGENTS 链 + 引用了该路径 (或其所在目录) 的上下文文件 + 改动的 AGENTS 的所有后代 AGENTS; code 下是区间 diff -> 每个文件有新增或删除的 hunk (删除行用旧侧行号 `L<old>` 报告, 行评在 LEFT). 结果为空就结束, 0 次模型调用.
5. pi finder -> verifier: finder 会话用只读工具 (read, grep, find, ls) 与 `report_finding`. context 下找过时陈述并可附补丁, code 下找新增行, 删除行和意图偏离, 工具没有补丁字段; 每个候选在新的 verifier 会话里被尝试反驳, 只有 `confirmed` 才保留, 再按 grade 做每 PR 评论预算. 规则分别为 `CX-AI` 与 `CODE-AI`, 等级都是 Warning. 补丁用 `git apply --check` 确定性校验.
6. 入库 + 回写: POST /runs 发送 kind, findings, 补丁, 耗时, token 用量; 用当前 GitHub 身份把可用补丁推到 `hx-ctx/patch-<sha>` 分支 (仅 context); push 发 commit comment, PR 更新同一条带标记的评论. `last_sha` 只由完整的 context push 运行推进. 身份优先是总览里登记的 GitHub App (见下), 没有安装时才退回 `github-actions[bot]`.

## 回评身份

评论和行评要显示成一个 App, 和 Qodo / DeepSource 一样, 而不是 Actions 机器人, 也不是仓库主人的个人账号. 全产品只有一个 GitHub App. 总览页创建或粘贴它, Worker 保存 App ID 和私钥. 每个业务仓库安装这个 App, GitHub 用 webhook 告诉 Worker 安装到了哪. 审查跑起来时, runner 用已有的 `HX_CTX_TOKEN` 向 Worker 换一张只属于该仓库的 installation token, 再用这张 token 发进度评论, 分块 review 和行评.

```mermaid
sequenceDiagram
    participant Admin as 总览页
    participant GH as GitHub
    participant Worker as Worker
    participant Run as 业务仓库 runner
    Admin->>GH: 创建 GitHub App（清单，确认一次）
    GH->>Worker: 回调 code，换 App ID 与私钥
    Note over Admin,Worker: 也可以在总览里粘贴已有 App
    GH->>Worker: 仓库安装后的 webhook
    Run->>Worker: GET /github/token（Bearer HX_CTX_TOKEN）
    Worker->>GH: App JWT 换 installation token
    GH-->>Worker: 1 小时 token
    Worker-->>Run: token + bot 登录名
    Run->>GH: 进度评论、分块 review、行评
    Note over GH: 显示为 hx-ai-review[bot]
```

业务仓库的 workflow 不用新增 secret. `GH_APP_TOKEN` 只是换 token 失败时的备用, 不是正路.

## 为什么这样分

- 需要仓库上下文的事都在 runner 里做: pi 直接读 checkout 下来的文件, 不用把代码搬到 CF.
- 仓库里只放 HX_CTX_TOKEN; api_key 由 CF 按仓下发, 可在 CF 里随时换模型, 轮换或停用.
- 串行和防抖交给 GitHub concurrency (cancel-in-progress), D1 里的 last_sha 保证审核区间不漏: 被取消的运行不执行 publish; review 失败时 publish 只把 L0 结果入库并标记 `complete: false`, Worker 不推进 last_sha, 下一次从更早的基点开始.
- Error 仍只来自 L0; AI 只出 Warning + 补丁, 与 hx-agent-code 同一报告契约 ([report-contract.md](../reference/report-contract.md)).
- 两种 CR 同服务而不是拆两个: 共享 budget, provider, 模型分级, 提示词附录与驳回抑制表; 两者的 Error 语义相同 (只来自 L0), 拆开就是重复实现; 总览页需要同时看两种 CR 的健康度. 只加一个 kind 维度, 老客户端不带这个参数时行为不变.
- concurrency group 带上 kind (`hx-context-review-<kind>-<repo>-<ref>`): 同一仓库的 context job 与 code job 互不取消, 各自串行与防抖; 而预算预留按组接管, 不同组仍是真正的并发, 两种 CR 争的是同一份月预算.

决策记录: [2026-10-11-pi-runner-direct-model.md](../decisions/2026-10-11-pi-runner-direct-model.md), [2026-10-25-dual-cr-kind.md](../decisions/2026-10-25-dual-cr-kind.md).

## 安全边界

| 资产 | 存放 | 暴露面 |
|---|---|---|
| HX_CTX_TOKEN | 业务仓库 secret; D1 只存 SHA-256 | /init, /spend, /runs, /feedback |
| api_key | Worker secret, D1 只存 secret 名 | /init 响应, RUNNER_TEMP 下 0600 文件 (review 读后即删), review 进程内存, 被 mask |
| GITHUB_TOKEN | Actions 自动注入, 只在没有 App token 时使用 | 推补丁分支, 评论 |
| GitHub App 私钥与 webhook secret | D1 `github_app`（总览写入）; 管理接口不回传 | 只用于签 App JWT 和校验安装 webhook |
| installation token | Worker 现签, 约 1 小时, 只覆盖发出请求的那个仓库 | runner 的 review 与 publish 进程 |
| HX_CTX_TOKEN | 只传给 init 与 publish 步骤 | /init, /runs |
| 管理权限 | Cloudflare Access | /api/* 校验 Access JWT (RS256, aud, exp), 未配置即 403 |

来自 fork 的 PR (pull_request 与 pull_request_target 都算) 在 job 条件里直接跳过: 它拿不到 secrets, head 提交也不在本仓库, 不能往本仓库推补丁分支. 模型生成的补丁只有在只改动被报告的那个上下文文件时才会推送, 且只可能来自 context 运行.

## 已知限制

- 补丁分支的提交不会触发其他 workflow (GITHUB_TOKEN 的限制), 需要人工开 PR 合入; 总览页提供 compare 链接.
- push 触发建议只开在默认分支, 因为 last_sha 是按仓一个游标; 这个游标只对 context CR 有意义, code CR 既不读也不推进它.
- code CR 的删除行锚在旧文件行号上, 行评用 GitHub 的 LEFT. 二进制补丁仍然没有 hunk, 不会被审. 离线黄金集重放流水线, 不调用托管模型, 见 [code-eval.md](../reference/code-eval.md).
- L0 读的 baseline 来自可信 base 提交, 不信任本次 diff 自己改的 baseline.
- CF 的引用索引是可选提示, runner 每次都会本地重算反向引用.
