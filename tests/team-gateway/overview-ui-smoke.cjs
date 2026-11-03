// Read-only local UI acceptance. Credentials remain in memory and are never logged.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'deploy/team-gateway/.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));
const base = `http://localhost:${env.GATEWAY_PORT}`;
const output = path.join(root, '.artifacts/ui-team-overview');
fs.mkdirSync(output, { recursive: true });
const checks = [];
let browser;
(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1700 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.name));
  await page.goto(base + '/sign-in?redirect=%2Fteams');
  await page.locator('input[name="username"]').fill(env.ADMIN_USERNAME);
  await page.locator('input[name="password"]').fill(env.ADMIN_PASSWORD);
  const loginResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/user/login');
  await page.locator('button[type="submit"]').click();
  const login = await (await loginResponse).json();
  assert(login.success, 'Native sign-in failed');
  await page.waitForURL(url => url.pathname === '/teams');
  const toastClose = page.locator('[data-sonner-toast] [data-close-button]');
  if (await toastClose.count()) await toastClose.first().click();
  const get = async route => {
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer ' + login.data.access_token } });
    const result = await response.json();
    assert(response.ok && result.success, 'Read-only team query rejected');
    return result.data;
  };
  const teams = await get('/api/teams');
  let fixture;
  let overview;
  for (const team of teams.filter(t => t.name.startsWith('本地验收团队 ')).reverse()) {
    const data = await get(`/api/teams/${team.id}/overview`);
    if (data.summary.requests > 0 && data.summary.actual > 0) {
      fixture = team;
      overview = data;
      break;
    }
  }
  assert(fixture, 'A previously populated local team fixture is required');
  const waitOverview = days => page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/teams/${fixture.id}/overview` && new URL(r.url()).searchParams.get('days') === String(days));
  const loaded = waitOverview(7);
  await page.getByRole('button', { name: fixture.name, exact: true }).click();
  assert((await (await loaded).json()).success, 'Overview query failed');
  await page.getByRole('region', { name: '概览', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 0);
  await page.getByRole('region', { name: '团队消费上限' }).waitFor();
  await page.getByRole('region', { name: '每日用量趋势' }).waitFor();
  const models = page.getByRole('table', { name: '按模型统计用量' });
  await models.waitFor();
  assert((await models.innerText()).includes(overview.models[0].model_name));
  checks.push('single-page team detail opens with Overview, shared quota, populated summary, trend and model table without tabs');
  const rangeLoaded = waitOverview(30);
  await page.getByRole('button', { name: '最近 30 天', exact: true }).click();
  const thirty = (await (await rangeLoaded).json()).data;
  assert.equal(thirty.trend.length, 30);
  assert.equal(await page.getByRole('button', { name: '最近 30 天', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('thirty-day control loads thirty calendar buckets and exposes selected state');
  const metricButtons = page.getByRole('group', { name: '趋势指标' });
  await metricButtons.getByRole('button', { name: '实际费用', exact: true }).click();
  assert.equal(await metricButtons.getByRole('button', { name: '实际费用', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('trend switches to exact-cost metric');
  for (const label of ['刷新用量', '刷新余额']) {
    const refreshed = waitOverview(30);
    const detail = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/teams/${fixture.id}`);
    await page.getByRole('button', { name: label, exact: true }).click();
    assert((await (await refreshed).json()).success && (await (await detail).json()).success, 'Refresh failed');
  }
  checks.push('both refresh actions refresh overview and shared budget');
  await page.getByRole('button', { name: '刷新用量', exact: true }).waitFor({ state: 'visible' });
  await page.evaluate(async () => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  await page.screenshot({ path: path.join(output, 'team-overview-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '刷新用量', exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(async () => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overview overflows viewport');
  // The app uses an internal scroll surface; a taller capture includes its full
  // content after checking the normal 390 x 844 phone viewport above.
  await page.setViewportSize({ width: 390, height: 2200 });
  await page.screenshot({ path: path.join(output, 'team-overview-mobile.png'), fullPage: true });
  checks.push('390px mobile layout has no page-level horizontal overflow');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, checks, fixture_team_id: fixture.id, summary: overview.summary }, null, 2));
  console.log(JSON.stringify({ success: true, checks }, null, 2));
})().catch(e => {
  // Never print request/response objects, credentials, session tokens or URLs.
  console.error(e.name + ': ' + e.message.replaceAll(env.ADMIN_PASSWORD, '[redacted]'));
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
