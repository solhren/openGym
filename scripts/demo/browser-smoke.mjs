// Optional real-browser acceptance. Supply an existing Playwright installation; no backend,
// real account, persistent browser profile, or additional dependency is required by the app.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(path.isAbsolute(process.env.PLAYWRIGHT_MODULE || ''), 'Set PLAYWRIGHT_MODULE to a trusted installed module')
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE))
const dist = fileURLToPath(new URL('../../frontend/dist-demo/', import.meta.url))
await fs.access(path.join(dist, 'index.html'))
const disk = await fs.statfs(dist)
assert.ok(disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'Disk reserve below 20 GiB')
const memory = await fs.readFile('/proc/meminfo', 'utf8')
assert.ok(Number(memory.match(/MemAvailable:\s+(\d+)/)[1]) * 1024 >= 2 * 1024 ** 3, 'Memory reserve below 2 GiB')
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }
const mount = '/openGym/' // GitHub Pages project-site path, not only localhost root.
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    assert.ok(pathname.startsWith(mount))
    const file = path.resolve(dist, pathname.slice(mount.length) || '.')
    assert.ok(file === path.resolve(dist) || file.startsWith(path.resolve(dist) + path.sep))
    const actual = (await fs.stat(file)).isDirectory() ? path.join(file, 'index.html') : file
    res.setHeader('Content-Type', types[path.extname(actual)] || 'application/octet-stream')
    res.end(await fs.readFile(actual))
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const evidence = { checks: [], forbiddenRequests: [], pageErrors: [] }
let browser, page
try {
  browser = await chromium.launch({ headless: true })
  evidence.browser = browser.version()
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || /(?:^|\/)api\//.test(url.pathname)) {
      evidence.forbiddenRequests.push(url.origin + url.pathname)
      return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => evidence.pageErrors.push(error.message))
  await page.goto(origin + mount + '#/home')
  await page.getByRole('button', { name: 'Nutrition', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Oats · Demo', exact: true }).waitFor()
  assert.equal(await page.locator('.nutrition-list > li').count(), 2)
  evidence.checks.push('Real App guest boot → Nutrition, two atomic seeded entries')
  await page.getByRole('button', { name: 'Add food', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: /Open Food Facts|Food catalogue/ }).count(), 0)
  await page.getByLabel('Search foods and recipes', { exact: true }).fill('milk')
  await page.locator('.nutrition-result').filter({ hasText: 'Milk · Demo' }).click()
  assert.equal(await page.getByRole('combobox', { name: /^Unit/ }).inputValue(), 'ml')
  await page.getByLabel('Quantity', { exact: true }).fill('200')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
  assert.equal(await page.locator('.nutrition-list > li').count(), 3)
  evidence.checks.push('Search → 200 ml → real durable add; no remote catalogue controls')
  await page.reload()
  await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
  assert.equal(await page.locator('.nutrition-list > li').count(), 3)
  await page.getByRole('button', { name: 'Edit Oats · Demo', exact: true }).click()
  await page.getByLabel('Quantity', { exact: true }).fill('80')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Oats · Demo', exact: true }).waitFor()
  assert.ok((await page.locator('.nutrition-list').innerText()).includes('80 g'))
  evidence.checks.push('Edit quantity persists after a real IndexedDB close/reopen')
  await page.getByRole('button', { name: 'Delete Oats · Demo', exact: true }).click()
  assert.equal(await page.locator(':focus').innerText(), 'Cancel')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Oats · Demo', exact: true }).waitFor({ state: 'hidden' })
  await page.reload()
  await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
  assert.equal(await page.locator('.nutrition-list > li').count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Edit Oats · Demo', exact: true }).count(), 0)
  evidence.checks.push('Confirmed deletion survives reload without resurrecting seeded entries')
  await page.getByRole('button', { name: 'Personal foods', exact: true }).click()
  await page.getByRole('button', { name: 'Create food', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('My browser food')
  await page.getByLabel('Calories', { exact: true }).fill('123')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'My browser food', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'My browser food', exact: true }).waitFor()
  evidence.checks.push('Create personal food and retain it after reloading')
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow at ${width}`)
  }
  evidence.checks.push('No horizontal overflow: 360, 390, 768, 1440 px')
  await page.getByRole('button', { name: 'Journal', exact: true }).click()
  await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
  const output = fileURLToPath(new URL('../nutrition-local-catalog/runtime/browser-demo/', import.meta.url))
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  const run = await fs.mkdtemp(path.join(output, 'run-'))
  for (const [name, width, scheme] of [['phone', 390, 'light'], ['desktop', 1440, 'dark']]) {
    await page.setViewportSize({ width, height: 900 })
    // This is this test's disposable guest profile; exercise the real boot/theme path.
    await page.evaluate(theme => {
      const state = JSON.parse(localStorage.getItem('gym_state_v1'))
      localStorage.setItem('gym_state_v1', JSON.stringify({ ...state, theme }))
    }, scheme)
    await page.reload()
    await page.getByRole('button', { name: 'Add food', exact: true }).waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), scheme)
    await page.screenshot({ path: path.join(run, `${name}.png`), fullPage: true })
  }
  evidence.screenshots = run

  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.forbiddenRequests, [])
  evidence.checks.push('Zero API/external requests and zero unhandled page errors throughout')
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ...evidence, page: await page?.locator('body').innerText().catch(() => '') }, null, 2))
  throw error
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
