# AI 审查 agent 设计

本文说明 runner 第 5 步 (pi finder -> verifier) 怎么审查: 审什么, 给模型看什么, 两个角色怎么分工, 哪些环节是确定性的, 有哪些上限, 失败时怎么处理, 以及怎么判断它审得好不好. 代码在 `context-cr/src/review/` 与 `context-cr/src/scope/`; 改这两处必须在同一次改动里更新本文 (HX-DOCLINK 强制). 整体链路见 [overview.md](overview.md), runner 各步见 [context-cr.md](context-cr.md).

AI 阶段有两种模式, 由本次运行的 kind 决定, 一次只跑一种:

| | context CR | code CR |
|---|---|---|
| 审什么 | 上下文文件是否被本次 diff 变成错的 | diff 新增或修改的行本身是否有缺陷 |
| scope | 祖先 AGENTS 链与反向引用 (`context-cr/src/scope/index.ts`) | diff 的新增行, 删除行, 以及删除所暴露的上下文行 (`context-cr/src/scope/code.ts`) |
| 系统提示 | `FINDER_SYSTEM` / `VERIFIER_SYSTEM` | `CODE_FINDER_SYSTEM` / `CODE_VERIFIER_SYSTEM` |
| 规则 | `CX-AI` | `CODE-AI` |
| 产物 | Warning + 补丁 (可能推送) | 只有 Warning 与建议文本, 永不推送 |

取舍原因见 [双模式决策](../decisions/2026-10-25-dual-cr-kind.md).

## 目标与边界

- context CR 的目标: 找出上下文文件 (AGENTS.md, README.md, SKILL.md, `docs/` 下的 markdown) 中被本次 diff 变成错误, 过期或误导的陈述, 并在修法确定时给出只改该文件的补丁.
- code CR 的目标: 找出本次 diff 新增, 删除, 或被删除所暴露的行里真实存在的缺陷, 并说清触发它的输入, 状态或时序. 它只报能被代码证实的问题: 逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界, 与既有设计相悖, 以及实现偏离 PR 标题, 正文, 关联 issue 或提交说明 (意图漂移).
- 读者假设: context CR 的读者是动手前读上下文的编码 agent, 判断标准是 "照着这句话做的 agent 会不会被误导"; code CR 的读者是审这次改动的维护者, 判断标准是 "合入前是否必须改".
- 不做: context CR 不审代码本身的 bug; code CR 不报纯风格, 命名, 格式, 导入顺序, 缺测试, 两种同样正确的写法之间的偏好, 以及本次 diff 之前就存在的问题. 两者都不产出 Error. Error 只来自 L0 确定性检查 (见 [report-contract.md](../reference/report-contract.md)); AI 只产出 Warning (context CR 另可产出补丁), 不阻断合并.
- 等级后果: L0 只存在于 context CR (`stepL0` 在 `kind === "code"` 时直接返回空), 所以 code CR 整条链上没有 Error 的来源, 一次代码 CR 永远不可能让 job 因为 AI 结论变红. 这是有意的: 代码改动的严重程度需要人判断, 自动阻断留给上下文规则与仓库规则引擎.
- 精度优先于召回: 误报会消耗维护者注意力并让人忽略整个工具, 所以每条候选都要经过确定性闸门和独立 verifier 两道过滤.
- 确定性规则引擎 (ARCH, STYLE, DOC, CTX, CI) 与豁免审核警告 EXEMPT-001 不属于本文的 AI 流程, 也不由模型产出; 它们的判据, 豁免信任与门禁见 [context-cr.md](context-cr.md) 的规则引擎一节.

## 流水线

`runReview` 先检查 scope 的 kind 与 `InitConfig.kind` 是否一致, 不一致就失败关闭 (错误信息 `a <scope> scope cannot be reviewed as <config>`), 一次模型会话都不开: 用另一套提示词与规则审这份 scope, 会把上下文发现记成代码缺陷. 一致时按 kind 分派.

context CR:

```text
scope (确定性)            哪些上下文文件可能受影响; 为空则 0 次模型调用
  -> 分批 (确定性)        按字节预算把上下文文件分成若干批
  -> finder x N (模型)    每批一个会话, 只读工具 + report_finding
  -> 闸门 (确定性)        在 report_finding 内即时判定: 文件属于本批, 行号存在, 未被抑制, 不重复
  -> verifier x M (模型)  每条候选一个全新会话, 尝试反驳, report_verdict
  -> 补丁闸门 (确定性)    verifier 判 correct 且 git apply --check 只触及该文件
  -> Warning + 补丁
```

