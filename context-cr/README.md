# context-cr

hx-context-review 的 runner 侧. 由 [review.yml](../.github/workflows/review.yml) 在业务仓库的 Actions 里按步骤调用, 也可本地一次跑完.

| 命令 | 步骤 | 产物 |
|---|---|---|
| `node src/cli.ts init` | 2 init: GET /init, `::add-mask::` api_key, 存入 RUNNER_TEMP 下 0600 文件 | `init.json` (不含 key), output `l0_only` |
| `node src/cli.ts l0` | 3 L0 确定性检查, 新 Error 退出 1 | `l0.json`; `--format findings` 输出 Finding 数组 |
| `node src/cli.ts scope` | 4 context_scope: diff -> 祖先 AGENTS 链 + 反向引用 | `scope.json`, output `empty` |
| `node src/cli.ts review` | 5 pi finder -> verifier, 读取并删除 key 文件 | `ai.json`, `sessions.jsonl` |
| `node src/cli.ts publish` | 6 入库 + 回写: POST /runs, 推补丁分支, commit/PR 评论 | `context-review.md` 与 `context-review.json` |
| `node src/cli.ts run` | 2 到 6 一次跑完 | 同上 |

中间状态写在 `RUNNER_TEMP` (本地为系统临时目录) 下的 `hx-context-review/<仓库路径哈希>/`, 不在被审仓库里; 最终报告写在 `scripts/.hx_code_quality/reports/context-review.{md,json}`, 与 hx-agent-code 同一状态目录与报告契约.

## 环境变量

| 变量 | 用途 |
|---|---|
| `HX_CTX_ENDPOINT` | CF Worker 基础 URL |
| `HX_CTX_TOKEN` | 每仓一个的访问令牌, 只用于 /init 与 /runs |
| `HX_CTX_API_KEY` | 可选, 设置时优先于 key 文件 (key 文件照样删除). review 仍需要一次非 L0 的 init 状态, 所以本地流程是: 设好 HX_CTX_ENDPOINT/HX_CTX_TOKEN 跑 init, 再跑 review |
| `RUNNER_TEMP` | Actions 自带, 状态目录的根 |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH` | Actions 自带, 用于范围计算, 推补丁和评论 |

## 仓库级配置

业务仓库根目录可放 `.hx-context-review.json`, 字段见 `src/config.ts`: `skillRoots`, `concurrentSkills`, `orphanRoots`, `exclude`, `scopeIgnore`, `virtualPaths`, `baseline`.

## 代码结构

- `src/l0/`: HC-CONTEXT, HC-BUDGET, HC-DOCNAME, CX-DEADREF, CX-SKILL, CX-ORPHAN
- `src/scope/`: 审核区间基点与受影响上下文计算
- `src/review/`: finder/verifier 编排 (`index.ts`), pi SDK 适配 (`pi.ts`), 工具与提示词
- `src/publish/`: POST /runs, 补丁分支, 评论渲染
- `src/contract/`: Finding 与报告, 与 hx-agent-code 同一契约

设计说明见 [docs/architecture/context-cr.md](../docs/architecture/context-cr.md).

## 测试

```sh
pnpm --filter context-cr test
```

`test/pi.test.ts` 起一个本地 OpenAI 兼容服务, 用真实 pi SDK 验证直连 api_url 与 report_finding 工具调用.
