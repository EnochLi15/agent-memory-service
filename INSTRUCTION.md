# 裁判执行说明书

本服务提供对话记忆写入与证据检索。默认运行配置为 `offline`，使用规则提取和 SQLite FTS5 检索，无需模型、GPU 或 API Key。所有接口鉴权方式为 **none**。

## 1. 提交目录与环境

```text
solution/
├── INSTRUCTION.md
├── SDD.md
├── MANIFEST.json
└── code/                         # 完整服务工程
    ├── package.json / package-lock.json
    ├── src/ / tests/ / contracts/ / scripts/
    ├── configs/
    ├── docs/
    └── licenses/                 # 第三方许可与必要声明
```

推荐直接从源码启动。受内网条件限制，当前仅以源码启动结果作为交付验证依据；Docker 作为备选，尚未完成评测内网的构建与启动验证。

源码运行环境要求：

- Node.js **24.18.0** 和 npm。
- Python 3、make、C++ 编译器，用于安装 SQLite 原生依赖时的本机编译。
- 可写的数据目录，以及安装期间可访问的 npm 依赖源。需要代理时通过 npm 配置设置。

依赖版本由 `package-lock.json` 固定。默认 offline 运行无需访问外部模型，依赖安装包和模型权重不随源码分发。

## 2. 源码启动

如果使用提交包，先进入 `solution/code/`；如果直接使用 service 仓库，在仓库根执行：

```sh
node --version                 # 应为 v24.18.0
npm ci
npm run build
HOST=0.0.0.0 PORT=8080 npm run start:offline
```

安装和启动均无交互步骤。服务以前台进程运行，监听 `0.0.0.0:8080`；同机评测地址为 `http://127.0.0.1:8080`，远程评测使用服务所在机器的可达地址。

命令读取 `configs/release-offline.env`。数据默认保存在工程根的 `.data-offline/`，可通过 `MEMORY_DATA_DIR=/绝对路径` 指定。端口被占用时设置 `PORT=8091`，接口 URL 相应修改。环境变量优先于配置文件，运行前请检查已有 `MEMORY_*` 配置。

需要模型模式时，先按[模型与运行配置](docs/CONFIGURATION.md)填写 `.env.models`，再使用 `npm run start:enhanced`。默认评测启动使用上述 offline 命令。

## 3. 接口地址与请求

| 方法 | 完整 URL | 鉴权 |
| --- | --- | --- |
| GET | `http://127.0.0.1:8080/health` | none |
| POST | `http://127.0.0.1:8080/add` | none |
| POST | `http://127.0.0.1:8080/search` | none |

POST 请求使用 `Content-Type: application/json`，无路径前缀。

### Add

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/add \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"demo-001","user_id":"delivery-demo","session_id":"session-1","messages":[{"role":"user","content":"I live in Oslo. My manager is Alice.","timestamp":"2026-01-01T00:00:00Z"}]}'
```

成功返回 HTTP 200：

```json
{"success":true,"request_id":"demo-001","user_id":"delivery-demo","session_id":"session-1"}
```

`request_id`、`user_id`、`session_id` 和 `messages` 必填。每条消息包含字符串 `role`、`content`；timestamp 若提供，须为带时区的 ISO 8601 时间。实现支持省略 timestamp，以消息顺序和可识别的会话时间锚处理。

返回 200 时事务已提交，可以立即检索。同一用户下，重复的 request_id 和相同载荷返回原回执；载荷变化返回 409。更新和遗忘通过消息内容表达，例如 `I now live in Portland.`、`Forget my access code.`。

### Search

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my current city?","user_id":"delivery-demo","top_k":100}'
```

响应结构示例：

```json
{"data":[{"id":"memory-id","content":"user: I live in Oslo.","score":0.02,"created_at":"2026-01-01T00:00:00Z"}]}
```