code CR:

```text
scope (确定性)            diff -> 有新增或删除的 hunk; 两者都没有则 0 次模型调用
  -> 意图卡 (确定性)      PR 标题/正文, 关联 issue, 区间内提交说明; 取不到就空卡, 审查继续
  -> 分组组装 (确定性)    同一文件的 hunk 收成一组; 再按字节预算把组分批, 超预算的文件才按 hunk 切开
  -> finder x N (模型)    每批一个会话, 只读工具 + report_finding (无 patch 字段); 提示词里是这批 diff 和意图卡
  -> 闸门 (确定性)        path 属于本批, 且 line 是新增行, 删除行 (side left) 或删除所暴露的上下文行;
                          证据里的反引号引用必须出现在 hunk 或被审文件里;
                          标题/说明/证据若要求读者确认、回答或检查上下文是否正确, 直接驳回;
                          非法的 grade / category / confidence 直接驳回
  -> verifier x M (模型)  每条候选一个全新会话, 尝试反驳, 并且必须自己核对证据和意图卡
  -> 证据再核 (确定性)    verifier 判 confirmed 之后再核一次引用是否真的在 diff/文件里, 以及理由有没有把判断推给读者
  -> 评论预算 (确定性)    按 critical > major > minor > nit 保留最多 5 条; 有更高档时丢掉全部 nit
  -> Warning (CODE-AI), 无补丁. grade 只用于排序, 不改变 Warning, 不让 job 变红
  -> PR                   进度评论随分组/分块/校验更新; 确认项写到 diff 行, 删除行用 LEFT
```

### 1. scope: 审哪些文件

`computeScope` 只用 git 与文件树, 不调模型:

- 审查区间: PR 用与 base 的 merge-base; push 优先用 D1 里的 last_sha (是 head 的祖先时), 否则用事件的 before, 再否则默认分支 merge-base, 都没有时以空树为基 (`context-cr/src/scope/base.ts`). `/init` 只对 context 运行下发 `lastSha`, code 运行拿不到这个游标也不推进它.
- 对每个变更路径 (改名时新旧路径都算, 忽略 lockfile 等 `scopeIgnore`): 变更的上下文文件本身; 所有祖先目录的 AGENTS.md; 通过链接或反引号路径引用了该文件或其祖先目录的上下文文件 (反向引用索引, 由 runner 在 checkout 上现建, 不依赖 Worker 下发); 变更的 AGENTS.md 的所有后代 AGENTS.md.
- 每个入选文件带上入选原因 (例如 `ancestor of api/user.ts`), 原因会进入 finder 提示词, 帮模型知道该看哪部分.
- `exclude` 中的路径 (vendor 内容) 不进 scope. scope 为空时本次运行直接结束, 0 次模型调用.

`computeCodeScope` 同样只读 git:

- 逐个变更文件取其 diff, 路径来自 NUL 安全的变更列表, 不从 diff 头解析, 所以带引号或非 ASCII 的路径不会被读错.
- 每个文件按 `@@` 头切成 hunk. 新增行与上下文行按新文件行号编号. 删除行没有新侧行号, 改用旧侧行号, 在正文里写成 `L<old>` (L12 是旧文件第 12 行). `\ No newline at end of file` 保留但不编号也不结束 hunk.
- 保留至少有一个新增行或一个删除行的 hunk. 纯删除的 hunk 和被删除的文件都留下, 报告锚在旧侧行号, 行评用 `side: LEFT`. 二进制补丁没有 hunk 头, 仍然不产生 hunk. `scopeIgnore` 与 `exclude` 中的路径跳过.
- 每个 `CodeHunk` 带 `path`, `header`, `body`, 新增行集合 `lines`, 删除行集合 `removed`, 以及 `exposed`: 同一个 hunk 里既有删除、又没被改动的上下文行的新侧行号. 闸门只接受这三类位置. 纯新增 hunk 里的上下文行仍然不能报, 避免把没被这次 diff 碰到的行开成评论位.

### 2. 分批

整份提示词必须放进模型上下文窗口: 可用总额 = 上下文窗口 - 输出预留 (`maxTokens`) - 提示词预留 (`PROMPT_RESERVE_BYTES`).

