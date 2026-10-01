import { useState } from 'react';
import type {
  CatalogEntry,
  FailureCode,
  InstallMode,
  InstallerStatus,
} from '../core/types';
import type { ManualBundle } from '../manuals';
import {
  RollbackControls,
  VersionCard,
  type ActivatedInfo,
  type InstallFailure,
  type InstallProgress,
} from './InstallControls';
import { StepsPanel } from './StepsPanel';
import { DrillPanel } from './DrillPanel';

interface Props {
  swReady: boolean;
  catalog: CatalogEntry[];
  activeVersion: string;
  activeTitle: string;
  releasedAt: string;
  bundle: ManualBundle | null;
  bundleVersion: string | null;
  loadError: string;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  activated: ActivatedInfo | null;
  rolledBack: { version: string; fromVersion: string } | null;
  previousVersion: string | null;
  previousTitle: string;
  rollbackStatus: Extract<InstallerStatus, { kind: 'rollback-reviewing' }> | null;
  onReviewRollback: () => void;
  onConfirmRollback: () => void;
  onCancelRollbackReview: () => void;
  failureText: Record<FailureCode, string>;
  switchNotice: boolean;
  dismissSwitchNotice: () => void;
  onInstall: (version: string, mode: InstallMode) => void;
  onCancel: () => void;
}

