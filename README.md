# Agent Memory Service

可独立部署的 TypeScript 记忆服务，包含写入准备、核验、生命周期、原子提交和恢复机制。只开放 `POST /add`、`POST /search`、`GET /health`；不生成最终答案，不导入 eval，也不读取问题答案或 rubric。复用代码的来源、修改范围和许可见 [UPSTREAM.md](UPSTREAM.md)。

当前为 V1 候选，正式发布仍需完整小集、全量评测和交付归档验收。工作区 README 和 V1交付计划是交付入口；[历史研发记录](docs/EXPERIMENTAL-HISTORY.md) 中的实验开关不代表发布默认值。

## 代码目录

```text
src/
├── server.ts、config.ts                 # HTTP 入口与配置校验
├── engine.ts                           # 写入与检索流程编排
├── extraction*.ts、verification*.ts     # 抽取、核验与有界修复
├── source-*.ts                         # 来源引用、覆盖与操作授权
├── binding.ts、transitions.ts、erasure.ts # 目标绑定、状态转移与遗忘
├── storage.ts、db-worker.ts             # 租户存储与 SQLite 原子提交
├── retrieval.ts、retrieval-policy.ts    # 混合召回与查询策略
├── retrieval/scoring.ts                 # 经典评分组件
├── text.ts、text/                       # 文本入口、实体抽取与词法归一化
└── models.ts、model-*.ts                # 模型适配与调用恢复
tests/                                  # 服务回归测试
contracts/                              # HTTP 契约快照
upstream/reference/                     # 原始来源与许可留档
baseline/                               # 隔离运行的固定版本对照
```

`src/` 以业务职责命名；生产构建只编译服务源码。`baseline/` 的独立依赖和原始代码用于对照验证，来源映射统一记在 `upstream/manifest.json` 与 [UPSTREAM.md](UPSTREAM.md)。

## 启动

需要 Node 24.18.0。独立增强服务：

```sh
npm ci
npm run build
npm test
cp -n .env.example .env
# 填写 .env 中可访问的模型地址与凭据，然后：
node --env-file=.env dist/server.js
```

也可使用 `npm start`（已编译运行）、`npm run dev`（源码变化自动编译重启）、`npm run debug`（自动重启并开放本机9229调试端口）。三个命令自动读取本仓库 `.env`，不需要 Docker 或 eval。调试支持 TypeScript source map；`build`、`dev`、`debug` 统一通过 `scripts/build.mjs` 清理 `dist/` 后编译，包含 SQLite Worker，避免移动源码后遗留旧模块；编译失败时不会继续运行旧服务。Ctrl+C 停止并保留数据。

`.env.example` 与工作区 `configs/release-enhanced.env` 保持一致。增强写入使用gpt-5.5，默认辅助模型gpt-5.4-mini；本地Ollama的nomic-embed-text为768维，digest固定在配置中。服务不自动下载模型。离线部署使用工作区独立的 `configs/release-offline.env`，能力与增强模式不同，数据卷也分开。

`MEMORY_RETRIEVAL` 仅接受 `hybrid`、`lexical`、`classic`。原评分对照配置统一迁移为 `classic`；其它值在启动时被拒绝，不会静默切换检索方式。

## 稳定边界

核验支持 `MEMORY_VERIFICATION_FORMAT=named`：模型输入输出使用具名对象及 `fact:…`、`msg:…`、`op:…` 等明确引用，服务端适配回原有证据、覆盖度与授权校验。`compact` 保留用于同预算对照，默认配置暂未切换。该开关不更改数据库格式、HTTP 接口、模型路由或修复预算；仍拒绝未知引用、不完整判定和不确定删除，明确否定不会被重新采样覆盖。

```mermaid
flowchart LR
  Add[POST /add] --> Prepare[来源路由、抽取、核验、操作准备]
  Prepare --> Commit[SQLite Worker 原子提交]
  Commit --> Data[用户隔离的事实、原文、FTS、向量和回执]
  Search[POST /search] --> Retrieve[生命周期过滤与混合召回]
  Data --> Retrieve
  Retrieve --> Evidence[最多32条、6000估算token证据]
```