context CR 的总额再分给 diff (上限 `DIFF_MAX_BYTES` 60000, 下限 `MIN_DIFF_BYTES` 4000) 与上下文正文 (上限 `CONTEXT_BATCH_BYTES` 40000, 下限 `MIN_BATCH_BYTES` 4000). 所以每个 finder 会话看到的上下文正文取 `min(40000, 总额 - diff 预算)`, 按带行号前缀后的实际显示字节计算; 超出时贪心切成多批, 每批一个 finder 会话.

code CR 不单独给 diff 留额度: hunk 本身就是 diff, 不再把整份 diff 塞进提示词 (`steps.ts` 给 code 运行传空 diff). 分组 (`assembleFileGroups`) 先按路径把同一文件的 hunk 收成一组, 再按 `header + body` 的实际显示字节把整组装进批次 (`batchGroups`), 额度与 context 的 diff 相同 (`budgets.diff`). 一组自己就超过额度时才按 hunk 切开, 并且不会和别的文件混进同一批. 单个组的显示上限从 `budgets.doc` 起按渲染后的提示词余量收缩, 所以一个超长 hunk 只会被截断显示, 不会挤掉同批其他组; 被截掉的部分模型可用 read 工具读. 组号, 路径, 新增行号和 hunk 正文都进 finder 提示词, 也进 PR 评论和总览报告, 所以外面看得到审的是哪一段 diff, 而不是只看到一句概述.

窗口连 `MIN_PROMPT_BYTES` 都放不下时不再抬高预算 (抬高只会让会话因上下文溢出而失败), 而是按 config 报错: 该区间记为未审, 运行 incomplete, last_sha 不推进.

分批与 diff 预算都是名义值, 文件标题, 围栏与固定说明不占其中额度, 所以提示词按渲染后的实际字节测量并逐次收缩到真正放得下为止; verifier 的提示词同理 (候选声明, 补丁与摘录本身没有上限, 按固定一半切 diff 会让小窗口溢出, 每个 verifier 会话都失败).

收缩只能作用于 diff 与上下文正文 (code 下是 hunk 正文): 变更路径列表, 抑制表与每文件标题不受预算约束, 超长时仍会撑破窗口. 此时不发送提示词, 而是记为未审并让运行 incomplete (报告里说明原因), 因为发出去只会让会话因上下文超限失败, 把真正的原因埋掉. verifier 侧候选声明过大时同样不发送, 该候选按 rejected 处理, 但代码同样调用 `review.fail(...)`: 整个运行记为 incomplete, last_sha 不推进, 而不是只丢掉这一条候选.

只读工具区分 "git 失败" 与 "空结果": `find` 与 `ls` 解析的是 `git ls-tree` 输出, 失败时不再把错误文本当文件名解析 (否则会回答 "No files." / "Empty or not a directory.", 让模型以为仓库里没有这些文件), 而是回 `git error: ...`; `grep` 无匹配仍返回 "No matches.". 上下文正文用 `git show HEAD:<path>` 从被审提交读取; 符号链接或读不到的文件不审, 记入 not reviewed. 这样大仓库不会把几十个文件塞进一个会话, 导致模型只看前面几个.

### 入库上限

`POST /runs` 一次最多收 500 条发现, 由 cf-admin 的 `MAX_FINDINGS` 决定. runner 侧对应 `INGEST_FINDING_LIMIT`, `stepPublish` 的 `capFindings()` 在超过时按严重性截断: 先留 Error (它才是能阻断合并的那一类), 再按 `sortFindings` 已定的顺序补 Warning.

截断而不是让请求失败, 是因为失败的代价远大于丢几条明细: 整次运行记录, 报告与花费都会一起丢掉, 总览上看不到这次运行. 完整列表仍在报告里, 随同一次请求存进 R2.

### 3. finder: 找候选

