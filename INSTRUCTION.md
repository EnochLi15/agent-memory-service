# 裁判执行说明书

本服务提供对话记忆写入与证据检索。默认运行配置为 `offline`，使用规则提取和 SQLite FTS5 检索，无需模型、GPU 或 API Key。所有接口鉴权方式为 **none**。

## 1. 提交目录与环境

```text
solution/
├── INSTRUCTION.md
├── SDD.md
├── Dockerfile
├── docker-compose.yml
├── docker-compose.enhanced.yml
├── MANIFEST.json
└── code/                         # 完整服务工程
    ├── package.json / package-lock.json
    ├── src/ / tests/ / contracts/ / scripts/
    ├── configs/
    ├── docs/
    └── upstream/ / UPSTREAM.md
```

推荐使用 Docker Engine 和 Docker Compose v2。基础镜像为 `node:24.18.0-bookworm-slim`；构建需要访问容器镜像、Debian apt 和 npm 依赖源。若网络使用代理，请在 Docker 与包管理器中配置。Debian 镜像域名可通过 `--build-arg APT_MIRROR=镜像域名` 设置。

原生环境需要 Node.js 24.18.0 和 npm。安装 `better-sqlite3` 时若没有匹配的预编译文件，还需 Python 3、make 和 C++ 编译器。运行需要可写的数据目录；模型权重和依赖安装包不包含在源码包内。

## 2. 启动

在解压后的 `solution/` 执行：

```sh
docker compose up -d --build --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8080/health
```

构建和启动均无交互步骤。服务在容器内监听 `0.0.0.0:8088`，宿主机绑定 `127.0.0.1:8080`，以 `node` 用户运行，数据保存在 `/data` 持久卷中。

不使用 Compose 时，执行：

```sh
docker build -t agent-memory:submission .
docker run -d --name agent-memory-submission --init \
  -p 127.0.0.1:8080:8088 \
  --mount type=volume,src=agent-memory-submission-offline,dst=/data \
  agent-memory:submission
```

端口被占用时，可使用 `MEMORY_PORT=8091 docker compose up -d --build --wait`，访问地址相应改为 `http://127.0.0.1:8091`。若评测客户端在另一台机器，需将 Compose 的宿主机绑定地址改为可达网卡地址。

原生等价命令：

```sh
cd code
npm ci
npm run build
HOST=0.0.0.0 PORT=8080 npm run start:offline
```

此命令读取 `configs/release-offline.env` 并前台常驻。默认数据目录为 `.data-offline/`，可设置 `MEMORY_DATA_DIR=/绝对路径` 覆盖。环境变量优先于配置文件，运行时请仅设置所需参数。

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

`query`、`user_id`、`top_k` 必填，正式请求传 `top_k:100`。可选 `options` 为数组，其中字符串元素用于匹配已有证据。返回最多 `min(floor(top_k),100,32)` 条，并受 6000 估算 token 预算限制。top_k=0 或没有匹配时返回 `{"data":[]}`。结果为该用户的记忆证据，最终作答由评测平台执行。

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

在 `solution/` 执行 HTTP 检查（客户端需要 Node.js）：

```sh
node code/scripts/smoke.mjs --url http://127.0.0.1:8080
```

脚本创建随机测试用户，检查同步写入、立即检索、幂等、隔离、top_k、更新、定向遗忘和重放抑制。最后输出 `status:passed` 且退出码为 0 表示通过。服务保持运行，由评测平台继续调用 Add/Search。

## 5. 数据与运维

```sh
docker compose logs --tail 100 memory-service
docker compose restart memory-service
docker compose down
```

`down` 保留数据卷。备份前正常停止服务，复制完整数据目录，包括可能存在的 WAL/SHM 文件。恢复时使用相同来源格式和向量空间的配置。

默认配置不需要模型资源。模型模式的 LLM、Embedding 及凭据设置见[模型与运行配置](docs/CONFIGURATION.md)，其中列明调用条件和已知限制。[验证结果](docs/VALIDATION.md)记录已测平台和测试范围。
