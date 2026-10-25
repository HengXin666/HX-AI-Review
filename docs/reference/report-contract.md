# 报告契约

hx-context-review 与 hx-agent-code 使用同一份报告契约: 同样的 Finding 字段, 同样的 Error/Warning 语义, 同样的展示阈值, 同一个状态目录 `scripts/.hx_code_quality/`.

## Finding

| 字段 | 类型 | 说明 |
|---|---|---|
| ruleId | string | 规则 ID, 见下表 |
| severity | `error` 或 `warning` | Error 阻断, Warning 只进 review |
| path | string | 仓库相对路径 |
| line | integer >= 1 | 行号 |
| message | string | 问题说明 |
| evidence | string | 证据; AI 发现附带 verifier 的理由 |
| fingerprint | string | `sha256(ruleId, path, anchor, content)` 前 24 位; 不只用行号 |
| origin | `new` 或 `historical` | 命中可信 baseline 的为 historical, 不阻断 |

代码: [context-cr/src/contract/finding.ts](../../context-cr/src/contract/finding.ts).

## 等级来源

- Error 只来自 L0 确定性检查. 只有 `origin: new` 的 Error 让 job 失败.
- AI 阶段 (finder -> verifier) 只产出 Warning (`CX-AI` 或 `CODE-AI`) 与补丁, 永远不让 job 失败.
- 规则自身崩溃产出 `tool-error` Error, 不能当作空诊断通过.
- 一次运行只跑一种 kind (`context` 或 `code`), 见 [双模式决策](../decisions/2026-10-25-dual-cr-kind.md).
  kind 决定用哪套 scope 与提示词, 不改变 Error/Warning 的等级语义.

## 规则表

### 上下文 CR (`kind: context`)

| ID | 等级 | 阶段 |
|---|---|---|
| HC-CONTEXT | Error | L0 |
| HC-BUDGET | Error | L0 |
| HC-DOCNAME | Error | L0 |
| CX-DEADREF | Error (链接) / Warning (反引号路径) | L0 |
| CX-SKILL | Error | L0 |
| CX-ORPHAN | Warning | L0 |
| CX-AI | Warning | AI |

### 代码 CR (`kind: code`)

| ID | 等级 | 阶段 | 判据 |
|---|---|---|---|
| CODE-AI | Warning | AI | diff 新增或修改的行存在真实缺陷, 且 verifier 无法反驳 |

代码 CR 的 finder 只报可被代码证实的缺陷: 逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界,
以及与既有设计相悖. 不报纯风格偏好, 不报未改动代码的既有问题, 不报无法从 diff 与仓库读出证据的猜测.
它不产出可自动推送的补丁分支: 代码改动需要人判断, 只给建议文本.

### 通用

| ID | 等级 | 阶段 |
|---|---|---|
| tool-error | Error | 任一 |

判据详见 [docs/architecture/context-cr.md](../architecture/context-cr.md) 的 L0 规则一节. HC 开头的规则与 hx-agent-code 规则目录同名同义.

## 报告文件

`scripts/.hx_code_quality/reports/context-review.json`:

```json
{
    "tool": "hx-context-review",
    "version": "0.3.0",
    "repo": "owner/name",
    "base": "<sha or empty>",
    "head": "<sha>",
    "ok": false,
    "counts": { "error": 0, "warning": 1, "blocking": 0 },
    "findings": [],
    "patches": [{ "fingerprint": "...", "diff": "diff --git ...", "applies": true }],
    "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0 },
    "durationMs": 0,
    "stages": { "base": "push before", "scope": "2 context file(s)", "ai": "1 confirmed, 1 rejected" },
    "rejections": [{ "path": "AGENTS.md", "title": "...", "reason": "verifier: still accurate" }]
}
```

`rejections` 是被确定性闸门或 verifier 驳回的 AI 候选及理由, 用于调提示词, 不计入 counts. `stages.ai` 写明确认数, 驳回数, 因候选上限或无法读取而未审的文件, 以及 incomplete 的原因. Markdown 版本在开头列出每个 stage 与驳回数.

Markdown 版本与 GitHub 评论遵守同一展示规则: 问题合计超过 10 条只列数量与类型统计, 不超过 10 条才逐条展开.

## 排序与稳定性

按 path, line, ruleId, fingerprint 排序, 不含时间戳与随机 ID (除 durationMs). Markdown 中转义控制字符.

## 规则维度 (2026-10-21)

规则引擎产出的事件在既有 finding 之上追加两个字段, 老字段不变:

```json
{ "ruleId": "ARCH-001", "severity": "error", "waived": false, "waiverReason": "" }
```

- `ruleId`: 规则命名空间 ARCH / STYLE / DOC / CTX / CI / META 加三位序号, 唯一事实源是 `context-cr/src/rules/registry.ts`, 不在别处拼字符串。
- `severity`: `error` 拦截 (退出码非零), `warning` 只汇总待 review。豁免后的条目进 `waived`, 不计入 counts。
- 规则表见 [rules.md](rules.md); 豁免登记格式与生效规则见该文档的豁免一节。
- 聚合口径: CF 侧按 `ruleId` 与 `severity` 分组统计, 字段名与本文一致。
