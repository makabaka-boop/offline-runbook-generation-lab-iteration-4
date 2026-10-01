/** IndexedDB 封装：只保存“当前代际与安装状态”一条记录。
 * 手册正文与任何资源都不写入 IndexedDB——离线读取由 Service Worker + Cache Storage 负责。
 * 该模块同时被页面与 Service Worker 使用。
 */
import type { PersistedState } from './types';
import { INITIAL_PERSISTED_STATE } from './types';

const DB_NAME = 'manual-kiosk-db';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'current';

type IDBFactoryLike = IDBFactory;

const generationFromCacheName = (cacheName: string): string => {
  const parts = cacheName.split(':');
  return parts.length >= 4 ? parts[parts.length - 1] : '';
};

export function openStateDb(idbFactory: IDBFactoryLike = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

export async function readState(db?: IDBDatabase): Promise<PersistedState> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!stored || typeof stored !== 'object') {
      return { ...INITIAL_PERSISTED_STATE };
    }
    const s = stored as Partial<PersistedState>;
    const activeCacheName =
      typeof s.activeCacheName === 'string' ? s.activeCacheName : null;
    const pendingCacheName =
      s.pending && typeof s.pending === 'object' && typeof s.pending.cacheName === 'string'
        ? s.pending.cacheName
        : null;
    // 升级前的存量记录没有 previous 字段：按 null 处理，正常启动但暂不能退回。
    const previousRaw =
      s.previous && typeof s.previous === 'object'
        ? (s.previous as Partial<PersistedState['previous'] & object>)
        : null;
    const previousCacheName =
      previousRaw && typeof previousRaw.cacheName === 'string' ? previousRaw.cacheName : null;
    return {
      activeVersion: typeof s.activeVersion === 'string' ? s.activeVersion : null,
      activeCacheName,
      activeGeneration:
        typeof s.activeGeneration === 'string'
          ? s.activeGeneration
          : activeCacheName
            ? generationFromCacheName(activeCacheName)
            : null,
      previous:
        previousRaw && typeof previousRaw.version === 'string' && previousCacheName
          ? {
              version: previousRaw.version,
              cacheName: previousCacheName,
              generation:
                typeof previousRaw.generation === 'string'
                  ? previousRaw.generation
                  : generationFromCacheName(previousCacheName),
            }
          : null,
      pending:
        s.pending &&
        typeof s.pending === 'object' &&
        typeof s.pending.version === 'string' &&
        pendingCacheName
          ? {
              version: s.pending.version,
              cacheName: pendingCacheName,
              installId:
                typeof s.pending.installId === 'string'
                  ? s.pending.installId
                  : generationFromCacheName(pendingCacheName),
              mode: s.pending.mode === 'reuse' ? 'reuse' : 'full',
              startedAt: Number(s.pending.startedAt) || 0,
            }
          : null,
    };
  } finally {
    if (owned) handle.close();
  }
}

export async function writeState(state: PersistedState, db?: IDBDatabase): Promise<void> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}

export async function commitStateIfPending(
  state: PersistedState,
  expectedGeneration: string,
  db?: IDBDatabase,
): Promise<boolean> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let committed = false;
      const req = store.get(KEY);
      req.onsuccess = () => {
        const current = req.result as Partial<PersistedState> | undefined;
        const pending = current?.pending as PersistedState['pending'] | undefined;
        if (pending?.installId !== expectedGeneration) {
          // 请求成功但代次不属于本次尝试：不能写入，也不能中止其他代次。
          return;
        }
        store.put(state, KEY);
        committed = true;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 提交失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 提交中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}

/**
 * 退回上一版的原子提交：仅当 IDB 当前激活代次仍等于 expectedActiveGeneration
 * 且没有进行中安装时，才在单个事务内写入回退后的状态。
 * 另一标签页已抢先完成切换（安装或退回）时返回 false，绝不覆盖新代际。
 */
export async function commitStateIfActive(
  state: PersistedState,
  expectedActiveGeneration: string,
  db?: IDBDatabase,
): Promise<boolean> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let committed = false;
      const req = store.get(KEY);
      req.onsuccess = () => {
        const current = req.result as Partial<PersistedState> | undefined;
        if (
          !current ||
          current.activeGeneration !== expectedActiveGeneration ||
          current.pending
        ) {
          // 代际已被其他页面切换，或存在进行中安装：不能写入。
          return;
        }
        store.put(state, KEY);
        committed = true;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 提交失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 提交中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}
