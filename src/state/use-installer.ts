import { useEffect, useState, useSyncExternalStore } from 'react';
import { InstallerCoordinator } from '../core/installer';
import { createBrowserPorts } from '../platform/browser-ports';
import type { Snapshot } from '../core/types';

const coordinator = new InstallerCoordinator(createBrowserPorts());

/** 单例协调器：整个应用共享同一份安装状态；挂载时执行一次启动恢复。 */
export function useInstaller(): { snapshot: Snapshot; ready: boolean } {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    coordinator
      .init()
      .catch(() => undefined)
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const snapshot = useSyncExternalStore(
    (onChange) => coordinator.subscribe(() => onChange()),
    () => coordinator.getSnapshot(),
    () => coordinator.getSnapshot(),
  );

  return { snapshot, ready };
}

export { coordinator };
