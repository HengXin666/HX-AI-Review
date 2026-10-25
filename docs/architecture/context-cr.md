# context-cr 设计

runner 侧 CLI. 入口 [context-cr/src/cli.ts](../../context-cr/src/cli.ts), 步骤实现 [context-cr/src/steps.ts](../../context-cr/src/steps.ts). 总体架构见 [overview.md](overview.md).

一次运行只跑一种 kind: `context` 审上下文文件是否还和代码一致, `code` 审 diff 本身有没有缺陷. 两者共用同一条流水线骨架与同一份报告契约, 只在阶段取舍, scope, 提示词, 规则命名空间与产物上分叉:

| | context CR | code CR |
|---|---|---|
| 阶段 | init -> L0 -> scope -> finder -> verifier -> publish | init -> scope -> finder -> verifier -> publish (没有 L0) |
| Error | 可能 (只来自 L0) | 不可能 (L0 不跑, AI 只出 Warning) |
| 补丁分支 | 可能推 | 永不推 |

L0 规则 (HC-*, CX-*) 判的是 "上下文文件是否与代码一致", 属于 context CR; 一次 code 运行让过期的 AGENTS.md 去 fail 一个审 diff 的 job 是两件事混淆, 而且那些发现会以 `kind=code` 入库, 污染代码 CR 的规则视图. 所以 `stepL0` 在 `config.kind === "code"` 时直接写空的 `l0.json` 并返回空数组 (仍然写文件, 让 publish 与 CLI 在两种 kind 下读到同形的状态). kind 的事实源是 `context-cr/src/contract/kind.ts`, 取舍原因见 [双模式决策](../decisions/2026-10-25-dual-cr-kind.md).

## 模块

| 模块 | 输入 | 输出 |
|---|---|---|
| `context-cr/src/init/client.ts` | HX_CTX_ENDPOINT, HX_CTX_TOKEN, HX_CTX_KIND, GITHUB_REPOSITORY, 可选 group | `InitConfig` (含 kind, 无 key, 含模型单价与可选 prompts 附录) + api_key |
| `context-cr/src/contract/kind.ts` | HX_CTX_KIND 或 /init 响应的 kind | `CrKind`; 缺省回退与非法值判定 |
| `context-cr/src/state.ts` | RUNNER_TEMP | 运行状态目录, key 文件 (0600, 读后即删), 运行 nonce |
| `context-cr/src/local/` | 工作区 diff, 基准 commit, 未跟踪文件 | 本地规则 `Finding[]`, `local-review.{md,json}` (kind 固定为 context) |
| `context-cr/src/local/suite/` | 六类测试清单, test 分支 overlay, 显式 `--base` | 每类别/层级的 `test-<category>-<tier>.{md,json}` |
| `context-cr/src/l0/` | 仓库快照 (git 跟踪文件), `.hx-context-review.json`, 可信 baseline | `Finding[]` |
| `context-cr/src/rules/` | 仓库快照, 配置, base 修订与豁免文件 | `Finding[]` + `rules.{md,json}` 报告 |
| `context-cr/src/scope/base.ts` | GitHub 事件, last_sha | 审核区间基点与原因 |
| `context-cr/src/scope/index.ts` | 快照, 变更列表, 可选引用索引提示 | `ContextScope` (`kind: "context"`) |
| `context-cr/src/scope/code.ts` | 每个变更文件的 diff | `CodeScope` (`kind: "code"`, 新增行的 hunk) |
| `context-cr/src/review/` | `InitConfig`, `ContextScope` 或 `CodeScope`, diff, `AgentRunner` | 确认后的 Warning, 补丁 (仅 context), 用量, 会话记录 |
| `context-cr/src/publish/` | 汇总报告 | POST /runs, 补丁分支 (仅 context), 评论 |

`context-cr/src/init/client.ts` 对可能让运行被误判为完整的字段失败关闭: `l0Only` 时缺失或未知的 `l0Cause` 按 `config` 处理 (不能与主动选择混淆, 否则该区间会被当成已审并推进 last_sha); 非 L0 响应缺少 `limits.maxRunUsd` 时报错, 只有显式 `null` 才表示无上限. `Review.session()` 只在开会话前检查已累计花费, 会话结束后才加上本次会话的花费, 所以达到 `maxRunUsd` 后不再启动新会话, 但单个会话仍可能使本次花费超过该值.

