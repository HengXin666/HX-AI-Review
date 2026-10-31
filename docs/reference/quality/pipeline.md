# 代码质量流水线

本文是本仓库代码质量体系的唯一说明: 什么时候跑, 跑哪些检查, 每项检查验证什么, 失败条件是什么, 以及改动时要同步什么. 下面"变更时同步"一节列出的路径改动时, 必须在同一次改动里更新本文, 由 HX-DOCLINK 检查强制.

质量体系由 hx-agent-code 驱动 (vendor 在 `.agents/skills/hx-agent-code/`, 来源与依赖清单见 [inventory.md](inventory.md)), 项目自己的检查命令都登记在 `scripts/quality/ci.json`.

## 触发与工作流

```text
push / pull_request
  |-- quality-code.yml   -> ci.ts code    : typecheck, format
  |-- quality-docs.yml   -> ci.ts docs    : context-l0, doc-links
  `-- quality-build.yml
        |-- build          -> ci.ts build : pages-build, 产物封存为 artifact
        |-- compatibility  -> ci.ts compatibility (当前不适用, 记录原因)
        |-- tests (quality-tests.yml, 下载同一次 build 产物) -> ci.ts tests
        `-- result         : build, compatibility, tests 任一失败即失败

workflow_dispatch
  `-- deploy-cf.yml      : 部署前先跑 cf-admin typecheck 与 test, 失败不部署

workflow_call (业务仓库调用, 本仓库自身不跑)
  `-- review.yml         : init -> L0 -> scope -> pi review -> publish
```

| 工作流 | 触发 | 必须通过才算绿 |
|---|---|---|
| [quality-code.yml](../../../.github/workflows/quality-code.yml) | push, pull_request | code 组无 Error |
| [quality-docs.yml](../../../.github/workflows/quality-docs.yml) | push, pull_request | docs 组无新 Error |
| [quality-build.yml](../../../.github/workflows/quality-build.yml) | push, pull_request | build, compatibility, tests 三个 job 都成功 |
| [quality-tests.yml](../../../.github/workflows/quality-tests.yml) | 被 quality-build 调用 | 选中的测试全部退出 0 |
| [tests-all.yml](../../../.github/workflows/tests-all.yml) | 手动或 workflow_call | 六类测试聚合, 任一类别失败即失败 |
| [tests-<category>.yml](../../../.github/workflows/tests-backend-api.yml) | 按类别: PR 路径, main push, schedule, label 或 tag | 对应类别退出 0; 没有 test 分支时输出 notice 并跳过 |
| [deploy-cf.yml](../../../.github/workflows/deploy-cf.yml) | 手动 | 部署前测试通过, 部署步骤无错 |

## 本地命令

| 命令 | 对应 CI | 说明 |
|---|---|---|
| `pnpm typecheck` | code / typecheck | 所有包与 `scripts/quality` 的 tsc strict |
| `pnpm format:check` | code / format | prettier, 4 空格, 行宽 120 |
| `pnpm l0` | docs / context-l0 | 本仓库自己的上下文 L0 检查 |
| `pnpm doc-links` | docs / doc-links | 与 origin/main 的 merge-base 比较, 含未提交与未跟踪文件; 有 finding 时退出 1, 可作 `&&` 门禁; 可加 `-- --base <ref>` |
| `pnpm test` | tests | 所有包的单元测试与 quality 自身测试 |
| `pnpm local:diff` | 无, 本地增量 | 只查与基准的差异: 规则 id 与 CI 相同, 写 `local-review.{md,json}`, 有阻断发现时退出 1; 可加 `-- --base <ref>` |
| `pnpm local:test -- --category <id> --tier <id> --root <tests tree> --code-root . --base <ref>` | tests 的六类 | 本地跑单类别或层级, 每层写 `test-<category>-<tier>.{md,json}`; 未知类别或层级退出 2 |
| `pnpm build` | build | 构建总览页 |

提交前至少跑 `pnpm typecheck && pnpm test && pnpm l0 && pnpm format:check`. `pnpm quality:*` 直接调用 CI runner, 需要 GitHub 事件环境, 只供 Actions 使用.

## runner 怎么跑 (hx-agent-code `scripts/ci.ts <group>`)

1. 范围: push 用事件的 `before..after`; PR 用 base 与 head 的 merge-base; 首次提交或 `before` 不可用时以空树为基并全量兜底. 范围写进 `scripts/.hx_code_quality/reports/scope-<group>.json`, 通过 `HX_QUALITY_SCOPE` 传给每个任务.
2. setup: `pnpm install --frozen-lockfile`. 失败则整组判失败, 后续任务不跑.
3. 任务: 逐个执行组内任务, 不因前一个失败而短路. `format: exit` 只看退出码; `format: findings` 解析标准输出的 findings JSON (ruleId, severity, path, line, message, evidence, fingerprint).
4. 基线: 从可信 base 读取 `scripts/quality/baseline.json`, 已批准的 Error 记为 historical, 不阻断; 新 Error 阻断; Warning 从不阻断.
5. 报告: `scripts/.hx_code_quality/reports/<group>.md|json`, CI 中作为 artifact 上传, 失败时也上传. 超过 10 条时只看数量与类型统计.
6. runner 自身故障 (缺命令, 输出损坏, 超时, 配置错误) 记为 HC-CI Error, 不会空结果放行.