export function Workshop(props: Props) {
  const {
    swReady,
    catalog,
    activeVersion,
    activeTitle,
    releasedAt,
    bundle,
    loadError,
    installing,
    failed,
    activated,
    rolledBack,
    previousVersion,
    previousTitle,
    rollbackStatus,
    onReviewRollback,
    onConfirmRollback,
    onCancelRollbackReview,
    failureText,
    switchNotice,
    dismissSwitchNotice,
    onInstall,
    onCancel,
  } = props;
  const [tab, setTab] = useState<'steps' | 'drill'>('steps');
  const [drillTerminatedFrom, setDrillTerminatedFrom] = useState<string | null>(null);
  const [recordsInvalidatedFrom, setRecordsInvalidatedFrom] = useState<{
    version: string;
    count: number;
  } | null>(null);

  const handleDrillTerminated = (previousVersion: string) => {
    setDrillTerminatedFrom(previousVersion);
  };

  const handleRecordsInvalidated = (previousVersion: string, count: number) => {
    setRecordsInvalidatedFrom({ version: previousVersion, count });
  };

  return (
    <>
      {switchNotice && (
        <div className="banner ok" data-testid="switch-notice">
          已切换到版本 {activeVersion}：现在只显示该版步骤与演练条目；未完成演练已终止，旧结论已失效。
          <button style={{ marginLeft: 12 }} onClick={dismissSwitchNotice}>
            知道了
          </button>
        </div>
      )}

      {drillTerminatedFrom && (
        <div className="banner warn" data-testid="drill-terminated">
          从版本 {drillTerminatedFrom} 切换到 {activeVersion}：未完成的演练已终止，
          请在当前版重新开始。
          <button style={{ marginLeft: 12 }} onClick={() => setDrillTerminatedFrom(null)}>
            知道了
          </button>
        </div>
      )}

      {recordsInvalidatedFrom && (
        <div className="banner warn" data-testid="records-invalidated">
          版本 {recordsInvalidatedFrom.version} 的 {recordsInvalidatedFrom.count} 条演练通过结论
          已随版本切换失效；当前版本 {activeVersion} 需重新演练。
          <button
            style={{ marginLeft: 12 }}
            onClick={() => setRecordsInvalidatedFrom(null)}
          >
            知道了
          </button>
        </div>
      )}

      {activated && (
        <div className="banner ok" data-testid="activated-banner">
          版本 {activated.version} 已完整安装并激活；系统最多保留它与紧邻上一版。
        </div>
      )}

      {rolledBack && (
        <div className="banner ok" data-testid="rolled-back-banner">
          已从版本 {rolledBack.fromVersion} 退回到版本 {rolledBack.version}：
          Service Worker、步骤页和演练会话均已指向该版本。
        </div>
      )}

      {failed && (
        <div className="banner error" data-testid="failed-banner">
          {failureText[failed.code]}
          <div className="small">
            {failed.scope === 'rollback'
              ? '退回操作已拒绝；当前版和上一版缓存均保留，当前可用版本保持不变。'
              : `未激活暂存缓存已清理，当前继续提供版本 ${activeVersion} 的完整手册。`}
          </div>
        </div>
      )}

      {installing && (
        <div className="banner info" data-testid="installing-banner">
          {installing.mode === 'reuse' ? '按摘要复用安装' : '完整下载安装'}版本 {installing.version}：
          {installing.phase === 'acquire'
            ? ` ${installing.completed}/${installing.total} · 复用 ${installing.reused} · 下载 ${installing.fetched} · `
            : ` 暂存区复核 ${installing.verified}/${installing.total} · `}
          {installing.progress}%
          {installing.cancelRequested ? '（正在取消…）' : '。完成校验前不会替换当前手册。'}
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <span className="badge active" data-testid="current-version">
              当前版本 {activeVersion}
            </span>
            <span style={{ marginLeft: 10 }}>{activeTitle}</span>
            <span className="small" style={{ marginLeft: 10 }}>
              {releasedAt}
            </span>
          </div>
          <span className="small" data-testid="offline-hint">
            断网时本页仍可打开（Service Worker + Cache Storage）
          </span>
        </div>
      </div>

      {loadError && (
        <div className="banner error" data-testid="manual-load-error">
          当前版手册读取失败：{loadError}
        </div>
      )}

      {bundle && (
        <>
          <div className="tabs" data-testid="tabs">
            <button
              className={tab === 'steps' ? 'on' : ''}
              data-testid="tab-steps"
              onClick={() => setTab('steps')}
            >
              断电步骤
            </button>
            <button
              className={tab === 'drill' ? 'on' : ''}
              data-testid="tab-drill"
              onClick={() => setTab('drill')}
            >
              离线演练
            </button>
          </div>

          {tab === 'steps' && <StepsPanel manifest={bundle.manifest} />}
          {/* 演练面板常驻挂载（仅隐藏），确保切换版本时即便停留在步骤页也能终止未完成演练。 */}
          <div style={{ display: tab === 'drill' ? 'block' : 'none' }}>
            <DrillPanel
              version={bundle.manifest.version}
              entries={bundle.faults}
              onTerminated={handleDrillTerminated}
              onRecordsInvalidated={handleRecordsInvalidated}
            />
          </div>
        </>
      )}

      <RollbackControls
        activeVersion={activeVersion}
        previousVersion={previousVersion}
        previousTitle={previousTitle}
        status={rollbackStatus}
        installing={installing}
        swReady={swReady}
        onReview={onReviewRollback}
        onConfirm={onConfirmRollback}
        onCancelReview={onCancelRollbackReview}
      />

      <div className="panel">
        <h2>手册版本管理</h2>
        <div className="small" style={{ marginBottom: 10 }}>
          新版本只有在所有资源获取/复制且 SHA-256 与整单摘要校验通过后才会激活；中断、取消、断网或配额异常都会清理未激活缓存，
          当前完整版本继续可用。复用安装只把当前已核验字节复制到新暂存区；成功后最多保留当前版与紧邻上一版。
          {!swReady && '（离线服务尚未就绪，暂不能开始安装）'}
        </div>
        {catalog.map((entry) => (
          <VersionCard
            key={entry.version}
            entry={entry}
            activeVersion={activeVersion}
            swReady={swReady}
            installing={installing}
            failed={failed}
            onInstall={onInstall}
            onCancel={onCancel}
          />
        ))}
      </div>
    </>
  );
}
