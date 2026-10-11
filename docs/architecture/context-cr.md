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

快照只看 git 跟踪的文件, 所以 runner 在工作区里 checkout 的工具目录不会被当成被审内容. 运行状态 (init, l0, scope, ai, 会话) 放在 `RUNNER_TEMP` 下而不是被审仓库里, init 每次清空并生成 nonce; publish 只采用带同一 nonce 的 AI 结果, PR 无法通过提交文件伪造发现或补丁.

## 审核区间

`resolveBase` 按顺序取第一个可用的基点:

1. PR: `merge-base(pull_request.base.sha, head)`.
2. last_sha: D1 里上次成功入库的 head, 必须是当前 head 的祖先.
3. push 事件的 `before`, 必须可达且是祖先 (force push 后不可达).
4. `origin/<default_branch>` 与 head 的 merge-base.
5. 空树 (首个提交).

[review.yml](../../.github/workflows/review.yml) 的 publish 步骤只要 init 成功且运行未被取消就执行. 被 concurrency 取消的运行不执行 publish, 不会入库. scope 或 review 失败, 没跑完时 publish 仍把 L0 结果入库, 但发送 `complete: false`, 运行状态记为 `incomplete` (L0 有阻断 Error 时为 failed), Worker 不推进 last_sha; 下一次运行会覆盖这段区间. 只有 event 为 push 的完整运行推进 last_sha.

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

- 编排在 `context-cr/src/review/index.ts`, 只依赖 `AgentRunner` 端口; `context-cr/src/review/pi.ts` 用 pi SDK 实现该端口.
- pi 会话: `ModelRuntime.registerProvider` 注册 api_url 为自定义 provider, `setRuntimeApiKey` 注入 key; `createAgentSession` 使用内存 SessionManager 与 SettingsManager, 自定义 ResourceLoader 不加载任何 AGENTS, skill 或 extension.
- 工具: 只读内置工具 `read`, `grep`, `find`, `ls`, 加上 `report_finding` (finder) 或 `report_verdict` (verifier).
- finder 提示词包含区间, 变更路径, 范围内上下文文件及原因, 抑制表 (含驳回原因), 截断后的 diff.
- 候选若不在范围内, 或指纹在抑制表里, 直接丢弃, 不调用 verifier.
- 模型单价 (每百万 token 美元) 由 /init 下发并注册到 pi 模型上, 会话统计的 cost 才是真实值; Worker 入库时还会按 token 数与单价复算, 取两者较大值计入月预算.
- verifier 每个候选一个新会话, 以反驳为目标; 没有调用 report_verdict 视为驳回.
- 保留的发现一律 Warning, ruleId `CX-AI`, 指纹为 `CX-AI + path + title`, 以便反馈跨运行生效.
- 补丁用 `git apply --check --numstat` 校验, 只改动被报告的那一个上下文文件且能应用才标记为可用; 其他补丁保留在报告里但不推送.
- 用量取 `session.getSessionStats()` 的 tokens 与 cost, 会话消息以 JSONL 入 R2.

## 回写

- 报告: `scripts/.hx_code_quality/reports/context-review.{md,json}`, 超过 10 条只列数量与类型.
- 补丁分支: `hx-ctx/patch-<head 前 12 位>`, 以 head 为基, 提交者 hx-context-review, `--force` 推送, 不碰被审分支. 互相冲突的补丁逐个跳过; 推送失败只记录日志, 不影响入库与评论.
- 评论: push 发 commit comment; PR 找到带 `<!-- hx-context-review -->` 标记的评论就更新, 否则新建.
