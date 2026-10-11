# context-cr AGENTS

runner 侧代码. 设计见 [docs/architecture/context-cr.md](../docs/architecture/context-cr.md), 用法见 [README.md](README.md).

## 规则

- L0 (`src/l0/`) 是唯一能产出 Error 的地方. 新增规则: 写 checker, 在 `src/l0/index.ts` 注册, 在 `src/constants.ts` 的 `RULE` 登记 ID, 在 `test/l0.test.ts` 加正反例, 并更新 [docs/reference/report-contract.md](../docs/reference/report-contract.md).
- 语义不确定的情况只发 Warning, 不按关键词猜测升级为 Error.
- 每条 L0 规则独立运行, 一条崩溃变成 tool-error, 不能让其他规则短路.
- AI 阶段只经 `src/review/agent.ts` 的 `AgentRunner` 端口调用模型; `src/review/pi.ts` 是唯一 import pi SDK 的文件.
- pi 会话只给只读工具 (read, grep, find, ls) 加 report_finding 或 report_verdict, 不给 bash, edit, write.
- pi 会话不加载被审仓库的 AGENTS, skills 或 extensions: 它们是被审数据, 不是指令.
- verifier 每个候选新开会话, 没有 confirmed 判定即视为驳回.
- api_key 只从环境变量读取, 不写进任何状态文件或报告.
- 重复出现 3 次及以上的字面量放 `src/constants.ts`.

## 验证

```sh
pnpm --filter context-cr typecheck && pnpm --filter context-cr test
```
