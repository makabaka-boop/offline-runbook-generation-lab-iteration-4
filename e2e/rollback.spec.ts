import { expect, test, type Page } from '@playwright/test';

/** 完整安装 v1 再安装 v2，使 v1 成为可退回的上一版。 */
const installV1ThenV2 = async (page: Page) => {
  await page.goto('/');
  await page.getByTestId('install-1.0.0').click();
  await expect(page.getByTestId('current-version')).toContainText('1.0.0');
  await page.getByTestId('install-2.0.0').click();
  await expect(page.getByTestId('current-version')).toContainText('2.0.0');
  await expect(page.getByTestId('rollback')).toContainText('1.0.0');
};

const readPersistedState = (page: Page) =>
  page.evaluate(async () => {
    const req = indexedDB.open('manual-kiosk-db');
    return await new Promise<{
      activeVersion: string | null;
      activeGeneration: string | null;
      previous: { version: string; generation: string } | null;
    }>((resolve, reject) => {
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('state', 'readonly');
        const get = tx.objectStore('state').get('current');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

test.describe('退回上一版', () => {
  test('退回后断网刷新仍是上一版：步骤与演练条目都来自同一版本', async ({ page, context }) => {
    await installV1ThenV2(page);
    await expect(page.getByTestId('step-1')).toContainText('双总线');

    await page.getByTestId('rollback').click();
    await expect(page.getByTestId('rolled-back-banner')).toContainText('已退回版本 1.0.0');
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    // 步骤页指向上一版：v1 共 8 步，无 v2 的第 9 步
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-8')).toBeVisible();
    await expect(page.getByTestId('step-9')).toHaveCount(0);

    // 保留当前版与上一版两份缓存，SW 与页面读同一份 IDB 指针
    const manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith('manual:')),
    );
    expect(manualCaches).toHaveLength(2);
    const state = await readPersistedState(page);
    expect(state.activeVersion).toBe('1.0.0');
    expect(state.previous?.version).toBe('2.0.0');

    // 断网刷新：上一版完整可读，演练条目也是上一版
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-8')).toBeVisible();
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('fault-search').fill('跳闸');
    await expect(page.getByTestId('fault-v1-pdu-trip')).toBeVisible();
    await expect(page.getByTestId('fault-v2-sts-failover')).toHaveCount(0);
    await context.setOffline(false);
  });

  test('另一标签页已完成切换：迟到的退回不得覆盖新代际', async ({ page, context }) => {
    await installV1ThenV2(page);

    // 让本页退回在“复核通过、提交代际前”暂停，构造确定的跨标签交错
    await page.evaluate(() => {
      const w = window as unknown as {
        __rollbackGateEntered: boolean;
        __rollbackGateRelease: (() => void) | null;
        __MANUAL_ROLLBACK_GATE__: () => Promise<void>;
      };
      w.__rollbackGateEntered = false;
      w.__rollbackGateRelease = null;
      w.__MANUAL_ROLLBACK_GATE__ = () =>
        new Promise<void>((resolve) => {
          w.__rollbackGateEntered = true;
          w.__rollbackGateRelease = resolve;
        });
    });
    await page.getByTestId('rollback').click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __rollbackGateEntered: boolean }).__rollbackGateEntered),
      )
      .toBe(true);

    // 另一标签页抢先完成退回：v2 → v1
    const page2 = await context.newPage();
    await page2.goto('/');
    await expect(page2.getByTestId('current-version')).toContainText('2.0.0');
    await page2.getByTestId('rollback').click();
    await expect(page2.getByTestId('rolled-back-banner')).toContainText('已退回版本 1.0.0');
    await expect(page2.getByTestId('current-version')).toContainText('1.0.0');

    // 放开本页迟到的退回：CAS 发现代际已变，拒绝且不得覆盖新代际
    await page.evaluate(() =>
      (window as unknown as { __rollbackGateRelease: () => void }).__rollbackGateRelease(),
    );
    await expect(page.getByTestId('rollback-refused-banner')).toContainText(
      '另一页面已完成版本切换',
    );

    // IndexedDB 保持另一标签页提交的新代际（active=1.0.0，previous=2.0.0）
    const state = await readPersistedState(page);
    expect(state.activeVersion).toBe('1.0.0');
    expect(state.previous?.version).toBe('2.0.0');
    const state2 = await readPersistedState(page2);
    expect(state2.activeGeneration).toBe(state.activeGeneration);

    // 本页刷新后与另一标签页一致：同一版本、同一代际
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await page2.close();
  });

  test('演练结论随版本失效：退回后上一版重新开始，结论仍按版本绑定归档', async ({ page }) => {
    await installV1ThenV2(page);

    // 在 v2 完成一次演练，得到绑定 2.0.0 的结论
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('fault-search').fill('STS');
    await page.getByTestId('fault-v2-sts-failover').click();
    for (let i = 0; i < 4; i++) {
      await page.getByTestId(`action-v2-sts-failover-${i}`).click();
    }
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 2.0.0');
    await expect(page.getByTestId('pass-code')).toContainText('PASS-2.0.0-');

    // 退回 v1：演练会话随版本切换终止，当前结论失效
    await page.getByTestId('tab-steps').click();
    await page.getByTestId('rollback').click();
    await expect(page.getByTestId('rolled-back-banner')).toContainText('已退回版本 1.0.0');

    await page.getByTestId('tab-drill').click();
    await expect(page.getByTestId('pass-box')).toHaveCount(0);
    // 只能搜索当前版（v1）条目：v2 条目不再出现
    await page.getByTestId('fault-search').fill('STS');
    await expect(page.getByTestId('fault-v2-sts-failover')).toHaveCount(0);
    await expect(page.getByTestId('fault-empty')).toBeVisible();
    await page.getByTestId('fault-search').fill('跳闸');
    await expect(page.getByTestId('fault-v1-pdu-trip')).toBeVisible();
    // 已归档的 v2 结论仍按版本绑定展示，不被当作当前版结论
    await expect(page.getByTestId('pass-history')).toContainText('版本 2.0.0');

    // 在上一版重新演练，结论绑定 v1
    await page.getByTestId('fault-v1-pdu-trip').click();
    for (let i = 0; i < 4; i++) {
      await page.getByTestId(`action-v1-pdu-trip-${i}`).click();
    }
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
    await expect(page.getByTestId('pass-code')).toContainText('PASS-1.0.0-');
  });

  test('只安装过一个版本时没有上一版，不显示退回入口', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('install-1.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('rollback')).toHaveCount(0);

    // 升级后出现退回入口
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('rollback')).toBeVisible();
  });
});