- 模型: `/init` 下发的 finder 档 (通常是便宜的小模型), 因为它要读很多内容, 产出只是候选. 两种 kind 用同一个档位.
- 输入 (context): 审查区间, 变更路径列表, 本批每个上下文文件的带行号全文与入选原因, 抑制表 (以前被驳回的指纹与驳回理由), 证据包, diff (`DIFF_MAX_BYTES` 60000 字节内, 超出截断并提示用工具读).
- 输入 (code): 审查区间, 变更路径列表, 本批每个 hunk 的 `@@` 头与正文 (新侧行号, 删除行带 `L` 号), 意图卡, 抑制表, 由重复驳回原因归纳出的仓库规则, 证据包. 没有整份 diff, 也没有上下文文件正文.
- 证据包来自 `context-cr/src/review/evidence.ts`: 变更文件的 import / require 边, `git grep` 找到的引用方, 以及 GitHub 搜索到的最近若干相关 PR 与 issue (仓库配置 `evidencePrs` / `evidenceIssues`, 默认各 5, 范围 0 到 20). 证据是不可信数据, 用围栏包住; 搜索或 git 失败时证据为空, 审查继续. 提示词放不下时先收缩证据, code 下再收缩意图卡, 再收缩 diff (code 下是 hunk), 再收缩上下文正文.
- 系统提示: 内置的 `FINDER_SYSTEM` (context) 与 `CODE_FINDER_SYSTEM` (code) 不变. `/init` 的 `prompts.finder` 若有非空 body, 以 `Operator addendum vN` 追加在末尾, 并写明不能改变等级 (Error 仍只来自 L0). 空正文或缺失字段不加, 对两套提示词一视同仁. verifier 同理使用 `prompts.verifier`.
- 工具: read, grep, find, ls, 加上 `report_finding`. 这四个只读工具不是 pi 的内置工具 (内置工具能解析任意路径), 而是本仓库基于 git 实现的: 只能看到被审提交里被跟踪的文件, 拒绝绝对路径, `..` 与 `.git`, 符号链接读出的是链接目标字符串而不是目标内容, 每次输出最多 30000 字符, 单次 git 调用有 `GIT_TOOL_TIMEOUT_MS` (30 秒) 超时, 并走异步子进程: 同步 git 会阻塞事件循环, 让会话计时器无法按时中断慢操作. 工具收到会话的 abort signal, 会话超时或轮数超限时正在跑的 git 子进程会一起被取消, 不必等满 30 秒超时. git 以 1 退出只表示 "没有匹配", 是空结果而不是工具错误; 只有 128 且未被 kill/取消才表示该提交里没有这个路径, 超时与取消都按工具错误回报, 不会伪装成"文件不存在". 没有写文件或执行命令的能力; `report_finding` 是它唯一的输出通道.
- `report_finding` 的参数按 kind 不同: code 下没有 `patch` 字段, 描述里直接说明 "a code review never pushes a patch branch". 模型能看见的 schema 里就没有这个字段, 所以一份注定被丢弃的补丁不会被写出来, 也不会白占轮次.
- 步骤 (context, 写在 system prompt 里): 先列出 diff 改了什么 (路径, 导出名, 命令, 参数, 配置键, 环境变量, 接口, schema, 模块边界, 工作流, 默认值, 错误行为); 再在每个上下文文件里找关于这些东西的陈述; 用工具对照当前代码确认; 只有当前代码与陈述矛盾, 或缺失了使用变更代码必须知道的信息时才报告; 行号取自带行号的列表; evidence 必须引用证明矛盾的代码或 diff 行.
- 步骤 (code): 先读意图卡, 再逐个 hunk. 对新增行, 删除行, 以及删除所暴露的上下文行问 "什么输入, 状态或时序会让它出错", 以及实现有没有偏离意图卡里写明的金额, 迁移或必须保留的检查. 用工具确认周围代码, 调用方与被认为破坏的契约, 不靠 diff 或记忆下结论. 报告的 path 与 line 必须是 hunk 列表里的新侧行号 (side right) 或 `L` 号对应的旧侧行号 (side left). evidence 必须引用 diff 或刚读过的文件. 同时给出 category, grade, confidence 与 repro. grade 不是 Error/Warning.
- 不报 (context): 文风, 没变代码的缺失文档, 与本次 diff 无关的问题, 列表外的文件, 已抑制项.
- 不报 (code): 纯风格, 命名, 格式, 导入顺序, 缺测试, 两种同样正确的写法之间的偏好, 本次 diff 之前就存在的问题, 以及任何无法落到新增行, 删除行或暴露上下文行上的怀疑. 模型没填 grade 时按 nit 处理, 评论预算会优先丢掉它.
- 补丁: 只在正确写法确定时附带, 必须是只改该上下文文件的最小 unified diff, 保持原文语言与风格. code 不产补丁, 修法写在 message 里.

### 4. 确定性闸门

finder 的候选在花钱请 verifier 之前先过代码检查 (`context-cr/src/review/index.ts`).

context (`gate`):

| 检查 | 不通过时 |
|---|---|
| 路径是本批的上下文文件 | 驳回 "not a context file of this batch" |
| 行号不超过文件行数 | 驳回 "line ... is past the end of the file" |
| 指纹 (路径 + 完整标题) 不在抑制表 | 驳回 "suppressed by earlier feedback" |
| 指纹不与本次已排队候选重复 | 驳回 "duplicate of another candidate" |