- 同一用户写入串行。准备阶段不直接改库，提交事务统一维护来源、事实、操作、索引和幂等回执；成功响应意味着已提交并可检索。
- 模型抽取与独立核验拒绝无来源事实、错误目标和不合法遗忘；定向修复有次数和总时间上限。发布配置的source-first写入不会静默落到未经核验的离线成功。
- 遗忘清除逻辑可检索内容及受影响依赖，保留独立邻居；更新、纠错、历史状态和明确重新授权有不同语义。测试不等于对物理磁盘或私有诊断追踪完成擦除。
- 明确命名属性的遗忘指令独立绑定，数字相同不表示同一目标。叙事短语保留全部限定词；部分词片段只在明确回指且未引入不同实体时用于回声处理。事件描述过滤覆盖原有事实及同一请求中新建后遗忘的事实。
- 不启用重排、多跳、反思、事件视图和覆盖打包。后续改进通过配置进入同预算候选对照，不能绕过生命周期检查。

## 恢复、数据与日志

核验格式恢复在原有最多两次核验调用内完成：首次坏 JSON 会被记录并触发一次完整补验；可解析但缺项或字段错误的响应，只补验尚未独立通过的项。已通过项仅在同次补验中临时保留，完整合并校验通过后才形成成功证书。真实否定不会被补验覆盖，未知或重复引用不能复用；补验失败或截止时间耗尽仍原子拒绝写入。HTTP 恢复会重放已记录的格式失败，避免重新生成前缀。抽取坏 JSON、删除不确定及其他终态错误仍保持原有边界。

确定性的 JSON 语法恢复只处理字符串外的尾逗号和标识符键两侧成对的弯引号；不修改值、布尔判定或补全缺失字段。恢复计数进入审计。分片遗漏和内部模型预算耗尽使用已有降级路径，显式语义拒绝及外层取消不降级；越界修复补丁被丢弃，只能在原有修复次数和相同范围内重试。

开启事件视图时，只有明确询问原话或消息轨迹的查询可以看到带“后来纠正、非当前事实”标记的撤回说法；普通当前/历史查询、as-of 查询及已擦除或依赖失效的内容仍受原有过滤。相对周时间向检索结果保留原表达和锚点，不把内部日历归一化边界展示为用户陈述的确切日期。

写入截止115秒，检索55秒。已提交的同ID同载荷请求返回已有回执，改动载荷返回冲突。未完成模型准备仅在同进程、同快照和五分钟有效期内有界继续，最多三个HTTP准备尝试；`WRITE_CONTINUATION_PENDING` 要求完全相同的请求。进程重启失去内存模型响应后明确终止，不承诺跨进程续跑。

每个用户在 `MEMORY_DATA_DIR/sha256(user_id)/memory.sqlite` 保存数据，WAL与FULL同步；增强发布来源格式为 `dual-source-v10-s1`，离线为 `dual-source-v2-s1`。不同来源格式、未知格式或无版本非空数据在打开租户库时拒绝。更换来源格式或向量空间需使用兼容快照，或新目录重新灌入。不要静默迁移旧库。`s1` 表示擦除事实、操作记录与遗忘标记的 scope 仅保留规范化摘要；原始范围不再写入这些记录，活动事实仍保留合法范围。摘要用于精确匹配，不是加密或磁盘安全擦除。无 `s1` 的旧库被明确拒绝，旧版本也不能打开新库；回退必须配套旧版本兼容的数据备份。重新灌入需重放完整合法操作历史，包含遗忘指令，不能只导入早期事实。

`/health` 验证进程与存储工作线程，不替代模型调用验证或逐租户数据兼容性验证。正常HTTP日志只有请求关联、哈希租户、阶段、耗时、状态和错误码。`MEMORY_MODEL_AUDIT` 可记录模型阶段、用量、传输类别和恢复状态；`MEMORY_MODEL_TRACE` 属于含输入输出的私有诊断，不进入正式交付包。备份、恢复、升级、容器命令和运行证据见工作区部署说明。
