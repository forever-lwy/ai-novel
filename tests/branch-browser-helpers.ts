import { expect, type Page } from '@playwright/test';

export async function currentBranchId(page: Page) {
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', /.+/);
  return (await page.locator('.workspace').getAttribute('data-branch-id'))!;
}

export async function chooseBranch(page: Page, target: string | { label: string }) {
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  await expect(dialog.getByRole('navigation', { name: '故事线分支树', exact: true })).toBeVisible();
  await (typeof target === 'string' ? dialog.locator(`button[data-branch-id="${target}"]`) : dialog.getByRole('button', { name: `切换到故事线 ${target.label}`, exact: true })).click();
  await expect(dialog).toHaveCount(0);
}