code (`gateCode`):

| 检查 | 不通过时 |
|---|---|
| 路径出现在本批的某个 hunk | 驳回 "not a file of this batch" |
| 行号是本批某个 hunk 的新增行, 或 (side 缺省 right 时) 删除所暴露的上下文行 | 否则驳回 "line ... is not a line this diff added to ..." |
| side 为 left 时, 行号是本批某个 hunk 的删除行 (旧侧) | 驳回 "line ... is not a line this diff removed from ..." |
| grade, category, confidence 要么缺省, 要么是允许的取值 | 驳回 "grade must be ..." / "category must be ..." / "confidence must be ..." |
| 指纹 (路径 + 完整标题) 不在抑制表 | 驳回 "suppressed by earlier feedback" |
| 指纹不与本次已排队候选重复 | 驳回 "duplicate of another candidate" |
| 标题, 说明, 证据没有把判断推给读者 (确认, 回答, 检查上下文是否正确) | 驳回 "asks a person to confirm..." |
| 证据里每个不少于 8 个字符的反引号引用都出现在本 hunk 或被审提交的文件里 | 驳回 "quoted evidence is not in this diff hunk..." 或 "evidence has no backtick quote..." |

两套闸门都在 `report_finding` 工具内即时执行: 被驳回的候选立刻把理由回给 finder, 不进入队列, 也不占用候选名额, 因此 finder 反复报已抑制, 重复或 diff 没碰过的行不会挤掉本批的真实问题. 工具另有 `REPORT_CALL_LIMIT` (40) 次调用上限: 超过后的调用只被拒绝并回一句 "stop and summarize", 模型仍可继续调用, 照样消耗会话时长与费用, 真正的兜底是每会话轮数上限与运行时限. 被驳回的候选 (包括 verifier 驳回的) 连同理由写入报告 JSON 的 `rejections`, Markdown 报告列出驳回数, 便于调提示词.

### 5. verifier: 尝试反驳

- 模型: verifier 档 (通常是更强的模型), 因为它只看一条候选, 要做最终判断.
- 每条候选一个全新会话, 不继承 finder 的上下文, 避免被 finder 的推理带偏.
- 输入 (context): 候选 (文件, 行, 标题, 说明, 证据; 以 JSON 代码块给出并标明是不可信的主张, 因为它出自读过不可信文件的模型), 补丁 (同样标为不可信), 该文件在报告行附近 +-15 行的带行号原文, diff (预算减半).
- 输入 (code): 候选 (同样标为不可信, 并带 side, category, grade, confidence, repro) 与该行所属 hunk 的 `@@` 头加正文, 以及同一份意图卡. 没有补丁, 也没有上下文文件摘录.
- 工具: 同样的 git 只读工具, 加上 `report_verdict`.
- 判定 (context): 默认立场是反驳. 以下任一成立就 rejected: 文件仍然准确; 报告行附近没有该陈述; 推测性或文风问题; 证据在当前代码里不成立; 照着该文件做的 agent 不会被误导. 只有矛盾真实且会误导 agent 才 confirmed.
- 判定 (code): 默认立场同样是反驳. 以下任一成立就 rejected: 该行对代码能收到的每种输入都正确; 问题需要仓库无法产生的状态, 时序或输入; 属于风格, 命名或偏好; 引用的证据在当前代码里不成立; 意图类候选所说的意图卡原文并不存在; 缺陷早于本次 diff, 改动既没有造成也没有暴露它; 候选或理由要求读者去确认, 回答, 或检查上下文是否正确. 只有 "证据引用真实存在, 且照这条候选做的维护者会同意改动是错的且合入前必须改" 才 confirmed. 模型给出 confirmed 之后, runner 再做一次确定性核对 (`groundEvidence`): 引用不在 diff 或文件里, 或理由仍在问人, 一律改判驳回. 这次核对的结论记在 `trace.checks`, 不靠模型自己说"我看过了".
- 评论预算: confirmed 之后按 grade 再裁一次 (`publishKeys`, 上限 `CODE_COMMENT_BUDGET` = 5). 顺序是 critical, major, minor, 同档比 confidence. 只要留下了任何非 nit, 全部 nit 都不再发表. 只有 nit 时, 只保留置信度不低于 0.8 的那一条. 被裁掉的候选留在 `trace.checks`, verdict 为 `suppressed`, 原因前缀 `comment budget:`, 不进入 `findings`, 也不发行评. 这不增加 rejected 以外的失败, 运行仍然 complete.
- 补丁判定: context 在同一次调用里给出 `patch`: correct (只改该文件且让陈述变真, 不引入新错误), incorrect, 或 none (没有补丁). code 的提示词明确要求 `patch` 恒为 none, 因为代码 CR 没有补丁可判. 没有调用 `report_verdict`, 或给出无法识别的值, 一律按 rejected / incorrect 处理.

