# 业务仓库接入

前提: cf-admin 已用一键部署工作流部署 (见 [deploy-cf.md](deploy-cf.md)), 你能通过 Access 打开总览页.

## 1. 登记仓库, 拿到 token

在总览页的 Repositories 区块填 owner/repo, provider, finder 与 verifier 模型, 月预算, 点 register repo. 页面只显示一次 `HX_CTX_TOKEN`; 在业务仓库 Settings -> Secrets -> Actions 新建同名 secret. 丢失后用 rotate 重新生成.

同一处还要选这个仓库服务哪种 CR:

| `kind` | 含义 |
|---|---|
| `context` | 只跑上下文 CR (默认, 与升级前的行为一致) |
| `code` | 只跑代码 CR |
| `both` | 两种都跑, 由调用方 workflow 的 `kind` 输入决定这一次跑哪种 |

仓库只服务一种时, 传另一种会被 `/init` 拒绝 (400), 而不是静默换成仓库默认值: 配错 kind 的 workflow 会立刻红, 不会跑一次没人要的审查还照样计费. 改这个字段用 `PATCH /api/repos/{owner}/{repo}`.

另外, 模式为 `l0` 的仓库不能跑代码 CR: `l0` 表示 "只跑确定性检查, 不调模型", 而代码 CR 没有确定性阶段, 这个组合什么都不会审. 想跑 code CR 就把模式改成 `full`.

## 2. 加 10 行调用方 workflow

只跑上下文 CR (大多数仓库的起点):

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
            kind: context
        secrets:
            HX_CTX_TOKEN: ${{ secrets.HX_CTX_TOKEN }}
```

- push 是主触发, pull_request 是辅助触发. push 只开默认分支, 因为 last_sha 是按仓一个游标.
- `kind` 缺省就是 `context`, 写出来是为了让读者一眼看到这次审的是哪一种.
- `endpoint` 是部署摘要里的 Worker 地址; 也可以不写, 改用仓库变量 `HX_CTX_ENDPOINT`.
- 来自 fork 的 PR 不运行 review: 它拿不到 secrets, 也不能往本仓库推补丁分支.
- 被调用的 workflow 需要 `contents: write` 与 `pull-requests: write`, 用于推补丁分支和评论.

**必须在调用方 workflow 顶层显式写 `permissions`**, 不要依赖仓库默认值:

```yaml
permissions:
    contents: write
    pull-requests: write
```

仓库默认 token 是只读时, 这一项没法隐式继承. 后果不是一条有用的报错, 而是 `startup_failure`: 没有 job, 没有日志, 什么都看不到. 实测 8 个仓库里只有默认值为 `write` 的那一个能跑, 其余全部静默失败.

排查方法: 对比 `gh api repos/{owner}/{repo}/actions/permissions/workflow` 的 `default_workflow_permissions`. 两种修法都行 —— 改仓库默认值为 `write`, 或者在调用方 workflow 里显式声明; 后者更稳, 因为它随代码走, 换仓库不会丢.

### 两种 CR 各配一个 job

仓库登记为 `both` 时, 在同一个 workflow 里写两个 job, 各自传一个 `kind`:

```yaml
jobs:
    context-review:
        uses: HengXin666/HX-AI-Review/.github/workflows/review.yml@v1
        with:
            endpoint: https://hx-context-review.<subdomain>.workers.dev
            kind: context
        secrets:
            HX_CTX_TOKEN: ${{ secrets.HX_CTX_TOKEN }}
    code-review:
        uses: HengXin666/HX-AI-Review/.github/workflows/review.yml@v1
        with:
            endpoint: https://hx-context-review.<subdomain>.workers.dev
            kind: code
        secrets:
            HX_CTX_TOKEN: ${{ secrets.HX_CTX_TOKEN }}
            # 可选. 不传时行评和进度评论由 github-actions[bot] 发出.
            GH_APP_TOKEN: ${{ secrets.GH_APP_TOKEN }}
```

两个 job 的关键差别:

| | context job | code job |
|---|---|---|
| 审什么 | 上下文文件是否还和代码一致 | diff 新增或修改的行本身 |
| L0 | 跑, 有 Error 会让 job 红 | 不跑, 整条链上没有 Error |
| 补丁分支 | 可能推 `hx-ctx/patch-<sha>` | 永不推. PR 上更新进度评论, 并提交分块审查与证据校验两个 review, 确认项写到 diff 行 |
| `last_sha` | 推进 (push 且完整时) | 不读也不推进 |
| 规则 id | `HC-*`, `CX-*`, `CX-AI` | `CODE-AI` |

两个 job 的 concurrency group 都带上 kind (`hx-context-review-<kind>-<owner/repo>-<ref>`), 所以它们互不取消, 各自串行与防抖: 连续 push 时 context 的旧运行被取消, code 的旧运行同样被取消, 但两者不会互相顶掉. 预算预留按组接管, 不同组之间仍是真正的并发, 两者争的是同一份月预算, 所以月预算要按"两种 CR 各跑几次"来估.

只跑 code CR 的仓库把 context job 删掉, 并把登记改成 `code`; 反过来同理. 一个仓库只跑一种时, 传另一种会 400.

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

- job 红: context job 的 L0 有新 Error (code job 不会因为 AI 结论变红), 看 artifact 里的 `context-review.md`.
- job 绿但有评论: AI 给出了 Warning. context 运行可能附带补丁分支 `hx-ctx/patch-<sha>`, 评论里有 compare 链接; code 运行只给建议文本, 没有分支.
- 在总览页采纳或驳回; 驳回原因会进入抑制表, 下次 finder 不再报同一问题. 抑制按规则命名空间分开, 驳回一条上下文发现不会顺带压掉同一行的代码缺陷.
