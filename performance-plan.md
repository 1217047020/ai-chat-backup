# 性能优化实施文档（AI Chat Backup）

> 本文档写给自动执行的 AI：按顺序完成每个任务，每完成一批运行 `pnpm compile` 和 `pnpm test`，全部通过后再进行下一批。代码片段是"意图示例"，落地时要适配上下文并保证 TypeScript 编译通过。

---

## 0. 全局护栏（禁止事项，优先级高于下面所有任务）

1. **禁止修改 `src/sync/hash.ts` 的哈希语义**（`OMITTED_KEYS`、`stableStringify`、`semanticHash`、`stableIdHash`）。哈希变了 → 所有已备份会话被判定为"有变化" → 全量重传。
2. **禁止并行化 provider 侧（ChatGPT/Claude 页面）的抓取请求，禁止降低 `throttleMs`（350ms）节流**。这是账号安全保护，本次只优化 Google Drive 侧和本地队列。
3. **禁止修改 Drive 文件/文件夹的 `appProperties` 键值结构**（`src/drive/layout.ts` 里的 `backupAppProperties` 与 `ensureFolder` 写入的属性）。旧备份靠这些属性被找到；改了会导致重复建文件夹/文件。
4. **禁止移除**：背压机制（`MAX_PENDING_BYTES`）、任务租约（lease）、断点续传（resumable upload）、崩溃后重放页的 checkpoint 逻辑。只按本文档的方式优化它们的实现成本。
5. `conversation.json` 保持 pretty-print（`JSON.stringify(..., null, 2)`），这是产品决策（可读性优先）。
6. 不改 `.output/`、`.wxt/`、`node_modules/`、`.keys/`、`config/`。

---

## 1. 架构速览（30 秒版）

```
ChatGPT/Claude 页面 (MAIN world)
  └─ src/adapters/chatgpt.ts / claude.ts   ← 用页面会话抓取，350ms 节流
  └─ src/content/pageBridge.ts             ← postMessage 桥
entrypoints/collector.content.ts           ← 隔离世界，转发给后台
entrypoints/background.ts (MV3 SW)
  ├─ src/sync/coordinator.ts               ← 扫描：分页列表 → 逐条抓详情 → 入队
  ├─ src/storage/queue.ts (Dexie/IndexedDB)← 持久化任务队列（含会话全文快照）
  ├─ src/sync/processor.ts                 ← 出队 → 上传
  └─ src/drive/store.ts + layout.ts + client.ts ← Google Drive REST
```

---

## 2. 为什么慢（诊断结论，按影响排序）

### B1【最严重】上传吞吐被"每 15 分钟最多 40 个会话"封顶，且单个失败会掐断整批

- `entrypoints/background.ts:372`：闹钟周期 15 分钟；每次触发后 `drain()` 最多处理 40 个任务（`background.ts:126-127`）。之后 Service Worker 空转直到下一次闹钟。
- `src/sync/processor.ts:83-91`：`drain()` 循环里 `if (!processed) break;`，而 `processOne()` **失败也返回 false** —— 任何一个会话上传失败（含临时 429）都会中断整批，剩余任务再等 15 分钟。
- 结果：初次备份 1000 个会话的理论上限约 160 个/小时，绝大部分时间 SW 在睡觉。

### B2【严重】每个会话首次上传要发约 15 个串行 Drive HTTP 请求

每个请求约 150–400ms，串行执行，单个会话 3–6 秒：

| 步骤 | 请求数 | 位置 |
|---|---|---|
| ensureRoot / provider / scope 文件夹查找（每个会话都重查一遍，无缓存） | 3 | `src/drive/layout.ts:85-113` |
| conversation 文件夹：查找 miss + 兜底二次查找 + 创建 | 3 | `layout.ts:49-74` |
| conversation.json / conversation.md / attachments.json：每个文件 findByProperties(miss) + findChildByName(miss) + 上传 | 9 | `src/drive/store.ts:109-161` |

另外 `attachments.json` **在会话没有任何附件时也照传**（`store.ts:210-216` 无条件写入）。

### B3【严重】本地队列 O(N²) 读放大，初次备份时越跑越慢