## 各组验证什么

| 组 | 任务 ID | 命令 | 验证内容 | 失败条件 |
|---|---|---|---|---|
| code | typecheck | `pnpm typecheck` (即 `pnpm -r typecheck && tsc -p scripts/quality`; `pnpm -r` 不含根包, 所以 CI 必须调用根脚本) | context-cr, cf-admin Worker, 总览页, Pages Functions, 部署脚本, quality 脚本全部 tsc strict, 无未用变量, 仅可擦除语法 | 任一类型错误 |
| code | format | `pnpm format:check` | prettier 格式 | 任一文件未格式化 |
| docs | context-l0 | `node context-cr/src/cli.ts l0 --format findings` | 下面 L0 规则表 | 新 Error |
| docs | doc-links | `node scripts/quality/doc-links/index.ts --format findings` | 被监视路径变更时关联文档同步变更 (HX-DOCLINK) | 漏改文档, 映射里的文档或前缀已不存在 |
| build | pages-build | `pnpm --filter cf-admin build` | 总览页能用 Vite 构建, 输出写到 `HX_QUALITY_BUILD` | 构建失败 |
| tests | 见下表 | 由影响图选择 | 单元与集成测试 | 任一选中测试失败 |
| compatibility | (无) | | 尚无已发布的 Worker 或 D1 schema, 记为不适用 | |

### 测试选择

`scripts/quality/graph.ts` 输出影响图: push 只跑受影响模块的测试, PR 全量跑. 改动 `global` 中的文件 (根 package.json, lockfile, workspace, tsconfig.base.json, `scripts/quality`) 时全量跑; 改动共享契约 `docs/reference/api/cf-admin.yaml` 时 context-cr 与 cf-admin 两侧都跑.

| 测试 ID | 命令 | 覆盖 |
|---|---|---|
| context-cr:unit | `pnpm --filter context-cr test` | L0 六条规则正反例, scope 计算 (祖先链, 反向引用, 改名删除, 空范围零模型调用, code 的新增行与删除行), 审查 agent (分批, 带行号上下文, 确定性闸门, verifier 补丁判定, 会话失败保留用量, 运行预算与运行时限导致 incomplete, 候选上限只计通过闸门的候选, 不可读文件, 评论预算), 黄金集回放的 precision 与 critical miss, git 只读工具拒绝 .git 与越界路径, 补丁只能是单文件纯文本修改 (冲突, 非 ASCII 与含制表符路径), /init 严格解析, 真实 pi SDK 直连本地 OpenAI 兼容端点并计费, 模型 500 被识别为会话失败 |
| cf-admin:unit | `pnpm --filter cf-admin test` | /init 鉴权, L0 降级与剩余预算, /runs 校验顺序与 R2 补偿清理, 状态推导, 预算计费 (含 PR 与缓存 token), last_sha 只随完整 push 推进, 反馈回流抑制表, provider, 仓库与 /runs 字段校验 (非法即 400, 省略保留旧值), 状态由服务端推导, l0Cause 与旧数据非法上限降级, 仓库名大小写与 409, Access 失败关闭与畸形断言 |
| quality:unit | `node --test scripts/quality/doc-links/index.test.ts` | HX-DOCLINK 漏改, 改名, 失效映射 |

## L0 规则 (context-cr)

配置在根目录 `.hx-context-review.json` (技能根, 排除路径, 孤儿检查根, 基线), 基线 `scripts/quality/context-baseline.json`. 每条规则独立运行, 某条崩溃记为工具错误而不是空通过.

`exclude` 里的路径从不注入, 因此既不计入 HC-BUDGET 的祖先 AGENTS.md 字节数, 也不计入技能注入上界: 被排除的 AGENTS.md 或 SKILL.md 不会因为体积大而把 CI 卡住. 这与 HC-CONTEXT, HC-DOCNAME, CX-SKILL 已有的排除行为一致.

| 规则 | 等级 | 验证内容 |
|---|---|---|
| HC-CONTEXT | Error | 含 README.md 或 AGENTS.md 的目录两者成对, AGENTS.md 少于 150 行 |
| HC-BUDGET | Error | 任一目录的祖先 AGENTS 链加技能注入上界不超过 65536 字节 (被 exclude 的路径从不注入, 不计入) |
| HC-DOCNAME | Error | `docs/` 下文档文件的目录与文件名小写 kebab, 无 v2 或日期副本 (decisions 除外); README/AGENTS 等固定名只豁免文件名. 只判文档扩展名 (md/mdx/yaml): `docs/` 里同时放站点源码 (tsx/html/css/svg) 不算违规. 非 ASCII 名与带序号的分节名 (`001-计佬常識`, `002-KMP`) 豁免, 因为 kebab 约束的是 ASCII 词分隔符, 不是要求文档用英文写 |
| CX-DEADREF | Error / Warning | 上下文文件里的 Markdown 链接失效为 Error, 反引号路径失效为 Warning; 围栏代码块内不算. 只由点组成的一段 (`...`) 是省略号占位, 不按路径解析 |
| CX-SKILL | Error | SKILL.md front matter 的 name 与目录名一致且有 description (兼容 CRLF) |
| CX-ORPHAN | Warning | `docs/` 下没有任何上下文文件引用的文档 |

