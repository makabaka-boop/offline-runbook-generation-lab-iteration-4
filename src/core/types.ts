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
  | 'unknown';

export const FAILURE_TEXT: Record<FailureCode, string> = {
  checksum: '资源校验失败（SHA-256 不匹配），已丢弃本版缓存',
  network: '下载中断或网络不可用，已丢弃本版缓存',
  quota: '存储空间配额异常，已丢弃本版缓存',
  canceled: '安装已取消，未激活缓存已清理',
  unknown: '安装发生未知错误，未激活缓存已清理',
};

export type InstallMode = 'full' | 'reuse';

/** 紧邻上一版（已核验完整版）的缓存指针，用于“退回上一版”。 */
export interface PreviousGeneration {
  version: string;
  cacheName: string;
  /** 上一版激活代次的安装 ID；缓存名也必须携带同一 ID。 */
  generation: string;
}

/** IndexedDB 中唯一持久化的记录（当前代际与安装状态）。 */
export interface PersistedState {
  /** 当前已激活的完整版本；从未成功安装时为 null。 */
  activeVersion: string | null;
  /** 已激活版本缓存的 Cache Storage 键名。 */
  activeCacheName: string | null;
  /** 已激活代次的唯一安装 ID；缓存名也必须携带同一 ID。 */
  activeGeneration: string | null;
  /**
   * 紧邻上一版的缓存指针；成功安装时最多保留当前版与上一版两份缓存。
   * 升级前的存量记录没有该字段，按 null 处理（可正常启动，暂不能退回）。
   */
  previous: PreviousGeneration | null;
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
  previous: null,
  pending: null,
};

/** 退回上一版被拒绝的原因分类。 */
export type RollbackRefuseReason =
  | 'installing' // 安装仍在进行（本页或其他页面），不能退回
  | 'missing' // 上一版缺失（无记录或目录中不存在）
  | 'checksum' // 上一版缓存复核未通过
  | 'stale' // 另一页面已完成切换，本次退回迟到
  | 'unknown';

export const ROLLBACK_REFUSE_TEXT: Record<RollbackRefuseReason, string> = {
  installing: '安装仍在进行，不能退回上一版；当前版本继续可用',
  missing: '没有可退回的上一版（未保留上一版完整缓存）；当前版本继续可用',
  checksum: '上一版缓存复核未通过（SHA-256 不匹配），已拒绝退回；当前版本继续可用',
  stale: '另一页面已完成版本切换，本次退回已取消，未覆盖新代际',
  unknown: '退回过程中发生未知错误，已保留当前版本',
};

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
  | { kind: 'failed'; installId?: string; version: string | null; code: FailureCode }
  | { kind: 'rolled-back'; installId: string; version: string }
  | { kind: 'rollback-refused'; version: string | null; reason: RollbackRefuseReason };

export interface Snapshot {
  activeVersion: string | null;
  /** 紧邻上一版版本号；为 null 时不可退回。 */
  previousVersion: string | null;
  status: InstallerStatus;
}
