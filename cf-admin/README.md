# cf-admin

hx-context-review 的 Cloudflare 侧: 配置下发, 入库, 总览. 不转发任何模型请求.

| 部分 | 路径 | 说明 |
|---|---|---|
| Worker | `worker/index.ts` | /init 配置下发, POST /runs 入库, POST /feedback 采纳或驳回, /api/* 管理接口 (含 GET /api/rules 规则聚合) |
| D1 | `migrations/0001_init.sql` 至 `0004_rule_results.sql` | providers, repos (含开关, 模式, 预算, last_sha), runs, findings, feedback, suppressions, prompt_versions, prompt_notes, rule_results |
| R2 | `worker/store/d1.ts` 的 `R2Blobs` | `runs/<repo>/<run>/report.md`, `report.json`, `sessions.jsonl`, `patches/<fingerprint>.diff` |
| 总览页 | `pages/` | React + TS + Vite 单页, 由 Cloudflare Access 或密码登录保护; 含按规则 id 与严重级的聚合视图. 构建产物作为 Worker 静态资源 (`[assets]`) 一起部署, 与 `/api/*` 同域, 不再单独部署 Pages |
| 部署 | `scripts/deploy.ts` | 由 [deploy-cf.yml](../.github/workflows/deploy-cf.yml) 手动触发的一键部署 |

HTTP 契约见 [docs/reference/api/cf-admin.yaml](../docs/reference/api/cf-admin.yaml), 设计见 [docs/architecture/cf-admin.md](../docs/architecture/cf-admin.md), 部署见 [docs/tutorials/deploy-cf.md](../docs/tutorials/deploy-cf.md).

## 规则维度

`rule_results` 每个运行的每个规则命中一行: `run_id`, `rule_id`, `severity`, `file`, `line`, `status`, `waived`. `POST /runs` 与 findings 同批写入; 人工驳回把对应行标为 `rejected` 并置 `waived = 1`, 后续提交把它标为 `resolved`. `waived` 表示已判定不处理, 仍计入命中总数.

`GET /api/rules` (Access 或会话 cookie) 按规则 id 与严重级聚合:

| 参数 | 说明 |
|---|---|
| `repo` | `owner/repo`, 只看一个仓库; 未登记的名字返回 404 |
| `severity` | `error` 或 `warning`, 只看一个等级 |
| `limit` | 返回的规则条数, 1..200, 默认 50 |

响应中 `total` 与 `waived` 覆盖全部命中, `byRule` 按命中数降序 (最多 `limit` 条), `bySeverity` 给出每个等级的命中数与规则数, `topRule` 是最常触发的规则 id. 规则 id 使用仓库统一命名空间: `ARCH-001`..`ARCH-004`, `STYLE-001`..`STYLE-004`, `DOC-001`..`DOC-002`, `CTX-001`..`CTX-002`, `CI-001`, `TEST-001`..`TEST-006`, `META-001`; 其他 id 照常聚合, 不改写.

`0004_rule_results.sql` 可重复执行: 建表与索引都用 `IF NOT EXISTS`, 回填用 `INSERT OR IGNORE`, 重复执行不报错也不重复插入. 手动重放:

```sh
pnpm --filter cf-admin exec wrangler d1 execute hx-context-review --remote --file migrations/0004_rule_results.sql
```

## 本地

```sh
pnpm --filter cf-admin exec wrangler d1 migrations apply hx-context-review --local
pnpm --filter cf-admin dev:worker   # Worker, 默认 127.0.0.1:8787
pnpm --filter cf-admin dev:pages    # 总览页热更新, /api 代理到本地 Worker (仅本地开发)
pnpm --filter cf-admin test
```

本地没有 Access 时 /api/* 一律返回 403, 这是设计上的 fail closed.
