# 源码来源与改造范围

本项目选用的上游为 [Mem0 TypeScript 开源代码](https://github.com/mem0ai/mem0)，commit `dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3`。原文件 SHA-256 及改动记录位于 `upstream/manifest.json`。运行模块按职责放在 `src/text/`、`src/retrieval/` 等位置；原始来源与许可放在 `upstream/reference/`，完整对照代码单独放在 `baseline/upstream/`。

| 上游模块 | 本项目运行模块 | 处理 |
|---|---|---|
| utils/entity_extraction.ts | src/text/entity-extraction.ts → src/text.ts | 直接保留实体抽取；修改 ESM 可选依赖加载与严格索引访问 |
| utils/lemmatization.ts | src/text/lemmatization.ts → src/text.ts | 保留词法归一化，新增中文分词通路 |
| utils/scoring.ts | src/retrieval/scoring.ts → src/retrieval.ts | 保留原评分函数作为经典评分对照；主候选使用联合候选与 RRF |
| llms/openai.ts、embeddings/ollama.ts | src/models.ts | 源码适配为显式模型、取消传播、真正批量向量、维度验证，无自动下载 |
| memory/index.ts、prompts/index.ts | src/extraction.ts、prompts.ts、engine.ts | 重构 additive pipeline：时间锚点、具名参与者、来源校验、操作提案、同步提交 |
| vector_stores/memory.ts、storage/SQLiteManager.ts | src/storage.ts、db-worker.ts | 替换分散存储为租户 SQLite 原子事务；向量、全文、回执、来源同事务 |

主 Memory 类已被拆分重构，没有把上游类套一层 API 后称为自研。核心生命周期、来源依赖、检索候选联合与 HTTP 契约是本项目的改动。`MEMORY_RETRIEVAL=classic` 仅复用原评分函数，**不等于完整未修改的 mem0 基线**；完整基线需另外执行并记录。

许可证：上游仓库根 LICENSE 原文保存在 `upstream/reference/LICENSE`；所选 mem0-ts package 元数据另标 MIT，保留在 `upstream/reference/source-package.json`。交付保留两份声明及明确来源，不擅自用单一标记消除上游元数据差异。
