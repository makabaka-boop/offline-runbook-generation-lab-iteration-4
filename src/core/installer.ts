/**
 * 安装状态协调器（框架无关的纯核心，Vitest 直接覆盖）。
 *
 * 不变量：
 * 1. 一个版本的所有资源“全部获得 + 逐项 SHA-256 + 整单摘要校验通过”后，才提交新的激活代际。
 * 2. 半包（pending）在任何路径下都不会被激活；取消、断网、校验失败、配额异常
 *    以及安装中关闭后重开，都只清理该未激活缓存。
 * 3. 已激活的完整版本在失败/中断期间继续保留并可读；从无成功安装则 activeVersion=null，
 *    界面显示“无可用离线包”。
 * 4. IndexedDB 的代际切换先于旧缓存删除（崩溃也只会留下孤儿缓存，下次启动回收）。
 * 5. 摘要复用只从当前激活代际复制字节到新暂存区；新代际激活后不引用旧缓存。
 * 6. 成功安装时最多保留当前版与紧邻上一版两份缓存；退回上一版前逐项复核上一版缓存
 *    与整单摘要，确认后一次 CAS 切换激活代际（SW、步骤页、演练会话随之指向同一版本）；
 *    旧版正在使用时绝不先清理其缓存。
 */
import type {
  CatalogEntry,
  FailureCode,
  InstallMode,
  PersistedState,
  ResourceRef,
  RollbackRefuseReason,
  Snapshot,
} from './types';
import { INITIAL_PERSISTED_STATE } from './types';
import { encodeCanonicalResourceList } from './resource-digest';
import {
  stageCacheNameFor,
  type InstallGeneration,
} from './generation';

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}
export class ChecksumError extends Error {
  constructor(public readonly url: string) {
    super(`校验失败: ${url}`);
    this.name = 'ChecksumError';
  }
}
export class QuotaError extends Error {
  constructor() {
    super('配额不足');
    this.name = 'QuotaError';
  }
}
export class Canceled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Canceled';
  }
}
export class StaleGenerationError extends Error {
  constructor() {
    super('安装代次已过期');
    this.name = 'StaleGenerationError';
  }
}

export interface StagedResource {
  bytes: Uint8Array;
  contentType: string;
}

/** 平台端口：浏览器实现由 src/platform 提供，测试用内存假实现。 */
export interface InstallerPorts {
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  /** 仅当 IDB 中的 pending 仍属于 expectedGeneration 时提交激活状态。 */
  commitStateIfPending(
    state: PersistedState,
    expectedGeneration: string,
  ): Promise<boolean>;
  /** 仅当 IDB 当前激活代次仍等于 expectedActiveGeneration 且无进行中安装时提交回退状态。 */
  commitStateIfActive(
    state: PersistedState,
    expectedActiveGeneration: string,
  ): Promise<boolean>;
  /** 下载单个资源；AbortSignal 触发时应拒绝 AbortError/Canceled。 */
  fetchResource(
    ref: ResourceRef,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** 在复制前估算可用容量；无法查询时允许返回 null（由写入时配额错误兜底）。 */
  estimateAvailableCapacity(): Promise<number | null>;
  openCache(name: string): Promise<ManualCacheLike>;
  readCacheEntry(cacheName: string, ref: ResourceRef): Promise<StagedResource | null>;
  deleteCache(name: string): Promise<boolean>;
  /** 列出当前所有代际缓存键名（前缀 manual:）。 */
  listManualCaches(): Promise<string[]>;
  now(): number;
}

export interface ManualCacheLike {
  get(url: string): Promise<StagedResource | null>;
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 每次安装尝试使用唯一暂存缓存名；只有提交后代际指针才指向它。 */
export { stageCacheNameFor };

type Listener = (snapshot: Snapshot) => void;

const toFailureCode = (err: unknown): FailureCode => {
  if (err instanceof ChecksumError) return 'checksum';
  if (err instanceof Canceled || err instanceof StaleGenerationError) return 'canceled';
  if (err instanceof QuotaError) return 'quota';
  if (err instanceof HttpError) return 'network';
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'Canceled' || name === 'StaleGenerationError') {
      return 'canceled';
    }
    if (
      name === 'QuotaExceededError' ||
      /quota|exceeded/i.test(err.message)
    ) {
      return 'quota';
    }
    if (name === 'TypeError' || name === 'NetworkError') return 'network';
  }
  return 'unknown';
};

