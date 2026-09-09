# 验证结果

验证日期：2026-09-09。源码验证环境为 macOS arm64、Node.js 24.18.0，默认使用 `configs/release-offline.env`。文件版本由包内 MANIFEST 和外部 ZIP 摘要标识。

受内网条件限制，当前仅以源码启动结果作为交付验证依据。Docker 作为备选，尚未完成评测内网的构建与启动验证。

## 1. 验证项目

| 项目 | 结果 |
| --- | --- |
| 新目录解压、npm ci | 通过 |
| 类型检查与构建 | 通过，包含 SQLite Worker |
| 服务回归测试 | 718 项通过，0 失败、0 skipped |
| 默认配置 HTTP 检查 | 13 项通过，包括重开引擎后的持久化检查 |
| 源码命令启动 | `start:offline` 启动后 Health 200，12 项外部 HTTP 检查通过；HOST、PORT 和数据目录覆盖生效 |
| 源码进程停止与重启 | SIGTERM 停止后重新启动，当前城市和经理保留，旧城市及已遗忘门禁码不返回 |
| 模型模式启动 | `start:enhanced` 无交互启动；不可达模型在 Health 中标记为 degraded |
| 归档完整性 | ZIP CRC、SHA-256、文件清单和路径检查通过 |
| Embedding 资源配置 | 本机协议测试验证地址、模型、维度、查询/文档前缀；有/无 Bearer Key 两种方式通过 |
| 本机实际 Embedding | service 适配器调用 nomic-embed-text:latest，2 条写入文本和 1 条查询均返回 768 维归一化向量，digest 与配置一致 |
| 模型资源注入 | Node 两个 env 文件加载顺序、各阶段模型和 Embedding 资源覆盖通过；操作系统环境变量优先 |

HTTP 检查覆盖同步 Add、回执、立即检索、幂等、冲突、用户隔离、top_k、options、无效请求、跨会话更新、定向遗忘及重放抑制。回归中的模型用例使用本机协议服务或固定响应；表中不包含在线模型的问答准确率。Linux 源码启动与完全断网安装尚未验证。

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
