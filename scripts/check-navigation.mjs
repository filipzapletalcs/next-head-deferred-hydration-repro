// Functional check used when trying a fix: client-side navigations still
// update <title>, the prefetched loading state of /slow is still shown, and
// back navigation restores the previous head. Records every <title> change.
//
// Usage: node scripts/check-navigation.mjs [--url http://localhost:3460]
import { chromium } from 'playwright'

const i = process.argv.indexOf('--url')
const base = (i > 0 ? process.argv[i + 1] : 'http://localhost:3460').replace(/\/$/, '')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.addInitScript(() => {
  window.__titles = []
  window.__hydrated = false
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_id, root) {
      if (!root.current.memoizedState?.isDehydrated) window.__hydrated = true
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    setStrictMode() {},
    checkDCE() {},
  }
  const record = () => {
    const titles = [...document.querySelectorAll('title')].map((t) => t.textContent)
    const last = window.__titles[window.__titles.length - 1]
    const entry = titles.join(' | ')
    if (entry !== last) window.__titles.push(entry)
  }
  new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true })
})

const steps = []
const check = async (name, fn) => {
  try {
    await fn()
    steps.push([name, 'ok'])
  } catch (e) {
    steps.push([name, 'FAIL ' + String(e).split('\n')[0]])
  }
}
const titleIs = (t) => page.waitForFunction((t) => document.title === t, t, { timeout: 10000 })
const singleTitle = async () => {
  const n = await page.evaluate(() => document.querySelectorAll('title').length)
  if (n !== 1) throw new Error(`${n} <title> elements`)
}

await page.goto(base + '/', { waitUntil: 'load' })
await check('hydrates', () => page.waitForFunction(() => window.__hydrated, null, { timeout: 30000 }))
await check('initial title', async () => (await titleIs('Home'), await singleTitle()))
await page.waitForTimeout(1500) // let viewport prefetches finish

await check('navigate to /other updates title', async () => {
  await page.click('a[href="/other"]')
  await page.waitForSelector('h1:text("Other")')
  await titleIs('Other')
  await singleTitle()
})
await check('navigate back to / via link', async () => {
  await page.click('a[href="/"]')
  await page.waitForSelector('h1:text("Home")')
  await titleIs('Home')
  await singleTitle()
})
await page.waitForTimeout(1500)
let sawLoading = false
await check('navigate to /slow shows prefetched loading state, then content and title', async () => {
  await page.evaluate(() => (window.__titles = [document.title]))
  await page.click('a[href="/slow"]')
  sawLoading = await page
    .waitForSelector('#loading', { timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  await page.waitForSelector('#slow', { timeout: 15000 })
  await titleIs('Slow')
  await singleTitle()
  if (!sawLoading) throw new Error('loading state not shown')
})
const slowTitles = await page.evaluate(() => window.__titles)
await check('history back restores title', async () => {
  await page.goBack()
  await page.waitForSelector('h1:text("Home")')
  await titleIs('Home')
  await singleTitle()
})

for (const [name, result] of steps) console.log(`${result === 'ok' ? 'ok  ' : 'FAIL'} ${name}${result === 'ok' ? '' : ': ' + result}`)
console.log('title changes during /slow navigation:', JSON.stringify(slowTitles))
console.log('errors:', errors.length ? errors : 0)
await browser.close()
process.exit(steps.every(([, r]) => r === 'ok') && errors.length === 0 ? 0 : 1)
