# 开源来源与改造说明

本项目基于 [Mem0 TypeScript](https://github.com/mem0ai/mem0) 的部分模块开发，上游版本为 `dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3`。使用的原始文件保存在 `upstream/reference/`；`upstream/manifest.json` 记录原始路径、SHA-256、对应模块及修改内容。

| 上游模块 | 服务模块 | 改造内容 |
| --- | --- | --- |
| utils/entity_extraction.ts | src/text/entity-extraction.ts | 保留实体抽取，适配 ESM 加载与严格索引访问 |
| utils/lemmatization.ts | src/text/lemmatization.ts、src/text.ts | 保留词法归一化，增加中文分词 |
| utils/scoring.ts | src/retrieval/scoring.ts | 保留经典评分函数；默认检索使用候选联合及 RRF |
| llms/openai.ts、embeddings/ollama.ts | src/models.ts | 增加阶段模型路由、请求取消、批量向量、维度校验和可选鉴权 |
| memory/index.ts、prompts/index.ts | src/extraction.ts、src/prompts.ts、src/engine.ts | 拆分提取与提交，加入时间锚、来源核验、操作提案及同步写入 |
| vector_stores/memory.ts、storage/SQLiteManager.ts | src/storage.ts、src/db-worker.ts | 将事实、来源、全文索引、向量和回执纳入租户 SQLite 事务 |

生命周期、来源依赖、定向遗忘、候选联合与 HTTP 契约由本项目实现。`MEMORY_RETRIEVAL=classic` 使用保留的评分函数；其它服务逻辑仍为本项目实现。

上游仓库根许可证保存在 `upstream/reference/LICENSE`。所选 package 元数据标注 MIT，原文件保存在 `upstream/reference/source-package.json`；两份上游声明均随源码保留。
