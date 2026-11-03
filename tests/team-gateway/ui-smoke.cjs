// Run with Playwright available through NODE_PATH or a local installation.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'deploy/team-gateway/.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const p = line.indexOf('='); return [line.slice(0, p), line.slice(p + 1)]; }));
const base = `http://localhost:${env.GATEWAY_PORT}`;
const output = path.join(root, '.artifacts/ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors = [];
  let accessToken;
  let fixtureKeyId;
  async function api(method, route, body) {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    assert(response.ok && result.success, `${method} ${route} failed`);
    return result.data;
  }
  page.on('pageerror', error => errors.push(error.name));
  try {
    await page.goto(base + '/sign-in');
    await page.locator('input[name="username"]').fill(env.ADMIN_USERNAME);
    await page.locator('input[name="password"]').fill(env.ADMIN_PASSWORD);
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/login');
    await page.locator('button[type="submit"]').click();
    const signedIn = await loginResponse;
    assert(signedIn.ok(), `Native login returned HTTP ${signedIn.status()}; keep rate limiting enabled and rerun after its window.`);
    accessToken = (await signedIn.json()).data.access_token;
    await page.waitForURL(url => !url.pathname.startsWith('/sign-in'));
    for (const route of ['/dashboard', '/users', '/keys', '/channels', '/usage-logs', '/wallet']) {
      // Use the real SPA navigation; repeated reloads consume auth refresh limits.
      await page.locator(`a[href^="${route}"]`).first().click();
      await page.waitForURL(url => url.pathname.startsWith(route));
      await page.waitForLoadState('networkidle');
      const text = await page.locator('body').innerText();
      assert(!/404|Something went wrong|Application error/.test(text), `${route} failed`);
      assert(!page.url().includes('/sign-in'), `${route} redirected to login`);
      console.log(JSON.stringify({ route, url: new URL(page.url()).pathname, rendered: true }));
      await page.screenshot({ path: path.join(output, route.slice(1) + '.png'), fullPage: true });
    }
    const fixtureName = `ui-local-${Date.now()}`;
    await api('POST', '/api/token/', { name: fixtureName, expired_time: Math.floor(Date.now() / 1000) + 600, remain_quota: 1000, unlimited_quota: false, model_limits_enabled: true, model_limits: 'team-local-mock', group: 'default' });
    fixtureKeyId = (await api('GET', '/api/token/?p=1&page_size=100')).items.find(item => item.name === fixtureName).id;
    await page.locator('a[href="/keys"]').first().click();
    // The fixture was inserted outside React Query, so refresh its cached list once.
    await page.reload();
    const row = page.getByRole('row').filter({ hasText: fixtureName });
    await row.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('menuitem', { name: 'CC Switch' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Codex' }).click();
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'team-local-mock', exact: true }).click();
    // Capture the native URI in memory; never launch an external app or log the key.
    await page.evaluate(() => { window.open = url => { window.__ccsTestURL = url; return null; }; });
    await dialog.getByRole('button', { name: /打开 CC Switch/ }).click();
    const imported = new URL(await page.evaluate(() => window.__ccsTestURL));
    assert.equal(imported.protocol, 'ccswitch:');
    assert.equal(imported.searchParams.get('app'), 'codex');
    assert.equal(imported.searchParams.get('endpoint'), base + '/v1');
    assert.equal(imported.searchParams.get('model'), 'team-local-mock');
    assert(imported.searchParams.get('apiKey').startsWith('sk-'));
    await page.locator('a[href^="/usage-logs"]').first().click();
    await page.waitForURL(url => url.pathname.startsWith('/usage-logs/'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, null, { timeout: 5000 }).catch(() => {});
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    await page.screenshot({ path: path.join(output, 'usage-mobile.png'), fullPage: true });
    assert(dimensions.document <= dimensions.viewport, 'Mobile page overflows viewport: ' + JSON.stringify(dimensions));
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    console.log(JSON.stringify({ passed: 9, checks: ['native form login', 'dashboard', 'personal administration', 'API keys', 'upstream channels', 'usage records', 'wallet', 'CC Switch native Codex URI', 'mobile usage viewport'], errors }));
  } finally {
    try { if (fixtureKeyId) await api('DELETE', '/api/token/' + fixtureKeyId); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
