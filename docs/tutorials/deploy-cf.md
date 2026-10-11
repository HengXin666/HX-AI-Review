# 部署 Cloudflare 侧

在 `cf-admin/` 目录执行. 需要 Cloudflare 账号与 wrangler 登录 (`pnpm exec wrangler login`).

## 1. D1 与 R2

```sh
pnpm exec wrangler d1 create hx-context-review     # 把 database_id 填进 wrangler.toml
pnpm exec wrangler r2 bucket create hx-context-review
pnpm db:migrate
```

## 2. 模型 provider 与 key

key 放 Worker secret, D1 只记 secret 名:

```sh
pnpm exec wrangler secret put PROVIDER_DEFAULT_KEY
```

部署后通过管理接口登记 provider (OpenAI 兼容用 `openai-completions`, Anthropic 兼容用 `anthropic-messages`):

```sh
curl -X PUT https://review.example.com/api/providers/default \
  -H "cf-access-token: $CF_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"apiUrl":"https://api.example.com/v1","api":"openai-completions","keySecret":"PROVIDER_DEFAULT_KEY","contextWindow":128000}'
```

## 3. Worker

在 `wrangler.toml` 填 `routes`, 把 `/init`, `/runs`, `/feedback`, `/api/*` 挂到同一域名, 然后:

```sh
pnpm deploy:worker
```

## 4. Pages 总览页

```sh
pnpm deploy:pages
```

把 Pages 项目绑定到同一域名的根路径.

## 5. Access

1. Zero Trust -> Access -> Applications 新建 Self-hosted 应用, 域名为总览页域名, 策略只允许管理员.
2. 为 `/init`, `/runs`, `/feedback` 三个路径建 Bypass 策略 (它们由 HX_CTX_TOKEN 鉴权).
3. 把应用的 AUD tag 与团队域名写进 `wrangler.toml` 的 `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, 重新部署 Worker.

没有这两个变量时 /api/* 一律 403.

## 6. 发布可复用 workflow 版本

调用方引用 `review.yml@v1`. 在本仓库 main 上打 tag:

```sh
git tag -f v1 && git push -f origin v1
```
