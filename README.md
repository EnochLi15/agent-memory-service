# Agent Memory Service

基于固定版本 mem0 TypeScript 源码改造的独立记忆服务。只开放 `POST /add`、`POST /search`、`GET /health`。运行时不导入评测器，不读取问题答案或 rubric。

## 本地运行

需要 Node 24.18.0；`npm ci && npm run build && npm test`。

```sh
MEMORY_MODE=offline MEMORY_DATA_DIR=.data HOST=127.0.0.1 PORT=8088 npm start
```

增强模式设置 `.env.example` 中的模型变量，再用 `node --env-file=.env dist/server.js` 启动。默认离线模式不会下载模型或调用网络。数据库存储在指定目录，每个 user_id 使用 SHA-256 分区；同用户写入串行，SQLite Worker 中一次事务提交来源、事实、FTS、向量、操作与幂等回执。`/add` 的成功响应代表已提交。

增强模式使用远端结构化抽取、本地 Ollama 批量 embedding；异常可回退到保守规则和词法检索。离线模式能演示记忆生命周期，不能代表增强模式问答质量。无法可靠绑定的破坏性操作返回失败。

增强写入会独立核验每条事实、操作目标、替换关系及参与者消息覆盖。语义失败只能定向修复，不能通过降级绕过；补丁新增事实必须显式给出模态，未来计划保持 tentative。同一次写入中，内容、来源与传递依赖未改变的通过记录可以复用；修复后仍传入完整上下文，合并结果必须覆盖全部提案。核验记录只存在于该次请求内存中。`MEMORY_INCREMENTAL_VERIFICATION=false` 关闭通过记录复用，便于消融，但仍保留未修改失败项的拒绝状态。模型调用审计中的 `verification_scope` 记录本次检查量和复用量。以上优化不改变115秒写入时限。

可选 `MEMORY_EXTRACTION_MODEL`、`MEMORY_VERIFICATION_MODEL`、`MEMORY_REPAIR_MODEL` 分别覆盖提取、核验及修复模型；未设置时统一使用 `MEMORY_LLM_MODEL`。结构错误的整份重提取也按修复阶段路由，核验格式修复仍使用核验模型。模型审计记录实际阶段与实际模型，核验记录绑定实际核验模型身份；失败不会自动切换到另一个模型。所有阶段共用既定接口、reasoning effort和单次写入总预算。阶段路由是实验配置，不代表某一组合已通过质量或成本验收。

`MEMORY_MAX_REPAIR_ROUNDS` 默认为1，可显式设为2；仅增加预算内可用的补丁轮数，不延长90秒默认模型预算或115秒写入时限。未变化的失败项不会重新判分，修改项和新项必须核验。目标范围不匹配与能独立发现的来源错误会一起反馈，减少先修范围、再发现引文错误的串行往返。

`MEMORY_VERIFICATION_FORMAT=compact` 启用实验性`source-reference-tuples-v1`输出：事实用来源槽位引用已有逐字引文，替换检查用本次目标清单编号，消息覆盖保留显式事实/操作引用。服务端解析后仍执行完整核验规则；越界编号、缺项、重复项及不合法来源不能产生通过记录。格式错误中的有效语义拒绝仍被保留。默认`verbose`与既有提示词保持一致，完整上下文、模型预算和必检语义不随编码开关改变。

当前及历史检索、同时间冲突、显式纠错、作用域移除、值/属性遗忘、显式重新授权均有区分。遗忘清除可检索内容并传播到依赖的推断；保留不可逆值摘要与来源 ID 以抵抗重放。这是服务检索层的遗忘语义，磁盘备份及已交付给调用方的历史响应不在服务控制范围内。

