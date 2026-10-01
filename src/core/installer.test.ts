import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ChecksumError,
  HttpError,
  InstallerCoordinator,
  QuotaError,
  stageCacheNameFor,
  type InstallerPorts,
  type ManualCacheLike,
} from './installer';
import { cacheNameMatchesGeneration } from './generation';
import type { CatalogEntry, PersistedState, ResourceRef } from './types';
import { INITIAL_PERSISTED_STATE } from './types';
import { encodeCanonicalResourceList } from './resource-digest';

const sha = (text: string | Uint8Array | Buffer) => createHash('sha256').update(text).digest('hex');

const makeRef = (version: string, name: 'manifest.json' | 'faults.json', body: string): ResourceRef => ({
  url: `/manuals/v${version === '1.0.0' ? '1' : '2'}/${name}`,
  sha256: sha(body),
  kind: name === 'manifest.json' ? 'manual' : 'faults',
});

const makeEntry = (version: '1.0.0' | '2.0.0'): { entry: CatalogEntry; bodies: Map<string, string> } => {
  const manifestBody = JSON.stringify({ version, steps: [{ order: 1, action: 'a', detail: 'd' }] });
  const faultsBody = JSON.stringify({ version, entries: [] });
  const bodies = new Map<string, string>();
  const r1 = makeRef(version, 'manifest.json', manifestBody);
  const r2 = makeRef(version, 'faults.json', faultsBody);
  bodies.set(r1.url, manifestBody);
  bodies.set(r2.url, faultsBody);
  const resources = [r1, r2];
  return {
    entry: {
      version,
      releasedAt: '2026-01-01',
      title: `v${version}`,
      stepCount: 1,
      resources,
      resourcesSha256: sha(Buffer.from(encodeCanonicalResourceList(resources))),
    },
    bodies,
  };
};


const makeReuseEntry = (): { v1: CatalogEntry; v2: CatalogEntry; bodies: Map<string, string> } => {
  const v1Manifest = JSON.stringify({ version: '1.0.0' });
  const v2Manifest = JSON.stringify({ version: '2.0.0' });
  const sharedFaults = JSON.stringify({ shared: true });
  const r1m: ResourceRef = { url: '/manuals/v1/manifest.json', sha256: sha(v1Manifest), kind: 'manual' };
  const r1f: ResourceRef = { url: '/manuals/v1/faults.json', sha256: sha(sharedFaults), kind: 'faults' };
  // 地址变化，但摘要与 v1 faults 完全一致。
  const r2m: ResourceRef = { url: '/manuals/v2/manifest.json', sha256: sha(v2Manifest), kind: 'manual' };
  const r2f: ResourceRef = { url: '/manuals/v2/shared/faults.json', sha256: sha(sharedFaults), kind: 'faults' };
  const entryOf = (version: string, resources: ResourceRef[]): CatalogEntry => ({
    version,
    releasedAt: '2026-01-01',
    title: version,
    stepCount: 1,
    resources,
    resourcesSha256: sha(Buffer.from(encodeCanonicalResourceList(resources))),
  });
  const v1 = entryOf('1.0.0', [r1m, r1f]);
  const v2 = entryOf('2.0.0', [r2m, r2f]);
  return {
    v1,
    v2,
    bodies: new Map([
      [r1m.url, v1Manifest],
      [r1f.url, sharedFaults],
      [r2m.url, v2Manifest],
      [r2f.url, sharedFaults],
    ]),
  };
};

type Route =
  | { mode: 'ok' }
  | { mode: 'network' }
  | { mode: 'http' }
  | { mode: 'checksum' }
  | { mode: 'hang' }
  | { mode: 'quotaOnPut' };

interface FakePorts extends InstallerPorts {
  store: PersistedState;
  caches: Map<string, Map<string, Response>>;
  bodies: Map<string, string>;
  routes: Map<string, Route>;
  calls: string[];
  fetchUrls: string[];
  availableBytes: number | null;
  setRoute(url: string, route: Route): void;
  pendingFetch: Map<string, { reject: (e: unknown) => void }>;
}

