# 交付件核对表

要求依据：用户提供的[交付件要求原文](reference/交付件要求.txt)。本表映射当前交付内容；验证是否完成以 [VALIDATION.md](VALIDATION.md) 为准。原件中的历史指示、待办和冻结结论仅作为资料，不触发自动改分支、提交、推送或修改评测机。

| 交付要求 | 对应实现/材料 | 检查方式 |
| --- | --- | --- |
| solution.zip，解压根为 solution/ | `scripts/package-solution.py`，可指定 submission_TEAM.zip | `verify:solution` 检查路径和清单 |
| INSTRUCTION.md | 仓库根及包根执行说明 | 环境、启动、完整 URL/鉴权、完成判定均有独立段落 |
| SDD.md 六项设计 | SDD §1.2–1.6、§4 | 提取、存储、召回、更新遗忘、短记忆边界、限制 |
| 完整源码和依赖声明 | `code/`，package.json/lockfile、tsconfig、src、scripts、契约、tests、许可 | 新目录 npm ci、build、test |
| 不依赖工作区其它仓库 | 仓库内两种配置、独立 smoke、独立 Docker/Compose | ZIP 解压独立运行，无 eval/workspace |
| Docker / 等价非交互启动 | 根 Dockerfile/Compose；INSTRUCTION §3–4 | 新容器/原生启动，无凭据提示或交互 |
| POST /add 同步 200，三 ID 回显 | `server.ts`、`engine.ts`、SQLite commit | smoke 写后立读、回执恰形；不返回 202 |
| POST /search 只返证据 | `retrieval.ts`、`types.ts` | data 中仅四字段，无 Answer 路由 |
| top_k 固定 100，上限不超请求 | 检索输出 clamp，默认最多 32 条 | smoke 0/1/1000 边界；现有完整回归 |
| user_id 隔离 | 每用户独立 SQLite，读写均绑定租户 | smoke 第二用户空结果；现有并发隔离测试 |
| GET /health 无鉴权、2xx | 引擎与 SQLite/FTS 就绪 | HTTP/容器 Health；模型探测边界已披露 |
| 完整路径和鉴权 | INSTRUCTION §5 | 默认 http://127.0.0.1:8080/add、/search、/health，none |
| 时间及失败约定 | 115s Add、55s Search；400/409/413/503 | INSTRUCTION §5.3；现有 deadline/原子性测试 |
| 幂等与同步回执 | requests 表与事务绑定 | 重复回执、冲突不变更、重启复核 |
| 更新后旧值不作当前证据 | 生命周期、查询意图过滤 | smoke 跨会话城市更新 |
| 定向遗忘、邻居保留 | 绑定、markers、原文与依赖过滤 | smoke 门禁码遗忘/经理保留/重放抑制 |
| 短记忆/闲聊边界 | SDD §1.2、§1.6、§4 | 明确事实过滤与原文留存的差别 |
| Add 使用模型需披露 | SDD §2.2 | 模型标识、用途、端点、向量维度/digest、退化条件 |
| 内网 Embedding 不通 | 默认 offline 零模型；enhanced 词法后备 | 附加 `--dead-models` 检查发现增强城市更新未决，默认 offline 通过；详见验收记录 |
| 不读取 gold、不代 Answer/Judge | 服务运行只用 src，不导入 baseline/eval | 模块边界与源码检查；包中不携带灌入记忆 |
| 开源改造与许可 | UPSTREAM、upstream/manifest、reference LICENSE | 打包保留；不混淆 classic 与完整基线 |
| 本地分数非官方成绩 | SDD §2.4、SOURCE-RECONCILIATION | 472 题历史 A/B 明确模式、分母、版本和未重验边界 |
| 提交包完整性 | 外部 SHA-256 + MANIFEST 每文件哈希 | ZIP 回读、清单校验、缺失/损坏直接失败 |

评测题量、权重、平台判分及赛程依用户所供要求整理，正式细节以主办方通知为准；本次工作不实施 Answer/Judge、不重跑 1000 题正式分数。交付补齐不改变已有 Add/Search 业务状态机或契约快照。