第二轮分支增加安全原文片段索引、独立候选池、先重排后打包，以及时间精度和操作事件视图。当前写入格式为 `dual-source-v2`（关闭来源索引则为 `facts-only-v2`），须使用新数据目录重新灌入；旧目录的格式检查会拒绝混写。`MEMORY_EVENT_VIEW=false` 可关闭事件召回，不删除事件记录。时间规范化保留原表达、来源锚点和日/月/年/周精度；没有可靠锚点的相对日期保持未解析。操作事件仅保存类别、顺序、来源及状态 ID，查询时按可见性投影，不能通过历史事件取回已遗忘值。确定性测试及合成探针通过不等同于正式评测提升。


`MEMORY_ERASURE_BINDING=true`启用实验性删除范围判定，使用`dual-source-v3`/`facts-only-v3`，必须重新灌入新目录，不能原地切换v2。模型提取与事实核验通过后，服务按已授权删除值的指纹找出同值改述候选；同一属性的确定性重放直接清除，其余候选交由核验模型逐项区分改述与有来源支持的独立信息。最多64个歧义候选对；不确定、缺项或无效引文均使写入失败，不能离线降级。阶段名`erasure_binding`，与其它模型调用共享90秒默认预算。

删除范围判定绑定请求、前置事实、提案和边界，提交时重新校验。保留证明只适用于被判定的事实及精确来源片段，不能让整句混合原文绕过删除。已有删除标记也参与后续写入，换scope不能跳过判定。旧助手回述在删除时从可检索原始历史及会话尾部清理。此候选发现目前基于归一化后的已删除字面值，并不证明不含该值的任意语义改述均能发现。默认关闭，完整真实评测尚未完成。

`MEMORY_VERIFICATION_RESPONSE_FORMAT=json_schema`为compact核验及独立删除范围阶段请求各自的严格输出结构；本地仍检查引用和语义。默认json_object；不支持schema的网关不会被自动降级。

## 契约和来源

静态契约位于 `contracts/`，权威版本由独立 eval 仓库维护。来源与改动见 [UPSTREAM.md](UPSTREAM.md)；实际复用代码位于 `src/mem0/`。本项目不是对 mem0 SDK 的 HTTP 包装。

测试：`npm run build && npm test`。运行参数见 `.env.example`。容器、黑盒验收和完整实验结果由 workspace 编排，service 本身可独立构建部署。


### Source-level erasure (v4 candidate)

Set `MEMORY_SOURCE_ERASURE=true` together with `MEMORY_ERASURE_BINDING=true` to validate raw-message paraphrases as well as facts. This uses fresh `dual-source-v4` / `facts-only-v4` directories. Existing v2/v3 ingestion cannot be reused. The default remains disabled.

Source candidates include whole messages, including unlinked assistant replies, and related fact content. Exact value matches and hashed non-stopword anchors nominate candidates; the verification model then distinguishes the authorized erased information from independent people, contexts and neighboring clauses. Source work is bounded to 256 candidates / 256000 candidate characters; each model batch is bounded to 64 candidates / 64000 JSON input characters. A single oversized candidate rejects the request. Batches use local indexes mapped back into one complete commit plan and share the same original deadline. Failure or uncertainty in any batch rejects the entire write. The source_erasure_v4 input stores exact source payloads and boundary/authorization payloads once in SOURCES and BOUNDARIES; every candidate retains its own index, references and matching words. No semantic fields are dropped, and batch sizing uses the actual packed JSON input. The source_erasure_v4 model response uses whole-source erase/retain decisions or unique nonoverlapping erase_quotes for a mixed source. Uniform decisions do not copy the text; mixed decisions explicitly certify every remaining gap as independent and retained. The model reports a fixed reason category consistent with the effect instead of a repeated free-text explanation. The server reconstructs the entire original message as exact erase/retain substrings. Unknown, ambiguous, overlapping or Unicode-splitting quotes reject; mixed fact records still require review. Missing coverage, changed text, split Unicode characters, uncertainty and stale plans reject the write. Mixed fact claims require review rather than automatic content rewriting.

