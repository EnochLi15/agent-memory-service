# Agent Memory Service

面向 AML Textual 赛道的长期记忆服务。服务从对话中保存事实、偏好和事件，处理后续更新与遗忘，并按用户检索相关证据。采用 TypeScript、Fastify 和 SQLite，提供 Add、Search、Health 三个 HTTP 接口。

## 文档

| 文件 | 内容 |
| --- | --- |
| [INSTRUCTION.md](INSTRUCTION.md) | 环境准备、启动命令、接口地址与就绪判定 |
| [SDD.md](SDD.md) | 记忆提取、存储、召回、更新与遗忘设计 |
| [模型与运行配置](docs/CONFIGURATION.md) | 各模型用途、地址、凭据、参数及启用条件 |
| [验证结果](docs/VALIDATION.md) | 构建、回归测试、HTTP 检查与已知问题 |
| [交付清单](docs/DELIVERY-CHECKLIST.md) | 提交文件与验收要求的对应关系 |

## 源码启动

源码启动为推荐方式。受内网条件限制，当前仅以源码启动结果作为交付验证依据；Docker 作为备选，尚未完成评测内网的构建与启动验证。

在 Node.js **24.18.0** 环境执行：

```sh
npm ci
npm run build
HOST=0.0.0.0 PORT=8080 npm run start:offline
```

服务启动后，在另一个终端检查：

```sh
curl --fail --silent --show-error http://127.0.0.1:8080/health
node scripts/smoke.mjs --url http://127.0.0.1:8080
```

默认配置 `configs/release-offline.env` 使用规则提取和词法检索，运行时不调用 LLM 或 Embedding。模型模式使用 `npm run start:enhanced`，模型地址、凭据和启用条件见[模型与运行配置](docs/CONFIGURATION.md)。

首次评测和重新评测应使用独立空数据目录。两种模式的数据位置、停服清库命令和检查方法见 [INSTRUCTION.md 第 5 节](INSTRUCTION.md#5-数据与评测初始化)。

## 工程结构

- `src/`：服务入口、记忆处理、存储、检索和模型适配。
- `configs/`：两种运行配置及模型资源模板。
- `contracts/`：接口定义；`tests/`：回归测试。
- `scripts/`：构建、开发、HTTP 检查和打包验证。
- `licenses/`：第三方许可与必要的来源声明。

生产构建编译 `src/`，SQLite Worker 与主服务一同输出至 `dist/`。`npm run dev` 支持源码变更重启，`npm run debug` 使用本机 9229 调试端口。

## 检查与打包

```sh
npm run typecheck
npm run build
npm test
npm run smoke:self
npm run package:solution
npm run verify:solution
```

输出为 `delivery-output/solution.zip`，解压根目录为 `solution/`。打包包括服务源码、依赖声明、测试、正式文档及许可；文件清单和摘要写入 `MANIFEST.json`。源码目录中的开发归档和独立对照工程不进入比赛提交包。

`verify:solution` 在新目录解压，校验摘要并重新安装依赖、构建、测试和运行 HTTP 检查。它需要 Python 3 和 npm 依赖源访问。验证日志写入 `delivery-output/verification/`。自定义文件名可使用 `npm run package:solution -- --output delivery-output/submission_TEAM.zip`。
