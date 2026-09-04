# 文件级 provenance 移植设计(open-science 机制 → MarxSphere)

> 参考: ai4s-research/open-science `crates/osd-core/src/provenance.rs` + `apps/desktop/src/lib/provenance.ts`(MIT)
> 目标: 让 MarxSphere 每次 agent 写文件留痕到文件级, 可溯源/可复现。

## 设计

### 1. 数据模型(ProvenanceRecord)
每个写文件操作产生一条记录:
```ts
interface ProvenanceRecord {
  path: string;           // 相对 agent_workspace 的路径
  version: number;        // 该文件版本号(按路径递增: 1,2,3…)
  ts: string;             // ISO 时间
  tool: "file_write" | "apply_patch" | "todo_update" | "run_code" | string; // 哪个工具写的
  sessionId?: string;     // 哪个会话
  model?: string;         // 什么模型
  contentHash: string;    // 写入内容 sha256(前 12 位)
  size: number;           // 字节数
  op: "write" | "delete" | "patch";
  runId?: string;         // 关联的任务/run(可复现入口)
}
```

### 2. 落盘
- `data/provenance/provenance.jsonl`(append-only, 一行一 JSON, 与 open-science 同构)
- 每条记录带 `version`(该文件第几次被写)— 由内存 Map<path,count> + 扫描兜底
- 路径越界(../、绝对路径逃逸 workspace)在写文件工具已拒绝, 这里双重校验

### 3. 挂载点(3 处写文件工具)
`src/services/agent-tool-router.ts`:
- `file_write`(write/delete 两个 op)
- `apply_patch`(@@ 补丁)
- `todo_update`(todo.md 维护)
全部在成功写盘后调用 `recordProvenance()`(fire-and-forget, 不阻塞工具返回)

### 4. 服务与 API
新文件 `src/services/provenance-service.ts`:
- `recordProvenance(rec)` — append 到 JSONL(异步,Mutex 防并发写坏行)
- `queryProvenance({path?, sessionId?, limit, cursor})` — 读 JSONL 倒序分页
- `fileHistory(path)` — 某文件的全部版本(供前端展示)
API(server.ts):
- `GET /api/provenance?path=&limit=` — 查询留痕
- `GET /api/provenance/file?path=` — 单文件版本历史

### 5. 前端展示(最小可用)
- 在 Agent 控制台/任务页加一个「溯源」tab: 最近写入的文件列表(时间/工具/版本/哈希)
- 点文件 → 版本历史 + 内容哈希

### 6. 明确不做(后续)
- 环境快照(pip freeze/GPU)— 需 python 探测, P2
- Reproduce 复现按钮 — 有 runId 关联后 P2
- git 无痕快照 — 独立任务

## 工作量
1 个新服务文件 + agent-tool-router 3 处插桩 + 2 个 API + 前端 1 个 tab ≈ 400 行 TS