- `src/storage/queue.ts:95-132` `claimNext()`：每认领**一个**任务，就把**所有**到期任务连同会话全文快照（每条可达几十至几百 KB）从 IndexedDB 全量读出再排序。队列 1000 条时，认领一个任务要搬运上百 MB。
- `src/sync/incremental.ts:43-54` `pendingBytes()`：把**全部**任务 `JSON.stringify` 一遍来算字节数；而 `coordinator.ts:153,182` 在扫描时**每处理一条 summary 就调一次**。一页 100 条 → 每页把整个队列序列化 100 次。这是初次备份时 CPU 卡死/发热的主因。

### B4【中等】全流程串行，抓取和上传互相阻塞

- 只有 1 个上传 worker，会话内 3 个文件也逐个上传。
- `src/sync/coordinator.ts:275-277`：每扫完一页要 `await this.processor.drain(10)`，扫描（页面侧抓取）被 Drive 上传阻塞，两条本可并行的流水线在轮流干活。

### B5【轻度】UI 轮询放大

- `src/ui/Dashboard.tsx:86`：每 2 秒发 `get_status`；`background.ts:203-232` 的 `status()` 调 `listIndexes()` 把 `conversationIndexes` **全表 toArray**。几千条会话时，弹窗开着就持续消耗后台。

### B6【轻度】杂项

- `layout.ts:49-63`：`ensureFolder` miss 时连发两次 `findByProperties`（全属性 + 子集兜底）。
- `coordinator.ts:178`：每条 summary 一次 `isPaused()`（一次 IndexedDB get）。

**量化预期**：500 个会话初次备份，现状常需数小时（受 B1 空转支配）；完成 P0+P1 后预计 15–30 分钟（页面侧 350ms 节流的抓取约 4 分钟 + Drive 并行上传，两者流水线化）。增量扫描中未变化会话应为 0 个 Drive 请求。

---

## 3. 修复任务

### 批次一：P0-2 —— Dexie v2：把会话快照拆出任务表（其他任务的地基）

**目的**：修复 B3。任务元数据（几百字节）和快照全文（几十~几百 KB）分表存储，`claimNext`/`pendingBytes` 只碰元数据。

**文件**：`src/storage/db.ts`、`src/storage/types.ts`、`src/storage/queue.ts`、`src/sync/incremental.ts`、`src/storage/queue.test.ts`

1. `src/storage/types.ts`：
   - `SyncJobRecord` 增加可选字段 `snapshotBytes?: number`；`snapshot` 字段保持类型不变（内存态仍会挂载，只是不再持久化在这张表）。
   - 新增 `export interface SyncJobBodyRecord { id: string; snapshot: unknown; }`。

2. `src/storage/db.ts`：新增表 + 升级迁移（同时为 P2-1 给 `conversationIndexes` 加 `platform` 索引）：

```ts
this.version(1).stores({ /* 原样保留 */ });
this.version(2).stores({
  conversationIndexes:
    '&conversationKey, [platform+scopeId], platform, sourceConversationId, syncStatus, lastSeenAt, lastSyncedAt',
  syncJobs:
    '&id, &conversationKey, status, nextAttemptAt, leaseUntil, [status+nextAttemptAt], priority, updatedAt',
  syncJobBodies: '&id',
  scanCheckpoints: '&id, [platform+scopeId], kind, updatedAt, completedAt',
  keyValues: '&key, updatedAt',
}).upgrade(async (tx) => {
  const jobs = await tx.table('syncJobs').toArray();
  for (const job of jobs) {
    if (job.snapshot === undefined) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(job.snapshot)).byteLength;
    await tx.table('syncJobBodies').put({ id: job.id, snapshot: job.snapshot });
    delete job.snapshot;               // 注意：用 delete + put 整条覆盖，不要用 update 写 undefined
    job.snapshotBytes = bytes;
    await tx.table('syncJobs').put(job);
  }
});
```

3. `src/storage/queue.ts`：
   - `enqueueLatest`：事务范围加入 `this.db.syncJobBodies`。写入时快照进 bodies 表，元数据记录**不含** `snapshot` 但含 `snapshotBytes`（用 `new TextEncoder().encode(JSON.stringify(input.snapshot)).byteLength` 计算一次）。
   - `claimNext`：事务范围加入 `syncJobBodies`。候选查询逻辑不变（现在 toArray 只有轻量元数据，几千条无压力）。选中后：先 `put` 元数据（status/lease 字段），再 `const body = await this.db.syncJobBodies.get(selected.id);`，返回 `{ ...claimed, snapshot: body?.snapshot }` —— **对外返回形状不变**，`processor.ts` 无需改动。
   - `complete`：事务范围加入 `syncJobBodies`，删除任务时同时 `await this.db.syncJobBodies.delete(job.id);`。
   - `fail`：bodies 保留不动（重试还要用）。写回的 job 对象来自元数据表，天然不含 snapshot，确认不要把内存态 snapshot 写回 `syncJobs`。
   - `clearAllForTests`：加上 `this.db.syncJobBodies.clear()`。