The source phase shares the existing total model deadline. It is logged as `source_erasure`; strict mode uses its own JSON schema. Up to 64 candidates / 64,000 serialized candidate characters are accepted; exceeding capacity fails explicitly. There is no semantic resampling or offline bypass.

Commit rechecks all original source bodies, facts, boundaries and operations. Raw text is whitespace-masked at original UTF-16 positions, passages are cut and their vectors invalidated, affected source quotes are cleaned, and derived facts remain subject to lifecycle invalidation. All changes and marker anchors roll back with the receipt. Later messages are checked using the persisted hashed anchors.

Candidate discovery still depends on word overlap or an exact value. Completely different wording and cross-message references need further coverage work. Hash anchors are lookup metadata, not a claim of resistance to guessing. This is a candidate implementation; complete benchmark quality, costs and deployment gates remain separate.


Optional `MEMORY_SEMANTIC_TRANSITIONS=true` requires source erasure and a fresh v5 data directory. Before single-valued facts can automatically hide prior values, the verification model classifies each candidate pair as compatible or exclusive. Compatible details coexist; exclusive states follow the existing effective-time and conflict rules. An uncertain implicit relationship preserves both grounded statements as conflicted, without selecting a current winner or superseding either. Missing, invalid or stale decisions reject the write. Explicit correction can resolve the remaining value even when its corroboration merges into a duplicate. Explicit operations/replacements retain their existing verification. The plan binds the request, ordered incoming facts, prior facts and operations, and is checked again inside the transaction. Models share the same request deadline; this adds a model call only when implicit pairs exist. Capacity is 64 pairs / 64000 candidate characters. An old v4 directory is not migrated.

The `state_transition_v4` model protocol provides explicit slot labels beside each witness and selects those zero-based indexes into the old/new `source_quotes`; the server validates and resolves them instead of requiring the model to copy quotes. Every relationship, including uncertain, requires valid witness indexes and exact candidate coverage. Invalid fields or indexes reject the write; uncertainty is a supported state decision and is not resampled. Uncertain authorization for deletion still rejects the write under the separate erasure protocol.

Optional `MEMORY_MODEL_TRACE` writes exact model inputs, parsed outputs (or partial text on a failed stream), stage and private request identity to a new mode-0600 JSONL file. It never serializes HTTP headers or configured credentials. Ordinary usage audit only stores a correlating trace ID. Keep the trace in ignored private artifacts; the configured directory must already exist. A requested trace that cannot be written fails the request without resampling a completed model response. This is disabled by default.

Deterministic target/scope errors and non-authorizing deletion witnesses are included in the same bounded repair scope, preserving a remaining repair round for semantic coverage. A validated erasure decision already retires its fact: the source stage skips rejudging that fact under other boundaries, while still reviewing all associated raw messages. Its fingerprint includes the verified-erased set; commit derives that set again from the validated preceding plan, so a changed erasure decision invalidates the source plan.

Source reviewers see the exact linked fact witnesses that would otherwise survive. These are context, not exemptions from an authorized erasure. Independent new decisions beside a deletion command must retain their witnesses; conflicting source/fact plans still fail atomically.

Source quotation defects may receive one bounded patch call per request (up to eight defects) through the verification model. The patch can change only invalid literal quotes, never effects, candidate coverage or valid sibling quotations. Every semantic row must already be resolved. Repaired spans must be exact, unique and nonoverlapping. The call shares the existing request deadline and does not enlarge the two proposal-repair rounds.

Source reviewers also receive linked facts already certified for erasure. Commit rejects an erased fact when every located original witness is left intact. This necessary consistency guard does not prove complete semantic erasure or remove arbitrary neighboring text. All changes require a fresh evaluation; component replay success is not full request reliability.

