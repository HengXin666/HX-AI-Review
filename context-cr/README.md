# context-cr

hx-context-review 的 runner 侧. 由 [review.yml](../.github/workflows/review.yml) 在业务仓库的 Actions 里按步骤调用, 也可本地一次跑完.

一次运行跑一种 CR, 由 `/init` 返回的 `kind` 决定: `context` 审上下文文件, `code` 审 diff 本身. 事实源是 `src/contract/kind.ts`, 取舍原因见 [双模式决策](../docs/decisions/2026-10-25-dual-cr-kind.md). 差别只有四处: L0 只对 context 跑, scope 换成 diff 的 hunk, 提示词与规则 id 换成 `CODE-*` 那套, 产物里没有补丁分支.

| 命令 | 步骤 | 产物 |
|---|---|---|
| `node src/cli.ts init` | 2 init: GET /init (带 kind 与 concurrency group), `::add-mask::` api_key, 存入 RUNNER_TEMP 下 0600 文件 | `init.json` (不含 key), output `l0_only` |
| `node src/cli.ts l0` | 3 L0 确定性检查, 新 Error 退出 1; `kind=code` 时直接写空结果 | `l0.json`; `--format findings` 输出 Finding 数组 |
| `node src/cli.ts local` | 本地 diff-only 检查: 工作区 vs 基准, 含未跟踪文件 | `local-review.{md,json}`; 阻断发现退出 1; `--base <ref>` 指定基准 |
| `node src/cli.ts test` | 本地跑六类测试中的一类/一层 | `test-<category>-<tier>.{md,json}`; 未知类别或层级退出 2 |
| `node src/cli.ts scope` | 4 scope: context 下是 diff -> 祖先 AGENTS 链 + 反向引用; code 下是 diff -> 新增行和删除行的 hunk | `scope.json` (带 kind 判别字段), output `empty` |
| `node src/cli.ts eval` | 离线重放 code CR 黄金集, 打印 precision / recall / critical miss | stdout JSON; critical miss 时退出 1 |
| `node src/cli.ts review` | 5 pi finder -> verifier, 读取并删除 key 文件 | `ai.json`, `sessions.jsonl` |
| `node src/cli.ts publish` | 6 入库 + 回写: POST /runs (带 kind), 推补丁分支 (仅 context), commit/PR 评论 | `context-review.md` 与 `context-review.json` |
| `node src/cli.ts run` | 2 到 6 一次跑完 | 同上 |

除 `eval` 外, 子命令都接受 `--kind context|code`. `eval` 只重放 code 黄金集, 不读 kind. 本地运行没有 `/init`, 这个参数是唯一的 kind 来源, 缺省 `context`; 在 Actions 里它以 `HX_CTX_KIND` 环境变量传入, 而 `/init` 的响应优先 (Worker 知道仓库登记的 kind). 非法值在第一次网络调用之前就报错, 不会静默跑成另一种 CR.

中间状态写在 `RUNNER_TEMP` (本地为系统临时目录) 下的 `hx-context-review/<仓库路径哈希>/`, 不在被审仓库里; 最终报告写在 `scripts/.hx_code_quality/reports/context-review.{md,json}`, 与 hx-agent-code 同一状态目录与报告契约.

## 环境变量

