# 规则表

本文件是规则的可读版本; 唯一事实源是 `context-cr/src/rules/registry.ts`, 编号与判据以代码为准。
每条规则在报告里都带 `ruleId` 与 `severity`, 契约字段见 [report-contract.md](report-contract.md)。

| 规则 | 级别 | 判什么 | 失败条件 |
|---|---|---|---|
| ARCH-001 | error | 有 `impl/` 的模块必须暴露公共入口, 其他模块只能依赖公共入口 | 直接 import 别的模块 `impl/` |
| ARCH-002 | error | 目录级 import 图无环 | 检出循环依赖 |
| ARCH-003 | warning (职责混杂时 error) | 单目录文件数不超过 6 | 超限; 同时混用多种源语言/职责时升级为 error |
| ARCH-004 | error | API 层不直接依赖数据源包, 不内嵌 SQL | 命中数据源依赖或在路由层写 SQL |
| STYLE-003 | error | 注释只描述函数语义, 长度不超过 10 行, 只用 ASCII 标点 | 超出长度, 出现决策叙述或中文标点 |
| STYLE-004 | warning | 新增第三方依赖需要人工决策 | 相对基线新增依赖且未登记决策 |
| DOC-001 | error | 文档内相对链接必须指向仓库里真实存在的文件或目录 | 相对链接失效 |
| CTX-001 | error | AGENTS.md 体积与结构: 单一主标题, 行数上限, 与 README.md 配对 | 超出上限或结构缺失 |
| CTX-002 | error | SKILL.md 有 front matter, `name` 与目录同名, 正文非空 | 字段缺失或名称不一致 |
| CI-001 | error | 工作流存在, 触发条件与 job 未被清空, 引用的脚本与包真实存在 | 引用不存在的脚本或包 |

## 豁免

在仓库根登记豁免后, 该条不再计入 counts:

```json
{
  "path": "src/user",
  "ruleId": "ARCH-003",
  "reason": "该目录承担同一职责, 拆分后反而增加依赖复杂度",
  "expires_on_change": true
}
```

`expires_on_change` 为 true 时, 该目录再次发生变更后豁免失效并重新检查; 豁免信息随仓库进 Git。
