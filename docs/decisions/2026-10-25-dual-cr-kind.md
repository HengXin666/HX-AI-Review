# 双模式: 上下文 CR 与代码 CR

2026-10-25

## 背景

hx-context-review 原本只做一件事: 检查业务仓库的 AI 上下文文件 (AGENTS.md, README.md, SKILL.md, docs/)
是否还和代码一致. 它复用 hx-agent-code 的 Finding 契约, 但规则集中在 `HC-*` 与 `CX-*`.

现在需要它同时承担第二件事: 对 diff 本身做 AI 代码审查 (code CR) —— 逻辑错误, 边界条件, 错误处理,
并发与资源, 安全边界, 以及变更是否与既有设计相悖. 这两件事共享同一条流水线 (init -> L0 -> scope ->
finder -> verifier -> publish), 同一个 D1/R2, 同一个总览页, 所以不新建服务, 而是在既有契约上加一个维度.

## 决定

引入 `kind` 维度, 取值 `context` 或 `code`. 事实源是 `context-cr/src/contract/kind.ts`.

| 维度 | context | code |
|---|---|---|
| 审什么 | 上下文文件是否过时 | diff 本身是否有缺陷 |
| 作用域 | diff -> 祖先 AGENTS 链 + 反向引用 | diff 新增/修改的行 |
| 规则命名空间 | `HC-*`, `CX-*` | `CODE-*` |
| 产物 | 补丁 (改上下文文件) | 建议 (改代码), 不自动推送 |
| 默认等级 | Warning | Warning |

`kind` 出现在三处, 语义一致:

1. 仓库配置 (`repos.kind`): 默认跑哪种. 一个仓库可以只跑一种, 也可以两种都跑.
2. 一次运行 (`runs.kind`): 这一跑的是哪种. `/init?kind=` 显式指定, 缺省取仓库配置.
3. 一条发现 (`findings.kind`): 从所属运行继承, 冗余存一份, 让总览页按 kind 筛选不必 join runs.

## 为什么不拆成两个服务

- 两者共享 budget, provider, 模型分级, 提示词附录, 驳回抑制表. 拆开会让同一个仓库有两份预算和两份驳回.
- 两者的 Error 都只来自 L0; AI 只出 Warning. 契约相同, 拆开就是重复实现.
- 总览页需要同时看两种 CR 的健康度; 同库同页更直接.

## 兼容

- 既有行没有 `kind`: 迁移把 `repos.kind` 与 `runs.kind` 的默认值设为 `'context'`, `findings.kind` 从
  `runs` 回填. 老客户端不带 `kind` 参数时行为不变.
- `/init` 的响应新增 `kind` 字段, 老 runner 忽略即可.
- `POST /runs` 的 `kind` 缺省为 `context`, 与旧行为一致.

## 一个仓库两种 CR 怎么跑

调用方 workflow 传 `kind` 输入 (默认 `context`). 想两种都跑就写两个 job, 各自带 concurrency group,
预算与 `last_sha` 独立: `last_sha` 只对 context CR 有意义 (它代表"上下文已审到哪"), code CR 不看它.