| 变量 | 用途 |
|---|---|
| `HX_CTX_ENDPOINT` | CF Worker 基础 URL |
| `HX_CTX_TOKEN` | 每仓一个的访问令牌, 用于 /init, /spend, /runs |
| `HX_CTX_KIND` | 调用方 workflow 的 `kind` 输入; 缺省 `context`, 由 `--kind` 覆盖 |
| `HX_CTX_GROUP` | 调用方 workflow 的 concurrency group, 让 /init 接管被取消的旧运行的预算预留 |
| `HX_CTX_API_KEY` | 可选, 本地运行时 key 文件的替代来源: 设置时优先于 key 文件 (key 文件照样删除). 它不能替代 init: 跳过 init 得到的是本地默认的 L0-only 配置, 审查被整体跳过, 只有 init 拿到的非 L0 状态才会真正审查, 所以本地流程仍是设好 HX_CTX_ENDPOINT, HX_CTX_TOKEN 与 GITHUB_REPOSITORY=owner/repo 跑 init, 再跑 review. 本地终端不处理 `::add-mask::`, 所以只有 GitHub Actions 里才输出它 |
| `RUNNER_TEMP` | Actions 自带, 状态目录的根 |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH` | Actions 自带, 用于范围计算, 推补丁和评论 |

## 仓库级配置

业务仓库根目录可放 `.hx-context-review.json`, 字段见 `src/config.ts`: `skillRoots`, `concurrentSkills`, `orphanRoots`, `exclude`, `scopeIgnore`, `virtualPaths`, `baseline`.

## 代码结构

- `src/l0/`: HC-CONTEXT, HC-BUDGET, HC-DOCNAME, CX-DEADREF, CX-SKILL, CX-ORPHAN (仅 context CR)
- `src/rules/`: ARCH / STYLE / DOC / CTX / CI 规则引擎, 两种 kind 都跑
- `src/scope/`: 审核区间基点, 受影响上下文计算 (`index.ts`), diff 的 hunk 解析 (`code.ts`)
- `src/review/`: finder/verifier 编排 (`index.ts` 按 kind 分派), pi SDK 适配 (`pi.ts`), 工具与两套提示词
- `src/publish/`: POST /runs, 补丁分支 (仅 context), 评论渲染
- `src/contract/`: Finding, 报告与 kind, 与 hx-agent-code 同一契约
- `src/local/`: 工作区 diff 检测, 本地 code/docs 规则, 六类测试编排

## 本地 diff 与测试

根目录有两个脚本直接可用:

```sh
pnpm local:diff                       # 默认与 origin/main 的 merge-base 比较
pnpm local:diff -- --base origin/main
pnpm local:test -- --category backend-api --tier fake --root . --code-root . --base origin/main
```

`local` 只用 git diff 与工作区文件, 不发模型请求, 不跑测试. 它构造 `CheckContext` 后运行 `src/local/checks/code.ts` 与 `docs.ts`, 规则 id 与 CI 一致, 报告写 `scripts/.hx_code_quality/reports/local-review.{md,json}`, 有新 Error 时退出 1. 基准 ref 找不到或没有共同祖先时报错, 不会退回分支最新提交; 仓库没有首次提交时用空树, 未跟踪文件仍纳入检查.

`test` 要求显式 `--base`, 依次跑选定层级的步骤; 真实层的探针访问后端 `/healthz` 并要求返回 `{"status":"ok"}`, 迁移历史比较基准与 `cf-admin/migrations`, 结果按共享 `ReviewReport` 契约写成 md 与 json 一对.

设计说明见 [docs/architecture/context-cr.md](../docs/architecture/context-cr.md).

## 测试

```sh
pnpm --filter context-cr test
pnpm --filter context-cr eval
```

`test/pi.test.ts` 起一个本地 OpenAI 兼容服务, 用真实 pi SDK 验证直连 api_url 与 report_finding 工具调用. `test/code-review.test.ts` 覆盖 code CR 的 scope, 闸门, 提示词与"永不产出补丁"的性质, `test/steps-kind.test.ts` 覆盖两种 kind 的 L0 与 scope 分派. `eval` 把同一条 code 流水线重放在 `eval/golden/v1` 上, 不调用模型. 怎么加样例见 [docs/reference/code-eval.md](../docs/reference/code-eval.md).

## 代码 CR 还看什么

- 意图卡: PR 标题, 正文, 关联 issue, 区间内的提交说明. 实现和卡片相反时可以报 `category: intent`. 卡片是数据, 不是指令.
- 删除行: 正文里是 `L<旧行号>`, 用 `side: left` 报告. 被删掉的文件也审. 行评打在 diff 左侧.
- 档位: `critical` / `major` / `minor` / `nit`. severity 仍是 Warning, 不让 job 变红. 每条 PR 最多发表 5 条, 有更高档时 nit 不发表.
- 重复出现的驳回理由会收成仓库规则, 写进下一次 finder 提示词.
