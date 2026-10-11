# cf-admin AGENTS

Cloudflare 侧代码. 设计见 [docs/architecture/cf-admin.md](../docs/architecture/cf-admin.md), 契约见 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml).

## 规则

- 路由 (`worker/routes/`) 只依赖 `worker/store/port.ts` 的 `Store` 与 `BlobStore` 接口, 不直接碰 D1 或 R2; 真实适配器在 `worker/store/d1.ts`, 测试用 `test/fake-store.ts`.
- Worker 永远不代理模型请求. 新增接口前先确认它属于配置, 入库或总览.
- api_key 不入 D1: providers.key_secret 只存 Worker secret 的名字.
- HX_CTX_TOKEN 只存 SHA-256; 明文只在创建或轮换时返回一次.
- /api/* 必须经过 `requireAdmin` (Cloudflare Access JWT 校验), 未配置 Access 时 fail closed.
- 禁用, 模式为 l0 或超预算的仓库, /init 只返回 L0 配置, 不带 api_url 与 api_key.
- PR 运行不推进 last_sha; last_sha 只跟随被 push 的分支历史.
- 改 D1 结构只新增迁移文件, 不改已发布的迁移.
- 改接口同时改 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml) 与 `test/worker.test.ts`.

## 验证

```sh
pnpm --filter cf-admin typecheck && pnpm --filter cf-admin test && pnpm --filter cf-admin build
```
