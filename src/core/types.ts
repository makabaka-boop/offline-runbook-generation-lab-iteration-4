/** 手册手册域的共享类型定义（无 DOM 依赖，可在 SW 与测试中使用）。 */

/** 清单中单个同源资源的引用：URL + SHA-256 完整性。 */
export interface ResourceRef {
  url: string;
  sha256: string;
  kind: 'manual' | 'faults';
}

/** 手册版本清单（含版本号、同源资源、有序步骤与故障条目）。 */
export interface ManualManifest {
  version: string;
  releasedAt: string;
  title: string;
  steps: OrderedStep[];
}

export interface OrderedStep {
  order: number;
  action: string;
  detail: string;
}

export interface FaultEntry {
  id: string;
  title: string;
  keywords: string[];
  symptoms: string;
  actions: string[];
}

/** 内置手册目录中的一个版本条目（清单：版本号 + 同源 URL + SHA-256 + 有序步骤数）。 */
export interface CatalogEntry {
  version: string;
  releasedAt: string;
  title: string;
  stepCount: number;
  resources: ResourceRef[];
  /** 对整份资源清单（URL、摘要、类型及顺序）的 SHA-256，防止单项之外的清单结构被替换。 */
  resourcesSha256: string;
}

/** 安装失败原因分类。 */
export type FailureCode =
  | 'checksum' // 校验失败
  | 'network' // 断网 / 下载失败
  | 'quota' // 配额异常
  | 'canceled' // 取消 / 过期安装代次
  | 'busy' // 安装仍在进行，不能退回
  | 'missing' // 上一版缓存或元数据缺失
  | 'stale' // 退回确认迟到，激活代际已被其他标签页切换
  | 'unknown';

export const FAILURE_TEXT: Record<FailureCode, string> = {
  checksum: '资源校验失败（SHA-256 不匹配）',
  network: '下载中断或网络不可用，已丢弃本版缓存',
  quota: '存储空间配额异常，已丢弃本版缓存',
  canceled: '安装已取消，未激活缓存已清理',
  busy: '安装仍在进行，不能退回版本；当前可用版本保持不变',
  missing: '上一版完整缓存缺失，不能退回；当前可用版本保持不变',
  stale: '退回确认已过期：另一标签页已完成切换，未覆盖新代际',
  unknown: '发生未知错误',
};

export type InstallMode = 'full' | 'reuse';

/** IndexedDB 中唯一持久化的记录（当前/上一版代际指针与安装状态）。 */
export interface PersistedState {
  /** 当前已激活的完整版本；从未成功安装时为 null。 */
  activeVersion: string | null;
  /** 已激活版本缓存的 Cache Storage 键名。 */
  activeCacheName: string | null;
  /** 已激活代次的唯一安装 ID；缓存名也必须携带同一 ID。 */
  activeGeneration: string | null;
  /**
   * 紧邻当前版、且缓存仍完整保留的上一版。
   * 成功安装新代际后写入；退回成功后与当前版交换。只有当前版的存量记录为 null。
   */
  previousVersion: string | null;
  previousCacheName: string | null;
  previousGeneration: string | null;
  /**
   * 正在进行中的安装（用于关闭后重开时识别“半包”）。
   * 一旦存在即视为中断残留，启动时清理并永不激活。
   */
  pending: {
    version: string;
    cacheName: string;
    installId: string;
    mode: InstallMode;
    startedAt: number;
  } | null;
}

export const INITIAL_PERSISTED_STATE: PersistedState = {
  activeVersion: null,
  activeCacheName: null,
  activeGeneration: null,
  previousVersion: null,
  previousCacheName: null,
  previousGeneration: null,
  pending: null,
};

export interface RollbackReview {
  version: string;
  cacheName: string;
  generation: string;
  resourceCount: number;
  resourcesSha256: string;
}

export type InstallerStatus =
  | { kind: 'idle' }
  | {
      kind: 'installing';
      installId: string;
      mode: InstallMode;
      version: string;
      phase: 'acquire' | 'verify';
      /** 0–100 的整数进度。 */
      progress: number;
      completed: number;
      total: number;
      reused: number;
      fetched: number;
      verified: number;
      cancelRequested: boolean;
    }
  | { kind: 'activated'; installId: string; version: string }
  | { kind: 'rollback-reviewing'; review: RollbackReview }
  | { kind: 'rolled-back'; version: string; fromVersion: string; generation: string }
  | {
      kind: 'failed';
      installId?: string;
      version: string | null;
      code: FailureCode;
      scope?: 'install' | 'rollback';
    };

export interface Snapshot {
  activeVersion: string | null;
  activeGeneration: string | null;
  previousVersion: string | null;
  previousGeneration: string | null;
  status: InstallerStatus;
}