`/init` 的 `budgetClaim` 是本次运行的预算预留 id, 原样带回 `POST /runs`: 计费时只有持有者能释放该预留, 被拒绝预算而仍上报 L0 结果的运行不会解开别人的预留. 第一次模型会话前还会 `POST /spend` 标记该预留已开始花费: 只有标记过的预留被接管时才结算额度, 在安装/L0/scope 阶段就被取消的运行按 0 结算, 不会让同一分支的连续 push 各自烧掉整月预算. 标记失败会中止审查 (fail closed), 因为继续花一份 Worker 仍认为未花掉的预算, 一旦本运行被取消, 接管就会把同一份余额再发一次; 预留已被别的运行抢走时同样会拿到 409, 避免同一次运行被记两次账. 请求 `/init` 时带上 workflow 的 concurrency group (`HX_CTX_GROUP`), 同组中已被 GitHub 取消的旧运行的预留可被接管, 否则快速连续 push 时幸存的运行会被自己前一次运行的预留挡住而只跑 L0.

标记用 `Review` 上的 `spendMarked` / `spendRefused` 状态而不是会话序号: finder 批次失败时循环只 `continue`, 所以按 "第 0 个会话" 判断会让第二个批次和之后的 verifier 会话绕过标记直接花预算. 一旦标记失败, 之后每个会话都被拒绝, 整次运行记为 incomplete. 标记本身是有界的网络调用: 上限为 `min(SPEND_MARK_TIMEOUT_MS, 剩余审查时限)`, 超时即 abort 并按 fail closed 处理, 不会让一个连上却不返回的 `/spend` 把运行拖到 job 超时、连 publish 都跑不到; 标记返回后重新读取时限再算本次会话的时长上限, 否则等待标记的时间会让会话越过在等待前算好的时限.

因此 `review.yml` 的 review 步骤也要拿到 `HX_CTX_TOKEN` (之前只有 init 与 publish 步骤有): 少了它 `steps.ts` 不会注册 `onSpend`, 有预算的运行就从不发 `POST /spend`, 接管时按 0 结算, 连续取消的运行可以反复拿到整份月余额. fork 的 PR 依然进不到这一步 (job 级条件). 同理, `steps.ts` 在 `maxRunUsd` 非 null 却缺少 `budgetClaim`, `HX_CTX_ENDPOINT` 或 `HX_CTX_TOKEN` 时按配置错误失败关闭, 而不是开始一次没有标记的模型会话: endpoint 与 token 是环境配置, 由 `steps.ts` 校验; `context-cr/src/init/client.ts` 只拒绝非 L0 且 `maxRunUsd` 非 null 却缺少 `budgetClaim` 的 /init 响应, 它看不到环境变量.

本地模式 (`cli.ts local`) 只读工作区 diff, 基准优先用请求的 ref 与 HEAD 的 merge-base, 没有 common ancestor 时直接报错而不是退回分支最新提交; 仓库还没有首次提交时用空树, 并把未跟踪文件一起纳入. 循环检查要求循环包含变更文件且至少一条导入边在基准里不存在, 所以只改无关文件不会触发旧循环. 测试模式 (`cli.ts test`) 要求显式 `--base`, 未知类别或层级退出 2, 结果按共享 `ReviewReport` 契约写成 md 与 json 一对. 这两个子命令审的都是上下文文件, 报告里的 kind 固定写 `context`.

快照只看 git 跟踪的文件, 所以 runner 在工作区里 checkout 的工具目录不会被当成被审内容. 运行状态 (init, l0, scope, ai, 会话) 放在 `RUNNER_TEMP` 下而不是被审仓库里, init 每次清空并生成 nonce; publish 只采用带同一 nonce 的 AI 结果, PR 无法通过提交文件伪造发现或补丁.

## kind 维度

kind 出现在四处, 语义一致, 一次运行只跑一种:

| 位置 | 取值 | 缺省 |
|---|---|---|
| 调用方 workflow 的 `kind` 输入 | `context` 或 `code` | `context` |
| `GET /init?kind=` | `context` 或 `code` | 仓库只服务 code 时取 code, 否则 context |
| `repos.kind` (D1) | `context`, `code`, `both` | `context` |
| `runs.kind` / `findings.kind` (D1) | `context` 或 `code` | `context`; 发现从所属运行继承 |

runner 侧的三条规则:

