# HX-AI-Review (hx-context-review)

在业务仓库每次 push / PR 时做两种 AI review, 一次运行只跑一种:

- context CR (原有): 检查 AGENTS.md, README.md, SKILL.md 与 docs 这些 "给 Agent 读的上下文" 是否仍与代码一致.
- code CR (新增): 审 diff 本身, 找逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界, 以及与既有设计相悖之处.

两种 CR 共用同一条流水线, 同一份报告契约与同一份月预算, 只在审什么, 提示词, 规则命名空间与产物上不同. 当前版本 v0.3.

![architecture](assets/context-review-arch.webp)

一句话流程: init 取配置 -> pi 直连模型 -> 结果入库 CF. 模型请求不经过 Cloudflare; CF 只做配置下发 (api_url + api_key), 存储 (D1/R2) 与总览页 (Pages + Access).

## 目录

| 路径 | 作用 |
|---|---|
| [context-cr/](context-cr/README.md) | GitHub runner 侧: L0 确定性检查, context_scope / code_scope, pi finder -> verifier, 入库与回写 |
| [cf-admin/](cf-admin/README.md) | Cloudflare 侧: Worker (/init, /runs, /feedback, /api), D1 schema, R2, 总览 Pages |
| [.github/workflows/review.yml](.github/workflows/review.yml) | 给业务仓库调用的可复用 workflow |
| [docs/architecture/overview.md](docs/architecture/overview.md) | 架构文档 (先读这篇) |
| [docs/reference/report-contract.md](docs/reference/report-contract.md) | 报告契约与规则表, 与 hx-agent-code 同一契约 |
| [docs/reference/api/cf-admin.yaml](docs/reference/api/cf-admin.yaml) | Worker HTTP 契约 (OpenAPI) |
| [docs/tutorials/onboard-repo.md](docs/tutorials/onboard-repo.md) | 业务仓库接入 (10 行调用方 workflow) |
| [.github/workflows/deploy-cf.yml](.github/workflows/deploy-cf.yml) | 手动触发的 Cloudflare 一键部署 |
| [docs/reference/quality/pipeline.md](docs/reference/quality/pipeline.md) | 代码质量流水线: 触发, 每项检查验证什么, 变更时同步规则 |
| [docs/tutorials/deploy-cf.md](docs/tutorials/deploy-cf.md) | 一键部署 Worker, D1, R2, Pages 与 Access 配置 |
| [docs/decisions/2026-10-11-pi-runner-direct-model.md](docs/decisions/2026-10-11-pi-runner-direct-model.md) | 为什么 pi 在 runner 直连模型, CF 只管配置与存储 |
| [docs/decisions/2026-10-25-dual-cr-kind.md](docs/decisions/2026-10-25-dual-cr-kind.md) | 为什么在既有契约上加 kind 维度, 而不是拆成两个服务 |
| [docs/reference/quality/inventory.md](docs/reference/quality/inventory.md) | hx-agent-code 门禁安装清单与未完成项 |

## 业务仓库接入 (摘要)

```yaml
name: context-review
on:
    push:
        branches: [main]
    pull_request:
jobs:
    context-review:
        uses: HengXin666/HX-AI-Review/.github/workflows/review.yml@v1
        with:
            endpoint: https://hx-context-review.<subdomain>.workers.dev
            kind: context
        secrets:
            HX_CTX_TOKEN: ${{ secrets.HX_CTX_TOKEN }}
```

`kind` 缺省为 `context`. 想同时跑代码 CR 就再加一个 job, 传 `kind: code`, 两者各有自己的 concurrency group, 互不取消. 仓库在总览页登记的 kind 必须包含请求的 kind, 否则 /init 返回 400.

完整步骤见 [docs/tutorials/onboard-repo.md](docs/tutorials/onboard-repo.md).

## 开发

需要 Node 22.19+ 与 pnpm (版本见 package.json 的 packageManager).

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm l0            # 用本工具检查本仓库自己的上下文
pnpm local:diff    # 本地 diff-only 检查, 写 local-review.{md,json}
pnpm quality:docs  # hx-agent-code 文档门禁
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md).
