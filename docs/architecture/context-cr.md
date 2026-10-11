# context-cr 设计

runner 侧 CLI. 入口 [context-cr/src/cli.ts](../../context-cr/src/cli.ts), 步骤实现 [context-cr/src/steps.ts](../../context-cr/src/steps.ts). 总体架构见 [overview.md](overview.md).

## 模块

| 模块 | 输入 | 输出 |
|---|---|---|
| `context-cr/src/init/client.ts` | HX_CTX_ENDPOINT, HX_CTX_TOKEN, GITHUB_REPOSITORY | `InitConfig` (无 key, 含模型单价) + api_key |
| `context-cr/src/state.ts` | RUNNER_TEMP | 运行状态目录, key 文件 (0600, 读后即删), 运行 nonce |
| `context-cr/src/l0/` | 仓库快照 (git 跟踪文件), `.hx-context-review.json`, 可信 baseline | `Finding[]` |
| `context-cr/src/scope/base.ts` | GitHub 事件, last_sha | 审核区间基点与原因 |
| `context-cr/src/scope/index.ts` | 快照, 变更列表, 可选引用索引提示 | `ContextScope` |
| `context-cr/src/review/` | `InitConfig`, `ContextScope`, diff, `AgentRunner` | 确认后的 Warning, 补丁, 用量, 会话记录 |
| `context-cr/src/publish/` | 汇总报告 | POST /runs, 补丁分支, 评论 |

`context-cr/src/init/client.ts` 对可能让运行被误判为完整的字段失败关闭: `l0Only` 时缺失或未知的 `l0Cause` 按 `config` 处理 (不能与主动选择混淆, 否则该区间会被当成已审并推进 last_sha); 非 L0 响应缺少 `limits.maxRunUsd` 时报错, 只有显式 `null` 才表示无上限. `Review.session()` 只在开会话前检查已累计花费, 会话结束后才加上本次会话的花费, 所以达到 `maxRunUsd` 后不再启动新会话, 但单个会话仍可能使本次花费超过该值.

`/init` 的 `budgetClaim` 是本次运行的预算预留 id, 原样带回 `POST /runs`: 计费时只有持有者能释放该预留, 被拒绝预算而仍上报 L0 结果的运行不会解开别人的预留. 第一次模型会话前还会 `POST /spend` 标记该预留已开始花费: 只有标记过的预留被接管时才结算额度, 在安装/L0/scope 阶段就被取消的运行按 0 结算, 不会让同一分支的连续 push 各自烧掉整月预算. 标记失败会中止审查 (fail closed), 因为继续花一份 Worker 仍认为未花掉的预算, 一旦本运行被取消, 接管就会把同一份余额再发一次; 预留已被别的运行抢走时同样会拿到 409, 避免同一次运行被记两次账. 请求 `/init` 时带上 workflow 的 concurrency group (`HX_CTX_GROUP`), 同组中已被 GitHub 取消的旧运行的预留可被接管, 否则快速连续 push 时幸存的运行会被自己前一次运行的预留挡住而只跑 L0.

标记用 `Review` 上的 `spendMarked` / `spendRefused` 状态而不是会话序号: finder 批次失败时循环只 `continue`, 所以按 "第 0 个会话" 判断会让第二个批次和之后的 verifier 会话绕过标记直接花预算. 一旦标记失败, 之后每个会话都被拒绝, 整次运行记为 incomplete. 标记本身是有界的网络调用: 上限为 `min(SPEND_MARK_TIMEOUT_MS, 剩余审查时限)`, 超时即 abort 并按 fail closed 处理, 不会让一个连上却不返回的 `/spend` 把运行拖到 job 超时、连 publish 都跑不到; 标记返回后重新读取时限再算本次会话的时长上限, 否则等待标记的时间会让会话越过在等待前算好的时限.

因此 `review.yml` 的 review 步骤也要拿到 `HX_CTX_TOKEN` (之前只有 init 与 publish 步骤有): 少了它 `steps.ts` 不会注册 `onSpend`, 有预算的运行就从不发 `POST /spend`, 接管时按 0 结算, 连续取消的运行可以反复拿到整份月余额. fork 的 PR 依然进不到这一步 (job 级条件). 同理, `steps.ts` 在 `maxRunUsd` 非 null 却缺少 `budgetClaim`, `HX_CTX_ENDPOINT` 或 `HX_CTX_TOKEN` 时按配置错误失败关闭, `context-cr/src/init/client.ts` 也会拒绝这种 /init 响应, 而不是开始一次没有标记的模型会话.

