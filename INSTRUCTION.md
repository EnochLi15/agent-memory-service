# 裁判执行说明书

本交付实现 AML Textual 记忆服务。评测启动方案固定为 **offline：确定性提取 + SQLite/FTS5 词法检索**，运行时不需要 LLM、Embedding、GPU、账号、API Key 或外网。只提供 Add、Search、Health，Search 返回记忆证据，最终作答与评分由评测平台完成。

本文件适用于 service 仓库和 `solution.zip`。解压后以 `solution/` 为根，完整工程在 `code/`。默认对外端口 **8080**，容器内端口 **8088**；所有接口鉴权均为 **none**。

## 1. 提交包与入口

```text
solution/
├── INSTRUCTION.md
├── SDD.md
├── Dockerfile
├── docker-compose.yml
├── MANIFEST.json             # 文件大小、SHA-256、源码基线和配置身份
└── code/
    ├── package.json / package-lock.json / tsconfig.json
    ├── src/ / scripts/ / tests/ / contracts/
    ├── configs/release-offline.env
    ├── configs/release-enhanced.env
    ├── upstream/ / baseline/ / UPSTREAM.md
    └── docs/                 # 核对表、验收记录、原始参考材料
```

`code/baseline/` 是有来源许可的独立对照源码，不参与服务编译或运行。无需外层 workspace、eval 仓库或 Git 子模块初始化。交付包不包含运行数据库、已灌入记忆、模型原文追踪、密钥或 `node_modules`。

## 2. 环境准备

| 项目 | 要求 |
| --- | --- |
| 推荐运行方式 | Docker Engine / Docker Desktop；Compose v2 用于一条命令启动 |
| 基础镜像 | `node:24.18.0-bookworm-slim`，构建与运行阶段一致 |
| 等价原生环境 | Node.js 24.18.0、npm；Python 3、make、C++ 编译器用于 `better-sqlite3` 无预编译包时的安装 |
| 联网构建依赖 | 容器镜像仓库、Debian apt 源、npm registry；依赖由 lockfile 锁定 |
| 数据 | 可写目录或 Docker volume，容器中为 `/data`；数据量随写入增长 |
| 资源 | CPU 运行；建议从 2 核、4 GiB 内存起部署，这只是部署起点，并非官方资源要求或容量保证 |
| 运行时网络 | offline 不调用外部模型；增强模式依赖见第 7 节 |

需要代理时，在 Docker/包管理器层配置可用的代理及镜像源。Docker 构建支持 `--build-arg APT_MIRROR=你的Debian镜像域名`，默认为 `deb.debian.org`。代理凭据不写入源码或镜像。需要完全断网构建的环境应预先准备镜像和 npm/apt 依赖缓存；本包包含源码与依赖声明，不包含依赖镜像、npm 安装包或模型权重。

## 3. Docker 非交互启动（推荐）

### 3.1 在解压后的 solution/ 执行

```sh
docker compose up -d --build --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8080/health
```

在 service 仓库根也可以直接执行相同命令；打包脚本已调整包根 Dockerfile 的源码路径及 Compose 配置路径。默认配置随源码提供，启动不需要填写 `.env`、登录模型平台或人工选择选项。容器以非 root 的 `node` 用户运行。

等价的单容器命令（同样在 `solution/`）：

```sh
docker build -t agent-memory:submission .
docker run -d --name agent-memory-submission --init \
  -p 127.0.0.1:8080:8088 \
  --mount type=volume,src=agent-memory-submission-offline,dst=/data \
  agent-memory:submission
curl --fail --silent --show-error http://127.0.0.1:8080/health
```

端口被占用时，Compose 使用 `MEMORY_PORT=8091 docker compose up -d --build --wait`；对应 URL 改为 `http://127.0.0.1:8091`。单容器修改 `-p` 左侧端口即可。上面的宿主机绑定是回环地址；若评测机位于其它主机，应按评测网络要求修改宿主机端口绑定和访问地址。容器内服务监听 `0.0.0.0:8088`。

### 3.2 停止、重启和日志

```sh
docker compose logs --tail 100 memory-service
docker compose restart memory-service
docker compose down
```

`down` 保留 volume；正常停止不使用 `down -v`。单容器使用 `docker stop -t 125 agent-memory-submission`。备份时先正常停服，复制整个数据目录（包括可能存在的 WAL/SHM），再启动。恢复需配套相同模式、来源格式、Embedding 空间的代码与配置。不要只复制活动库的单个 SQLite 文件。

## 4. 原生非交互启动（等价方式）

在 `solution/` 中执行：

```sh
cd code
npm ci
npm run build
HOST=0.0.0.0 PORT=8080 npm run start:offline
```

