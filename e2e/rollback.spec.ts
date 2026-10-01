import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

const readPersistedState = async (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const dbReq = indexedDB.open('manual-kiosk-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbReq.onsuccess = () => resolve(dbReq.result);
      dbReq.onerror = () => reject(dbReq.error);
    });
    const tx = db.transaction('state', 'readonly');
    const req = tx.objectStore('state').get('current');
    const state = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return state as {
      activeVersion: string | null;
      previousVersion: string | null;
      activeCacheName: string | null;
      previousCacheName: string | null;
    };
  });

test.describe('断网退回上一版', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('install-1.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
  });

  test('复核上一版后一次切换，断网刷新、步骤页和 SW 均指向 v1，并保留两代缓存', async ({ page, context }) => {
    await expect(page.getByTestId('rollback-previous-version')).toHaveText('上一版：1.0.0');
    await page.getByTestId('rollback-review').click();
    await expect(page.getByTestId('rollback-confirmation')).toBeVisible();
    await expect(page.getByTestId('rollback-digest')).toContainText('整单摘要：');
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');

    await page.getByTestId('rollback-confirm').click();
    await expect(page.getByTestId('rolled-back-banner')).toContainText('1.0.0');
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-1')).not.toContainText('双总线');
    await expect(page.getByTestId('rollback-previous-version')).toHaveText('上一版：2.0.0');

    const state = await readPersistedState(page);
    expect(state).toMatchObject({
      activeVersion: '1.0.0',
      previousVersion: '2.0.0',
    });
    const cacheNames = await page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith('manual:')),
    );
    expect(cacheNames).toHaveLength(2);
    expect(cacheNames).toContain(state.activeCacheName!);
    expect(cacheNames).toContain(state.previousCacheName!);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-8')).toBeVisible();
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('fault-search').fill('UPS');
    await expect(page.getByTestId('fault-v1-ups-overload')).toBeVisible();
    await expect(page.getByTestId('fault-v2-sts-failover')).toHaveCount(0);
    await context.setOffline(false);
  });

  test('跨标签交错：另一标签页已完成退回时，迟到确认不会覆盖新代际', async ({ page, context }) => {
    const tabA = page;
    await tabA.getByTestId('rollback-review').click();
    await expect(tabA.getByTestId('rollback-confirmation')).toBeVisible();

    const tabB = await context.newPage();
    await tabB.goto('/');
    await expect(tabB.getByTestId('current-version')).toContainText('2.0.0');
    await tabB.getByTestId('rollback-review').click();
    await tabB.getByTestId('rollback-confirm').click();
    await expect(tabB.getByTestId('current-version')).toContainText('1.0.0');

    await tabA.getByTestId('rollback-confirm').click();
    await expect(tabA.getByTestId('failed-banner')).toContainText('另一标签页已完成切换');
    const state = await readPersistedState(tabA);
    expect(state.activeVersion).toBe('1.0.0');
    expect(state.previousVersion).toBe('2.0.0');
  });

  test('安装进行中不能退回', async ({ page }) => {
    // 已升级到 v2 后，启动 v3 安装；安装期间退回按钮禁用。
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'hang' }]);
    await page.getByTestId('install-3.0.0').click();
    await expect(page.getByTestId('installing-banner')).toContainText('3.0.0');
    await expect(page.getByTestId('rollback-review')).toBeDisabled();
    await page.getByTestId('cancel-3.0.0').click();
    await clearFaultRules(page);
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
  });

  test('只有当前版的存量记录可正常启动，但显示暂不能退回', async ({ browser }) => {
    const cleanContext = await browser.newContext();
    const cleanPage = await cleanContext.newPage();
    await cleanPage.goto('/');
    await cleanPage.getByTestId('install-1.0.0').click();
    await expect(cleanPage.getByTestId('current-version')).toContainText('1.0.0');
    await expect(cleanPage.getByTestId('rollback-unavailable')).toContainText('暂不能退回');
    await cleanContext.close();
  });
});
