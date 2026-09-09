# Agent Memory Service

可独立部署的 TypeScript 长期记忆服务。提供 `POST /add`、`POST /search`、`GET /health`：同步写入、用户隔离、只返回记忆证据。源码包可以在没有 workspace/eval 仓库的环境构建运行。

## 交付入口

| 文件 | 用途 |
| --- | --- |
| [INSTRUCTION.md](INSTRUCTION.md) | 裁判执行说明：环境、非交互启动、完整 URL、鉴权、就绪判定 |
| [SDD.md](SDD.md) | 系统设计：记什么、怎么存/召回、更新遗忘、短期边界、限制与模型披露 |
| [交付核对表](docs/DELIVERY-CHECKLIST.md) | 任务书要求与文件、代码、自检逐项映射 |
| [验收记录](docs/VALIDATION.md) | 本次构建、测试、解压安装与容器验证的实际范围 |
| [参考材料核对](docs/SOURCE-RECONCILIATION.md) | 所附三份文档与当前代码的差异、历史成绩口径 |
| [UPSTREAM.md](UPSTREAM.md) | 开源来源、改造范围、文件哈希和许可 |

默认交付采用 **offline**，运行时无需模型、密钥、GPU 或外网；首次构建需要镜像源与依赖仓库。增强模式另行配置，二者不共享数据目录，也不将一种模式的成绩用于另一种模式。

## 快速启动

在本仓库根执行（需要 Docker Compose v2）：

```sh
docker compose up -d --build --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:8080/health
node scripts/smoke.mjs --url http://127.0.0.1:8080
```

默认宿主机 `127.0.0.1:8080` → 容器 `0.0.0.0:8088`，鉴权 none。端口占用时设置 `MEMORY_PORT=8091`。`docker compose down` 保留数据卷。

原生启动使用 Node **24.18.0**（版本在 `.node-version`，依赖在 lockfile）：

```sh
npm ci
npm run build
HOST=0.0.0.0 PORT=8080 npm run start:offline
```

`start:offline` 显式读取仓库内 `configs/release-offline.env`。`npm start`、`npm run dev`、`npm run debug` 则读取可选 `.env`，用于已有个人环境；debug 开放本机 9229，支持 source map。build/dev/debug 经 `scripts/build.mjs` 清理旧 dist 后编译，包含 SQLite Worker。

## 生成提交包

```sh
npm run typecheck
npm run build
npm test
npm run smoke:self
npm run package:solution
npm run verify:solution
```

生成 `delivery-output/solution.zip` 与 `solution.zip.sha256`；ZIP 根为 `solution/`，包含两份必交文档、完整 `code/`、根 Dockerfile/Compose 和逐文件 `MANIFEST.json`。打包采用明确的源码目录清单，排除密钥文件、数据库、依赖安装目录、私有模型追踪和运行产物；包含当前尚未提交的交付文件。输出目录由 Git 忽略。

`verify:solution` 校验外部摘要、ZIP 安全路径和完整清单，在新临时目录执行 `npm ci`、类型检查、构建、全量测试及默认 offline 的真实 HTTP smoke。需 Python 3 及 npm registry 访问；详细日志写入 `delivery-output/verification/`。Docker 冷启动按执行说明书另外验证。可附加 `--include-enhanced` 检查模型不可达时的完整生命周期；本次该额外检查发现增强降级无法确定城市更新的新旧关系，详见验收记录，不能把它标为已通过或用于默认提交。

## 代码目录

```text
src/
├── server.ts、config.ts、types.ts       # HTTP 契约与配置校验
├── engine.ts                           # 用户队列、幂等与写入/检索编排
├── extraction*.ts、verification*.ts     # 抽取、独立核验与有界修复
├── source-*.ts                         # 来源引用、覆盖及操作授权
├── binding.ts、transitions.ts、erasure.ts # 目标绑定、状态转移及遗忘
├── storage.ts、db-worker.ts             # 租户 SQLite 与原子提交
├── retrieval.ts、retrieval-policy.ts    # 候选联合、意图仲裁与预算
├── retrieval/scoring.ts、text/          # 开源评分和文本组件的适配
└── models.ts、model-*.ts                # 模型路由、有限重试和协议恢复
configs/                                # 独立 offline/enhanced 固定配置
contracts/                              # 已有契约快照（兼容扩展见说明书）
tests/                                  # 服务回归与对抗反例
scripts/                                # 构建、开发、HTTP smoke、打包/验包
upstream/                               # 来源映射、原文与许可
baseline/                               # 独立对照源码，不参与生产构建
docs/reference/                         # 用户提供的历史参考材料原件
```

## 默认配置和数据语义

| 配置 | 默认 offline | 可选 enhanced |
| --- | --- | --- |
| 提取 / 检索 | 确定性规则 / lexical | 模型及核验 / hybrid |
| 来源格式 | dual-source-v2-s1 | dual-source-v5-s1 |
| 聚合、佐证、事件视图、覆盖打包 | 开启 | 开启 |
| source-first、续传、重排、多跳、查询焦点 | 关闭 | 关闭 |
| Add / Search 截止 | 115s / 55s | 115s / 55s |
| 证据上限 / 估算 token | 32 / 6000（另受 top_k≤100 限制） | 相同 |

增强 `.env.example` 与仓库内增强配置一致：提取/核验/修复配置 `gpt-5.5`，默认辅助模型 `gpt-5.4-mini`；Embedding 使用 768 维 `nomic-embed-text`，digest 在配置固定。服务不自动下载模型。v5 普通写入可在部分能力故障时退回确定性准备，明确语义拒绝和无法绑定的遗忘仍失败；实验 v10/续传路径有更严格的提交条件。

每个用户存储在 `MEMORY_DATA_DIR/sha256(user_id)/memory.sqlite`，事实、原文、索引及成功回执同事务提交。遗忘控制逻辑可检索内容及相关依赖，不声称物理磁盘、备份或远端日志不可恢复。切换来源格式/向量空间需使用兼容快照或独立目录，重放完整合法历史（含遗忘），不静默迁移旧库。

`/health` 验证引擎/存储工作线程，模型列表探测只是元数据。正常日志不包含消息、查询或凭据；模型原文 trace 默认关闭。更详细的恢复边界和限制见 SDD；[历史研发记录](docs/EXPERIMENTAL-HISTORY.md) 与原始设计稿不是当前配置说明或当前成绩证明。
