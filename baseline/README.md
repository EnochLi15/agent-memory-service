# 固定上游基线

`upstream/src/` 是 mem0 commit `dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3` 的逐文件原样副本。`upstream/source-manifest.json` 记录源代码校验，不修改 Memory 类、抽取 prompt 或排序算法。它只用于对照，不进生产镜像。

```sh
npm ci
MEM0_TELEMETRY=false MEM0_DIR=.data/config node --env-file=../../.env --import tsx server.ts
```

监听 127.0.0.1:8091，评测器仍仅通过 HTTP 通信。SDK 依赖单独锁定，保留 OpenAI 4 系列；额外安装 pg 是因为上游 factory 的静态加载需要它，运行仍用 SQLite。

输入转换：保留 role/content 和已有时间文本，**不向上游透传不支持的 timestamp 参数**；created_at 使用上游字段。选项只传给 Answer，未改上游检索。使用相同 nomic 权重，但原版 OpenAI embedding provider 不添加本项目的 nomic 查询/文档前缀；这是需要报告的差异。适配器限制 32 条/约 6000 token，提供进程内重试回执，不赋予原版持久幂等、同步多库事务或遗忘能力。

U1 通过 `node prepare-u1.mjs` 从固定副本机械生成：将 `addToVectorStore` 和 `search` 方法体移入独立模块，保留字节内容、this 绑定和公共辅助函数身份。生成文件位于 `.data/u1`，原版源码不变。测试工具单独固定 TypeScript 5.9.3 的 AST API，生产构建仍使用 TypeScript 7.0.2。

运行 `MEM0_TELEMETRY=false MEM0_DIR=.data/config node --import tsx parity.ts`，比较两实现的真实 SQLite 写入、抽取提示词、去重、追加更新、三组带分数检索、隔离及参数拒绝。测试用确定性模型替身，证明这些路径的重构等价；公开模型质量仍由独立 HTTP 评测衡量。

本次远端网关会断开原版长非流式请求。`eval/scripts/streaming-gateway.py` 是实验传输桥接：保持模型、messages 和其他参数，将远端 SSE 还原为 OpenAI JSON。U0/U1 公平对照均通过此桥接；直接调用原网关失败的原始 U0 记录另行保留。桥接不赋予上游任何新增记忆能力。