`query`、`user_id`、`top_k` 必填，正式请求传 `top_k:100`。可选 `options` 为数组，其中字符串元素用于匹配已有证据。默认返回最多 `min(floor(top_k),100)` 条，并受服务配置的 6000 估算 token 预算限制；实际条数可能因相关性、去重和预算而减少。赛题要求的是不超过 top_k，6000 是本方案可调的默认预算。top_k=0 或没有匹配时返回 `{"data":[]}`。结果为该用户的记忆证据，最终作答由评测平台执行。预算配置规则见[模型与运行配置](docs/CONFIGURATION.md#4-运行参数)。

### 失败与时限

错误结构为 `{"error":{"code":"...","message":"..."}}`。

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求 JSON 或字段不符合要求 |
| 409 | request_id 已对应不同载荷 |
| 413 | 请求体超过 8 MiB |
| 503 | 写入核验、操作绑定、存储或请求可用性错误 |

Add 内部截止时间为 115 秒，Search 为 55 秒，分别为 120 秒和 60 秒调用上限预留余量。若连接中断导致响应未收到，请以相同 ID 和载荷重试，通过回执确认结果。

## 4. 就绪与执行完成判定

服务就绪时，Health 返回 HTTP 200，例如：

```json
{"status":"ok","models":"ok"}
```

Health 验证引擎与 SQLite/FTS 工作线程。默认 offline 不访问模型，此时 `models:ok` 表示无需外部模型。采用模型配置时，models 是模型列表探测状态，生成与向量调用仍需单独验证。

在服务工程根的另一个终端执行 HTTP 检查：

```sh
node scripts/smoke.mjs --url http://127.0.0.1:8080
```

脚本创建随机测试用户，检查同步写入、立即检索、幂等、隔离、top_k、更新、定向遗忘和重放抑制。最后输出 `status:passed` 且退出码为 0 表示通过。检查完成后，按第 5 节为正式评测启动一个空数据目录，再交由评测平台调用 Add/Search。

## 5. 数据与评测初始化

### 5.1 数据存在哪里

两种模式均使用本机 SQLite，每个用户的数据路径为：

```text
MEMORY_DATA_DIR/
└── <user_id 的 SHA-256 十六进制摘要>/
    ├── memory.sqlite
    ├── memory.sqlite-wal         # 运行期间可能存在
    └── memory.sqlite-shm         # 运行期间可能存在
```

| 启动方式 | 默认数据目录（相对于启动时的工程根） | 向量数据 |
| --- | --- | --- |
| `npm run start:offline` | `.data-offline/` | 不生成 Embedding，事实和原文的 vector 为 null |
| `npm run start:enhanced` | `.data-enhanced/` | 生成成功的事实、原文向量与文本一起写入同一 SQLite |
| `npm start` | 读取 `.env`；完整模板为 `.data-enhanced/`，未配置时为 `.data/` | 由运行模式和模型调用结果决定 |

`MEMORY_DATA_DIR` 环境变量可覆盖上述路径，建议指定绝对路径。数据库同时保存消息、事实、原文分段、全文索引、会话、更新与遗忘记录、请求回执及元数据。Embedding 存在 `facts.body`、`passages.body` 的 JSON `vector` 字段中，服务没有独立向量数据库；Search 的查询向量仅在请求中使用，不写入记忆库。

Embedding 不可达时，模型模式仍在原数据目录保存可提交的文本和词法索引，缺失的向量为 null。Ollama 提供向量计算，模型权重由模型服务管理，清理记忆库无需删除模型权重。

### 5.2 首次评测与重新评测：使用新空目录

**每轮完整评测使用一个独立空目录。** 联调和 smoke 产生的数据也应与正式评测分开。先结束上一轮请求，使用 Ctrl+C 或 SIGTERM 停止旧服务，确认进程已退出；随后在工程根执行以下命令。依赖和构建步骤只需按第 2 节完成一次。

默认 offline 模式：

```sh
mkdir -p "$PWD/.data-runs"
EVAL_DATA_DIR="$(mktemp -d "$PWD/.data-runs/offline.XXXXXX")" || exit 1
printf '本轮数据目录：%s\n' "$EVAL_DATA_DIR"
HOST=0.0.0.0 PORT=8080 MEMORY_DATA_DIR="$EVAL_DATA_DIR" npm run start:offline
```

模型模式先准备 `.env.models`，然后选择以下命令：

```sh
mkdir -p "$PWD/.data-runs"
EVAL_DATA_DIR="$(mktemp -d "$PWD/.data-runs/enhanced.XXXXXX")" || exit 1
printf '本轮数据目录：%s\n' "$EVAL_DATA_DIR"
HOST=0.0.0.0 PORT=8080 MEMORY_DATA_DIR="$EVAL_DATA_DIR" npm run start:enhanced
```

重新评测时重复所选命令，会创建另一个空目录，上一轮数据保留但不会被本轮读取。保留打印出的绝对路径；如果只是中断后继续同一轮，应使用该路径重新启动，不要新建目录。一次完整评测中的多个会话、Add 和 Search 之间不得清库。

### 5.3 复用原目录时如何清库

如需复用固定目录，**必须先停止所有使用该目录的服务进程**，再删除整个数据目录。以下命令会永久删除 `.data-offline/` 中所有用户的记忆、向量、索引、回执和遗忘记录；需要留存时先按第 5.5 节备份。在工程根执行：

```sh
rm -rf -- "$PWD/.data-offline"
HOST=0.0.0.0 PORT=8080 MEMORY_DATA_DIR="$PWD/.data-offline" npm run start:offline
```

模型模式则删除并重新使用 `.data-enhanced/`：

```sh
rm -rf -- "$PWD/.data-enhanced"
HOST=0.0.0.0 PORT=8080 MEMORY_DATA_DIR="$PWD/.data-enhanced" npm run start:enhanced
```

如果实际使用自定义 `MEMORY_DATA_DIR`，应清理并重新指定那个绝对路径。只删除默认目录不会影响自定义目录。不要在线删除文件、只清 facts 表，或只删除 `memory.sqlite` 而留下 WAL/SHM。服务会在新请求到来时自动创建用户数据库，无需手动建表。

服务未提供清库 HTTP 接口。业务消息中的 forget 是定向遗忘，会保留回执和防重入记录，不能代替整轮评测初始化。切换 offline/enhanced，或更换 Embedding 模型、维度、digest 时，也应使用新目录并重新执行 Add。

### 5.4 清库后的检查

服务启动后检查 `/health` 返回 200。在本轮第一次 Add 前，使用上一轮的实际 user_id 和已知事实执行 Search，应返回 `{"data":[]}`。例如上一轮使用了本文的示例用户：

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my current city?","user_id":"delivery-demo","top_k":100}'
```

Health 仅表示服务就绪，不代表数据库为空。新目录或已清空的目录会同时清除请求回执，同一 user_id、request_id 可在新一轮重新写入，不会命中上一轮回执。完成检查后，由评测平台按本轮数据重新执行 Add，再执行 Search。

### 5.5 停止、备份与日志

服务日志输出至标准输出。正常停止不会删除数据；使用相同数据目录和兼容配置重启即可恢复。备份前正常停服，复制完整数据目录，包括可能存在的 WAL/SHM 文件。

`.env`、`.env.models` 和模型权重不在记忆数据库中。若启用了 `MEMORY_MODEL_TRACE`、`MEMORY_MODEL_AUDIT` 或 `MEMORY_RETRIEVAL_AUDIT`，日志写在各自指定路径；位于数据目录外的日志及备份不会随清库删除，也不会作为记忆重新载入。按评测轮次分别管理这些文件。

[验证结果](docs/VALIDATION.md)记录已测平台和测试范围。

## 6. Docker 备选方式

包内保留 `Dockerfile` 和 Compose 配置，供具备镜像源、依赖源及容器运行条件的环境使用。该方式尚未完成评测内网验证，推荐按第 2 节从源码启动。

以下命令在仓库根或提交包的 `solution/` 目录执行：

```sh
docker compose up --build -d --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8080/health
```

默认使用 offline 配置，端口仅绑定宿主机 `127.0.0.1:8080`。远程评测需调整 Compose 的端口绑定地址。数据保存在 `memory-offline` 卷中；停止使用 `docker compose down`，保留数据时不要添加 `-v`。

Docker 备选方式若需整轮清库，应停止该 Compose 项目并删除其数据卷：默认配置执行 `docker compose down --volumes`，模型配置执行 `docker compose -f docker-compose.enhanced.yml down --volumes`。这会删除对应项目的数据卷；再次启动会创建空卷，操作仍未纳入评测内网验证。
