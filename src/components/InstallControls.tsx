import type { CatalogEntry, FailureCode, InstallMode } from '../core/types';

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
  failureText: Record<FailureCode, string>;
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
  const failedHere = failed?.version === entry.version;
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
    unknown: '安装发生未知错误，未激活缓存已清理',
  };
  return map[code];
};