4. `src/sync/incremental.ts`：

```ts
async pendingBytes(): Promise<number> {
  const jobs = await this.db.syncJobs.toArray();   // 现在只有轻量元数据
  return jobs.reduce((total, job) => total + (job.snapshotBytes ?? 0), 0);
}
```

5. `src/storage/queue.test.ts`：凡直接断言 `syncJobs` 表里存在 `snapshot` 字段的用例，改为断言 `syncJobBodies`；`claimNext` 返回值仍应带 `snapshot`（保持这条断言）。

**验证**：`pnpm test` 全绿；手动场景——旧版本已存在待传任务时升级扩展，任务仍能上传成功（迁移正确）。

---

### 批次二：P0-1 + P0-3 + P0-4 —— 连续排水、失败不断批、扫描/上传流水线化

**目的**：修复 B1、B3 的调用频率、B4 的扫描阻塞。

#### P0-1a `src/sync/processor.ts`

1. `processOne()` 返回值从 `boolean` 改为三态：

```ts
export type ProcessOutcome = 'processed' | 'failed' | 'empty';
```
   - 无任务可认领 → `'empty'`；上传成功 → `'processed'`；失败 → `'failed'`。
2. 增加共享限流冷却：类内 `private cooldownUntil = 0;`。在 `processOne` 的 catch 里，`driveFailure(error)` 之后：`if (failure.retryAfterMs) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + failure.retryAfterMs);`。
3. 重写 `drain`（并发常量先设 1，批次四再调 3）：

```ts
const WORKER_CONCURRENCY = 1; // 批次四完成后改为 3

async drain(maxJobs = 200, concurrency = WORKER_CONCURRENCY): Promise<number> {
  let completed = 0;
  let consecutiveFailures = 0;
  let started = 0;
  const worker = async () => {
    while (started < maxJobs && consecutiveFailures < 5) {
      if (await this.state.isPaused()) return;
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      started += 1;
      const outcome = await this.processOne();
      if (outcome === 'empty') return;
      if (outcome === 'failed') consecutiveFailures += 1;
      else { consecutiveFailures = 0; completed += 1; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return completed;
}
```

关键点：**失败不再中断整批**（失败任务已被 `fail()` 设了未来的 `nextAttemptAt`，不会被立刻重复认领）；连续失败 5 次熔断，交给闹钟稍后重试。

#### P0-1b `entrypoints/background.ts`

1. 新增排水闹钟常量 `const DRAIN_ALARM = 'ai-chat-backup-drain';`。
2. 重写 `drain()`：循环直到把队列排空，期间用轻量 API 调用维持 SW 存活；结束时若仍有积压（熔断/冷却退出），挂 1 分钟后的一次性闹钟兜底：

```ts
function drain(): Promise<number> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    if (!await connected() || await runtime().state.isPaused()) return 0;
    let total = 0;
    const keepalive = setInterval(() => void chrome.runtime.getPlatformInfo(() => undefined), 20_000);
    try {
      while (true) {
        const n = await runtime().processor.drain(50);
        total += n;
        if (n < 50) break; // 队列空 / 熔断 / 暂停
      }
    } finally {
      clearInterval(keepalive);
    }
    const counts = await runtime().processor.queue.counts();
    if (counts.pending > 0) void chrome.alarms.create(DRAIN_ALARM, { delayInMinutes: 1 });
    else void chrome.alarms.clear(DRAIN_ALARM);
    return total;
  })().finally(() => { drainPromise = undefined; });
  return drainPromise;
}
```

3. `chrome.alarms.onAlarm` 监听器里加分支：`if (alarm.name === DRAIN_ALARM) void drain().catch(...)`。原 15 分钟 `ALARM_NAME` 逻辑不变（它负责周期扫描）。

#### P0-3 `src/sync/coordinator.ts`：降低背压/暂停检查频率

`for (const summary of page.items)` 循环内（约 176-186 行）的两个 await 检查改为**每 25 条检查一次**（保留循环外/每页顶部的检查不动）：

