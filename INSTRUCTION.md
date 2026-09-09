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
    └── upstream/ / UPSTREAM.md
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

在服务工程根的另一个终端执行 HTTP 检查：

```sh
node scripts/smoke.mjs --url http://127.0.0.1:8080
```

脚本创建随机测试用户，检查同步写入、立即检索、幂等、隔离、top_k、更新、定向遗忘和重放抑制。最后输出 `status:passed` 且退出码为 0 表示通过。服务保持运行，由评测平台继续调用 Add/Search。

## 5. 数据与运维

服务日志输出至标准输出。停止时使用 Ctrl+C，或向服务进程发送 SIGTERM；再次运行同一启动命令即可读取原数据。数据目录不会因正常停止被删除。

备份前正常停服，复制完整数据目录，包括可能存在的 WAL/SHM 文件。恢复时使用相同来源格式和向量空间的配置。模型资源、凭据与数据目录应按部署环境分别管理。

[验证结果](docs/VALIDATION.md)记录已测平台和测试范围。

## 6. Docker 备选方式

包内保留 `Dockerfile` 和 Compose 配置，供具备镜像源、依赖源及容器运行条件的环境使用。该方式尚未完成评测内网验证，推荐按第 2 节从源码启动。

以下命令在仓库根或提交包的 `solution/` 目录执行：

```sh
docker compose up --build -d --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8080/health
```

默认使用 offline 配置，端口仅绑定宿主机 `127.0.0.1:8080`。远程评测需调整 Compose 的端口绑定地址。数据保存在 `memory-offline` 卷中；停止使用 `docker compose down`，保留数据时不要添加 `-v`。
