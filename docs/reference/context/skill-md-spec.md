# SKILL.md 规范

SKILL.md 是一个技能的唯一入口: frontmatter 决定它何时被加载, 正文决定加载后怎么做. 本规范规定必填字段, 正文五节, 引用写法与长度上限.

结构判据由 CTX-002 定义, 等级见 [validation.md](validation.md); 其中 frontmatter 与目录名一致已由 CX-SKILL 实现, 正文结构尚未实现.

## frontmatter

必填两个字段:

| 字段 | 要求 | 缺字段等级 |
|---|---|---|
| name | 与所在目录名完全一致, 小写 kebab | error |
| description | 非空; 写清做什么, 触发条件, 不触发场景 | error |

写法:

```yaml
---
name: hx-agent-code
description: "为目标项目一次性安装和补齐代码质量红线与精简规范文件, 定制 AST 规则、文档与 AI 上下文检查、Diff 测试选择、回合结束的 Agent hook、Git hooks、GitHub CI 和元门禁, 不编写测试. Use when 用户主动调用 $hx-agent-code 或 /hx-agent-code, 要求按 AI 代码质量规范完成项目门禁安装或补装; 不因普通代码编辑自动触发"
disable-model-invocation: true
metadata:
  author: Heng_Xin
  version: "1.2"
---
```

- description 建议 200-500 字符: 第一句说做什么, 第二句用 "Use when" 列触发词, 第三句写不触发.
- 触发词要覆盖用户真实会说的词: 命令名, 中文别名, 文件类型, 场景词.
- 可选字段: disable-model-invocation, metadata (author, version). 可选字段不得承载正文内容.
- 禁止在 frontmatter 写实现细节, 路径清单, 变更记录.
- 双引号包裹含冒号或中文的描述, 避免 YAML 解析歧义.

## 正文结构

五节, 顺序固定:

| 节 | 写什么 | 缺节等级 | 建议上限 |
|---|---|---|---|
| 何时用 | 触发条件, 不触发, 边界 | error | 15 行 |
| 输入 | 需要用户给什么, 缺什么先问, 默认值 | warning | 15 行 |
| 步骤 | 有序动作, 每步带验证点 | error | 80 行 |
| 判据 | 完成定义, 可运行验证或可核对输出 | error | 20 行 |
| 反例 | 常见错误做法与错在哪 | warning | 20 行 |

### 何时用

- 正例: 用户说某句话 / 仓库出现某类文件 / 任务命中某个命令.
- 反例: 列出相似但不该触发的任务, 并写明转给哪个技能.
- 与 description 分工: description 负责路由, 本节负责路由后的确认与边界.
- 不写 "适用于各种场景" 这类无法证伪的触发条件.

### 输入

- 列出必须由用户提供的参数, 缺失时是询问还是取默认.
- 明确不可猜的项: 目标仓库, 凭据, 授权范围.
- 写清输入校验: 路径存在, 分支存在, 权限足够.
- 正文没有输入节时, 至少要在开头段落交代输入来源.

### 步骤

- 一步一个动作, 动词开头; 用编号或表格, 不写大段散文.
- 每步写验证点: 命令, 期望输出, 失败怎么办.
- 长步骤拆到 references/, 正文只留入口与判断.
- 步骤之间不跳步, 需要人工确认的步骤单独标出.

### 判据

- 完成定义必须可观测: 退出码, 文件存在, 字段值, 报告条目.
- 区分"跑过"与"通过": 只贴命令不算通过, 必须给输出或结果.
- 无法自动验证的项标注人工核对点.
- 判据与步骤的验证点呼应, 不引入新命令.

### 反例

- 至少 2 条, 来自真实失败, 不写假设性反例.
- 每条写: 错误做法, 现象, 根因, 正确做法.
- 反例指向具体文件或命令, 不写 "注意不要出错" 这类空话.

## 引用其他文件

- 相对技能根书写, 例如 `references/<topic>.md`, `scripts/<tool>.ts`; 禁止 `./` 与 `../` 开头.
- 反引号用于 agent 读取, markdown 链接用于人跳转; 两者都必须可达.
- 代码块内的路径不算引用, 不能靠示例满足可达性.
- 大文件拆分: 正文只留路由, 细节进 references/; 每个引用一行, 附一句何时读.
- 引用失效: markdown 链接为 Error, 反引号路径为 Warning (CX-DEADREF).
- 引用其他技能时写技能名与其 SKILL.md 路径, 不复制其正文.