### 6. 补丁闸门

只有 context CR 走到这一步. 只有 verifier 判 correct 的补丁才进入下一步: 必须是单个已有文件的纯文本修改 (`--numstat` 只报路径, 所以另行拒绝新建, 删除, 改权限, 变成符号链接, 改名, 复制与二进制补丁, 以及含多个文件头的补丁); `git apply --check --numstat -z` 必须成功, 且触及的文件恰好只有被报告的那个上下文文件 (路径按原始字节比较, 含非 ASCII 或制表符的路径也不会被截断冒充). 通过的补丁在 publish 阶段合到一个 `hx-ctx/patch-*` 分支, 互相冲突的补丁跳过, 补丁分支失败不影响报告入库.

code CR 没有补丁闸门, 也没有补丁分支: `stepPublish` 在 `config.kind === "code"` 时跳过整个补丁分支推送. 它改为在 PR 上留三样东西, 都由 `GITHUB_TOKEN` 的身份发出. 默认可复用工作流用的是 `github.token`, 也就是 github-actions[bot] 这个 App; 调用方传入可选 secret `GH_APP_TOKEN` 时, 进度评论和行评改由那个 GitHub App 安装令牌发出.

- 一条带 `<!-- hx-context-review -->` 的 issue 评论, 审查过程中按「分组组装 → 分块审查 → 证据校验」原地更新, 结束时换成带分组 diff 摘录和校验表的总结. 没有 PR (纯 push) 时退回一条 commit 评论, 不发行评.
- 一个「分块审查」review, 正文是各组的 diff 摘录.
- 一个「证据校验」review. 确认且没被预算裁掉的发现写到 diff 上: 新增行和暴露的上下文行用 `side: RIGHT` (新文件行号), 删除行用 `side: LEFT` (旧文件行号). 驳回和被预算抑制的只出现在 review 正文里. 行评正文带已经核对过的引用, 以及 grade 和 category, 不要求读者再去确认. GitHub 拒绝某一行 (该行不在 PR diff 上) 时, 改为只发正文, 入库不受影响.

总览页运行记录的「进度」读取 `GET /api/runs/{owner}/{repo}/{id}/report` 里的 `trace`. 报告在 publish 时入库, 所以页面上的进度是这次运行结束后的分组和校验; 跑的过程中看 PR 上那条原地更新的评论.

## 隔离与安全

