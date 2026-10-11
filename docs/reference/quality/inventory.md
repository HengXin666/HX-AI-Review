# 质量门禁清单 (hx-agent-code)

本仓库按 hx-agent-code 初始化. 技能固定版本 vendor 在 `.agents/skills/hx-agent-code/` (来源 HengXin666/HXLoLis 提交 0a3f736), 运行期依赖 hx-agent-notes 同样 vendor 在 `.agents/skills/hx-agent-notes/`.

流水线与每项检查的说明见 [pipeline.md](pipeline.md). 逐规则裁决见 `scripts/quality/coverage.json`. 本次是首轮安装, 只有部分规则已实现, 其余标 blocked 并写明原因, 不冒充已完成.

## 事实

| 项 | 值 |
|---|---|
| 托管 | GitHub, HengXin666/HX-AI-Review, 默认分支 main |
| 包管理 | pnpm workspace (`context-cr`, `cf-admin`), 版本见根 package.json 的 packageManager |
| 运行时 | Node 22.19+ (pi SDK 要求), 原生类型剥离运行 TS |
| 语言 | TypeScript; 没有 Python |
| 格式 | prettier, 4 空格, 行宽 120 (`.prettierrc.json`) |
| 类型 | tsc strict, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly` |
| 测试 | `node --test`, 每个包一个测试 ID, 见 `scripts/quality/graph.ts` |
| CI | `.github/workflows/quality-{code,docs,build,tests}.yml`, 配置 `scripts/quality/ci.json` |
| 协作 | `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`, `CONTRIBUTING.md` |

## 技术栈裁决 (HC-STACK)

- Worker 用 TypeScript: Cloudflare Workers 的原生语言, 不适用 Python + FastAPI 推荐.
- runner 用 TypeScript: pi coding agent SDK 只提供 TS/Node 接口.
- 总览页用 React + TS + pnpm + Vite, 符合新前端规定.

## 依赖 (HC-DEPS, 待批准)

| 依赖 | 包 | 用途 |
|---|---|---|
| @earendil-works/pi-coding-agent 1.1.0 | context-cr | finder/verifier 会话 (用户指定基于 pi 实现) |
| typebox 1.3.27 | context-cr | 工具参数 schema, 与 pi 使用同一版本 |
| react, react-dom 19.3.0 | cf-admin | 总览页 |
| vite 8.3.4, @vitejs/plugin-react 6.1.2 | cf-admin (dev) | 总览页构建 |
| wrangler 4.149.0, @cloudflare/workers-types | cf-admin (dev) | Worker 开发与部署 |
| typescript 5.9.3, prettier 3.9.10, @types/* | dev | 类型检查与格式 |

## 已实现

- HC-CONTEXT, HC-BUDGET, HC-DOCNAME: 由本仓库自己的 `context-cr l0` 实现, 接入 `quality-docs` 组, 正反例在 `context-cr/test/l0.test.ts`.
- 代码组: `pnpm -r typecheck` 与 `prettier --check`.
- 构建组: 总览页 Vite 构建, 产物交给测试组.
- 测试组: context-cr 与 cf-admin 两个测试 ID, 静态影响图.

## 未完成 (blocked)

AST 类规则 (HC-BOUNDARY, HC-DATA, HC-CYCLE, HC-LITERAL, HC-ABSPATH), lint (HC-LINT, 需批准 eslint), 文本类 (HC-TEXT, HC-DOCSIZE, HC-COMMENT), HC-NOTES 接线, HC-PERF 预算, HC-CONTRACT 契约测试, 元门禁 HC-META, Agent/Git hooks. 原因逐条见 coverage.json.