## 长度上限

| 对象 | 上限 | 依据 |
|---|---|---|
| frontmatter | 10 行 | 常驻注入, 每个技能都计费 |
| 正文 | 150 行 | 加载时注入, 与并发加载数相乘 |
| 单文件 | 500 行 | 仓库通用上限 |
| 注入预算 | 每个目标目录的注入总量不超过 65536 字节 (组成见下) | HC-BUDGET (Error) |

- 超 150 行: 保留 何时用 / 输入 / 步骤 / 判据, 细节移 references/.
- 超 500 行: 必须拆分, 不允许靠压缩行宽规避.
- 行数按换行符计数, 末尾换行不计.
- 正文行数 = 总行数 - frontmatter 行数.
- 注入总量按每个目标目录分别计算: 所有技能 frontmatter + 最大的 concurrentSkills 个正文 + 该目录的祖先 AGENTS.md 链; 被 exclude 的路径不计入.
- 注入总量等于 65536 字节通过, 超过才报 Error; 判据与 HC-BUDGET 实现一致, 详见 [validation.md](validation.md).

## 真实例子: hx-agent-code

来源: 本仓库 `.agents/skills/hx-agent-code/SKILL.md`, 94 行. frontmatter 与正文节选如下.

```markdown
---
name: hx-agent-code
description: "为目标项目一次性安装和补齐代码质量红线与精简规范文件, 定制 AST 规则、文档与 AI 上下文检查、Diff 测试选择、回合结束的 Agent hook、Git hooks、GitHub CI 和元门禁, 不编写测试. Use when 用户主动调用 $hx-agent-code 或 /hx-agent-code, 要求按 AI 代码质量规范完成项目门禁安装或补装; 不因普通代码编辑自动触发"
disable-model-invocation: true
metadata:
  author: Heng_Xin
  version: "1.2"
---

# hx-agent-code

针对用户指定项目, 完成取证、适配、安装和验收. 先复用项目已有能力, 再补确定性脚本, 不以建议清单代替已授权的实现...

## 步骤

| 步骤 | 只负责 | 契约 |
|---|---|---|
| 取证 | 目标项目、复用顺序、适用性、缺失信息 | `steps/1-discover/index.md`: 开始时读 |
| 安装 | 规则、报告、测试选择、上下文、元门禁 | `steps/2-install/index.md`: 落地本地工具时读 |
| 接线 | Agent/Git 检查点、CI、协作文件 | `steps/3-connect/index.md`: 连接实际宿主时读 |
| 验收 | 最终 Diff 一轮测试、正反证据、交付 | `steps/4-verify/index.md`: 实现完成后读 |

## 完成边界

逐项落实规则目录. 默认 Error, 只有明确标为 Warning 或静态无法裁决的语义项交人工 review...

## 按需资料

- `references/rules.md`: 安装前逐项读取的规则 ID、等级、阈值及正反例
- `references/runtime.md`: 实现本地检查点、快照适配、缓存、MD/JSON、输出展示与 baseline 时读
```

| 必选节 | 对应内容 | 结论 |
|---|---|---|
| 何时用 | 无独立节, 触发条件全在 description | 缺: 不触发与边界只靠 description, 按 error 记录 |
| 输入 | 开头段: 目标项目, 授权范围, 依赖技能查找顺序 | 具备, 但散在正文, 新技能应独立成节 |
| 步骤 | "## 步骤" 表 + steps/ 索引 | 具备: 每步带契约与读取时机 |
| 判据 | "## 完成边界" + "## 可执行件" | 具备: Error 阻断, 报告合并, 退出码写清 |
| 反例 | 无 | 缺: 正反例放在 references/, 按 warning 记录 |

结论: 该技能把细节压到 references/, 正文 94 行符合 150 行上限, 是重型技能的合适形态; 但 何时用 与 反例 缺失, 新技能不要照抄这一点.

## 提交前检查清单

- [ ] name 与目录名一致, 小写 kebab
- [ ] description 有做什么, 触发词, 不触发
- [ ] 五节齐全
- [ ] 正文少于 150 行, 单文件少于 500 行, 注入总量不超过 65536 字节
- [ ] 所有引用可达, 无 ./ 或 ../ 前缀
- [ ] 细节在 references/, 正文只留路由
- [ ] 判据可运行, 至少一条给出命令与期望输出
- [ ] 反例至少 2 条且来自真实失败