const normalizeHash = (hex: string) => hex.trim().toLowerCase().replace(/^sha256-/, '');

export interface InstallOptions {
  mode?: InstallMode;
  /** 当前激活版本的目录条目；复用模式按其中资源摘要从激活缓存定位字节。 */
  activeEntry?: CatalogEntry | null;
}

interface InstallAttempt {
  generation: InstallGeneration;
  cacheName: string;
  mode: InstallMode;
  controller: AbortController;
}

export class InstallerCoordinator {
  private state: PersistedState = { ...INITIAL_PERSISTED_STATE };
  private snapshot: Snapshot = {
    activeVersion: null,
    previousVersion: null,
    status: { kind: 'idle' },
  };
  private current: InstallAttempt | null = null;
  /** 退回流程重入保护：同一时间只允许一个退回（跨标签并发由 CAS 兜底）。 */
  private rollingBack = false;
  /** 当前安装尝试使用的激活版本目录条目；仅按其中资源摘要定位旧版字节。 */
  private activeCatalogEntry: CatalogEntry | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly ports: InstallerPorts) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private emit() {
    this.snapshot = {
      activeVersion: this.state.activeVersion,
      previousVersion: this.state.previous?.version ?? null,
      status: this.snapshot.status,
    };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private setStatus(status: Snapshot['status']) {
    this.snapshot = {
      activeVersion: this.state.activeVersion,
      previousVersion: this.state.previous?.version ?? null,
      status,
    };
    this.emit();
  }

  /**
   * 启动恢复：若存在 pending 半包（含“安装中关闭后重开”），丢弃其缓存与状态，
   * 继续展示此前的完整版本；若无完整版本则界面显示“无可用离线包”。
   * 同时回收任何不属于当前激活代际的孤儿缓存。
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    const state = await this.ports.loadState();
    if (state.pending) {
      await this.safeDelete(state.pending.cacheName);
      state.pending = null;
      await this.ports.saveState(state);
    }
    this.state = state;
    await this.reconcileCaches();
    this.snapshot = {
      activeVersion: state.activeVersion,
      previousVersion: state.previous?.version ?? null,
      status: { kind: 'idle' },
    };
    this.emit();
  }

  /** 回收孤儿缓存：仅保留当前激活缓存与紧邻上一版缓存（最多两份）。 */
  private async reconcileCaches() {
    const keep = new Set(
      [this.state.activeCacheName, this.state.previous?.cacheName].filter(
        (name): name is string => typeof name === 'string',
      ),
    );
    let names: string[] = [];
    try {
      names = await this.ports.listManualCaches();
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => !keep.has(name) && name.startsWith('manual:'))
        .map((name) => this.safeDelete(name)),
    );
  }

  private async safeDelete(name: string) {
    try {
      await this.ports.deleteCache(name);
    } catch {
      // 删除失败不改变状态正确性：该缓存既不在 IDB 中被引用，后续仍会被回收。
    }
  }

  private assertCurrent(attempt: InstallAttempt) {
    if (this.current !== attempt || attempt.controller.signal.aborted) {
      throw attempt.controller.signal.aborted ? new Canceled() : new StaleGenerationError();
    }
  }

  private async assertOwnedAfter(attempt: InstallAttempt) {
    this.assertCurrent(attempt);
    const stored = await this.ports.loadState();
    if (stored.pending?.installId !== attempt.generation.installId) {
      throw new StaleGenerationError();
    }
    this.state = stored;
  }

  async install(entry: CatalogEntry, options: InstallOptions = {}): Promise<void> {
    await this.init();
    if (this.current) {
      // 同一时间只允许一个安装；重复点击直接忽略。
      return;
    }

    const mode: InstallMode = options.mode === 'reuse' ? 'reuse' : 'full';
    this.activeCatalogEntry = options.activeEntry ?? null;
    const total = entry.resources.length;
    const version = entry.version;
    const installId = `${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const generation = { version, installId };
    const cacheName = stageCacheNameFor(version, installId);
    const controller = new AbortController();
    const attempt: InstallAttempt = { generation, cacheName, mode, controller };
    this.current = attempt;

    // 清理可能的同名残留（理论上唯一，防御性处理）。
    await this.safeDelete(cacheName);

    this.state = {
      ...this.state,
      pending: { version, cacheName, installId, mode, startedAt: this.ports.now() },
    };
    await this.ports.saveState(this.state);
    this.setInstalling({
      total,
      phase: 'acquire',
      completed: 0,
      reused: 0,
      fetched: 0,
      verified: 0,
      attempt,
    });

    try {
      const staged = await this.acquireResources(entry, attempt);
      await this.assertOwnedAfter(attempt);
      const cache = await this.ports.openCache(cacheName);

      // 复制/下载阶段已校验摘要；入暂存后再逐项读取重验，确保 Cache Storage 中实际落盘内容完整。
      this.setInstalling({
        total,
        phase: 'verify',
        completed: total,
        reused: staged.reused,
        fetched: staged.fetched,
        verified: 0,
        attempt,
      });
      for (let i = 0; i < entry.resources.length; i++) {
        if (controller.signal.aborted) throw new Canceled();
        const ref = entry.resources[i];
        const storedEntry = await cache.get(ref.url);
        if (!storedEntry) throw new ChecksumError(ref.url);
        const actual = normalizeHash(await this.ports.sha256(storedEntry.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        if ((i + 1) % 3 === 0 || i + 1 === total) {
          await this.assertOwnedAfter(attempt);
        }
        this.setInstalling({
          total,
          phase: 'verify',
          completed: total,
          reused: staged.reused,
          fetched: staged.fetched,
          verified: i + 1,
          attempt,
        });
      }

      const manifestActual = normalizeHash(
        await this.ports.sha256(encodeCanonicalResourceList(entry.resources)),
      );
      if (manifestActual !== normalizeHash(entry.resourcesSha256)) {
        throw new ChecksumError('catalog-resources');
      }

      // 原子切换：全部资源、逐项摘要、整单摘要均通过后才提交新代际。
      // 成功安装时最多保留当前版与紧邻上一版：旧激活代际降级为“上一版”指针。
      const nextState: PersistedState = {
        activeVersion: version,
        activeCacheName: cacheName,
        activeGeneration: installId,
        previous:
          this.state.activeVersion && this.state.activeCacheName && this.state.activeGeneration
            ? {
                version: this.state.activeVersion,
                cacheName: this.state.activeCacheName,
                generation: this.state.activeGeneration,
              }
            : null,
        pending: null,
      };
      const committed = await this.ports.commitStateIfPending(nextState, installId);
      if (!committed) throw new StaleGenerationError();
      this.state = nextState;

      // 代际已持久提交，再回收更早的孤儿缓存（保留新激活缓存与上一版缓存）。
      await this.reconcileCaches();

      this.current = null;
      this.setStatus({ kind: 'activated', installId, version });
    } catch (err) {
      this.current = null;
      await this.failInstallation(attempt, err);
    }
  }

  private setInstalling(data: {
    total: number;
    phase: 'acquire' | 'verify';
    completed: number;
    reused: number;
    fetched: number;
    verified: number;
    attempt: InstallAttempt;
  }) {
    const { total, phase, completed, reused, fetched, verified, attempt } = data;
    const progress =
      phase === 'acquire'
        ? Math.min(89, Math.round(((reused + fetched) / Math.max(1, total)) * 90))
        : 90 + Math.min(9, Math.round((verified / Math.max(1, total)) * 9));
    this.setStatus({
      kind: 'installing',
      installId: attempt.generation.installId,
      mode: attempt.mode,
      version: attempt.generation.version,
      phase,
      progress,
      completed,
      total,
      reused,
      fetched,
      verified,
      cancelRequested: attempt.controller.signal.aborted,
    });
  }

  private async acquireResources(
    entry: CatalogEntry,
    attempt: InstallAttempt,
  ): Promise<{ reused: number; fetched: number; totalBytes: number }> {
    const { resources } = entry;
    const total = resources.length;
    const sourceCacheName = this.state.activeCacheName;
    const byHash = new Map<string, ResourceRef>();
    if (attempt.mode === 'reuse' && this.state.activeVersion && sourceCacheName) {
      this.activeCatalogEntry?.resources.forEach((ref) =>
        byHash.set(normalizeHash(ref.sha256), ref),
      );
    }

    let reused = 0;
    let fetched = 0;
    let knownBytes = 0;
    const collected = new Array<StagedResource>(resources.length);

    const update = () => {
      this.setInstalling({
        total,
        phase: 'acquire',
        completed: reused + fetched,
        reused,
        fetched,
        verified: 0,
        attempt,
      });
    };

    for (let i = 0; i < resources.length; i++) {
      const ref = resources[i];
      if (attempt.controller.signal.aborted) throw new Canceled();
      const source =
        attempt.mode === 'reuse' ? byHash.get(normalizeHash(ref.sha256)) ?? null : null;
      let resource: StagedResource;

      if (source) {
        const cached = sourceCacheName
          ? await this.ports.readCacheEntry(sourceCacheName, source)
          : null;
        if (cached) {
          const actual = normalizeHash(await this.ports.sha256(cached.bytes));
          if (actual !== normalizeHash(ref.sha256)) {
            // 激活缓存异常时不复用；完整安装入口仍可从网络恢复，复用模式按校验失败保护旧版。
            throw new ChecksumError(source.url);
          }
          resource = cached;
          reused++;
        } else {
          throw new ChecksumError(source.url);
        }
      } else {
        resource = await this.ports.fetchResource(ref, attempt.controller.signal);
        if (attempt.controller.signal.aborted) throw new Canceled();
        const actual = normalizeHash(await this.ports.sha256(resource.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        fetched++;
      }

      knownBytes += resource.bytes.byteLength;
      const available = await this.ports.estimateAvailableCapacity();
      if (available !== null && available < knownBytes) {
        throw new QuotaError();
      }

      collected[i] = resource;
      update();
    }

    // 预容量检查不改变旧版；真正写入再由平台配额错误兜底。
    const available = await this.ports.estimateAvailableCapacity();
    if (available !== null && available < knownBytes) {
      throw new QuotaError();
    }

    const cache = await this.ports.openCache(attempt.cacheName);
    for (let i = 0; i < resources.length; i++) {
      if (attempt.controller.signal.aborted) throw new Canceled();
      const ref = resources[i];
      const item = collected[i];
      await cache.put(ref.url, item.bytes, item.contentType);
      if (attempt.controller.signal.aborted) throw new Canceled();
      if ((i + 1) % 3 === 0 || i + 1 === total) {
        await this.assertOwnedAfter(attempt);
      }
    }

    return { reused, fetched, totalBytes: knownBytes };
  }

  private async failInstallation(attempt: InstallAttempt, err: unknown) {
    const code = toFailureCode(err);
    const stale = err instanceof StaleGenerationError || this.current !== null;

    if (!stale) {
      const stored = await this.ports.loadState().catch(() => this.state);
      if (stored.pending?.installId === attempt.generation.installId) {
        this.state = { ...stored, pending: null };
        await this.ports.saveState(this.state).catch(() => undefined);
      } else {
        this.state = stored;
      }
      await this.safeDelete(attempt.cacheName);
      await this.reconcileCaches();
    }

    this.setStatus({
      kind: 'failed',
      installId: attempt.generation.installId,
      version: attempt.generation.version,
      code,
    });
  }

  async cancel(): Promise<void> {
    const attempt = this.current;
    if (!attempt || attempt.controller.signal.aborted) return;
    const status = this.snapshot.status;
    if (status.kind === 'installing' && status.installId === attempt.generation.installId) {
      this.setStatus({ ...status, cancelRequested: true });
    }
    attempt.controller.abort();
  }

  /** 复核指定缓存中的资源：逐项 SHA-256 与整单摘要全部通过才返回 true。 */
  private async verifyCachedEntry(cacheName: string, entry: CatalogEntry): Promise<boolean> {
    try {
      for (const ref of entry.resources) {
        const stored = await this.ports.readCacheEntry(cacheName, ref);
        if (!stored) return false;
        const actual = normalizeHash(await this.ports.sha256(stored.bytes));
        if (actual !== normalizeHash(ref.sha256)) return false;
      }
      const manifestActual = normalizeHash(
        await this.ports.sha256(encodeCanonicalResourceList(entry.resources)),
      );
      return manifestActual === normalizeHash(entry.resourcesSha256);
    } catch {
      return false;
    }
  }

  /**
   * 退回上一版：复核上一版缓存（逐项 SHA-256 + 整单摘要）后，一次 CAS 切换 IndexedDB
   * 激活代际，Service Worker、步骤页与演练会话随之指向同一版本。
   * 安装仍在进行、上一版缺失或校验失败时拒绝退回并保留当前可用版本；
   * 另一标签页已抢先完成切换时，本次迟到退回不得覆盖新代际。
   *
   * @param entry 上一版在内置目录中的条目（用于复核）；目录中不存在时传 null。
   */
  async rollback(entry: CatalogEntry | null): Promise<void> {
    await this.init();

    const refuse = (reason: RollbackRefuseReason, version: string | null) => {
      this.setStatus({ kind: 'rollback-refused', version, reason });
    };

    // 本页面安装仍在进行：拒绝退回。
    if (this.current) {
      refuse('installing', this.state.previous?.version ?? null);
      return;
    }
    // 同一时间只允许一个退回；重复点击直接忽略（并发由 CAS 兜底）。
    if (this.rollingBack) return;
    this.rollingBack = true;
    try {
      await this.rollbackOnce(entry, refuse);
    } finally {
      this.rollingBack = false;
    }
  }

  private async rollbackOnce(
    entry: CatalogEntry | null,
    refuse: (reason: RollbackRefuseReason, version: string | null) => void,
  ): Promise<void> {
    const stored = await this.ports.loadState();
    this.state = stored;
    const previous = stored.previous;
    const current =
      stored.activeVersion && stored.activeCacheName && stored.activeGeneration
        ? {
            version: stored.activeVersion,
            cacheName: stored.activeCacheName,
            generation: stored.activeGeneration,
          }
        : null;

    // 其他页面安装仍在进行（IDB 存在 pending）：拒绝退回，且绝不清除其 pending。
    if (stored.pending) {
      refuse('installing', previous?.version ?? null);
      return;
    }
    if (!current || !previous || !entry || entry.version !== previous.version) {
      refuse('missing', previous?.version ?? null);
      return;
    }

    // 退回前复核：上一版缓存逐项 SHA-256 + 整单摘要，全部通过才允许切换。
    const verified = await this.verifyCachedEntry(previous.cacheName, entry);
    if (!verified) {
      // 复核失败：拒绝退回并保留当前可用版本。损坏的上一版缓存不得继续作为退回目标；
      // 但仅当代际仍属于本次复核时才清理——若其他页面已抢先切换，
      // 该缓存可能正在使用，绝不能删除。
      const cleared: PersistedState = { ...stored, previous: null };
      const clearedCommitted = await this.ports
        .commitStateIfActive(cleared, current.generation)
        .catch(() => false);
      if (clearedCommitted) {
        this.state = cleared;
        await this.safeDelete(previous.cacheName);
      } else {
        this.state = await this.ports.loadState().catch(() => this.state);
      }
      refuse('checksum', previous.version);
      return;
    }

    // 测试钩子（仅 e2e/Vitest 设置）：提交前等待，确定性构造跨标签交错；生产环境不存在。
    const gate = (globalThis as { __MANUAL_ROLLBACK_GATE__?: () => Promise<void> })
      .__MANUAL_ROLLBACK_GATE__;
    if (gate) await gate();

    // 一次切换：仅当 IDB 激活代次仍为我们复核时的代次才提交；
    // 旧版（当前版）正在使用，切换提交前绝不清理其缓存。
    const nextState: PersistedState = {
      activeVersion: previous.version,
      activeCacheName: previous.cacheName,
      activeGeneration: previous.generation,
      previous: current,
      pending: null,
    };
    let committed: boolean;
    try {
      committed = await this.ports.commitStateIfActive(nextState, current.generation);
    } catch {
      // 存储故障：拒绝退回，当前可用版本保持不变。
      this.state = await this.ports.loadState().catch(() => this.state);
      refuse('unknown', previous.version);
      return;
    }
    if (!committed) {
      // 另一标签页已完成切换：刷新本地状态，绝不覆盖新代际。
      this.state = await this.ports.loadState().catch(() => this.state);
      refuse('stale', previous.version);
      return;
    }
    this.state = nextState;

    // 代际已持久提交：回收孤儿缓存（新激活版与刚退下的上一版都保留）。
    await this.reconcileCaches();
    this.setStatus({
      kind: 'rolled-back',
      installId: previous.generation,
      version: previous.version,
    });
  }
}