```ts
for (const [i, summary] of page.items.entries()) {
  throwIfAborted(options.signal);
  if (i % 25 === 24) {
    if (await this.processor.state.isPaused()) { stoppedForPause = true; break; }
    if (await this.incremental.isBackpressured()) { stoppedForBackpressure = true; report.skippedForBackpressure = true; break; }
  }
  ...
}
```

说明：最多多放 25 条 × ~100KB ≈ 2.5MB 进队列，相对 100MB 上限可忽略；P0-2 完成后这两个检查本身也已变廉价。

#### P0-4 `src/sync/coordinator.ts` + `background.ts`：扫描不再被上传阻塞

1. `ScanOptions` 增加 `triggerDrain?: () => void;`，删除（或废弃）`drainAfterPage`。
2. 把 `coordinator.ts:275-277` 的

```ts
if (options.drainAfterPage !== false) { await this.processor.drain(10); }
```

改为非阻塞触发：

```ts
options.triggerDrain?.();
```

3. `background.ts` 的 `scanAvailable()` 里，`scanAdapter` 调用参数把 `drainAfterPage: await connected()` 换成 `triggerDrain: () => { void drain(); }`（`drain()` 自带去重，重复触发无害）。

**验证**：`pnpm compile`、`pnpm test`。手动：开首备，观察 SW 控制台——上传持续进行，队列非空时不存在超过 1 分钟的空窗；人为造一个失败（断网几秒）后其余任务继续。

---

### 批次三：P1 —— 砍掉每个会话的冗余 Drive 请求

**目的**：修复 B2、B6。每会话请求数：首传 ~15 → ~5；重传（内容变化）~10 → ~4。

#### P1-1 `src/drive/layout.ts`：文件夹缓存 + 单飞（single-flight）+ 复用已知映射

> 单飞是批次四并行上传的前置条件：没有它，两个 worker 同时处理同一新 scope 的会话会重复建文件夹。

1. `DriveLayoutManager` 增加：

```ts
private readonly folderCache = new Map<string, DriveFile>();
private readonly inflight = new Map<string, Promise<DriveFile>>();

private folderKey(appProperties: Record<string, string>, parentId?: string): string {
  // 键取"身份属性"，不含 name（改名不应改变身份）
  return [parentId ?? 'root', appProperties.objectType ?? 'folder',
          appProperties.provider ?? '', appProperties.scope ?? '',
          appProperties.conversation ?? ''].join('|');
}
```

2. 把现有 `ensureFolder` 重命名为 `ensureFolderUncached`（逻辑见 P1-5 的合并改动），新的 `ensureFolder` 包一层缓存+单飞：

```ts
private async ensureFolder(name: string, appProperties: Record<string, string>, parentId?: string): Promise<DriveFile> {
  const key = this.folderKey({ app: APP_MARKER, kind: appProperties.objectType ?? 'folder', ...appProperties }, parentId);
  const cached = this.folderCache.get(key);
  if (cached) return cached;
  const pending = this.inflight.get(key);
  if (pending) return pending;
  const promise = this.ensureFolderUncached(name, appProperties, parentId)
    .then((folder) => { this.folderCache.set(key, folder); return folder; })
    .finally(() => this.inflight.delete(key));
  this.inflight.set(key, promise);
  return promise;
}

/** 上传遇到 404 时调用，清掉涉及该 id 的缓存。 */
invalidateFolder(folderId: string): void {
  for (const [key, value] of this.folderCache) {
    if (value.id === folderId) this.folderCache.delete(key);
  }
}
```

   注意：缓存命中时会跳过"标题变化→改名"逻辑，对 root/provider/scope 无影响（名字固定）；conversation 文件夹的改名处理见下面第 4 点。

3. `DriveLayout` 接口把四个字段类型放宽为 `Pick<DriveFile, 'id'>`（`store.ts` 只用 `.id`），并增加 `conversationCreated: boolean`（P1-2 用）。`ensureFolderUncached` 返回时带上"是否新建"信息（返回 `{ file, created }` 或在类内部记录，实现自选，保证 `ensureConversation` 能得到 conversation 文件夹的 created 标志）。

4. `ensureConversation(conversation, existing?: DriveFileMapping)` 增加第二参数，开头加快速路径：

