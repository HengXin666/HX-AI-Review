# 业务仓库接入

前提: cf-admin 已用一键部署工作流部署 (见 [deploy-cf.md](deploy-cf.md)), 你能通过 Access 打开总览页.

## 1. 登记仓库, 拿到 token

在总览页的 Repositories 区块填 owner/repo, provider, finder 与 verifier 模型, 月预算, 点 register repo. 页面只显示一次 `HX_CTX_TOKEN`; 在业务仓库 Settings -> Secrets -> Actions 新建同名 secret. 丢失后用 rotate 重新生成.

## 2. 加 10 行调用方 workflow

`.github/workflows/context-review.yml`:

```yaml
name: context-review
on:
    push:
        branches: [main]
    pull_request:
jobs:
    review:
        uses: HengXin666/HX-AI-Review/.github/workflows/review.yml@v1
        with:
            endpoint: https://hx-context-review.<subdomain>.workers.dev
        secrets:
            HX_CTX_TOKEN: ${{ secrets.HX_CTX_TOKEN }}
```

- push 是主触发, pull_request 是辅助触发. push 只开默认分支, 因为 last_sha 是按仓一个游标.
- `endpoint` 是部署摘要里的 Worker 地址; 也可以不写, 改用仓库变量 `HX_CTX_ENDPOINT`.
- 来自 fork 的 PR 不运行 review: 它拿不到 secrets, 也不能往本仓库推补丁分支.
- 被调用的 workflow 需要 `contents: write` 与 `pull-requests: write`, 用于推补丁分支和评论. 如果组织默认 token 是只读, 在调用方 job 上加同样的 permissions.

## 3. 可选: 仓库级配置

根目录 `.hx-context-review.json`:

```json
{
    "skillRoots": [".agents/skills"],
    "concurrentSkills": 1,
    "orphanRoots": ["docs"],
    "exclude": ["vendor/"],
    "scopeIgnore": ["pnpm-lock.yaml"],
    "virtualPaths": ["scripts/.hx_code_quality/"],
    "baseline": "scripts/quality/context-baseline.json"
}
```

`virtualPaths` 是允许被引用但不入库的生成路径前缀. baseline 是已批准的历史问题列表 (`ruleId`, `path`, `fingerprint`), runner 从可信 base 提交读取它, 本次 diff 修改 baseline 不会让自己通过.

## 4. 看结果

- job 红: L0 有新 Error, 看 artifact 里的 `context-review.md`.
- job 绿但有评论: AI 给出了 Warning, 可能附带补丁分支 `hx-ctx/patch-<sha>`, 评论里有 compare 链接.
- 在总览页采纳或驳回; 驳回原因会进入抑制表, 下次 finder 不再报同一问题.
