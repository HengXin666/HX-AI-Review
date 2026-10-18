# 决策: 多轮审查, 证据包, 提示词附录与密码登录

日期: 2026-10-18. 状态: 采纳.

## 决策

- finder 额外看到有界证据包: 本地 import 边, git grep 引用方, 最近 N 个相关 PR 与 issue. 失败不让审查失败. 证据当不可信数据, 先于 diff 被截断.
- 同一 PR 的后续提交把未再出现的 open 发现标为 resolved. 不完整或仅 L0 的运行不解决 CX-AI, 因为模型没有复查. push 不解决历史发现.
- 驳回原因继续进抑制表, 同时进 prompt_notes. 操作者发布的是附录, 追加在内置系统提示之后, 不能把 AI 输出变成 Error.
- 总览页使用 @hx/ui. 登录凭证放在 Worker 变量, 默认 admin / hx-context-review, 部署可用 HX_ADMIN_USER 与 HX_ADMIN_PASSWORD 覆盖. Access 身份仍然优先.

## 不采纳

- 用附录替换整个系统提示: 一次错误发布就能让模型无视 Error 边界.
- 不完整运行也把 CX-AI 标为 resolved: 模型没看过的问题会被错误地当成已修复.
