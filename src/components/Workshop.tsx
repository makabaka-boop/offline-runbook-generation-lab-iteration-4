import { useState } from 'react';
import type { CatalogEntry, FailureCode, InstallMode } from '../core/types';
import type { ManualBundle } from '../manuals';
import {
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
    failureText,
    switchNotice,
    dismissSwitchNotice,
    onInstall,
    onCancel,
  } = props;
  const [tab, setTab] = useState<'steps' | 'drill'>('steps');
  const [drillTerminatedFrom, setDrillTerminatedFrom] = useState<string | null>(null);

  const handleDrillTerminated = (previousVersion: string) => {
    setDrillTerminatedFrom(previousVersion);
  };

  return (
    <>
      {switchNotice && (
        <div className="banner ok" data-testid="switch-notice">
          已切换到版本 {activeVersion}：现在只显示该版步骤与演练条目；未完成演练已终止。
          <button style={{ marginLeft: 12 }} onClick={dismissSwitchNotice}>
            知道了
          </button>
        </div>
      )}

      {drillTerminatedFrom && (
        <div className="banner warn" data-testid="drill-terminated">
          从版本 {drillTerminatedFrom} 升级到 {activeVersion}：未完成的演练已终止，
          请在当前版重新开始。
          <button style={{ marginLeft: 12 }} onClick={() => setDrillTerminatedFrom(null)}>
            知道了
          </button>
        </div>
      )}

      {activated && (
        <div className="banner ok" data-testid="activated-banner">
          版本 {activated.version} 已完整安装并激活；旧版缓存已清理。
        </div>
      )}

      {failed && (
        <div className="banner error" data-testid="failed-banner">
          {failureText[failed.code]}
          <div className="small">
            当前继续提供版本 {activeVersion} 的完整手册。
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
            />
          </div>
        </>
      )}

      <div className="panel">
        <h2>手册版本管理</h2>
        <div className="small" style={{ marginBottom: 10 }}>
          新版本只有在所有资源获取/复制且 SHA-256 与整单摘要校验通过后才会激活；中断、取消、断网或配额异常都会清理未激活缓存，
          当前完整版本继续可用。复用安装只把当前已核验字节复制到新暂存区，激活后不引用旧缓存。
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
