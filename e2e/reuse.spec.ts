import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

test.describe('按内容摘要复用安装', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
  });

  test('仅清单变化：断网时复用已核验故障资源，只获取变化清单并原子激活', async ({ page, context }) => {
    // v3 故障资源地址不可达；因为摘要与当前 v2 已核验字节一致，安装不应发起该下载。
    // 清单发生变化，仍需从网络获取；随后断网刷新证明新激活版本完整自包含。
    await setFaultRules(page, [{ match: '/manuals/v3/faults.json', behavior: 'abort' }]);
    await page.getByTestId('reuse-install-3.0.0').click();

    await expect(page.getByTestId('installing-banner')).toContainText('按摘要复用安装');
    await expect(page.getByTestId('installing-3.0.0')).toContainText('复用 1');
    await expect(page.getByTestId('installing-3.0.0')).toContainText('下载 1');
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
    await expect(page.getByTestId('activated-banner')).toContainText('3.0.0');
    await expect(page.getByTestId('step-1')).toContainText('已有已核验离线包');
    await expect(page.getByTestId('step-9')).toBeVisible();

    // 新版暂存区自包含 v3 的新地址；激活后旧版缓存已回收，不允许继续引用旧缓存。
    const cacheState = await page.evaluate(async () => {
      const stateReq = indexedDB.open('manual-kiosk-db');
      const state = await new Promise<{ activeVersion: string | null; activeCacheName: string | null }>((resolve, reject) => {
        stateReq.onsuccess = () => {
          const db = stateReq.result;
          const tx = db.transaction('state', 'readonly');
          const req = tx.objectStore('state').get('current');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        };
        stateReq.onerror = () => reject(stateReq.error);
      });
      const names = await caches.keys();
      const manualNames = names.filter((name) => name.startsWith('manual:'));
      const activeCache = state.activeCacheName ? await caches.open(state.activeCacheName) : null;
      const v3Faults = await activeCache?.match('/manuals/v3/faults.json');
      const v2Faults = await activeCache?.match('/manuals/v2/faults.json');
      return {
        activeVersion: state.activeVersion,
        manualNames,
        hasV3Faults: Boolean(v3Faults),
        hasV2FaultsInActive: Boolean(v2Faults),
      };
    });
    expect(cacheState.activeVersion).toBe('3.0.0');
    expect(cacheState.manualNames).toHaveLength(1);
    expect(cacheState.hasV3Faults).toBe(true);
    expect(cacheState.hasV2FaultsInActive).toBe(false);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
    await expect(page.getByTestId('step-1')).toContainText('已有已核验离线包');
    await context.setOffline(false);
    await clearFaultRules(page);
  });

  test('变化资源校验失败：丢弃暂存区，离线仍完整使用旧版；原完整安装入口仍可恢复', async ({ page, context }) => {
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'tamper' }]);
    await page.getByTestId('reuse-install-3.0.0').click();

    await expect(page.getByTestId('failed-banner')).toContainText('校验失败');
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');

    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-1')).toContainText('双总线');
    const manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith('manual:')),
    );
    expect(manualCaches).toHaveLength(1);
    await context.setOffline(false);

    // 保留的完整安装入口可完成同一版本安装。
    await page.getByTestId('install-3.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
  });

  test('复用安装中重载：识别并清理半成品，旧版继续完整离线可用', async ({ page, context }) => {
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'hang' }]);
    await page.getByTestId('reuse-install-3.0.0').click();
    await expect(page.getByTestId('installing-3.0.0')).toContainText('1/2');
    await page.reload();

    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('installing-banner')).toHaveCount(0);
    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toBeVisible();
    const manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith('manual:')),
    );
    expect(manualCaches).toHaveLength(1);
    await context.setOffline(false);
  });
});
