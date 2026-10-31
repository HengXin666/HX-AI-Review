# 代码 CR: 意图, 删除行, 评论预算, 离线黄金集

2026-10-31

## 背景

code CR 是精度优先的 finder 然后 verifier. 它原先只给新增行编号, 纯删除和被删掉的文件不进 scope, 也不读 PR 说明. 发现没有类别和档位, 一条 PR 上的 nit 和缺陷占同样的评论位. 学习只有指纹抑制和一份全局提示词附录. 没有可以复现的召回评测.

## 决定

- 删除行用旧侧行号, 正文写成 `L<old>`, 行评用 GitHub 的 LEFT. 同一个 hunk 里没被改动、但旁边有删除的上下文行可以报在新侧. 纯新增 hunk 里的上下文行仍然不能报.
- 意图卡由 runner 从 PR 标题, 正文, 关联 issue 和 `git log` 拼出来, 作为不可信数据放进 finder 和 verifier. 是否偏离由模型判断, 闸门只核对引用.
- Finding.severity 保持 Warning. grade (`critical` / `major` / `minor` / `nit`) 只用于每 PR 最多 5 条的评论预算. 有更高档时 nit 不发表.
- 同一条驳回理由出现至少两次, 就收成一条仓库规则写进下一次 finder 提示词. resolution rate 是采纳 / (采纳 + 驳回), 没有反馈时为 null.
- 离线评测重放真实流水线, 模型侧用钉死的回放稿. 每次结果带 promptHash 和 configHash. CI 不调用托管模型.

## 为什么评测不直接打模型

托管模型的输出不稳定, 也需要 key. 回放稿让闸门, 意图卡注入, 删除行可见性和评论预算可以被单测锁住: 提示词里少了约定的句子, 或预算把 critical 裁掉, recall 和 critical miss 会变. 这量的是这条流水线, 不是某个模型当天的召回. 接模型是下一步, 不是这一步的替代品.

## 不做什么

- 不把 grade 提升成 Error, 也不让 code CR 把 job 打红.
- 不把 grade 写进指纹, 避免一次改档就躲开抑制.
- 不在 `/init` 里新增 resolution rate 字段. 反馈已经在 D1, 比率函数在 runner, 等总览要展示时再加响应字段.