- `HX_CTX_KIND` 来自 workflow 的 `kind` 输入, `cli.ts --kind` 是同一入口 (本地运行没有 /init, 它是唯一来源). 值非法时在第一次网络调用之前就报错: 猜一个值会跑错审查对象, 却照样上报一个总览页会相信的状态.
- `/init` 响应里的 `kind` 优先, 因为 Worker 知道仓库默认值. 只有响应缺这个字段时才回退到本次请求的 kind, 而不是固定回退到 `context`; 否则旧 Worker 会把一次 code 请求悄悄跑成 context CR.
- `scope.json` 带 kind. review 步发现 scope 的 kind 与配置不一致时直接失败关闭 (错误信息为 `a <scope> scope cannot be reviewed as <config>`), 不调用任何模型: 用另一套提示词与规则审这份 scope, 会把上下文发现记成代码缺陷.

`review.yml` 的第 4 步在文件里仍叫 `4 context_scope`, 但它按 kind 分派: context 走 `computeScope`, code 走 `computeCodeScope`, 输出 `empty` 的含义也随之变成 "没有上下文文件" 或 "没有可报的新增行". 步骤名是历史包袱, 改它会让已有运行日志与文档对不上, 所以先留名不改行为.

L0 (第 3 步) 只在 context 运行里真正执行, 见上表. 规则引擎 (第 3b 步, ARCH/STYLE/DOC/CTX/CI) 是仓库级确定性检查, 不看 kind, 两种运行都会跑, 所以一次 code job 仍可能因为 `ARCH-001` 之类的仓库规则变红; 那是代码结构问题, 与 "上下文是否过时" 不是一回事. 上报时 L0 发现 (code 下为空) 与该运行的 AI 发现一并入库, 记在该运行的 kind 下; `last_sha` 只由 context 运行推进, 因为它是 "上下文已审到哪" 的游标.

## 审核区间

`resolveBase` 按顺序取第一个可用的基点:

1. PR: `merge-base(pull_request.base.sha, head)`.
2. last_sha: D1 里上次成功入库的 head, 必须是当前 head 的祖先.
3. push 事件的 `before`, 必须可达且是祖先 (force push 后不可达).
4. `origin/<default_branch>` 与 head 的 merge-base.
5. 空树 (首个提交).

[review.yml](../../.github/workflows/review.yml) 的 publish 步骤只要 init 成功且运行未被取消就执行. 被 concurrency 取消的运行不执行 publish, 不会入库. scope 或 review 失败, 没跑完时 publish 仍把 L0 结果入库, 但发送 `complete: false`, 运行状态记为 `incomplete` (L0 有阻断 Error 时为 failed), Worker 不推进 last_sha; 下一次运行会覆盖这段区间. 审查 agent 的会话失败, 运行预算或运行时限用尽, 以及 `/init` 因预算 (`l0Cause: budget`) 或配置问题 (`l0Cause: config`) 只下发 L0 时, 同样发送 `complete: false`; 仓库被停用或设为 l0 模式属于主动选择, 照常推进. 只有 event 为 push 的完整 context 运行推进 last_sha.

来自 fork 的 PR 对 pull_request 与 pull_request_target 都在 job 条件里跳过, 不在带 HX_CTX_TOKEN 与写权限的流程里检出不受信任的代码.

`kind` 输入同时进入三处: `GET /init` 的 `kind` 参数, `HX_CTX_KIND` 环境变量, 以及 concurrency group 的组名. 组名是 `hx-context-review-<kind>-<repo>-<ref>`, 同一个值也作为 `HX_CTX_GROUP` 发给 /init, 所以同一仓库的 context job 与 code job 互不取消, 各自串行与防抖; 而预算预留按组接管, 不同组之间是真正的并发, 仍然互斥, 两种 CR 争的是同一份月预算. 想两种 CR 都跑就在调用方写两个 job, 各传一个 kind, 见 [接入教程](../tutorials/onboard-repo.md).

## L0 规则

| ID | 等级 | 判据 |
|---|---|---|
| HC-CONTEXT | Error | 每处 README.md 与 AGENTS.md 双向配对; AGENTS 少于 150 行且少于 16384 bytes |
| HC-BUDGET | Error | 每个文件所在目录: 祖先 AGENTS 字节和 + skill 注入上界不超过 65536 |
| HC-DOCNAME | Error | docs 下小写 kebab, 扩展名 md/mdx/yaml, 禁 v2/final/copy/bak/tmp/draft, 日期前缀只在 decisions |
| CX-DEADREF | Error / Warning | markdown 链接指向不存在路径为 Error; 反引号路径不存在为 Warning (可能指生成物或别的项目) |
| CX-SKILL | Error | SKILL.md 有 front matter, name 等于目录名, description 非空 |
| CX-ORPHAN | Warning | docs 下的文档没有被任何上下文文件引用 |