const makePorts = (bodies: Map<string, string>): FakePorts => {
  const ports: FakePorts = {
    store: { ...INITIAL_PERSISTED_STATE },
    caches: new Map(),
    bodies,
    routes: new Map(),
    calls: [],
    fetchUrls: [],
    availableBytes: null,
    pendingFetch: new Map(),

    setRoute(url, route) {
      this.routes.set(url, route);
    },

    async loadState() {
      return JSON.parse(JSON.stringify(this.store)) as PersistedState;
    },
    async saveState(state) {
      this.calls.push('save');
      this.store = JSON.parse(JSON.stringify(state)) as PersistedState;
    },
    async commitStateIfPending(state, expectedGeneration) {
      if (this.store.pending?.installId !== expectedGeneration) return false;
      this.calls.push('commit');
      this.store = JSON.parse(JSON.stringify(state)) as PersistedState;
      return true;
    },
    async commitStateIfActive(state, expectedActiveGeneration) {
      if (this.store.activeGeneration !== expectedActiveGeneration) return false;
      if (this.store.pending) return false;
      this.calls.push('commit-rollback');
      this.store = JSON.parse(JSON.stringify(state)) as PersistedState;
      return true;
    },

    async fetchResource(ref, signal) {
      this.fetchUrls.push(ref.url);
      const route = this.routes.get(ref.url) ?? { mode: 'ok' };
      if (route.mode === 'network') {
        throw new TypeError('Failed to fetch');
      }
      if (route.mode === 'http') {
        throw new HttpError(500);
      }
      if (route.mode === 'hang') {
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort);
            this.pendingFetch.set(ref.url, { reject });
          }
        });
      }
      let body = this.bodies.get(ref.url) ?? '{}';
      if (route.mode === 'checksum') body = `${body}-tampered`;
      const bytes = new TextEncoder().encode(body);
      return { bytes, contentType: 'application/json' };
    },

    async sha256(bytes) {
      return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    },

    async estimateAvailableCapacity() {
      return this.availableBytes;
    },

    async openCache(name): Promise<ManualCacheLike> {
      let map = this.caches.get(name);
      if (!map) {
        map = new Map();
        this.caches.set(name, map);
      }
      return {
        get: async (url) => {
          const response = map!.get(url);
          if (!response) return null;
          const buffer = await response.clone().arrayBuffer();
          return {
            bytes: new Uint8Array(buffer),
            contentType: response.headers.get('content-type') ?? 'application/json',
          };
        },
        put: async (url, bytes, contentType) => {
          const route = this.routes.get(url);
          if (route?.mode === 'quotaOnPut') throw new QuotaError();
          // 用字节重建 Response 模拟 Cache 存储
          map!.set(
            url,
            new Response(bytes, { headers: { 'Content-Type': contentType } }),
          );
        },
      };
    },

    async readCacheEntry(cacheName, ref) {
      const map = this.caches.get(cacheName);
      const response = map?.get(ref.url);
      if (!response) return null;
      const buffer = await response.clone().arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get('content-type') ?? 'application/json',
      };
    },

    async deleteCache(name) {
      return this.caches.delete(name);
    },

    async listManualCaches() {
      return [...this.caches.keys()].filter((k) => k.startsWith('manual:'));
    },

    now: () => 1000,
  };
  return ports;
};

const activeCacheNameOf = (ports: FakePorts) => {
  const name = ports.store.activeCacheName!;
  expect(ports.caches.has(name)).toBe(true);
  return name;
};

