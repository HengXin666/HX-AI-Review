# cf-admin

hx-context-review 的 Cloudflare 侧: 配置下发, 入库, 总览. 不转发任何模型请求.

| 部分 | 路径 | 说明 |
|---|---|---|
| Worker | `worker/index.ts` | /init 配置下发, POST /runs 入库, POST /feedback 采纳或驳回, /api/* 管理接口 |
| D1 | `migrations/0001_init.sql` | providers, repos (含开关, 模式, 预算, last_sha), runs, findings, feedback, suppressions |
| R2 | `worker/store/d1.ts` 的 `R2Blobs` | `runs/<repo>/<run>/report.md`, `report.json`, `sessions.jsonl`, `patches/<fingerprint>.diff` |
| Pages | `pages/` | 总览页 (React + TS + Vite), 由 Cloudflare Access 保护 |

HTTP 契约见 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml), 设计见 [docs/architecture/cf-admin.md](../docs/architecture/cf-admin.md), 部署见 [docs/tutorials/deploy-cf.md](../docs/tutorials/deploy-cf.md).

## 本地

```sh
pnpm --filter cf-admin exec wrangler d1 migrations apply hx-context-review --local
pnpm --filter cf-admin dev:worker   # Worker, 默认 127.0.0.1:8787
pnpm --filter cf-admin dev:pages    # 总览页, /api 代理到本地 Worker
pnpm --filter cf-admin test
```

本地没有 Access 时 /api/* 一律返回 403, 这是设计上的 fail closed.