快照只看 git 跟踪的文件, 所以 runner 在工作区里 checkout 的工具目录不会被当成被审内容. 运行状态 (init, l0, scope, ai, 会话) 放在 `RUNNER_TEMP` 下而不是被审仓库里, init 每次清空并生成 nonce; publish 只采用带同一 nonce 的 AI 结果, PR 无法通过提交文件伪造发现或补丁.

## 审核区间

`resolveBase` 按顺序取第一个可用的基点:

1. PR: `merge-base(pull_request.base.sha, head)`.
2. last_sha: D1 里上次成功入库的 head, 必须是当前 head 的祖先.
3. push 事件的 `before`, 必须可达且是祖先 (force push 后不可达).
4. `origin/<default_branch>` 与 head 的 merge-base.
5. 空树 (首个提交).

[review.yml](../../.github/workflows/review.yml) 的 publish 步骤只要 init 成功且运行未被取消就执行. 被 concurrency 取消的运行不执行 publish, 不会入库. scope 或 review 失败, 没跑完时 publish 仍把 L0 结果入库, 但发送 `complete: false`, 运行状态记为 `incomplete` (L0 有阻断 Error 时为 failed), Worker 不推进 last_sha; 下一次运行会覆盖这段区间. 审查 agent 的会话失败, 运行预算或运行时限用尽, 以及 `/init` 因预算 (`l0Cause: budget`) 或配置问题 (`l0Cause: config`) 只下发 L0 时, 同样发送 `complete: false`; 仓库被停用或设为 l0 模式属于主动选择, 照常推进. 只有 event 为 push 的完整运行推进 last_sha.

来自 fork 的 PR 对 pull_request 与 pull_request_target 都在 job 条件里跳过, 不在带 HX_CTX_TOKEN 与写权限的流程里检出不受信任的代码.

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

## context_scope

对每个变更路径 (改名同时看新旧名, 删除也算):

- 路径本身是上下文文件 -> 纳入.
- 从仓库根到它所在目录的每一级 AGENTS.md -> 纳入 (祖先链).
- 任何上下文文件引用了该路径, 或引用了它的某一级父目录 -> 纳入 (反向引用).
- 路径是 AGENTS.md -> 其目录下所有后代 AGENTS.md 纳入.

`scopeIgnore` (默认锁文件) 与 `exclude` 中的路径不拉入上下文. 结果为空时 review 步骤被跳过.

## finder -> verifier

审查 agent 的完整设计 (角色分工, 输入, 闸门, 上限, 失败语义, 评估) 见 [agent-review.md](agent-review.md). 这里只记实现落点:

- 编排在 `context-cr/src/review/index.ts`, 只依赖 `AgentRunner` 端口; `context-cr/src/review/pi.ts` 用 pi SDK 实现该端口, 并负责每会话的轮数与时长上限.
- pi 会话: `ModelRuntime.registerProvider` 注册 api_url 为自定义 provider, `setRuntimeApiKey` 注入 key; `createAgentSession` 使用内存 SessionManager 与 SettingsManager, 自定义 ResourceLoader 不加载任何 AGENTS, skill 或 extension.
- 上下文文件正文用 `git show HEAD:<path>` 从被审提交读取, 符号链接与 `.git` 下的路径不读 (`context-cr/src/review/context.ts` 负责编号, 分批, 摘录).
- 被审仓库的 checkout 设置 `persist-credentials: false`, .git 目录的 config 里没有 token; 推补丁分支时 publish 只为那一条 `git push` 通过 `GIT_CONFIG_*` 环境变量注入 GITHUB_TOKEN.
- 用量取 `session.getSessionStats()` 的 tokens 与 cost, 会话消息以 JSONL 入 R2.
- review 结果带 `complete`; 会话失败或运行预算用尽时为 false, publish 据此发送 `complete: false`.
- `steps.ts` 的 `stages.ai` 把未审文件逐条列出并自带原因 (不可读或符号链接, 候选数上限), 不再统一标注为 candidate limit; 该阶段时长上限按 workflow 传入的 `HX_CTX_STARTED_AT` 扣除前置步骤耗时.

## 回写

- 报告: `scripts/.hx_code_quality/reports/context-review.{md,json}`, 超过 10 条只列数量与类型.
- 补丁分支: 只收 verifier 判 correct, 且是单个已有文件的纯文本修改 (不含新建, 删除, 改权限, 改名, 二进制) 的补丁. `hx-ctx/patch-<head 前 12 位>`, 以 head 为基, 提交者 hx-context-review, `--force` 推送, 不碰被审分支. 互相冲突的补丁逐个跳过; 推送失败只记录日志, 不影响入库与评论.
- 评论: push 发 commit comment; PR 找到带 `<!-- hx-context-review -->` 标记的评论就更新, 否则新建.
