# 模型与运行配置

## 1. 两种运行配置

| 配置 | Add | Search | 模型依赖 |
| --- | --- | --- | --- |
| `configs/release-offline.env`（默认） | 规则提取 | 词法检索 | 无 |
| `configs/release-enhanced.env` | 模型提取、核验、修复，生成事实/原文向量 | 混合检索，生成查询向量 | LLM + Ollama Embedding |

调用条件由 `src/extraction.ts`、`src/engine.ts` 控制：offline 不请求模型；enhanced 的 Add 在有待存事实或原文时生成向量，Search 在检索方式不是 lexical 时请求查询向量。仅将检索方式改为 lexical，不会关闭 enhanced 的 Add 向量调用。

下文命令在服务工程根执行；提交包中对应 `solution/code/`。

## 2. 模型资源参数

| 环境变量 | 配置值/填写要求 | 用途 |
| --- | --- | --- |
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容地址，包含 `/v1` | LLM 服务入口 |
| `MEMORY_LLM_API_KEY` | 部署环境提供；本地免鉴权服务可留空 | LLM 鉴权 |
| `MEMORY_LLM_MODEL` | `gpt-5.4-mini` | 通用默认模型；可选重排/查询焦点模型 |
| `MEMORY_EXTRACTION_MODEL` | `gpt-5.5` | 事实与操作提取 |
| `MEMORY_VERIFICATION_MODEL` | `gpt-5.5` | 来源、授权、擦除及状态转移核验 |
| `MEMORY_REPAIR_MODEL` | `gpt-5.5` | 定向修复 |
| `MEMORY_LLM_REASONING_EFFORT` | `low` | 推理参数，须由所选端点支持 |
| `MEMORY_EMBEDDING_BASE_URL` | Ollama 服务地址，不带 `/v1` | `/api/tags`、`/api/embed` 入口 |
| `MEMORY_EMBEDDING_API_KEY` | 可选；不为空时使用 Bearer 鉴权 | Embedding 网关凭据 |
| `MEMORY_EMBEDDING_MODEL` | `nomic-embed-text:latest` | 向量模型 |
| `MEMORY_EMBEDDING_DIMENSIONS` | `768` | 校验向量长度 |
| `MEMORY_EMBEDDING_DIGEST` | 加载模型的 digest，随包固定值见下文 | 校验模型权重身份 |

提取、核验和修复可填写不同模型名，共用 LLM 端点与凭据。阶段模型未设置时使用通用模型。默认关闭 `MEMORY_RERANK` 和 `MEMORY_QUERY_FOCUS`，因而不会调用对应的通用模型路径。

随包 Embedding 摘要为：

```text
0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f
```

部署前须预置相应模型，核对 `/api/tags` 返回的名称及 digest。若部署不同权重，应同时修改模型名、维度和 digest，并使用新数据目录。digest 留空可以关闭权重校验，维度检查仍生效。Embedding 接口采用 Ollama 协议，不能直接将地址替换为 OpenAI `/embeddings` 地址。

## 3. 从源码启动模型模式

在服务工程根安装依赖、编译，并准备模型资源文件：

```sh
npm ci
npm run build
cp configs/models.env.example .env.models
# 在 .env.models 中填写模型服务地址、模型名及凭据。
HOST=0.0.0.0 PORT=8080 npm run start:enhanced
```

`start:enhanced` 先读取 `configs/release-enhanced.env`，再读取 `.env.models`；后者覆盖模型资源参数。操作系统环境变量优先级最高。模型运行在同机时，地址可用 `http://127.0.0.1:8080/v1` 与 `http://127.0.0.1:11434`；如果 LLM 已占用 8080，记忆服务应改用 `PORT=8091` 或其它空闲端口。远程模型填写服务可达的内网地址。

也可以复制完整 `.env.example` 为 `.env`，填写参数后执行 `npm start`。两种方式均运行编译后的 `dist/server.js`，停止服务使用 Ctrl+C。

实际模型名必须能被所配置的服务识别。LLM 端点需支持流式 Chat Completions 以及配置使用的 `json_schema` / reasoning 参数。模型模式的降级更新存在已知限制，见 [VALIDATION.md](VALIDATION.md)。

## 4. 运行参数

| 参数 | offline / enhanced 默认值 |
| --- | --- |
| `HOST` / `PORT` | 配置文件默认 `127.0.0.1:8088`；执行说明书通过环境变量设置为 `0.0.0.0:8080` |
| `MEMORY_DATA_DIR` | `.data-offline` / `.data-enhanced`，可指定绝对路径 |
| `MEMORY_ADD_TIMEOUT_MS` / `MEMORY_SEARCH_TIMEOUT_MS` | `115000` / `55000` |
| `MEMORY_MAX_EVIDENCE` / `MEMORY_TOKEN_BUDGET` | `32` / `6000` |
| `MEMORY_RETRIEVAL` | `lexical` / `hybrid` |
| `MEMORY_MODEL_TRANSPORT_ATTEMPTS` | 模型配置为 `3`，受请求总时限约束 |
| `MEMORY_MODEL_MIN_INTERVAL_MS` | `0`；可按模型服务限流要求增加间隔 |
| `MEMORY_MAX_REPAIR_ROUNDS` | 模型配置为 `2` |
| `MEMORY_MODEL_AUDIT` | 默认留空；填写文件路径后记录模型阶段与用量 |
| `MEMORY_MODEL_TRACE` | 默认留空；启用后包含模型输入输出，应按数据敏感性管理 |

聚合、佐证、事件视图和覆盖打包在两种随包配置中开启；重排、多跳、查询焦点、source-first 与写入续传关闭。完整取值见 `configs/` 和 `src/config.ts`。环境变量优先于 Node env 文件；启用新配置时应检查现有环境变量，避免参数残留。
