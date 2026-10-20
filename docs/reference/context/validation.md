# 上下文文件校验判据 (CTX-001 / CTX-002)

CTX-001 判定 AGENTS.md 结构, CTX-002 判定 SKILL.md 结构. 两者是规范级判据, 尚未接入 L0; 已实现的部分在"对应实现"列标注. 本文只定义判据与等级, 不描述实现细节.

规范正文见 [agents-md-spec.md](agents-md-spec.md) 与 [skill-md-spec.md](skill-md-spec.md); 可直接复制的模板在 `templates/AGENTS.md.tpl` 与 `templates/SKILL.md.tpl`.

## 等级原则

- error: 结构缺失导致 agent 无法路由, 无法判断边界, 或引用断链; 阻断.
- warning: 完整性, 风格, 冗余; 不阻断, 进 review.
- 同一问题只报一次: 长度与配对归 HC-CONTEXT, frontmatter 归 CX-SKILL, 引用归 CX-DEADREF, CTX 只补结构判据.
- 启发式判据只出 warning, 不参与阻断.

## 总览

| 问题类型 | CTX-001 | CTX-002 |
|---|---|---|
| 缺节 | error: 定位, 共享铁律, 红线; warning: 项目布局, 落盘 | error: 何时用, 步骤, 判据; warning: 输入, 反例 |
| 缺字段 | error: 同目录 README.md | error: name, description |
| 超长 | error: 达到 150 行或 16384 字节; warning: 达到 90% | warning: 正文达到 150 行; error: 文件达到 500 行, 注入达到 65536 字节 |
| 引用失效 | error: markdown 链接; warning: 反引号路径 | error: markdown 链接; warning: 反引号路径 |
| 其他 | error: 决策进文件头; warning: 决策未引用, 复制父级 | warning: 引用前缀, 示例冒充引用 |

## CTX-001: AGENTS.md

| 检查项 | 判据 | 等级 | 对应实现 |
|---|---|---|---|
| 缺 定位 | 标题后 15 行内没有定位段或首读链接 | error | 无 |
| 缺 共享铁律 | 没有可判定的硬约束节 | error | 无 |
| 缺 红线 | 没有禁止事项或决策引用规则 | error | 无 |
| 缺 项目布局 | 没有目录表或路由规则, 且未写明原因 | warning | 无 |
| 缺 落盘 | 没有产物, 凭据, 文档去向, 且未写明原因 | warning | 无 |
| 缺 README 配对 | 同目录没有 README.md | error | HC-CONTEXT |
| 超长 (行) | 行数达到 150 | error | HC-CONTEXT |
| 超长 (字节) | 字节数达到 16384 | error | HC-CONTEXT |
| 接近上限 | 行数达到 135, 或字节数达到 14745 | warning | 无 |
| 链接失效 | markdown 链接目标不存在 | error | CX-DEADREF |
| 路径失效 | 反引号路径不存在 | warning | CX-DEADREF |
| 决策进文件头 | 前 10 行出现决策, 历史或变更记录 | error | 无 |
| 决策未引用 | 正文出现决策结论, 且未指向函数签名或 note | warning | 无 |
| 复制父级 | 与父级 AGENTS.md 连续 5 行以上相同 | warning | 无 |
| 孤儿目录 | 目录未登记在布局表或归属索引 | warning | 无 |

判据细节:

- 文件头 = 标题到第一个二级标题之间; 只允许标题, 定位段, 首读链接.
- 写明原因 = 文件内有一行明确说明该节不适用, 例如"本仓库无产物落盘, 不设落盘节".
- 接近上限取上限的 90%: 135 行, 14745 字节, 用于提前提醒而不是阻断.
- 决策未引用是启发式: 出现"决定", "选择", "因为"等结论句, 且同段没有函数签名或 note 引用.
- 孤儿目录不归 CX-ORPHAN: 该规则只覆盖 docs 下未被引用的文档, 不覆盖目录.

## CTX-002: SKILL.md

