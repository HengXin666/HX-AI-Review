# cf-admin AGENTS

Cloudflare 侧代码. 设计见 [docs/architecture/cf-admin.md](../docs/architecture/cf-admin.md), 契约见 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml).

## 规则

- 路由 (`worker/routes/`) 只依赖 `worker/store/port.ts` 的 `Store` 与 `BlobStore` 接口, 不直接碰 D1 或 R2; 真实适配器在 `worker/store/d1.ts`, 测试用 `test/fake-store.ts`.
- Worker 永远不代理模型请求. 新增接口前先确认它属于配置, 入库或总览.
- api_key 不入 D1: providers.key_secret 只存 Worker secret 的名字.
- HX_CTX_TOKEN 只存 SHA-256; 明文只在创建或轮换时返回一次.
- /api/* 必须经过 `requireAdmin` (Cloudflare Access JWT 校验), 未配置 Access 时 fail closed.
- 禁用, 模式为 l0 或超预算的仓库, /init 只返回 L0 配置, 不带 api_url 与 api_key.
- 每次运行 (含 PR) 都计入预算; last_sha 只在 push 运行且 `complete` 不为 false 时推进.
- /runs 先完整校验再写 R2/D1; historical 发现不进入待处理列表.
- 部署只走 `scripts/deploy.ts` (由 deploy-cf 工作流调用); `wrangler.toml` 只是本地模板, 不放真实 id.
- 改 D1 结构只新增迁移文件, 不改已发布的迁移.
- 改接口同时改 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml) 与 `test/worker.test.ts`.

## 验证

```sh
pnpm --filter cf-admin typecheck && pnpm --filter cf-admin test && pnpm --filter cf-admin build
```
