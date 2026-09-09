# 本次交付验收记录

验证日期：2026-09-09。源码基线：`a73871dc0689f0c8d8172a6feb163d79525677d9`，交付补齐位于该基线之上的工作树。最终包以 `solution.zip.sha256` 和包内 `MANIFEST.json` 的逐文件哈希为身份依据，不能仅用 Git commit 代替未提交交付文件的身份。

**默认 offline 已通过下列部署与契约验收。** 可选 enhanced 的断模型完整生命周期检查存在已知失败，单独列在后文，不混为通过。

## 默认方案实测

| 检查 | 实际结果与边界 |
| --- | --- |
| 主机初始类型检查及回归 | Node v25.8.2：类型检查通过，716/716 测试通过，0 skipped |
| 指定 Node 版本独立安装 | 在新临时目录从 ZIP 解压；Node v24.18.0，npm ci 成功，不复制现有 node_modules |
| 解压源码类型检查和编译 | typecheck、build 通过，包含 SQLite Worker |
| 解压源码完整回归 | 716/716 通过，0 失败、0 skipped |
| 默认 offline 的真实 HTTP smoke | 13 项通过，含 Health、同步回执/立读、幂等、409 冲突不变更、隔离、top_k、options、不合法请求、路由、跨会话更新、定向遗忘、重放抑制、重开引擎持久化 |
| Docker 归档根构建 | 从 solution/ 根 Dockerfile 成功构建，包含一次 --no-cache 构建；基础镜像 Node 24.18.0 Bookworm |
| Docker 干净数据卷启动 | 新测试容器/匿名卷；Health HTTP 200、Docker healthy、运行用户 node；12 项外部 HTTP smoke 通过 |
| Docker 进程重启 | 同卷重启后新城市 Portland、独立经理 Alice 保留，已忘门禁码未返回；3 项通过 |
| 自定义容器端口 | PORT=9099，Docker Health healthy，外部 HTTP smoke 12 项通过，健康检查不再硬编码 8088 |
| Compose 配置 | 仓库根 docker compose config 校验通过；包根配置路径由打包脚本调整 |
| ZIP 格式和完整性 | 只有 solution/ 顶层，含根 INSTRUCTION/SDD、完整 code、Docker/Compose；CRC 回读、外部 SHA-256、逐文件清单检查通过 |
| 归档拒绝检查 | 修改 server.ts 并重算外部 ZIP 摘要仍因 MANIFEST 不符被拒绝；含 ../ 越界路径在解压前被拒绝 |
| 文档与源码 | 当前入口文档相对链接检查通过；git diff --check 通过；src 与 contracts 未改动 |

容器实测平台为 **Linux arm64 / Docker 27.5.1**，宿主机 macOS arm64。没有执行 amd64 原生或模拟冷启动，不把另一架构标为已测。冷启动使用独立测试容器、端口和新卷，不复用已灌入评测记忆。默认运行零外部模型依赖；从源码构建需要镜像与 npm/apt 源，未验证完全断网构建。

smoke 是合成输入的契约/生命周期演示，不代表所有自然语言场景的正确率。现有回归中的模型测试包含桩/固定响应，716 个通过不等于真实在线模型评测。

## 增强模式附加检查：未通过

命令：

```sh
node scripts/smoke.mjs --self --dead-models
# 或在解压隔离验证中附加这一项：
npm run verify:solution -- --include-enhanced
```

配置：`release-enhanced.env`（v5），将 LLM 与 Embedding 指向本机不可用端点，不使用凭据。Health 返回 200、models=degraded；首次 Add 走 extraction_offline/embedding_lexical 降级，基本检索、幂等和隔离等检查通过。

失败位置：先写入 `I live in Oslo.`，再写入 `I now live in Portland.`。第二次 Add 返回 200，但当前城市查询同时返回 Oslo 和 Portland，并标明 `Conflicting statements recorded; no single current value`。此结果未满足自检所要求的“新值生效、当前证据中不出现旧值”。脚本保留严格断言并以非零退出，后续增强遗忘/重启检查未执行，不能宣称通过。

这证明增强的模型能力降级只能保证部分写入和检索可用性，不能推出与 offline 相同的更新语义或完整契约验收。**默认交付仍固定 offline；增强配置保留供后续模型环境验证，不作为当前可替换的已验收评测入口。** 本次未放宽断言、未修改业务状态机以掩盖问题。

## 可复验入口与证据位置

```sh
npm run package:solution
npm run verify:solution
```

默认 verify 只对默认 offline 做完整验收；`--include-enhanced` 是独立的扩展检查。每一步的退出码、运行时长、ZIP SHA-256 和 Node 版本写入 `delivery-output/verification/result.json`，安装、构建、类型、测试、smoke 日志保存在同目录。第一次附加增强检查的失败日志和结果保留在 `delivery-output/verification-enhanced-degraded/`。

容器证据位于 `delivery-output/docker-build.log`、`docker-smoke.log`、`docker-restart.json`、`docker-custom-port-smoke.log`。这些本机生成日志和测试数据库不打进交付包；包内保留本记录、源码和可复验命令。最终 ZIP 摘要不嵌回包内文档，避免循环哈希。

CI 使用同样的独立打包/解压验证，并从归档根构建镜像、以新容器运行 HTTP smoke；CI 配置已补齐，本次没有发起远程 CI，也不声称远程 CI 已通过。

## 历史成绩范围

所附文档的 508 单测、12/12 旧契约、4622 请求回放、MemOps 472 题 A/B（judged 74.5%、planned 68.6%）属于历史版本记录。本次没有重跑其 Answer/Judge、核验完整逐题产物，或执行官方 1000 题评测；这些数字不是当前提交包的官方成绩，也不是 LoCoMo 的实测分数。保留细节见 [SOURCE-RECONCILIATION.md](SOURCE-RECONCILIATION.md)。
