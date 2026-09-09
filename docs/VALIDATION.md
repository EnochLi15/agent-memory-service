# 验证结果

验证日期：2026-09-09。源码验证环境为 macOS arm64、Node.js 24.18.0，默认使用 `configs/release-offline.env`。文件版本由包内 MANIFEST 和外部 ZIP 摘要标识。

受内网条件限制，当前仅以源码启动结果作为交付验证依据。Docker 作为备选，尚未完成评测内网的构建与启动验证。

## 1. 验证项目

| 项目 | 结果 |
| --- | --- |
| 新目录解压、npm ci | 通过 |
| 类型检查与构建 | 通过，包含 SQLite Worker |
| 服务回归测试 | 719 项通过，0 失败、0 skipped |
| 返回条数与预算 | 预算充足时默认可返回 100 条；请求 top_k、100 条硬上限及 token 预算分别生效 |
| 默认配置 HTTP 检查 | 13 项通过，包括重开引擎后的持久化检查 |
| 源码命令启动 | `start:offline` 启动后 Health 200，12 项外部 HTTP 检查通过；HOST、PORT 和数据目录覆盖生效 |
| 源码进程停止与重启 | SIGTERM 停止后重新启动，当前城市和经理保留，旧城市及已遗忘门禁码不返回 |
| 模型模式启动 | `start:enhanced` 无交互启动；不可达模型在 Health 中标记为 degraded |
| 评测初始化 | offline/enhanced 均验证新目录隔离、停服清空原目录及相同请求 ID 的新载荷重写；文本、向量、索引与回执一并重置 |
| 归档完整性 | ZIP CRC、SHA-256、文件清单和路径检查通过 |
| Embedding 资源配置 | 本机协议测试验证地址、模型、维度、查询/文档前缀；有/无 Bearer Key 两种方式通过 |
| 本机实际 Embedding | service 适配器调用 nomic-embed-text:latest，2 条写入文本和 1 条查询均返回 768 维归一化向量，digest 与配置一致 |
| 模型资源注入 | Node 两个 env 文件加载顺序、各阶段模型和 Embedding 资源覆盖通过；操作系统环境变量优先 |

HTTP 检查覆盖同步 Add、回执、立即检索、幂等、冲突、用户隔离、top_k、options、无效请求、跨会话更新、定向遗忘及重放抑制。回归中的模型用例使用本机协议服务或固定响应；表中不包含在线模型的问答准确率。GLM-5.2 的实际调用结果见第 4 节。Linux 源码启动与完全断网安装尚未验证。

## 2. 复验

在服务工程根执行：

```sh
npm ci
npm run build
npm test
npm run smoke:self
npm run package:solution
npm run verify:solution
```

归档验证会重新解压、安装、构建、测试和运行默认配置。日志及逐步结果保存在 `delivery-output/verification/`。源码启动及 HTTP 检查命令见 [INSTRUCTION.md](../INSTRUCTION.md)。

## 3. 模型模式的已知问题

在 LLM 和 Embedding 均不可达时，enhanced 模式的普通 Add 可降级写入，但城市更新的状态关系可能保持未决。复现步骤是先写入 `I live in Oslo.`，再写入 `I now live in Portland.`；当前城市查询会同时返回两值，并标明 `Conflicting statements recorded; no single current value`。

该行为未满足“更新后当前查询排除旧值”的检查要求。默认配置采用 offline。模型模式下的降级问题可运行以下命令复现：

```sh
node scripts/smoke.mjs --self --dead-models
```

脚本在更新检查处以非零退出，后续步骤未执行。正式模型环境下仍需验证完整的写入、更新、遗忘和检索流程。

## 4. 实际模型调用的小样本验证

使用 GLM-5.2 和本地 nomic-embed-text:latest，按 enhanced 配置顺序执行 HTTP 请求；使用合成消息、独立用户和临时数据库。两轮单条消息 Add 共 6 次，新增耗时 8.95–17.23 秒、更新 13.20–22.96 秒、遗忘 14.85–22.50 秒，全部返回 200 且没有降级。后续当前城市、经理和已遗忘门禁码的 6 项检索检查通过。

20 条短消息合并写入时，首次在 27.89 秒返回 503，错误为分片提取输出不符合预期结构；相同输入在独立用户中复测，40.72 秒成功。这组输入仍存在模型输出格式波动。整个验证共 8 次 Add，7 次成功、1 次失败；7 次 Add Embedding 和 6 次查询 Embedding 均成功并通过 768 维校验。

该验证使用调整证据条数上限前的 32 条/6000 token 配置，验证的是模型调用、写入耗时与简单状态变化。重复输入的提示缓存、模型预热和网络状况会影响耗时；这些结果不代表 100 条配置的准确率、并发负载表现或正式评测成绩。