```ts
const scopeHash = await stableIdHash(conversation.scope.scopeKey);
const conversationHash = await stableIdHash(conversation.sourceId);
const expectedName = `${safeDriveName(conversation.title)}__${conversationHash}`;
if (existing?.rootFolderId && existing.providerFolderId && existing.scopeFolderId &&
    existing.conversationFolderId && existing.conversationFolderName === expectedName) {
  return {
    root: { id: existing.rootFolderId }, provider: { id: existing.providerFolderId },
    scope: { id: existing.scopeFolderId }, conversation: { id: existing.conversationFolderId },
    scopeHash, conversationHash, conversationCreated: false,
  };
}
// 标题变了或映射不全 → 走原有完整流程（会顺带把 Drive 文件夹改名）
```

5. `src/storage/types.ts`：`DriveFileMapping` 增加可选字段 `conversationFolderName?: string`。

6. `src/drive/store.ts` `backupConversation`：
   - 调用改为 `await this.layout.ensureConversation(conversation, input.existing)`。
   - 成功组装 mapping 时写入 `mapping.conversationFolderName = expectedName`（把 expectedName 的计算放到 store 或由 layout 返回，实现自选，保证与 layout 内的命名公式一致——建议 layout 在 `DriveLayout` 上直接返回 `conversationFolderName` 字段）。
   - **404 自愈**：把"写主文件 + 写 artifacts"的整段包进一个内部函数 `writeAll(layout)`；首次用（可能来自快速路径的）layout 执行，捕获 `DriveApiError` 且 `status === 404` 时：对四个 id 调 `this.layout.invalidateFolder(...)`，用**不带 existing** 的 `ensureConversation(conversation)` 重新解析一次，重跑 `writeAll`，只重试一次，再失败则抛出（交给队列重试）。

#### P1-2 `src/drive/store.ts`：新建的会话文件夹里不做文件查找

`writeFile` 增加参数 `skipLookup: boolean`。为 true 且 `spec.fileId` 为空时，跳过 `resolveExisting`（`existing` 记为 undefined），直接走"新建上传"分支。调用处：主文件与 artifacts 都传 `skipLookup: layout.conversationCreated`。

理由：文件夹刚创建，里面不可能有旧文件；省 2 个查询/文件 × 3-4 个文件。

#### P1-4 `src/drive/store.ts`：空附件不上传 attachments.json

组装 `primarySpecs` 后过滤：

```ts
const specs = primarySpecs.filter((spec) =>
  spec.fileType !== 'attachments' ||
  conversation.attachments.length > 0 ||
  Boolean(existing.attachmentsFileId));   // 已存在的文件继续维护，避免陈旧内容
```

后续循环用 `specs`。多数会话没有附件，直接少 1/3 的文件操作。

#### P1-5 `src/drive/layout.ts`：`ensureFolder` 的两次查找合并为一次

`ensureFolderUncached` 中，删除第一次"全属性"查询，只保留现有的兜底子集查询（`['app','kind','provider','scope','conversation']` 中存在的键）。子集是全属性的子集，能同时命中新旧两种文件夹，行为等价，省 1 个请求/未命中。

**验证**：手动首备若干会话后，在 Drive 网页端确认：无重复的 provider/scope/conversation 文件夹；改一条已备份会话的标题再 `sync_now`，Drive 文件夹被改名且文件被更新（走完整路径）；对未变化会话点 `sync_now`，网络面板 googleapis 请求数为 0（入队即判 unchanged）。

---

### 批次四：并行上传（依赖批次三的单飞）

#### P1-3a `src/sync/processor.ts`

`WORKER_CONCURRENCY` 从 1 改为 3。

#### P1-3b `src/drive/store.ts`：会话内文件并行写

主文件（过滤后的 `specs`）改为并行；resumable 大文件保持串行（并发的 resumable 会互相覆盖 `job.upload` 断点状态）：

```ts
const isLarge = (spec: FileSpec) => new Blob([spec.content]).size > RESUMABLE_THRESHOLD_BYTES;
const small = specs.filter((s) => !isLarge(s));
const large = specs.filter(isLarge);
const results = await Promise.all(small.map(async (spec) => ({ spec, result: await this.writeFile(...) })));
for (const spec of large) { /* 原串行逻辑 */ }
// mapping 赋值与 filesWritten 统计放在 results 出来之后统一做（保持原字段逻辑）
```

