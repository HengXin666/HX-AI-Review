# 代码 CR 离线评测

黄金集在 `context-cr/eval/golden/v1/`. 运行器是 code CR 的真实流水线 (`computeCodeScope` 然后 `runReview`): scope, 意图卡, 确定性闸门, verifier, 评论预算都走生产代码. 模型侧是每个样例里钉死的回放稿, 不调用托管模型, 所以没有 key 也能复现.

```sh
pnpm --filter context-cr eval
```

stdout 是一份 JSON. `criticalMisses > 0` 时退出码为 1. `pnpm --filter context-cr test` 里的 `test/eval.test.ts` 锁住起始集的指标, 改坏闸门或预算会让它失败.

## 记什么

| 字段 | 含义 |
|---|---|
| `dataset` | 清单里的 `version`, 当前是 `v1` |
| `mode` | `replay`. 换托管模型时改成该模型 id, 并换掉回放稿 |
| `models` | 本模式固定 `{ finder: "replay", verifier: "replay" }` |
| `promptHash` | `CODE_FINDER_SYSTEM` 与 `CODE_VERIFIER_SYSTEM` 的 sha256 前 16 位. 改提示词就会变 |
| `configHash` | 数据集版本, 样例 id, 评论预算, 模型名和钉死的 limits 的 sha256 前 16 位 |
| `precision` | 命中的发表发现 / 全部发表发现. 没有发表发现时记 1 |
| `recallByCategory` | 每个类别 `hit / expected`. 类别是 `intent`, `breaking`, `stability`, `security`, `other` |
| `falsePositiveRate` | 期望零发现的样例里, 发表了至少一条的比例 |
| `criticalMisses` | 期望 grade 为 `critical` 但没有被发表的条数 |
| `findingsPerPr` | 发表发现总数 / 样例数, 用来看噪声 |

匹配是一对一的: `path`, `category`, `grade` 都要相同, `titleIncludes` 还要出现在 finding 的 message 里. 降级再发表算 miss, 不算命中. 多出来的发表发现算 false positive.

## 起始集

十个样例, 覆盖意图漂移 (金额单位), 破坏性变更 (删掉回填, 浮点累加金额, 删掉未支付守卫文件), 稳定性 (空引用, 监听器泄漏, 共享计数竞争, 以及一条混在 nit 里的空引用), 安全 (SQL 拼接), 和一条只改名的干净样例.

干净样例的回放稿会报一条低置信度 nit. 评论预算必须把它丢掉, 否则 false-positive rate 上升. `nit-flood` 在一条 critical 旁边报三条 nit, 只允许发表 critical.

回放稿可以要求提示词里出现某句话 (`requires`). 意图样例要求意图卡原文, 删除文件样例要求 diff 里的符号, 竞争样例要求系统提示里的 `concurrency and resources`. 这些句子不见了, 对应的 recall 就会掉下来.

## 加一条样例

1. 在 `context-cr/eval/golden/v1/` 新建 `<id>.json`, 不要改已有样例的 id.
2. 把它的文件名加进同目录 `manifest.json` 的 `cases`. 改了清单或样例, `configHash` 会变, 这是预期的.
3. 字段:

```json
{
    "id": "short-name",
    "note": "why this case exists",
    "path": "src/file.ts",
    "status": "M",
    "diff": "diff --git ...",
    "intent": {
        "source": "pull_request",
        "title": "",
        "body": "",
        "commits": [],
        "issues": []
    },
    "replay": {
        "finder": [
            {
                "path": "src/file.ts",
                "line": 2,
                "side": "right",
                "title": "short title",
                "message": "what is wrong",
                "evidence": "`a quote of at least 8 characters from the diff`",
                "category": "stability",
                "grade": "major",
                "confidence": 0.9,
                "repro": "the input that triggers it",
                "requires": "optional substring of the system prompt or the user prompt"
            }
        ],
        "verdicts": { "short title": "confirmed" }
    },
    "expect": [{ "category": "stability", "grade": "major", "path": "src/file.ts", "titleIncludes": "short" }]
}
```

`status` 缺省 `M`. 删文件用 `D`, 行号用旧侧行号, `side` 用 `left`. `intent` 可以省略. `expect` 为空表示这条 PR 不该发表任何发现.

`evidence` 里的反引号引用必须真实出现在 hunk 正文或被审文件里, 否则闸门会在 verifier 之前丢掉它, 这条期望就变成 miss. `verdicts` 里没有的标题按 rejected 处理.

4. 跑 `pnpm --filter context-cr test`, 按新的 precision, recall 和 critical miss 改 `test/eval.test.ts` 里的断言. 不要为了让断言继续是 1 而放宽匹配.

设计见 [agent-review.md](../architecture/agent-review.md). 取舍见 [2026-10-31-code-review-eval.md](../decisions/2026-10-31-code-review-eval.md).