Optional `MEMORY_EXTRACTION_FORMAT=message_groups` changes initial generation to one group per participant message, including empty groups. Message-local `new:<message_index>:<local_fact_index>` handles are flattened chronologically on the server; unknown handles, missing/duplicate groups, assistant substitutions and unsupported forward source links reject. Group traversal is not a semantic coverage certificate: the independent verifier still checks every fact and participant, including empty groups. Semantic repairs use the existing flattened patch schema and original bounded repair/deadline policy. Default remains `flat`; use fresh experiment ingestion when comparing formats.

Generation failures export only bounded diagnostic categories: provider HTTP status, stream-started flag, known completion reason, refusal flag and known connection error codes. Provider messages, headers and request IDs are not logged. An aborted deadline is distinguished from connection or protocol failure; a failed repair is no longer described as a deadline failure unless the shared deadline actually expired. These diagnostics do not change retries, model routing or semantic acceptance.

Optional `MEMORY_EXTRACTION_FORMAT=source_refs` extends message groups with server-built sentence/span tables. Facts return `source_refs:[[message_index,span_slot],...]`; the server reconstructs exact original quotes and UTF-16 offsets before independent verification. It preserves every selected sentence qualifier and distinguishes repeated occurrences without asking the model to copy offsets. A same-message operation target alone may use a unique literal subclause when a whole span would cross its later command. Missing, non-human, forward, duplicate and mixed-encoding references reject. Semantic repair still uses original messages and the flat patch schema; unchanged offsets survive, and edited offsets must match their exact source text. References establish provenance only: selecting the right semantic support and covering relevant information still require verification. This experimental input protocol changes neither HTTP APIs nor the persisted v5 fact/source representation. Use new experiment directories for comparisons.

Experimental `MEMORY_SOURCE_OPERATIONS=true` requires enhanced mode, semantic transitions and lifecycle enabled, and fresh `dual-source-v6`/`facts-only-v6` data. A separate verification-model stage can resolve direct rejection of an unrecorded assistant assertion in the current add. It returns exact source targets and cuts, including later echoes; ordinary fact operations remain separate. The original request, tenant, stored facts and source positions bind the plan, which is revalidated with proposed fact witnesses at commit. Source cuts, raw context, passages, FTS/vector visibility, safe events and receipt update in the same transaction. Missing/uncertain plans, future targets, inexact cuts and overlapping fact witnesses reject. The full model budget remains shared.

The first slice covers current-chunk assistant assertions only. Historical source targets and facts already representing the rejected claim still need ordinary erasure review; persistent suppression of future paraphrases is not yet implemented. A necessary lexical guard rejects new details found only in removed assistant text, including negative summaries. Independent human occurrences prevent shared words alone from suppressing unrelated facts; this guard is not a complete semantic erasure proof. The independent fact checker also rejects negative restatements of removed details. Resolved source context participates in verification cache identity. Prefer flat extraction for this experimental mode until surviving subclauses have a dedicated source-reference encoding. No new HTTP interface is exposed.

`MEMORY_SOURCE_OPERATION_HISTORY=true` extends source-only operations to stored history and requires source operations plus a fresh v7 directory. Current and historical sources share a stable server-built catalog. Stored sources are sorted by write ordinal and ID, include non-searchable records and all tenant sessions, and are bound into the plan fingerprint. Target assertions must precede the instruction; later current echoes may be cut only as separately reviewed echoes. Commit resolves historical slots back to their original IDs and checks every linked fact's per-source witness before mutation. Sources from other tenants are never supplied.

The complete serialized history review is currently limited to 180000 characters; exceeding it returns `SOURCE_OPERATION_LIMIT` without writes or silent truncation. This first history implementation is therefore not ready for the full E10 history: its first43 sessions plus segment44 already contain316453 characters of source text alone. Complete bounded batching and cross-batch reference resolution remain required. Future-request suppression of new paraphrases and joint fact/source removal remain open. Small-history HTTP controls cover cross-session erasure, retained neighbors, restart retrieval and a same-name different-person counterexample; they do not establish full-benchmark quality.