（`RESUMABLE_THRESHOLD_BYTES` 从 `./client` 导出，已存在。）artifacts 同理：小的并行（可用简单的每批 3 个 `Promise.all`），大的串行。

**验证**：开首备，SW 网络面板可见并发的 googleapis 请求；连续观察 10 分钟无 429 风暴（偶发 429 会经 `cooldownUntil` 退避）。若出现持续 429，把 `WORKER_CONCURRENCY` 降回 2。

---

### 批次五：P2 杂项

#### P2-1 `entrypoints/background.ts`：`status()` 轻量化（修 B5）

替换 `listIndexes()` 全表遍历：

```ts
const [chatgptConversations, claudeConversations, scopePairs] = await Promise.all([
  backupDb.conversationIndexes.where('platform').equals('chatgpt').count(),
  backupDb.conversationIndexes.where('platform').equals('claude').count(),
  backupDb.conversationIndexes.orderBy('[platform+scopeId]').uniqueKeys() as Promise<Array<[string, string]>>,
]);
const byPlatform = {
  chatgpt: { scopes: scopePairs.filter(([p]) => p === 'chatgpt').length, conversations: chatgptConversations },
  claude:  { scopes: scopePairs.filter(([p]) => p === 'claude').length,  conversations: claudeConversations },
};
```

（`platform` 索引已在批次一的 v2 schema 中添加。）如 `queue.listIndexes` 不再被引用可删除。

#### P2-2 `src/storage/queue.ts`：`recordFullScanPresence` 用 `bulkPut`（可选）

把逐条 `update` 改为在内存组装修改后的记录数组，一次 `bulkPut`。全量扫描收尾时几千条会话可感知提速。

#### P2-3 `src/ui/Dashboard.tsx`（可选）

轮询间隔 2s → 3s；`document.visibilityState === 'hidden'` 时跳过刷新（options 页常驻后台标签时省电）。

---

## 4. 实施顺序与依赖（务必遵守）

```
批次一 P0-2（schema 拆表）            ← 地基，先行
批次二 P0-1 / P0-3 / P0-4            ← 并发常量保持 1
批次三 P1-1 / P1-2 / P1-4 / P1-5     ← 含单飞，是并行的前置
批次四 P1-3（并发调到 3 + 文件并行）  ← 必须在批次三之后
批次五 P2-1 / P2-2 / P2-3            ← 独立，随时可做
```

每批完成后：`pnpm compile && pnpm test`，然后 `pnpm build` 并在 `chrome://extensions` 重新加载 `.output/chrome-mv3` 做一次手动冒烟（连接 Drive → sync_now 单条会话成功）。

---

## 5. 验收标准

1. **吞吐**：500 个会话初次备份在 30 分钟内完成（现状为数小时）。度量方法：临时在 `background.ts` 的 `onProgress` 回调里 `console.log(Date.now(), event.kind, event.conversationKey)`，统计 succeeded 事件速率（验收后移除日志）。
2. **无空转**：队列 `pending > 0` 且未暂停时，不存在超过 60 秒无上传请求的窗口。
3. **失败隔离**：单个会话上传失败（可断网 5 秒模拟）不影响其余会话继续上传；恢复后失败项按退避自动重试。
4. **无重复**：并行开启后做一次全新初次备份，Drive 中每个 scope/conversation 只有一个文件夹，每个会话只有一份 conversation.json/md。
5. **增量零请求**：对内容未变化的会话触发扫描/sync_now，网络面板中 googleapis.com 请求数为 0。
6. **重传省请求**：修改一条会话（新增一句话）后增量同步，该会话的 Drive 请求总数 ≤ 5（现状约 10-15）。
7. **升级兼容**：带着未完成队列从 v1 schema 升级到 v2，任务不丢失、继续上传成功。
8. `pnpm compile`、`pnpm test` 全部通过。

---

## 6. 已评估但本次不做（不要顺手实现）

- **Drive batch API**（合并元数据请求）：并行 worker 已覆盖大部分收益，batch 的实现/错误处理复杂度不划算。
- **降低 provider 节流 / 并行抓取页面**：账号风控风险，明确不做。
- **conversation.json 改紧凑格式**：可读性是产品决策。
- **`fileId` 已知时跳过 `getFile` 预检**：该预检同时承担"手工编辑保护"（`preserveManualEdit` 需要当前 md5），跳过会削弱该功能，收益仅 1 请求/文件，不做。