| 检查项 | 判据 | 等级 | 对应实现 |
|---|---|---|---|
| 缺 frontmatter | 文件不以 --- 开头, 或没有闭合的 --- | error | CX-SKILL |
| 缺 name | frontmatter 没有 name | error | CX-SKILL |
| name 不一致 | name 与所在目录名不同 | error | CX-SKILL |
| 缺 description | description 缺失或为空 | error | CX-SKILL |
| description 无触发 | 没有 Use when 或等价触发词 | warning | 无 |
| 缺 何时用 | 没有该节 | error | 无 |
| 缺 步骤 | 没有该节, 或步骤少于 1 条 | error | 无 |
| 缺 判据 | 没有该节, 或判据不可观测 | error | 无 |
| 缺 输入 | 没有该节, 且正文未说明输入 | warning | 无 |
| 缺 反例 | 没有该节 | warning | 无 |
| 超长 (正文) | 正文达到 150 行 | warning | 无 |
| 超长 (文件) | 文件达到 500 行 | error | 仓库通用上限 |
| 注入超预算 | 所有 frontmatter 加最大的 concurrentSkills 个正文达到 65536 字节 | error | HC-BUDGET |
| 链接失效 | markdown 链接目标不存在 | error | CX-DEADREF |
| 路径失效 | 反引号路径不存在 | warning | CX-DEADREF |
| 引用前缀 | 引用以 ./ 或 ../ 开头 | warning | 无 |
| 示例冒充引用 | 路径只出现在代码块, 正文没有引用 | warning | 无 |

判据细节:

- frontmatter 只解析文件开头的第一个 --- 块; 缺失或未闭合都按缺 frontmatter 处理.
- 正文行数 = 总行数 - frontmatter 行数.
- 判据可观测 = 含命令, 路径, 字段名或退出码; "确认无误"不算判据.
- 示例冒充引用用于提醒: 代码块不参与引用解析, 不能靠示例满足可达性.
- 引用前缀仍可解析, 所以只记 warning; 规范要求相对技能根书写.

## 判定示例

| 场景 | 结果 |
|---|---|
| AGENTS.md 120 行, 五节齐全, 链接可达 | 无 finding |
| AGENTS.md 152 行 | CTX-001 error (超长), 与 HC-CONTEXT 同一指纹, 只报一次 |
| AGENTS.md 140 行 | CTX-001 warning (接近上限) |
| AGENTS.md 前 5 行写"我们决定用 D1" | CTX-001 error (决策进文件头) |
| AGENTS.md 链接到已删除文档 | CTX-001 error (链接失效) |
| SKILL.md 没有 frontmatter | CTX-002 error (缺 frontmatter) |
| SKILL.md 的 name 与目录不同 | CTX-002 error (name 不一致) |
| SKILL.md 正文 200 行, 细节在 references/ | CTX-002 warning (超长) |
| SKILL.md 只缺 反例 | CTX-002 warning (缺节) |

## 与现有规则的关系

| CTX | 复用 | 增量 |
|---|---|---|
| CTX-001 | HC-CONTEXT 的配对与长度, CX-DEADREF 的引用解析 | 五节结构, 文件头决策, 复制父级, 孤儿目录 |
| CTX-002 | CX-SKILL 的 frontmatter, HC-BUDGET 的注入预算, CX-DEADREF 的引用解析 | 五节结构, 正文长度, 引用前缀 |

引用解析复用 `context-cr/src/l0/refs.ts` 的候选顺序: 相对所在文件, 相对仓库根, 相对所在技能根. CTX 不另造解析器, 否则同一断链会被两条规则各报一次.

## 实现边界

- 只做结构判定, 不判断内容是否正确.
- 不做语义去重: 两节写同一件事只按存在性判定.
- 不把结构判据放进 AI 阶段: 结构问题必须确定性可复现.
- 接入时在 [report-contract.md](../report-contract.md) 的规则表登记, 并补正反例.
- CTX 未实现不影响 HC-CONTEXT 与 CX-SKILL 已生效的检查.

## 不做什么

- 不对 warning 设豁免名单; 例外写进文件本身.
- 不为通过检查而改写业务事实.
- 不用行号定位结构问题: 节标题会移动, 指纹用规则加路径加锚点.
