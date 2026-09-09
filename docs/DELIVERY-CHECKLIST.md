# 交付清单

| 要求 | 交付内容 |
| --- | --- |
| solution.zip，解压根为 solution/ | 根执行说明、设计文档、MANIFEST 和 code/；附 Docker/Compose 备选文件 |
| 裁判执行说明书 | INSTRUCTION：环境、启动、端口、完整 Add/Search URL、鉴权和就绪判定 |
| 记忆提取、存储与召回设计 | SDD §2.1–2.3 |
| 更新、遗忘与短期记忆边界 | SDD §2.4–2.5 |
| 模型及用途披露 | SDD §3.1、docs/CONFIGURATION、configs/models.env.example |
| 已知限制 | SDD §5、docs/VALIDATION |
| 完整源码及依赖声明 | src、scripts、tests、contracts、package.json、package-lock.json、tsconfig.json |
| 非交互启动 | Node.js 源码启动命令，默认无需模型凭据 |
| 同步 Add、隔离 Search、无鉴权 Health | 服务实现与 HTTP smoke |
| top_k 和时限约束 | 输出不超过请求 top_k 与 100；默认 32 条，Add/Search 截止 115s/55s |
| 冷启动与回归 | 新目录安装构建、源码进程启动与重启、回归及 HTTP 检查 |
| 开源来源和许可 | UPSTREAM、upstream/manifest.json、upstream/reference/ |
| Docker 备选 | 保留构建文件；受内网条件限制，尚未完成评测内网验证 |
| 文件完整性 | solution.zip.sha256 与 MANIFEST 的逐文件 SHA-256 |

打包命令：`npm run package:solution`。独立验证命令：`npm run verify:solution`。文件范围由打包脚本显式指定。