const waitFor = async (predicate: () => boolean, label = 'condition') => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时: ${label}`);
};

describe('InstallerCoordinator 状态协调', () => {
  it('首次完整安装：全部资源校验通过后才提交激活，状态为 installing→activated', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.status.kind));
    await c.init();

    await c.install(v1.entry);

    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    const cacheName = ports.store.activeCacheName!;
    const cache = ports.caches.get(cacheName)!;
    expect(cache.size).toBe(2);
    // 只有在第二份资源入缓存之后才出现 activated
    expect(seen).toContain('installing');
    expect(seen[seen.length - 1]).toBe('activated');
    // 无多余孤儿缓存
    expect(await ports.listManualCaches()).toEqual([cacheName]);
  });

  it('首次失败：无激活版本，快照显示失败且界面语义为“无可用离线包”', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'network' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    const snap = c.getSnapshot();
    expect(snap.activeVersion).toBeNull();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(ports.store.activeVersion).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('校验失败：标记 checksum，清理未激活缓存，已激活版本保留', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[1].url, { mode: 'checksum' });
    await c.install(v2.entry);

    const snap = c.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(snap.activeVersion).toBe('1.0.0');
    // v2 暂存缓存被清理，v1 激活缓存保留
    expect(ports.caches.has(v1Cache)).toBe(true);
    const stageV2 = [...ports.caches.keys()].filter((k) => k.includes(':2.0.0:'));
    expect(stageV2.length).toBe(0);
  });

  it('断网（下载中途）：标记 network，旧版继续可用', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[0].url, { mode: 'network' });
    await c.install(v2.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('配额异常：标记 quota，未激活缓存清理', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'quotaOnPut' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'quota' });
    expect(ports.store.activeVersion).toBeNull();
    // 配额失败后暂存缓存被整体删除
    expect(ports.caches.size).toBe(0);
  });

  it('取消安装：AbortSignal 中止下载，标记 canceled 且清理暂存缓存', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const done = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing', 'installing');
    expect(c.getSnapshot().status).toMatchObject({ cancelRequested: false });

    await c.cancel();
    await done;

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(ports.store.pending).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('安装中关闭后重开：pending 半包被清除，继续展示此前完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const first = new InstallerCoordinator(ports);
    await first.init();
    await first.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 模拟浏览器在 v2 安装中途被杀掉：IDB 留下 pending，暂存缓存有半包内容。
    const leftover = stageCacheNameFor('2.0.0', 'leftover');
    ports.store = {
      ...ports.store,
      pending: {
        version: '2.0.0',
        cacheName: leftover,
        installId: 'leftover',
        mode: 'full',
        startedAt: 900,
      },
    };
    const halfCache = new Map<string, Response>();
    halfCache.set(v2.entry.resources[0].url, new Response('partial'));
    ports.caches.set(leftover, halfCache);

    const reopened = new InstallerCoordinator(ports);
    await reopened.init();
    const snap = reopened.getSnapshot();

    expect(snap.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    expect(ports.caches.has(leftover)).toBe(false);
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('同版本重装失败：旧激活缓存必须保留，仍展示该完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v1.entry.resources[0].url, { mode: 'checksum' });
    await c.install(v1.entry);

    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.caches.has(v1Cache)).toBe(true);
    const cachesForV1 = [...ports.caches.keys()].filter((k) => k.includes(':1.0.0:'));
    expect(cachesForV1).toEqual([v1Cache]);
  });

  it('成功升级：保留新激活缓存与紧邻上一版缓存，更早的孤儿缓存全部回收', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 无关孤儿缓存
    ports.caches.set('manual:stage:2.0.0-orphan', new Map());

    await c.install(v2.entry);

    expect(c.getSnapshot().activeVersion).toBe('2.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'activated' });
    // 上一版指针指向 v1 激活代际，其缓存保留；孤儿缓存被回收
    expect(ports.store.previous).toMatchObject({ version: '1.0.0', cacheName: v1Cache });
    const names = await ports.listManualCaches();
    expect(names).toHaveLength(2);
    expect(names).toContain(ports.store.activeCacheName);
    expect(names).toContain(v1Cache);
    expect(names).not.toContain('manual:stage:2.0.0-orphan');
  });

  it('摘要复用：下载地址变化时按摘要复制已核验字节；断网只影响变化资源', async () => {
    const data = makeReuseEntry();
    const ports = makePorts(data.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(data.v1);
    const v1Cache = activeCacheNameOf(ports);
    ports.fetchUrls.length = 0;

    // v2 的 faults 已离线复用；只让发生变化的 manifest 请求断网，旧版仍必须完整保留。
    ports.setRoute(data.v2.resources[0].url, { mode: 'network' });
    await c.install(data.v2, { mode: 'reuse', activeEntry: data.v1 });
    expect(c.getSnapshot()).toMatchObject({ activeVersion: '1.0.0' });
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(ports.fetchUrls).toEqual([data.v2.resources[0].url]);
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect([...ports.caches.keys()].filter((k) => k.includes(':2.0.0:'))).toEqual([]);

    ports.routes.clear();
    await c.install(data.v2, { mode: 'reuse', activeEntry: data.v1 });

    expect(c.getSnapshot()).toMatchObject({ activeVersion: '2.0.0' });
    expect(c.getSnapshot().status).toMatchObject({ kind: 'activated' });
    expect(ports.fetchUrls).toEqual([data.v2.resources[0].url, data.v2.resources[0].url]);
    expect(ports.fetchUrls).not.toContain(data.v2.resources[1].url);
    const v2Cache = ports.caches.get(ports.store.activeCacheName!)!;
    expect(v2Cache.has(data.v2.resources[1].url)).toBe(true);
    // 激活缓存自包含；v1 缓存作为紧邻上一版保留，可用于退回
    const names = await ports.listManualCaches();
    expect(names).toHaveLength(2);
    expect(names).toContain(ports.store.activeCacheName);
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(ports.store.previous).toMatchObject({ version: '1.0.0', cacheName: v1Cache });
  });

  it('摘要复用单项变更：只下载变化资源，随后逐项与整份清单重新校验', async () => {
    const data = makeReuseEntry();
    const ports = makePorts(data.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(data.v1);
    ports.fetchUrls.length = 0;

    await c.install(data.v2, { mode: 'reuse', activeEntry: data.v1 });

    expect(ports.fetchUrls).toEqual([data.v2.resources[0].url]);
    const cache = ports.caches.get(ports.store.activeCacheName!)!;
    expect(cache.size).toBe(2);
  });

  it('暂存区落盘后被篡改：复核失败，不激活且保留旧版', async () => {
    const data = makeReuseEntry();
    const ports = makePorts(data.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(data.v1);
    const v1Cache = activeCacheNameOf(ports);

    // 在获取/复制结束、最终复核前破坏新暂存缓存。
    const target = data.v2.resources[0].url;
    const originalOpen = ports.openCache.bind(ports);
    let calls = 0;
    ports.openCache = async (name) => {
      calls++;
      const cache = await originalOpen(name);
      if (name.includes(':2.0.0:') && calls === 2) {
        await cache.put(target, new TextEncoder().encode('corrupt-after-staging'), 'application/json');
      }
      return cache;
    };

    await c.install(data.v2, { mode: 'reuse', activeEntry: data.v1 });

    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(ports.store.activeCacheName).toBe(v1Cache);
  });

  it('容量预估不足：复制前失败，不生成新激活版本且旧版保留', async () => {
    const data = makeReuseEntry();
    const ports = makePorts(data.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(data.v1);
    const v1Cache = activeCacheNameOf(ports);
    ports.availableBytes = 1;

    await c.install(data.v2, { mode: 'reuse', activeEntry: data.v1 });

    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'quota' });
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(await ports.listManualCaches()).toEqual([v1Cache]);
  });

  it('迟到安装代次不得提交：IDB 已有新 pending 时旧尝试只失败，不激活旧候选', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const oldAttempt = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing');
    const oldInstallId = (c.getSnapshot().status as { installId: string }).installId;
    ports.store = {
      ...ports.store,
      pending: {
        ...ports.store.pending!,
        installId: 'newer-install',
        cacheName: stageCacheNameFor('1.0.0', 'newer-install'),
      },
    };
    ports.pendingFetch.get(v1.entry.resources[0].url)?.reject(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    await oldAttempt;

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(ports.store.activeVersion).toBeNull();
    expect(ports.store.pending?.installId).toBe('newer-install');
    expect((c.getSnapshot().status as { installId?: string }).installId).toBe(oldInstallId);
  });


  it('重复发起安装被忽略，同一时刻只有一个安装', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const first = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing');
    // 第二次立即返回，不产生新流程
    await c.install(v1.entry);
    await c.cancel();
    await first;
    expect(ports.pendingFetch.size).toBe(1);
  });

  it('订阅者收到不可变快照，失败与激活版本字段一致', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const snapshots: { active: string | null; status: string }[] = [];
    c.subscribe((s) => snapshots.push({ active: s.activeVersion, status: s.status.kind }));
    await c.init();
    ports.setRoute(v1.entry.resources[0].url, { mode: 'http' });
    await c.install(v1.entry);

    expect(snapshots[0].active).toBeNull();
    const failedSnap = snapshots[snapshots.length - 1];
    expect(failedSnap).toEqual({ active: null, status: 'failed' });
  });
});

describe('退回上一版', () => {
  /** 依次完整安装 v1、v2，返回协调器与两份缓存名。 */
  const installV1ThenV2 = async (ports: FakePorts) => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = ports.store.activeCacheName!;
    await c.install(v2.entry);
    const v2Cache = ports.store.activeCacheName!;
    return { c, v1Entry: v1.entry, v2Entry: v2.entry, v1Cache, v2Cache };
  };

  it('成功退回：一次 IDB 提交切换代际，当前版与上一版互换且两份缓存都保留', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);
    expect(c.getSnapshot().previousVersion).toBe('1.0.0');
    ports.calls.length = 0;

    await c.rollback(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rolled-back', version: '1.0.0' });
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().previousVersion).toBe('2.0.0');
    // 一次切换：只有一回 CAS 提交，没有任何中间态 saveState
    expect(ports.calls.filter((x) => x === 'commit-rollback')).toHaveLength(1);
    expect(ports.calls).not.toContain('save');
    // 代际互换：刚退下的 v2 成为新的上一版；两份缓存都保留
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.store.previous).toMatchObject({ version: '2.0.0', cacheName: v2Cache });
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(ports.caches.has(v2Cache)).toBe(true);
    // 激活指针与代次自洽（SW 只认同一安装代次的缓存）
    expect(cacheNameMatchesGeneration(ports.store.activeCacheName!, ports.store.activeGeneration!)).toBe(true);
    // 新激活缓存内容可读且为 v1 字节
    const reread = await ports.readCacheEntry(v1Cache, v1.entry.resources[0]);
    expect(new TextDecoder().decode(reread!.bytes)).toBe(v1.bodies.get(v1.entry.resources[0].url));
  });

  it('退回后再次退回可往返：上一版指针随切换互换', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);

    await c.rollback(v1.entry);
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');

    await c.rollback(v2.entry);
    expect(c.getSnapshot().status).toMatchObject({ kind: 'rolled-back', version: '2.0.0' });
    expect(c.getSnapshot().activeVersion).toBe('2.0.0');
    expect(ports.store.activeCacheName).toBe(v2Cache);
    expect(ports.store.previous).toMatchObject({ version: '1.0.0', cacheName: v1Cache });
  });

  it('本页安装仍在进行：拒绝退回，安装流程与当前版不受影响', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Entry } = await installV1ThenV2(ports);

    const v3 = makeEntry('2.0.0'); // 用同版本重装模拟进行中的安装
    ports.setRoute(v3.entry.resources[0].url, { mode: 'hang' });
    const installing = c.install(v3.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing', 'installing');

    await c.rollback(v1Entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'installing' });
    expect(ports.store.activeVersion).toBe('2.0.0');
    expect(ports.store.pending).not.toBeNull();
    await c.cancel();
    await installing;
    expect(ports.store.activeVersion).toBe('2.0.0');
  });

  it('其他页面安装仍在进行（IDB 存在 pending）：拒绝退回且绝不清除其 pending', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Entry } = await installV1ThenV2(ports);

    ports.store = {
      ...ports.store,
      pending: {
        version: '2.0.0',
        cacheName: stageCacheNameFor('2.0.0', 'other-tab-install'),
        installId: 'other-tab-install',
        mode: 'full',
        startedAt: 900,
      },
    };

    await c.rollback(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'installing' });
    expect(ports.store.activeVersion).toBe('2.0.0');
    expect(ports.store.pending?.installId).toBe('other-tab-install');
  });

  it('上一版缺失（只装过一个版本）：拒绝退回，当前版保留', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);
    expect(c.getSnapshot().previousVersion).toBeNull();

    await c.rollback(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'missing' });
    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('升级前只有当前版的存量记录：正常启动但暂不能退回', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    // 模拟功能升级前的存量记录：没有 previous 字段
    const legacyCache = stageCacheNameFor('1.0.0', 'legacy-gen');
    const legacyCacheMap = new Map<string, Response>();
    for (const ref of v1.entry.resources) {
      legacyCacheMap.set(ref.url, new Response(v1.bodies.get(ref.url)));
    }
    ports.caches.set(legacyCache, legacyCacheMap);
    ports.store = {
      activeVersion: '1.0.0',
      activeCacheName: legacyCache,
      activeGeneration: 'legacy-gen',
      pending: null,
    } as PersistedState;

    const c = new InstallerCoordinator(ports);
    await c.init();

    const snap = c.getSnapshot();
    expect(snap.activeVersion).toBe('1.0.0');
    expect(snap.previousVersion).toBeNull();
    expect(snap.status.kind).toBe('idle');
    expect(ports.caches.has(legacyCache)).toBe(true);

    await c.rollback(v1.entry);
    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'missing' });
    expect(ports.store.activeVersion).toBe('1.0.0');
  });

  it('目录条目与上一版不匹配：按缺失拒绝退回', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v2Entry } = await installV1ThenV2(ports);

    await c.rollback(v2Entry); // 上一版是 1.0.0，却传入 2.0.0 的目录条目
    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'missing' });
    await c.rollback(null); // 目录中不存在该版本
    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'missing' });
    expect(ports.store.activeVersion).toBe('2.0.0');
  });

  it('上一版缓存被篡改：复核失败拒绝退回，当前版保留，损坏缓存与指针被清理', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);

    // 篡改上一版缓存中的一个资源
    const target = v1.entry.resources[0].url;
    const tampered = new Map(ports.caches.get(v1Cache)!);
    tampered.set(target, new Response('corrupt-previous'));
    ports.caches.set(v1Cache, tampered);

    await c.rollback(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'checksum' });
    expect(c.getSnapshot().activeVersion).toBe('2.0.0');
    expect(ports.store.activeVersion).toBe('2.0.0');
    expect(ports.store.previous).toBeNull();
    expect(ports.caches.has(v1Cache)).toBe(false);
    expect(ports.caches.has(v2Cache)).toBe(true);
  });

  it('上一版缓存整体缺失：复核失败拒绝退回，当前版保留', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);

    ports.caches.delete(v1Cache); // 上一版缓存被外部清掉

    await c.rollback(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'checksum' });
    expect(ports.store.activeVersion).toBe('2.0.0');
    expect(ports.store.previous).toBeNull();
    expect(ports.caches.has(v2Cache)).toBe(true);
  });

  it('整单摘要被篡改：复核失败拒绝退回', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v2Cache } = await installV1ThenV2(ports);

    const forged: CatalogEntry = { ...v1.entry, resourcesSha256: sha('forged-manifest') };
    await c.rollback(forged);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'checksum' });
    expect(ports.store.activeVersion).toBe('2.0.0');
    expect(ports.caches.has(v2Cache)).toBe(true);
  });

  it('另一标签页已完成切换：迟到的退回不得覆盖新代际', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);
    const genV1 = ports.store.previous!.generation;

    // 提交前钩子：模拟另一标签页已抢先完成退回（active 变为 v1 代际）
    (globalThis as { __MANUAL_ROLLBACK_GATE__?: () => Promise<void> }).__MANUAL_ROLLBACK_GATE__ =
      async () => {
        ports.store = {
          activeVersion: '1.0.0',
          activeCacheName: v1Cache,
          activeGeneration: genV1,
          previous: { version: '2.0.0', cacheName: v2Cache, generation: ports.store.activeGeneration! },
          pending: null,
        };
      };
    try {
      await c.rollback(v1.entry);
    } finally {
      delete (globalThis as { __MANUAL_ROLLBACK_GATE__?: () => Promise<void> }).__MANUAL_ROLLBACK_GATE__;
    }

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'stale' });
    // 新代际保持另一标签页的结果，未被本次迟到退回覆盖
    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.store.activeGeneration).toBe(genV1);
    expect(ports.store.previous?.version).toBe('2.0.0');
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(ports.caches.has(v2Cache)).toBe(true);
  });

  it('存储故障（提交时抛错）：拒绝退回，当前可用版本保持不变', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const { c, v1Cache, v2Cache } = await installV1ThenV2(ports);
    const storeBefore = JSON.parse(JSON.stringify(ports.store)) as PersistedState;

    const original = ports.commitStateIfActive.bind(ports);
    ports.commitStateIfActive = async () => {
      throw new Error('IDB 写入失败（模拟存储故障）');
    };
    await c.rollback(v1.entry);
    ports.commitStateIfActive = original;

    expect(c.getSnapshot().status).toMatchObject({ kind: 'rollback-refused', reason: 'unknown' });
    expect(ports.store).toEqual(storeBefore);
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(ports.caches.has(v2Cache)).toBe(true);
  });
});

// 让未使用的类型导入保持显式（ChecksumError 在映射逻辑中间接验证）
void ChecksumError;