服务前台常驻。在另一终端检查 `http://127.0.0.1:8080/health`。默认数据目录是 `code/.data-offline/`；通过 `MEMORY_DATA_DIR=/绝对路径` 指向专用目录。命令显式读取 `configs/release-offline.env`，无需 `.env`。若只执行 `npm run start:offline`，原生默认监听 `127.0.0.1:8088`。

Node 的环境变量优先于 env 文件。原生正式运行前应移除 shell 中之前实验留下的 `MEMORY_*` 变量，仅设置上述部署参数；Compose 按固定配置注入，避免继承实验开关。`npm start` 用于开发者自己准备的 `.env`，不是本文默认评测启动入口。

## 5. 接口路径、鉴权与示例

| 接口 | 完整 URL（默认 Docker/本文原生命令） | 鉴权 |
| --- | --- | --- |
| Health | `GET http://127.0.0.1:8080/health` | none，无需任何鉴权头 |
| Add | `POST http://127.0.0.1:8080/add` | none |
| Search | `POST http://127.0.0.1:8080/search` | none |

POST 使用 `Content-Type: application/json`，没有额外路径前缀。

### 5.1 同步 Add

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/add \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"demo-001","user_id":"delivery-demo","session_id":"session-1","messages":[{"role":"user","content":"I live in Oslo. My manager is Alice.","timestamp":"2026-01-01T00:00:00Z"}]}'
```

HTTP **200**，JSON 恰为：

```json
{"success":true,"request_id":"demo-001","user_id":"delivery-demo","session_id":"session-1"}
```

必填：`request_id`、`user_id`、`session_id`（字符串）及 `messages`（数组）；消息包含字符串 `role`、`content`。提供 `timestamp` 时应为带时区的 ISO 8601 时间。运行实现也接受省略 timestamp 的消息，按顺序及可识别的会话锚处理，合成顺序不冒充真实事件日期。`contracts/` 是已有契约快照，其中 timestamp 标为必填；省略时间戳属于兼容扩展，示例使用双方均接受的形式。

返回 200 前完成事务提交，随后可以直接 Search，无需等待后台任务或轮询 Add。相同用户下同 `request_id` 同有效载荷返回原回执，不重复写入；改变载荷返回 409。不同用户可独立使用相同 request_id。

### 5.2 Search 只返回证据

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my current city?","user_id":"delivery-demo","top_k":100}'
```

响应结构（ID、score 和时间以实际返回为准）：

```json
{"data":[{"id":"memory-id","content":"user: I live in Oslo.","score":0.02,"created_at":"2026-01-01T00:00:00Z"}]}
```

`query`、`user_id`、`top_k` 在当前实现中均必填；正式请求明确传 `top_k:100`。可选 `options` 是数组，字符串元素仅辅助已有证据匹配，不能成为记忆或答案。无匹配返回 `{"data":[]}`。返回数量不超过 `min(floor(top_k),100,MEMORY_MAX_EVIDENCE)`，当前配置证据上限为 32、估算 token 预算为 6000；top_k=0 返回空数组。分数只用于相关性排序，不是置信概率。

Search 只读当前 `user_id` 的数据，不根据查询构造事实或生成答案。更新、纠错、遗忘和重新授权通过 Add 中的对话指令表达，没有单独 Delete 或 Answer 接口。

### 5.3 失败与预算

错误结构为 `{"error":{"code":"...","message":"..."}}`。

| 状态 | 含义与处理 |
| --- | --- |
| 400 | JSON/字段不合法；纠正请求，不记为成功 |
| 409 | request_id 对应不同有效载荷；核对请求身份 |
| 413 | HTTP 请求体超过 8 MiB；由评测调用方按会话规则分块 |
| 503 | 语义核验、操作绑定、存储或可用性错误；该请求不当作已完成 |
| 404 | 未提供的路径，例如 `/answer` |

服务 Add 截止时间为 **115000 ms**、Search 为 **55000 ms**，对照交付要求的 120s/60s 上限预留余量；排队及模型调用也消耗预算。超时存在“响应未收到但事务可能已提交”的常见边界，应以完全相同的请求重试并核对幂等回执，避免更换 ID 重灌。成功返回绝不使用 202 或异步任务句柄。

交付要求所列 `1–120s / 1–60s` 不能作为本实现保证的最小响应时延；确定性路径可能在 1 秒以内完成，没有人为 sleep。契约是否合规由实际字段、同步提交、隔离和证据内容决定。

## 6. 执行完成判定与自检

