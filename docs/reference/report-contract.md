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
- AI 阶段 (finder -> verifier) 只产出 Warning (`CX-AI`) 与补丁, 永远不让 job 失败.
- 规则自身崩溃产出 `tool-error` Error, 不能当作空诊断通过.

## 规则表

| ID | 等级 | 阶段 |
|---|---|---|
| HC-CONTEXT | Error | L0 |
| HC-BUDGET | Error | L0 |
| HC-DOCNAME | Error | L0 |
| CX-DEADREF | Error (链接) / Warning (反引号路径) | L0 |
| CX-SKILL | Error | L0 |
| CX-ORPHAN | Warning | L0 |
| CX-AI | Warning | AI |
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