skill 注入上界 = 所有 skill 的 front matter (常驻 L1) + 最大的 `concurrentSkills` 个 SKILL.md 正文 (同时加载的 L2). 未知时按保守上界计算, 不当作 0.

引用解析顺序: 相对所在文件, 相对仓库根, 相对所在 skill 根. 代码块 (``` 围栏) 内的内容不算引用.

## 规则引擎 (rules)

`cli.ts rules` 是 review.yml 的第 3b 步, 调用 `context-cr/src/rules/run.ts`, 在 L0 之外再跑一组确定性规则. 结果写到 `scripts/.hx_code_quality/reports/rules.{md,json}` 和只列 Warning 的 `scripts/.hx_code_quality/reports/rules-pending-review.md`; workflow 的 rules 步骤 continue-on-error 以便报告先落盘并随同一份 artifact 上传, 随后单独一步在仍有未豁免 Error 时让 job 失败, 所以规则既产出报告, 也真正参与门禁.

| ID | 等级 | 判据 |
|---|---|---|
| ARCH-001 | Error | 有 impl/ 的模块暴露公共入口, 其他模块只导入该入口 |
| ARCH-002 | Error | 目录导入图无环 |
| ARCH-003 | Warning | 每目录最多 6 个文件; 混用语言时升为 Error |
| ARCH-004 | Error | 接口层不导入数据源包, 不直接写 SQL |
| STYLE-003 | Error | 文件头注释不超过 10 行, 注释只用 ASCII 标点且无 emoji |
| STYLE-004 | Warning | 基线中没有的新依赖需要人工决策 |
| DOC-001 | Error | 文档相对链接指向已跟踪文件或目录 |
| CTX-001 | Error | AGENTS.md 少于 150 行与 16KB, 单个一级标题, 无标题跳级, 有配对 README |
| CTX-002 | Error | SKILL.md 有 front matter 与匹配的 name, description, 正文有标题 |
| CI-001 | Error | 工作流保留下 on: 与 jobs:, 调用的脚本, 包与工作流都存在 |

豁免只认 base: 根目录豁免文件里只有与 base 版本逐字段一致的条目才能让发现保持 exempt; 工作区新增或修改的条目按 expired 处理, 对应 Error 照常阻断, 改动豁免文件本身还会产出 EXEMPT-001 Warning 交人工确认. base 解析失败时改用空树计算变更, 所有豁免按 expired 处理, 并产出阻断级 tool-error, 不允许在无法判断变更时放行.

## context_scope

对每个变更路径 (改名同时看新旧名, 删除也算):

- 路径本身是上下文文件 -> 纳入.
- 从仓库根到它所在目录的每一级 AGENTS.md -> 纳入 (祖先链).
- 任何上下文文件引用了该路径, 或引用了它的某一级父目录 -> 纳入 (反向引用).
- 路径是 AGENTS.md -> 其目录下所有后代 AGENTS.md 纳入.

`scopeIgnore` (默认锁文件) 与 `exclude` 中的路径不拉入上下文. 结果为空时 review 步骤被跳过.

## code_scope

`context-cr/src/scope/code.ts` 的 `computeCodeScope` 只在 kind 为 `code` 时使用, 同样只读 git, 不调模型:

- 逐个变更文件取其 diff. 路径来自 NUL 安全的变更列表, 不从 diff 头里解析, 所以带引号或非 ASCII 的路径不会被读错.
- 每个文件按 `@@ -a,b +c,d @@` 切成 hunk. 新增行与上下文行按新文件行号编号; 删除行不编号 (它在被审的新文件里没有位置, 因此永远不能被报告); `\ No newline at end of file` 保留但不编号, 也不结束当前 hunk.
- 只保留至少有一个新增行的 hunk: 纯删除的 hunk 没有可报的位置. 删除文件与二进制补丁不产生 hunk.
- `scopeIgnore` 与 `exclude` 中的路径跳过. 结果为空 (diff 里没有新增行) 时 review 步骤被跳过.
- 每个 `CodeHunk` 带 `path`, `header`, 带新侧行号的 `body`, 以及新增行的行号集合 `lines`. `lines` 是确定性闸门的依据: 报一条 diff 没碰过的行会被拒.

## finder -> verifier

审查 agent 的完整设计 (角色分工, 输入, 闸门, 上限, 失败语义, 评估) 见 [agent-review.md](agent-review.md). 这里只记实现落点:

- 编排在 `context-cr/src/review/index.ts`, 只依赖 `AgentRunner` 端口; `context-cr/src/review/pi.ts` 用 pi SDK 实现该端口, 并负责每会话的轮数与时长上限.
- `runReview` 按 scope 的 kind 分派到 `runContextReview` 或 `runCodeReview`; kind 与 scope 不一致时失败关闭, 一次模型会话都不开.
- 两套提示词: context 用 `FINDER_SYSTEM` / `VERIFIER_SYSTEM`, code 用 `CODE_FINDER_SYSTEM` / `CODE_VERIFIER_SYSTEM`. 操作者附录 (`prompts.finder` / `prompts.verifier`) 对两套都生效, 都不能提高等级.
- 分批: context 按带行号的正文 (`batchDocs`) 用 `budgets.doc` 计, code 按 hunk 的 header 加 body (`batchHunks`) 用 `budgets.diff` 计. code 不把整份 diff 塞进提示词, hunk 本身就是 diff, 所以 `steps.ts` 给 code 传空 diff.
- `report_finding` 在 code 下没有 `patch` 参数: 代码 CR 只给建议文本, 不产补丁, 也就不可能推送分支. 拒掉这个字段是为了不让模型把轮次花在写一份注定被丢弃的补丁上.
- 确定性闸门也分两套: context 要求 path 是本批的上下文文件且行号存在 (`gate`); code 要求 path 属于本批且 line 是本批某个 hunk 的新增行 (`gateCode`). 抑制表与去重两边一致.
- `steps.ts` 的 review 步在开会话前调用 `buildEvidencePack` (调用图, 引用方, 最近相关 PR/issue). 失败只记日志, 不把运行标成 incomplete.
- `/init` 可带 `prompts.finder` / `prompts.verifier` (`{ version, body }` 或 null). 缺失整个 `prompts` 字段时按旧 Worker 处理; 字段在但形状不对则解析失败. 非空 body 追加到对应系统提示, 不替换内置提示.
- pi 会话: `ModelRuntime.registerProvider` 注册 api_url 为自定义 provider, `setRuntimeApiKey` 注入 key; `createAgentSession` 使用内存 SessionManager 与 SettingsManager, 自定义 ResourceLoader 不加载任何 AGENTS, skill 或 extension.
- 上下文文件正文用 `git show HEAD:<path>` 从被审提交读取, 符号链接与 `.git` 下的路径不读 (`context-cr/src/review/context.ts` 负责编号, 分批, 摘录).
- 被审仓库的 checkout 设置 `persist-credentials: false`, .git 目录的 config 里没有 token; 推补丁分支时 publish 只为那一条 `git push` 通过 `GIT_CONFIG_*` 环境变量注入 GITHUB_TOKEN.
- 用量取 `session.getSessionStats()` 的 tokens 与 cost, 会话消息以 JSONL 入 R2.
- review 结果带 `complete`; 会话失败或运行预算用尽时为 false, publish 据此发送 `complete: false`.
- `steps.ts` 的 `stages.ai` 把未审文件逐条列出并自带原因 (不可读或符号链接, 候选数上限, 提示词超出窗口); code 运行列的是未审的 hunk 路径. 该阶段时长上限按 workflow 传入的 `HX_CTX_STARTED_AT` 扣除前置步骤耗时.

## 回写

- 报告: `scripts/.hx_code_quality/reports/context-review.{md,json}`, 超过 10 条只列数量与类型. 报告带 `kind`, Markdown 开头写明这次审的是哪一种.
- 补丁分支: 只有 context 运行会推. 只收 verifier 判 correct, 且是单个已有文件的纯文本修改 (不含新建, 删除, 改权限, 改名, 二进制) 的补丁. `hx-ctx/patch-<head 前 12 位>`, 以 head 为基, 提交者 hx-context-review, `--force` 推送, 不碰被审分支. 互相冲突的补丁逐个跳过; 推送失败只记录日志, 不影响入库与评论. code 运行即使某个候选带了补丁也不会推: `stepPublish` 在 `config.kind === "code"` 时跳过整个推送步骤.
- 评论: push 发 commit comment; PR 找到带 `<!-- hx-context-review -->` 标记的评论就更新, 否则新建. `POST /runs` 返回的 `resolved` 大于 0 时, 评论注明本 PR 上有多少条更早的发现被标成 resolved.
