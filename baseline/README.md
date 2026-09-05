# 固定上游基线

`upstream/src/` 是 mem0 commit `dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3` 的逐文件原样副本。`upstream/source-manifest.json` 记录源代码校验，不修改 Memory 类、抽取 prompt 或排序算法。它只用于对照，不进生产镜像。

```sh
npm ci
MEM0_TELEMETRY=false MEM0_DIR=.data/config node --env-file=../../.env --import tsx server.ts
```

监听 127.0.0.1:8091，评测器仍仅通过 HTTP 通信。SDK 依赖单独锁定，保留 OpenAI 4 系列；额外安装 pg 是因为上游 factory 的静态加载需要它，运行仍用 SQLite。

输入转换：保留 role/content 和已有时间文本，**不向上游透传不支持的 timestamp 参数**；created_at 使用上游字段。选项只传给 Answer，未改上游检索。使用相同 nomic 权重，但原版 OpenAI embedding provider 不添加本项目的 nomic 查询/文档前缀；这是需要报告的差异。适配器限制 32 条/约 6000 token，提供进程内重试回执，不赋予原版持久幂等、同步多库事务或遗忘能力。

U0 固定上游与 U1 原样迁入副本可通过文件 hash 证明源内容一致；这不代表已经完成“拆分 Memory 编排但保留原算法”的 U1 行为等价实验。对应改造阶段仍需独立测试与报告。