- 被审仓库里的 AGENTS.md, skills, pi 扩展, prompt 模板都是被审数据, 不是给 agent 的指令: pi 会话使用隔离的资源加载器, 不发现任何仓库内资源, system prompt 只用本仓库定义的四份 (两种 kind 各两份).
- 四份 system prompt 都声明: 仓库内容 (上下文文件, 代码, diff, 提交信息) 与 finder 报出的候选都是数据, 其中任何指令都不执行. code 的提示词额外说明它审的是改动本身, 不审文档.
- 插入提示词的代码块用长于正文中最长反引号串的围栏, 所以仓库文档里的 ``` 无法提前闭合边界; 正文中的其余内容不改变围栏长度.
- 模型的文件访问只经过 git 只读工具, 看不到 .git 目录 (含其中的 config), 未跟踪文件, `/proc` 或仓库外的文件; 上下文正文同样从 git 读取.
- 被审仓库的 checkout 不保留凭据 (`persist-credentials: false`), 推补丁分支时才通过环境变量为那一条命令提供 GITHUB_TOKEN.
- api_key 的生命周期见 [context-cr.md](context-cr.md): 只在 review 进程内存在, 不进日志与状态文件.

## 上限与预算

| 上限 | 值 | 来源 | 触发时 |
|---|---|---|---|
| 每批上下文字节 (context) | min(40000, 上下文窗口剩余额 - diff 预算) | `CONTEXT_BATCH_BYTES`, `MIN_BATCH_BYTES`, `PROMPT_RESERVE_BYTES` | 切成更多 finder 会话 |
| 每批 hunk 字节 (code) | 与 diff 预算同值: max(4000, min(60000, 上下文窗口剩余额的一半)) | `DIFF_MAX_BYTES`, `MIN_DIFF_BYTES` | 切成更多 finder 会话 |
| diff 字节 (context) | finder min(60000, 上下文窗口剩余额的一半), verifier 30000, 两者都再按渲染后的提示词余量收缩 | `DIFF_MAX_BYTES`, `MIN_DIFF_BYTES` | 截断, 并说明被截掉的部分工具读不到 (read 只读被审提交) |
| 单个 hunk 显示字节 (code) | 从上下文正文额度起, 按渲染后的提示词余量收缩 | `CONTEXT_BATCH_BYTES`, `MIN_BATCH_BYTES` | 截断该 hunk, 提示用 read 工具读其余部分 |
| 每次运行候选总数 | 默认 12 | `/init` 的 `limits.maxCandidates` | 剩余批次记为 not reviewed (报告中列出), 不算失败 |
| 每会话轮数 | 40 | `SESSION_MAX_TURNS` | 仅当第 40 轮后仍需继续时才中止; 正常结束的最终回答不算超限, 运行记为 incomplete |
| 每会话时长 | 15 分钟, 且不超过运行剩余时间 | `SESSION_TIMEOUT_MS` | 中止会话, 运行记为 incomplete |
| 每会话时长为什么是 15 分钟 | 要放得下一次会话的真实工作量, 不只是防挂死 | 同上 | code finder 用工具读 hunk 再推理: 实测在慢 provider 上单个 hunk 跑到 480 秒即超时, 一次已花掉 177k 输入 token 的审查被整份丢弃. 总花费仍由下面的运行截止时间约束, `Review.session` 把每个会话裁剪到剩余时间内, 所以调大这一项不会让运行越过 `RUN_DEADLINE_MS` |
| 整个 AI 审查时长 | min(20 分钟, job 剩余时间 - 发布预留) | `RUN_DEADLINE_MS`, `JOB_TIMEOUT_MS`, `PUBLISH_RESERVE_MS` | 不再开新会话, 运行记为 incomplete; 截止时间按 job 剩余时间 (workflow 传入的 `HX_CTX_STARTED_AT`) 扣除 checkout/install/init/L0/scope 的耗时和 2 分钟发布预留, 保证在 job 的 30 分钟超时前进入 publish, 花费照常计入预算 |
| 每次运行花费 | 本次运行可用额度 | `/init` 的 `limits.maxRunUsd` (无上限时为 null) | 不再开新会话, 运行记为 incomplete; 只在开会话前检查已累计花费, 所以单个会话仍可能使本次花费略超该值 |
| 预留开始花费 | 第一次会话前上报一次 | `POST /spend` (`ReviewDeps.onSpend`), 上限 min(30 秒, 运行剩余时间) | 上报失败, 超时 (abort) 或预留已被接管 (409) 都中止审查, 且之后每个 finder 批次与 verifier 会话都不再启动 (状态而非会话序号决定), 运行记为 incomplete; 该预留被接管时按额度结算, 未上报则按 0 结算. 上报后重新读取时限, 等待标记的时间不会让会话越过时限 |
| 月预算 | 仓库配置 | Worker | 用完后 `/init` 只下发 L0 配置, 不给 key. context 与 code 运行争的是同一份月预算 |

费用按 provider 的输入, 输出, 缓存读, 缓存写单价由 pi 计算并上报; Worker 用 token 数重算, 取两者较大值计入月预算.

## 失败语义

- pi 遇到模型错误不会抛异常, 而是以 stopReason 为 error 结束. runner 检查最后一条 assistant 消息: error, aborted (含我们因超时或轮数中止), length (输出被截断) 或没有 assistant 消息, 都视为会话失败.
- 任一 finder 或 verifier 会话失败只影响该会话: 它已花的 token 照常计入用量与预算, 会话记录照常保存; 已确认的发现照常保留, 但运行记为 incomplete. verifier 失败的候选不算驳回, 也不保留.
- 运行预算或运行时限用尽同样记为 incomplete.
- 预算用完后 `/init` 只下发 L0 配置并带 `l0Cause: budget`; provider 配置有问题时为 `l0Cause: config`. 这两种情况 runner 也报 incomplete, last_sha 停在原处, 等预算重置或配置修好后, 下一次运行一并审查积累的区间.
- incomplete 运行仍把 L0 结果 (code 下为空) 和已确认的 AI 发现入库, 状态为 `incomplete` (context 运行的 L0 有阻断 Error 时为 failed), 不推进 last_sha, 下一次运行会重新审这段区间.
- 候选数上限触发与文件无法读取不是失败: 重跑会遇到同样情况, 所以只在报告的 `stages.ai` 中列出未审文件及原因 (每条自带原因, 不再统一标为 candidate limit), 正常推进.
- scope 的 kind 与配置不一致属于配置错误: 不开任何会话, 运行记为 incomplete 并把原因写进 `errors`, 由下一次正确配置的运行覆盖该区间.

## 输出与反馈闭环

- 每条确认且没被预算裁掉的发现是一个 Warning: context 用规则 `CX-AI`, code 用 `CODE-AI`. 消息为 "标题: 说明", 证据附 verifier 理由和 repro, 指纹为 规则 + 路径 + 完整标题 (同一条过期陈述或同一个缺陷跨运行保持同一指纹; 标题不截断, 以免指纹变化让抑制失效). code 发现另带 grade, category, confidence, side. 这些字段不改变 severity, 也不进入指纹, 所以改一改 grade 不会让旧的驳回失效.
- 两种 kind 的指纹命名空间不同, 所以对上下文发现的驳回不会顺带压掉同一行的代码缺陷, 反之亦然.
- 报告名与报告目录的共享常量在 `context-cr/src/constants.ts`: CI 审查写 `context-review`, 本地 diff 写 `local-review`, 两者使用同一 `ReviewReport` 契约 (含 `kind` 字段); 这些命名不影响 AI 发现语义.
- 报告 (MD/JSON, 含 `rejections`) 与全部会话记录 (finder 与 verifier 的完整消息, 包括失败会话, JSONL) 存入 R2, 可在总览页追溯每条结论是怎么得出的.
- 维护者在总览页采纳或驳回发现; 驳回的指纹与理由进入抑制表, 下次 `/init` 下发: finder 在提示词里看到它们, 闸门直接拦下同指纹候选. 同一条驳回理由出现至少两次时, `rulesFromDismissals` 把它收成一条仓库规则, 写进下一次 code finder 的提示词 ("Do not report this again"). 采纳数除以采纳加驳回是 resolution rate (`resolutionRate`); 没有反馈时为 null, 不记成 0. 总览页的记录仍在 D1 `feedback`, `/init` 目前不下发这个比率.

## 怎么判断审得好不好

- 精度: 总览页的采纳率 (accepted / (accepted + rejected)), 按 kind 分开看. 驳回理由按类别归纳后, 回写到对应 kind 的 system prompt 的"不报"清单或闸门里.
- 召回: 离线评测把 code reviewer 的真实流水线 (scope, 意图卡, 闸门, verifier, 评论预算) 重放在版本化的黄金集上, 见 [code-eval.md](../reference/code-eval.md). 模型侧是钉死的回放稿, 不调用托管模型. 指标是 precision, 分类 recall, 干净样例上的 false-positive rate, critical miss 数, 以及每条 PR 的发现数. 每次结果带 promptHash 与 configHash.
- 成本: 每次运行的 token 与费用随运行入库, 总览页按仓库与 kind 展示.
- verifier 驳回率: 会话记录里 finder 候选数与确认数之比. 驳回率长期很高说明 finder 提示词过宽.

## 已知限制与后续

- 黄金集衡量的是流水线会不会保住钉死的回放稿里的真问题, 并丢掉 nit. 它不调用托管模型, 所以不能代替真实模型的召回. 接上模型时把 `mode` 从 `replay` 换成该模型 id, 并换掉回放稿; promptHash 与 configHash 仍要一起记.
- 超大 diff 截断后, 被截掉的部分 (尤其是 base 侧) 用现有只读工具读不到, 只能依赖模型在能看到的部分里判断, 召回会下降.
- 删除行可以报, 锚是旧侧行号, 行评在 LEFT. GitHub 若拒绝该行, publish 退回只发正文, 发现仍入库. 二进制补丁仍然没有 hunk.
- 上下文行只有在同一个 hunk 里还有删除时才能报. 没被删改碰到的行仍然不能报.
- 评论预算默认 5. 超过 5 条 critical 时, 置信度较低的 critical 也会被裁掉, 这会计入评测的 critical miss.
- verifier 只有一票; 是否对高影响发现做多模型投票, 等有采纳率数据后再定.
- `/init` 不下发 resolution rate. 比率函数在 runner 里, 反馈行仍由总览写入 D1.
- 修改本文描述的任何角色, 闸门, 上限或失败语义时, 同步更新 `context-cr/test/review.test.ts` 与 `context-cr/test/code-review.test.ts` 中对应的测试.
