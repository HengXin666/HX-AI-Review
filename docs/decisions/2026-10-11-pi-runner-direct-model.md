# 决策: pi 在 runner 直连模型, CF 只做配置, 存储与总览

日期: 2026-10-11. 状态: 采纳. 对应架构图 v0.3, 见 [overview.md](../architecture/overview.md).

## 背景

上下文 review 需要读整棵仓库 (祖先 AGENTS 链, 被引用的代码, diff). 同时需要集中管理模型 key, 预算, 开关与历史结果.

## 决策

- 计算在 GitHub Actions runner: checkout 完整历史, L0, context_scope, pi finder -> verifier 全部在 runner 内完成.
- 模型由 pi coding agent SDK (`@earendil-works/pi-coding-agent`) 直连 api_url, 不经过 CF.
- CF Worker 只做三件事: /init 按仓下发 api_url + api_key + 模型分级; /runs 与 /feedback 入库到 D1/R2; 总览页 (Pages + Access).
- 仓库里只放 HX_CTX_TOKEN.
- Error 只来自 L0, AI 只出 Warning + 补丁.

## 备选方案

- 什么都不做, 继续人工 review 上下文: 零成本, 但上下文过时没有任何信号, 正是要解决的问题. 否决.
- 复用 hx-agent-code 现有的文档门禁: 它已覆盖 HC-CONTEXT/BUDGET/DOCNAME 等确定性规则, 最强理由是不重复造轮子; 但它没有语义层, 判断不了 "陈述是否仍然为真". 采纳其报告契约与规则 ID, 在其上增加 AI 层, 而不是替代它.
- 模型请求经 CF Worker 代理: 最强理由是 key 永不离开 CF. 但 Worker 需要仓库内容, 要么把代码上传到 CF, 要么让 Worker 反向读 GitHub, 都比在 runner 里读 checkout 更慢更贵, 并且 Worker 的 CPU 与时长限制不适合多轮工具调用. 否决; 改为 key 在 runner 内 mask 且只存在于环境变量.
- 每个业务仓库自己放模型 key: 最强理由是最简单. 但换模型, 轮换 key, 停用, 预算都要逐仓改 secret. 否决.
- 让 AI 也能产出 Error: 最强理由是能拦更多问题. 但模型结论不确定, 会让 CI 变得不可重复. 否决, AI 只出 Warning, 由 verifier 反驳过滤.

## 后果

- runner 需要 Node 22.19+ 与 pnpm 安装 pi SDK, 每次运行有几十秒安装开销.
- fork PR 拿不到 HX_CTX_TOKEN, 不会运行 review.
- last_sha + concurrency 共同保证区间不漏不重.
