import { expect, test, type Route } from '@playwright/test';
import { startStudio, type StudioFixture } from './fixture.js';

let studio: StudioFixture;
test.beforeAll(async () => { studio = await startStudio(); });
test.afterAll(async () => { await studio?.close(); });
test.beforeEach(async ({ context }) => {
  // No external service participates; localhost still exercises the real image server.
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    return origin === studio.base || origin === studio.imageBase ? route.continue() : route.abort();
  });
});

test('sign in, save/reload, recover an expired session, and publish through a keyboard-safe dialog', async ({ page, context }, info) => {
  const editor = `/admin/editor.html?tk=${studio.tk}`;
  await page.goto(studio.base + '/login?next=' + encodeURIComponent(editor));
  await page.getByLabel('Username', { exact: true }).fill(studio.username);
  await page.getByLabel('Password', { exact: true }).fill(studio.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(studio.base + editor);
  const title = page.locator('#deTitle');
  await expect(title).toHaveValue('Browser fixture');
  await title.fill('Browser saved story');
  await page.locator('#saveDraft').click();
  await expect.poll(async () => (await studio.pool.query("SELECT title FROM posts WHERE translation_key=$1 AND locale='de'", [studio.tk])).rows[0]?.title).toBe('Browser saved story');
  await page.reload();
  await expect(title).toHaveValue('Browser saved story');

  await title.fill('Recovered unsaved story');
  // Expire the real session at the save boundary, not before Playwright can
  // click: background read refreshes can otherwise redirect ahead of the action.
  const savePath = studio.base + `/posts/${studio.tk}`;
  const expireOnSave = async (route: Route) => {
    if (route.request().method() === 'PUT') {
      await studio.pool.query('DELETE FROM sessions');
    }
    await route.continue();
  };
  await page.route(savePath, expireOnSave);
  const loginReady = page.waitForResponse(response => response.url() === studio.base + '/auth/status');
  await page.locator('#saveDraft').click();
  expect((await loginReady).status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.unroute(savePath, expireOnSave);
  await page.getByLabel('Username', { exact: true }).fill(studio.username);
  await page.getByLabel('Password', { exact: true }).fill(studio.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(studio.base + editor);
  const restore = page.getByRole('dialog');
  await expect(restore).toBeVisible();
  await expect(restore).toHaveAccessibleName(/\S/);
  await restore.getByRole('button', { name: /restore/i }).click();
  await expect(title).toHaveValue('Recovered unsaved story');
  expect((await studio.pool.query("SELECT title FROM posts WHERE translation_key=$1 AND locale='de'", [studio.tk])).rows[0]?.title).toBe('Browser saved story');
  await page.locator('#saveDraft').click();
  await expect.poll(async () => (await studio.pool.query("SELECT title FROM posts WHERE translation_key=$1 AND locale='de'", [studio.tk])).rows[0]?.title).toBe('Recovered unsaved story');

  await page.locator('#publishBtn').click();
  const dialog = page.locator('#publishDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/\S/);
  await expect(page.locator('#publishDialogConfirm')).toBeFocused();
  // Native modal inertness must prevent even programmatic background focus.
  await page.locator('#saveDraft').evaluate(button => button.focus());
  await expect(page.locator('#publishDialogConfirm')).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    // Chromium can visit its browser chrome between tab cycles (activeElement
    // becomes body), but never an interactive control behind the modal.
    expect(await dialog.evaluate(node => node.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#publishBtn')).toBeFocused();
  await page.locator('#publishBtn').press('Enter');
  const published = page.waitForResponse(response => response.url().endsWith(`/posts/${studio.tk}/publish`) && response.request().method() === 'POST', { timeout: 120_000 });
  await page.locator('#publishDialogConfirm').click();
  expect((await published).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
  const publicPage = await context.newPage();
  await publicPage.goto(studio.base + '/browser-story/');
  await expect(publicPage.getByRole('heading', { level: 1 })).toHaveText('Recovered unsaved story');
  await expect(publicPage.locator('main')).toContainText('Original story body.');
  await publicPage.screenshot({ path: info.outputPath('published-story.png'), fullPage: true });
});

test('rendered admin fields have nonempty accessible names after initialization', async ({ page }) => {
  await page.goto(studio.base + '/login');
  await page.getByLabel('Username', { exact: true }).fill(studio.username);
  await page.getByLabel('Password', { exact: true }).fill(studio.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/admin\//);
  for (const name of ['editor', 'about', 'settings', 'posts', 'media', 'users', 'import', 'index']) {
    await page.goto(studio.base + `/admin/${name}.html` + (name === 'editor' ? `?tk=${studio.tk}` : ''));
    await expect(page.locator('.cms-user-name')).toHaveText(studio.username);
    const fields = page.locator('input:not([type="hidden"]):visible, textarea:visible, select:visible');
    for (const field of await fields.all()) await expect(field, `${name}: ${await field.getAttribute('id')}`).toHaveAccessibleName(/\S/);
  }
});