1. 服务进程持续运行，`GET /health` 返回 HTTP 200、`status:"ok"`；Docker health 状态为 healthy。
2. Add 返回 200 和四字段回执，立即 Search 能召回该用户的新证据。
3. 另一 user_id 不召回该证据，且返回条数不超过 top_k。

offline 的典型健康响应是 `{"status":"ok","models":"ok"}`，其中 `models:"ok"` 表示该模式不需要外部模型。enhanced 的 `models:"degraded"` 仅是模型列表探测结果；Health 检查引擎与 SQLite/FTS 工作线程，**不能证明模型能生成、全租户数据兼容或记忆质量达标**。Health 本身无需鉴权，即使其它部署层日后加入网关鉴权也应保留此约定。

在 service/ 或 solution/code/ 执行独立 HTTP smoke（需要 Node，客户端无需 npm 安装）：

```sh
node scripts/smoke.mjs --url http://127.0.0.1:8080
```

该脚本用随机演示用户检查写后立读、幂等、冲突、隔离、条数、更新和定向遗忘，不需要评测数据或 Answer/Judge。会写入自身的演示用户。退出码 0 且最后 `status:"passed"` 才算通过；这证明契约演示，不是正式准确率。

开发者本地完整检查和打包：

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run smoke:self
npm run package:solution
npm run verify:solution
```

`package:solution` 产出 `delivery-output/solution.zip` 与外部 SHA-256；可用 `npm run package:solution -- --output delivery-output/submission_TEAM.zip` 改文件名，内部根目录仍是 solution/。打包读取允许范围内的当前工作树，包括未提交交付文件；MANIFEST 标出基线 commit 和逐文件哈希，不把未提交工作树冒称为该 commit 的原样归档。

`verify:solution` 校验 ZIP 路径、完整性及文件清单，在新临时目录解压，仅从 `code/` 执行 npm ci、类型检查、构建、全部测试、HTTP smoke（含重开引擎的持久化验证）。日志留在 `delivery-output/verification/`，不自动打进提交包。Docker 冷启动仍应另外按第 3 节执行；本次实际验证范围见 [验收记录](docs/VALIDATION.md)（包内为 `code/docs/VALIDATION.md`）。

## 7. 可选增强模式及模型披露

默认评测运行不需要本节。`configs/release-enhanced.env` 对应 `dual-source-v5-s1`，保留为可选研究配置。**本次模型完全不可达的附加自检未通过城市更新检查：Add 200 后新旧城市均以冲突未决证据出现。** 因此该配置不作为本次验收通过的评测入口；若改用增强模式，需先验证模型环境下完整生命周期。它与 offline 的能力、模型成本和历史成绩不能互换。模型用途详见 SDD。

先准备可达的 OpenAI 兼容 Chat Completions 端点与凭据，以及本地/内网 Ollama `nomic-embed-text:latest`（768 维，digest 已固定在配置）。服务不会下载模型。以 `solution/` 为工作目录，执行非交互启动命令：

```sh
# 先由部署环境注入 MEMORY_LLM_BASE_URL、MEMORY_LLM_API_KEY、MEMORY_EMBEDDING_BASE_URL。
# 地址必须能从容器访问；容器内 127.0.0.1 指容器本身。
docker run -d --name agent-memory-enhanced --init \
  -p 127.0.0.1:8091:8088 \
  --env-file code/configs/release-enhanced.env \
  -e HOST=0.0.0.0 -e PORT=8088 -e MEMORY_DATA_DIR=/data \
  -e MEMORY_LLM_BASE_URL -e MEMORY_LLM_API_KEY -e MEMORY_EMBEDDING_BASE_URL \
  --mount type=volume,src=agent-memory-submission-enhanced,dst=/data \
  agent-memory:submission
```

原生部署可复制 `.env.example` 为 `.env` 并提前配置连接信息，然后 `npm start`。v5 普通写入在部分模型能力故障时退回确定性准备；明确语义拒绝、无法绑定的遗忘及外层截止仍失败。Embedding 不可达时退回词法召回。包内两种发布配置都关闭 source-first 和 write-continuation；代码保留的 v10 严格实验路径不能套用上述降级保证。

可运行 `node scripts/smoke.mjs --self --dead-models` 重现完整生命周期的断模型检查，或 `npm run verify:solution -- --include-enhanced` 在解压环境附加该检查；检查保留严格断言，当前会在上述更新行为处失败。普通 `verify:solution` 验证默认 offline，不将增强失败计作通过。

两种模式必须使用不同数据目录/卷。格式不兼容会在首次打开租户数据库时返回 `SOURCE_FORMAT`；不能靠重启 Health 成功来确认兼容。新格式需要新目录并完整重放合法历史，包括所有遗忘操作。
