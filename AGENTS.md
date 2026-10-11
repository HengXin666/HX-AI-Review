# AGENTS

本仓库是 hx-context-review: 检查业务仓库的 AI 上下文文件是否与代码一致. 改动前先读 [docs/architecture/overview.md](docs/architecture/overview.md).

## 边界

- `context-cr/` 只在 GitHub Actions runner 里运行, 读 checkout 下来的文件, 用 pi SDK 直连模型. 它不依赖 `cf-admin/` 的任何代码, 两边只通过 [docs/reference/api/cf-admin.yaml](docs/reference/api/cf-admin.yaml) 的 HTTP 契约对接.
- `cf-admin/` 是 Cloudflare Worker + D1 + R2 + Pages. 它永远不转发模型请求, 只下发配置, 入库, 提供总览.
- Error 只来自 L0 确定性检查; AI 阶段只产出 Warning 与补丁. 改规则等级前先改 [docs/reference/report-contract.md](docs/reference/report-contract.md).
- api_key 只能出现在 /init 响应, runner 的 0600 临时 key 文件 (review 读后即删) 与 review 进程里; 不进 `$GITHUB_ENV`, 不入 D1, 不进日志.

## 约定

- TypeScript, Node 原生类型剥离运行 (`node file.ts`), import 带 `.ts` 后缀, 不写 enum, namespace 或构造参数属性.
- 4 空格缩进, 行宽 120, 控制语句体不写在同一行; `pnpm format` 统一格式.
- 文档与注释用中文或英文, 标点只用 ASCII, 不用 emoji.
- 新文档放 `docs/` 下, 文件名小写 kebab; 当前事实写 reference, 原因写 decisions, 不建 v2 副本.
- 每个含 README.md 或 AGENTS.md 的目录两者成对; AGENTS.md 少于 150 行.

## 代码质量

- 质量流水线, 每项检查验证什么, 以及改动时要同步什么, 都在 [docs/reference/quality/pipeline.md](docs/reference/quality/pipeline.md). 改 `scripts/quality/`, quality 工作流, L0 规则或格式/类型配置前先读它, 并在同一次改动里更新它; 漏改由 HX-DOCLINK 检查拦下.
- 新增"改了 X 就要改文档 Y"的约束时, 登记到 `scripts/quality/doc-links/links.json`.

## 完成前

```sh
pnpm typecheck && pnpm test && pnpm l0 && pnpm format:check && pnpm doc-links
```

门禁报告写在 `scripts/.hx_code_quality/reports/`, 超过 10 条只看数量与类型统计.

## 子目录

- [context-cr/AGENTS.md](context-cr/AGENTS.md)
- [cf-admin/AGENTS.md](cf-admin/AGENTS.md)
