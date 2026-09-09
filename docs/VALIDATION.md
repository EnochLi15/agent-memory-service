# 验证结果

验证日期：2026-09-09。服务采用 `configs/release-offline.env`；Node.js 24.18.0，容器平台为 Linux arm64，Docker 27.5.1。文件版本由包内 MANIFEST 和外部 ZIP 摘要标识。

## 1. 验证项目

| 项目 | 结果 |
| --- | --- |
| 新目录解压、npm ci | 通过 |
| 类型检查与构建 | 通过，包含 SQLite Worker |
| 服务回归测试 | 718 项通过，0 失败、0 skipped |
| 默认配置 HTTP 检查 | 13 项通过，包括重开引擎后的持久化检查 |
| 新卷容器启动 | Health 200，Docker healthy，12 项外部 HTTP 检查通过 |
| 容器重启与数据 | 当前城市和经理保留，已遗忘门禁码不返回 |
| 非默认容器端口 | PORT=9099 时 Health 和 HTTP 检查通过 |
| 归档完整性 | ZIP CRC、SHA-256、文件清单和路径检查通过 |
| Embedding 资源配置 | 本机协议测试验证地址、模型、维度、查询/文档前缀；有/无 Bearer Key 两种方式通过 |
| 本机实际 Embedding | service 适配器调用 nomic-embed-text:latest，2 条写入文本和 1 条查询均返回 768 维归一化向量，digest 与配置一致 |
| 模型资源注入 | 增强版 Compose 的地址、阶段模型、Embedding 模型/维度和凭据覆盖检查通过 |

HTTP 检查覆盖同步 Add、回执、立即检索、幂等、冲突、用户隔离、top_k、options、无效请求、跨会话更新、定向遗忘及重放抑制。回归中的模型用例使用本机协议服务或固定响应；表中不包含在线模型的问答准确率。amd64 与完全断网构建尚未验证。

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

归档验证会重新解压、安装、构建、测试和运行默认配置。日志及逐步结果保存在 `delivery-output/verification/`。容器验证命令见 [INSTRUCTION.md](../INSTRUCTION.md)。

## 3. 模型模式的已知问题

在 LLM 和 Embedding 均不可达时，enhanced 模式的普通 Add 可降级写入，但城市更新的状态关系可能保持未决。复现步骤是先写入 `I live in Oslo.`，再写入 `I now live in Portland.`；当前城市查询会同时返回两值，并标明 `Conflicting statements recorded; no single current value`。

该行为未满足“更新后当前查询排除旧值”的检查要求。默认配置采用 offline。模型模式下的降级问题可运行以下命令复现：

```sh
node scripts/smoke.mjs --self --dead-models
```

脚本在更新检查处以非零退出，后续步骤未执行。正式模型环境下仍需验证完整的写入、更新、遗忘和检索流程。