## HX-DOCLINK 映射

映射在 `scripts/quality/doc-links/links.json`. 当前:

| 监视路径前缀 | 必须同步的文档 |
|---|---|
| `scripts/quality/`, quality 工作流 (前缀 .github/workflows/quality-), `.agents/skills/hx-agent-code/`, `context-cr/src/l0/`, `.hx-context-review.json`, `.prettierrc.json`, `.prettierignore`, `tsconfig.base.json`, 各包的 tsconfig.json | 本文 |
| `.github/workflows/deploy-cf.yml`, `cf-admin/scripts/deploy.ts` | [deploy-cf.md](../../tutorials/deploy-cf.md) |
| `context-cr/src/contract/` | [report-contract.md](../report-contract.md) |
| `.github/workflows/review.yml`, `context-cr/src/` 下的 steps.ts, state.ts, cli.ts, publish/, init/ | [context-cr.md](../../architecture/context-cr.md) |
| `context-cr/src/review/`, `context-cr/src/scope/`, `context-cr/src/constants.ts` | [agent-review.md](../../architecture/agent-review.md) |
| `context-cr/src/eval/`, `context-cr/eval/` | [code-eval.md](../code-eval.md) |

`constants.ts` 被 agent-review.md 记录 (会话轮数, 会话时长, 运行截止时间, 批次与 diff 预算, 每 PR 评论预算), 所以改这些上限必须同步该文档.

`cf-admin/pages/tsconfig.json` 在 paths 里把 `@hx/ui` 指到 `pages/src/vendor-ui.ts`, 让 `tsc` 不跟进 `@hx/ui` 整库源码 (erasableSyntaxOnly 与 noUnusedLocals 会扫到库内无关符号). Vite 另用 alias 指向真实组件入口.

新增一类"改了 X 就必须改文档 Y"的约束时, 在 links.json 加一项, 同时更新上表. 确实不需要改文档的特例, 按 hx-agent-code 基线流程把该 finding 写入 `scripts/quality/baseline.json` 并写明原因与批准人.

## 规则覆盖 (coverage.json)

`scripts/quality/coverage.json` 对 hx-agent-code 规则目录逐条记录 implemented, blocked 或 not-applicable 及证据. 当前 implemented: HC-CONTEXT, HC-BUDGET, HC-DOCNAME (由 context-l0 实现). 其余为 blocked 并写明缺什么 (checker, 探针或远程验证); blocked 不算通过. 把某条改为 implemented 时, 必须同时: 接入 ci.json 的任务, 提供正反例测试, 更新本文的组表或规则表.

## 变更时同步

| 你改了 | 同一次改动里还要改 |
|---|---|
| ci.json 的组, 任务或测试 ID | 本文 "各组验证什么" 与 "测试选择"; 新测试 ID 登记到 graph.ts |
| graph.ts 的模块或 global | 本文 "测试选择" |
| quality-*.yml 的触发或 job | 本文 "触发与工作流" |
| L0 规则, 等级或 `.hx-context-review.json` | 本文 "L0 规则", [report-contract.md](../report-contract.md) (等级变化), context-cr 测试 |
| coverage.json 状态 | 本文 "规则覆盖" |
| 新增被监视的约束 | links.json 与本文 "HX-DOCLINK 映射" |
| deploy-cf.yml 或 deploy.ts | [deploy-cf.md](../../tutorials/deploy-cf.md) |

## 六类测试工作流

`context-cr/src/local/suite/categories.ts` 是唯一类别清单. 每个类别有一个 `tests-<category>.yml`, 用 `workflow_call` 调用 `tests-category.yml`; `tests-all.yml` 聚合六个类别. 触发条件按类别: backend-api 与 build-compat 在 PR 与 main push 跑, frontend 两类只在 pages 变更时跑, e2e 只在 PR 带 `e2e` label 或夜间跑, perf 只在夜间与 `v*` tag 跑.

类别 runner 在 `test` 分支存在时把该分支 checkout 到 `.hx-tests`, 用 `--root .hx-tests --code-root . --base <ref>` 跑; 没有 test 分支时输出 notice 并跳过该类别, 不伪装成通过. 迁移历史检查只接受显式 `--base`, 不退回 `HEAD`, 所以已提交的迁移修改也能被发现.

## 已知限制

- 远程 GitHub Actions 上的四个 quality 工作流尚未在本仓库实际跑通前, HC-CI 保持 blocked.
- vendor 的 hx-agent-code 与 hx-agent-notes 不在本仓库修改, 其问题回到上游 HengXin666/HXLoLis 修复后重新 vendor.
- 端到端 (init -> publish 全链路) 目前用本地脚本验证, 未进入 CI.
