import { useEffect, useMemo, useRef, useState } from 'react';
import type { FaultEntry } from '../core/types';
import {
  buildPassRecord,
  checkNext,
  isActionUnlocked,
  searchEntries,
  selectEntry,
  startDrill,
  type DrillSession,
  type PassRecord,
} from '../core/drill';

interface Props {
  version: string;
  entries: FaultEntry[];
  /** 未完成演练因版本切换被终止时回调（由父级持久展示提示）。 */
  onTerminated: (previousVersion: string) => void;
  /** 已通过但绑定旧版本的结论在切换后失效时回调。 */
  onRecordsInvalidated: (previousVersion: string, count: number) => void;
}

export function DrillPanel({ version, entries, onTerminated, onRecordsInvalidated }: Props) {
  const [session, setSession] = useState<DrillSession | null>(null);
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<PassRecord[]>([]);
  const previousVersionRef = useRef(version);
  const sessionRef = useRef<DrillSession | null>(null);
  const recordsRef = useRef<PassRecord[]>([]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  // 版本切换：未完成演练终止；旧版本的通过结论不再作为当前版结论，全部失效并清空。
  useEffect(() => {
    const previousVersion = previousVersionRef.current;
    if (previousVersion === version) return;

    const previousSession = sessionRef.current;
    if (
      previousSession?.version === previousVersion &&
      previousSession.selectedEntryId !== null &&
      !previousSession.passed
    ) {
      onTerminated(previousVersion);
    }

    const staleRecords = recordsRef.current;
    if (staleRecords.length > 0) {
      const staleCount = staleRecords.filter((record) => record.version === previousVersion).length;
      onRecordsInvalidated(previousVersion, staleCount);
      setRecords([]);
    }

    setSession(startDrill(version));
    setQuery('');
    previousVersionRef.current = version;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const results = useMemo(() => searchEntries(entries, query), [entries, query]);
  const selected = entries.find((e) => e.id === session?.selectedEntryId) ?? null;

  const handleSelect = (entry: FaultEntry) => {
    setSession((s) => (s ? selectEntry(s, entry) : startDrill(version)));
  };

  const handleCheck = (index: number) => {
    if (!session || !selected) return;
    const next = checkNext(session, selected, index);
    setSession(next);
    if (next.passed) {
      const record = buildPassRecord(next, selected, Date.now());
      if (record) setRecords((rs) => [record, ...rs]);
    }
  };

  return (
    <div className="panel" data-testid="drill-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>离线故障演练 · 版本 {version}</h2>
        <span className="badge">只能选择当前版条目</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <input
          type="search"
          data-testid="fault-search"
          placeholder="搜索当前版故障条目，如：UPS、跳闸、STS、温度"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="fault-list" data-testid="fault-list">
        {results.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`fault-item ${session?.selectedEntryId === entry.id ? 'on' : ''}`}
            data-testid={`fault-${entry.id}`}
            onClick={() => handleSelect(entry)}
          >
            <strong>{entry.title}</strong>
            <div className="small" style={{ marginTop: 4, textAlign: 'left' }}>
              {entry.symptoms}
            </div>
          </button>
        ))}
        {results.length === 0 && (
          <div className="small" data-testid="fault-empty">
            当前版未找到匹配条目。
          </div>
        )}
      </div>

      {selected && session && (
        <div className="panel" style={{ background: 'var(--panel-2)', marginTop: 14 }}>
          <h2 style={{ fontSize: 15 }}>{selected.title}</h2>
          <div className="small">{selected.symptoms}</div>
          <ul className="action-list" data-testid="action-list">
            {selected.actions.map((action, i) => {
              const unlocked = isActionUnlocked(session, i);
              const done = i < session.checkedUpTo;
              return (
                <li key={i} className={unlocked || done ? '' : 'locked'}>
                  <span className="idx">{done ? '✓' : i + 1}</span>
                  <span style={{ flex: 1 }}>{action}</span>
                  <button
                    type="button"
                    data-testid={`action-${selected.id}-${i}`}
                    disabled={!unlocked}
                    onClick={() => handleCheck(i)}
                  >
                    {done ? '已完成' : '勾选本步'}
                  </button>
                </li>
              );
            })}
          </ul>

          {session.passed && (
            <div className="pass-box" data-testid="pass-box">
              <div style={{ fontWeight: 700 }}>演练通过</div>
              <div className="small" style={{ margin: '6px 0' }}>
                本结论绑定版本 {version} · {selected.title}
              </div>
              <code data-testid="pass-code">
                PASS-{version}-{records.find((r) => r.entryId === selected.id)?.code ?? '----'}
              </code>
            </div>
          )}
        </div>
      )}

      {records.length > 0 && (
        <div className="history" data-testid="pass-history">
          <strong>已通过结论（按版本绑定）：</strong>
          <ul>
            {records.map((r) => (
              <li key={r.code} data-testid={`record-${r.code}`}>
                版本 {r.version} · {r.entryTitle} · 编号 {r.code}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
