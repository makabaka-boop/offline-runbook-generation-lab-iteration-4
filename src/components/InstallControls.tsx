import type { CatalogEntry, FailureCode, InstallMode, InstallerStatus } from '../core/types';

export interface InstallProgress {
  installId: string;
  mode: InstallMode;
  phase: 'acquire' | 'verify';
  version: string;
  progress: number;
  completed: number;
  total: number;
  reused: number;
  fetched: number;
  verified: number;
  cancelRequested: boolean;
}

export interface InstallFailure {
  installId?: string;
  version: string | null;
  code: FailureCode;
  scope?: 'install' | 'rollback';
}

export interface ActivatedInfo {
  installId: string;
  version: string;
}

export interface InstallControlsProps {
  catalog: CatalogEntry[];
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  activated?: ActivatedInfo | null;
  onInstall: (version: string, mode: InstallMode) => void;
  onCancel: () => void;
}

export function VersionCard({
  entry,
  activeVersion,
  swReady,
  installing,
  failed,
  onInstall,
  onCancel,
  compact,
}: {
  entry: CatalogEntry;
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  onInstall: (version: string, mode: InstallMode) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const isActive = entry.version === activeVersion;
  const isInstallingThis = installing?.version === entry.version;
  const failedHere = failed?.version === entry.version && failed.scope !== 'rollback';
  const otherInstalling = installing !== null && installing.version !== entry.version;

  return (
    <div className="card" data-testid={`catalog-card-${entry.version}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>
          版本 {entry.version}
          {isActive && (
            <span className="badge active" data-testid={`active-badge-${entry.version}`} style={{ marginLeft: 8 }}>
              当前版
            </span>
          )}
        </strong>
        <span className="small">{entry.releasedAt} 发布</span>
      </div>
      {!compact && <div className="meta">{entry.title}</div>}
      <div className="meta">
        {entry.stepCount} 个有序步骤 · {entry.resources.length} 个同源资源（SHA-256 校验）
      </div>

      {isInstallingThis && installing && (
        <div data-testid={`installing-${entry.version}`}>
          <div className="small">
            {installing.phase === 'acquire' ? '正在获取/复制' : '正在复核暂存区'}
            {' '}
            {installing.phase === 'acquire'
              ? `${installing.completed}/${installing.total}（复用 ${installing.reused}、下载 ${installing.fetched}）`
              : `${installing.verified}/${installing.total}`}
            （{installing.progress}%）…
            {installing.cancelRequested && ' 正在取消…'}
          </div>
          <div className="progress">
            <span style={{ width: `${installing.progress}%` }} />
          </div>
          <button className="danger" data-testid={`cancel-${entry.version}`} onClick={onCancel}>
            取消安装
          </button>
        </div>
      )}

      {!isInstallingThis && (
        <div className="row" style={{ gap: 8 }}>
          <button
            className={isActive ? '' : 'primary'}
            data-testid={`install-${entry.version}`}
            disabled={!swReady || otherInstalling}
            onClick={() => onInstall(entry.version, 'full')}
          >
            {isActive ? '重新下载并校验（重装）' : `完整安装 ${entry.version}`}
          </button>
          {!isActive && (
            <button
              data-testid={`reuse-install-${entry.version}`}
              disabled={!swReady || otherInstalling || !activeVersion}
              title={activeVersion ? '只下载摘要变化的资源，其余从当前已核验版本复制' : '需先完整安装一个版本'}
              onClick={() => onInstall(entry.version, 'reuse')}
            >
              按摘要复用安装
            </button>
          )}
        </div>
      )}

      {failedHere && failed && (
        <div className="banner error" data-testid={`fail-${entry.version}`} style={{ marginTop: 10 }}>
          {failureTextOf(failed.code)}
        </div>
      )}
    </div>
  );
}

const failureTextOf = (code: FailureCode): string => {
  const map: Record<FailureCode, string> = {
    checksum: '资源校验失败（SHA-256 不匹配），未激活缓存已清理',
    network: '下载中断或网络不可用，未激活缓存已清理',
    quota: '存储空间配额异常，未激活缓存已清理',
    canceled: '安装已取消，未激活缓存已清理',
    busy: '安装仍在进行，不能退回版本；当前可用版本保持不变',
    missing: '上一版完整缓存缺失，不能退回；当前可用版本保持不变',
    stale: '退回确认已过期：另一标签页已完成切换，未覆盖新代际',
    unknown: '发生未知错误',
  };
  return map[code];
};

interface RollbackControlsProps {
  activeVersion: string;
  previousVersion: string | null;
  previousTitle: string;
  status: Extract<InstallerStatus, { kind: 'rollback-reviewing' }> | null;
  installing: InstallProgress | null;
  swReady: boolean;
  onReview: () => void;
  onConfirm: () => void;
  onCancelReview: () => void;
}

export function RollbackControls({
  activeVersion,
  previousVersion,
  previousTitle,
  status,
  installing,
  swReady,
  onReview,
  onConfirm,
  onCancelReview,
}: RollbackControlsProps) {
  const review = status?.review ?? null;
  const reviewingThis = review?.version === previousVersion;

  return (
    <div className="panel" data-testid="rollback-panel">
      <h2>退回上一已核验版本</h2>
      <div className="small" style={{ marginBottom: 10 }}>
        成功安装后最多只保留当前版与紧邻上一版。退回会先离线复核上一版缓存的每个资源与整单摘要，
        确认后才一次切换 IndexedDB 激活代际；Service Worker、步骤页和演练会话随后都指向上一版。
      </div>

      {!previousVersion && (
        <div className="banner warn" data-testid="rollback-unavailable">
          当前只有版本 {activeVersion} 的存量完整记录，可正常离线启动；暂无紧邻上一版，暂不能退回。
        </div>
      )}

      {previousVersion && !reviewingThis && (
        <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <div>
            <strong data-testid="rollback-previous-version">上一版：{previousVersion}</strong>
            <div className="small">{previousTitle}</div>
          </div>
          <button
            className="primary"
            data-testid="rollback-review"
            disabled={!swReady || installing !== null}
            title={installing ? '安装仍在进行时不能退回' : '复核上一版缓存与整单摘要'}
            onClick={onReview}
          >
            复核上一版
          </button>
        </div>
      )}

      {previousVersion && reviewingThis && review && (
        <div data-testid="rollback-confirmation">
          <div className="banner ok">
            复核通过：版本 {review.version} 的 {review.resourceCount} 个资源均可从本地缓存读取，
            SHA-256 逐项一致。
            <div className="small" data-testid="rollback-digest">
              整单摘要：{review.resourcesSha256}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="primary" data-testid="rollback-confirm" onClick={onConfirm}>
              确认退回 {review.version}
            </button>
            <button data-testid="rollback-cancel" onClick={onCancelReview}>
              取消，保留 {activeVersion}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
