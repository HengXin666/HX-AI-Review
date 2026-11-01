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
```

两个 job 的关键差别:

| | context job | code job |
|---|---|---|
| 审什么 | 上下文文件是否还和代码一致 | diff 新增或修改的行本身 |
| L0 | 跑, 有 Error 会让 job 红 | 不跑, 整条链上没有 Error |
| 补丁分支 | 可能推 `hx-ctx/patch-<sha>` | 永不推, 只给建议文本 |
| `last_sha` | 推进 (push 且完整时) | 不读也不推进 |
| 规则 id | `HC-*`, `CX-*`, `CX-AI` | `CODE-AI` |

两个 job 的 concurrency group 都带上 kind (`hx-context-review-<kind>-<owner/repo>-<ref>`), 所以它们互不取消, 各自串行与防抖: 连续 push 时 context 的旧运行被取消, code 的旧运行同样被取消, 但两者不会互相顶掉. 预算预留同组接管, 不同组各占一份单次额度 (默认月预算的 1/4) 并发运行, 两者争的是同一份月预算, 所以月预算要按"两种 CR 各跑几次"来估.

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

## webhook 一键接入

除了上面手写调用方 workflow, 还可以直接用模板 [templates/hx-context-review.workflow.yml](../../templates/hx-context-review.workflow.yml). 它同时声明 `push`, `pull_request` 与 `workflow_dispatch` 三种触发, 所以既能自己按提交触发, 也能接住 GitHub App webhook 的 dispatch (Worker 默认 dispatch 的文件名就是 `hx-context-review.yml`, 业务仓库里没有这个文件时 dispatch 会 422). 两条接入路都会让**默认分支的每次 push 都触发一次审查**, 这是有意的行为: last_sha 是按仓一个游标, 主线每个提交都要进区间.

### A. 手动

1. 把 `templates/hx-context-review.workflow.yml` 原样复制到业务仓库的 `.github/workflows/hx-context-review.yml`, 不需要改任何内容.
2. Settings -> Secrets and variables -> Actions -> Secrets: 新建 `HX_CTX_TOKEN` (第 1 节登记时拿到的值).
3. 同一页 Variables: 新建 `HX_CTX_ENDPOINT`, 值为 Worker 地址 (`https://hx-context-review.<subdomain>.workers.dev`). 模板不写 `endpoint`, review.yml 会回落到这个变量.
4. 如果要 webhook 触发, 再按 [github-app.md](../architecture/github-app.md#app-注册) 把 App 安装到这个仓库; 只靠 push / pull_request 的话这一步可以省.

模板里的要点:

- push 不写 `branches` 过滤, 由 job 的 `if` 判断 `github.ref_name` 是否等于 `github.event.repository.default_branch`. 这样 main 与 master 都不用改模板; 非默认分支的 push 会留下一条 skipped 记录, 不占 runner 也不计费.
- `workflow_dispatch` 传下来的 `head_sha` 会被真正 checkout 并评审 (review.yml 的 checkout 取 `inputs.head_sha || github.event.pull_request.head.sha || github.sha`), 所以 Worker dispatch 的提交就是被审的提交; 没传 `head_sha` 时才退回被 dispatch 的 ref 的 HEAD. PR 上的评论靠 `pull_request` 触发, 它 checkout PR 头.
  `head_sha` 按不可信输入处理: 它只进 `with`, 不拼进 shell; checkout 一个 sha 不执行它.
- 不定义 `concurrency`: review.yml 内部已按 kind + 仓库 + PR 号或 ref 串行化, 调用方再加一层会提前取消运行.
- `kind` 由 job 的 matrix 决定: dispatch 时只跑 Worker 传来的那一个 kind (`fromJSON(format('["{0}"]', inputs.kind))`), push / pull_request 时跑模板里 `__KINDS_JSON__` 展开的列表. 注意 `__KINDS_JSON__` 只在一键启用写入时被替换成仓库登记的 kind, 手动复制模板时它不会被替换, 所以手动接入的仓库把这一行的 `fromJSON('__KINDS_JSON__')` 手改成 `fromJSON('["context"]')` 或 `fromJSON('["context","code"]')`.

### B. 控制台一键

1. 总览页 GitHub App 页签: 连接账号 (App 已注册并 verify, 且已安装到目标仓库), 在仓库列表里对目标仓库点启用.
2. 系统按顺序做几步, 每一步在界面上单独显示结果 (成功, 跳过或失败及原因):
    - 登记或沿用 repos 表里的仓库, 生成 `HX_CTX_TOKEN`;
    - 把 token 写成业务仓库的 Actions secret `HX_CTX_TOKEN`, 并写仓库变量 `HX_CTX_ENDPOINT`;
    - 把模板内容写入业务仓库默认分支的 `.github/workflows/<workflowFile>` (默认 `.github/workflows/hx-context-review.yml`, 与 App 配置里的 `workflowFile` 一致), 文件不存在时结果为 `created`, 已存在时覆盖为 `updated`.
3. 某一步失败时, 后续依赖它的步骤显示为跳过, 已完成的步骤不回滚; 修好原因 (常见是 App 缺 Contents: write, Secrets: write 或 Variables: write 权限) 后再点一次启用即可, 写文件是幂等的, 第二次会是 `updated`.
4. 写入工作流文件本身就是一次推到默认分支的提交, 会立刻按 push 触发第一次审查.

注意: 一键启用依赖 Worker 的启用接口与 App 的写权限. 当前 [github-app.md](../architecture/github-app.md) 列出的 App 权限只够 dispatch 与评论; 接口未就绪时用 A.

### 同时开了两条路

模板自带 push 触发, App 又会对同一个 push dispatch 一次, 两次运行落在同一个 concurrency group (`hx-context-review-<kind>-<repo>-refs/heads/<default>`), 后到的取消先到的, 结果是同一个 HEAD 审一次. 区别和取舍见 [github-app.md 的触发路径](../architecture/github-app.md#触发路径).
