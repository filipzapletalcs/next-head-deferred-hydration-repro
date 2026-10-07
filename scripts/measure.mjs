// Loads a page in Chromium with network/CPU throttling and counts React
// commits during hydration, without patching React: it installs a minimal
// React DevTools global hook, which production react-dom also calls on every
// commit (onCommitFiberRoot).
//
// Usage:
//   node scripts/measure.mjs [--url http://localhost:3460/] [--runs 3]
//     [--cpu 4] [--network slow4g|none] [--hold-ms 0] [--settle-ms 3000]
//     [--channel chrome] [--json results/out.json]
//
// --hold-ms N  holds the response of the client chunk that contains
//              "HEAVY_CLIENT_CHUNK" for N ms (deterministic alternative to
//              network throttling; use it with --network none).
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
    return acc
  }, [])
)
const url = args.url || 'http://localhost:3460/'
const runs = Number(args.runs || 3)
const cpu = Number(args.cpu || 4)
const network = args.network || 'slow4g'
const holdMs = Number(args['hold-ms'] || 0)
const settleMs = Number(args['settle-ms'] || 3000)

// Lighthouse "Slow 4G" (devtools throttling): 150 ms RTT x 3.75, 1.6 Mbps down, 750 Kbps up.
const SLOW_4G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1474.56 * 1024) / 8,
  uploadThroughput: (675 * 1024) / 8,
}

const hookScript = () => {
  const s = (window.__repro = {
    commits: 0,
    commitsWhileDehydrated: 0,
    emptyCommitsWhileDehydrated: 0,
    firstCommitAt: null,
    lastDehydratedCommitAt: null,
    hydratedAt: null,
    longTasks: [],
  })
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1
      this.renderers.set(id, renderer)
      return id
    },
    onCommitFiberRoot(_id, root) {
      const now = performance.now()
      const current = root.current
      s.commits++
      if (s.firstCommitAt === null) s.firstCommitAt = now
      // The root stays dehydrated until the shell has hydrated. A commit while
      // it is still dehydrated did not hydrate anything.
      if (current.memoizedState && current.memoizedState.isDehydrated) {
        s.commitsWhileDehydrated++
        s.lastDehydratedCommitAt = now
        if (current.child === null) s.emptyCommitsWhileDehydrated++
      } else if (s.hydratedAt === null) {
        s.hydratedAt = now
      }
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    setStrictMode() {},
    checkDCE() {},
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.longTasks.push([Math.round(e.startTime), Math.round(e.duration)])
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const browser = await chromium.launch({ headless: true, channel: args.channel })
const results = []
for (let run = 1; run <= runs; run++) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.addInitScript(hookScript)

  let heavyChunk = null
  if (holdMs > 0) {
    await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, async (route) => {
      const response = await route.fetch()
      const body = await response.body()
      if (body.includes('HEAVY_CLIENT_CHUNK')) {
        heavyChunk = route.request().url()
        await new Promise((r) => setTimeout(r, holdMs))
      }
      await route.fulfill({ response, body })
    })
  }

  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  if (network === 'slow4g') {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', SLOW_4G)
  }

  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  await page.waitForFunction(() => window.__repro.hydratedAt !== null, null, { timeout: 120000 })
  await page.waitForTimeout(settleMs)

  const { metrics } = await cdp.send('Performance.getMetrics')
  const metric = (name) => Math.round((metrics.find((m) => m.name === name)?.value || 0) * 1000)
  const data = await page.evaluate(() => {
    const s = window.__repro
    const js = performance
      .getEntriesByType('resource')
      .filter((r) => /\.js(\?|$)/.test(r.name))
      .map((r) => ({ name: r.name.split('/').pop(), end: Math.round(r.responseEnd), size: r.encodedBodySize }))
    return {
      ...s,
      renderCounter: window.__renderCounter || 0,
      heavyText: document.getElementById('heavy')?.textContent || null,
      lastJsResponseEnd: Math.max(...js.map((r) => r.end)),
      largestJs: js.sort((a, b) => b.size - a.size)[0] || null,
      rx: window.__rx || null,
    }
  })
  const longTaskMs = data.longTasks.reduce((sum, [, d]) => sum + d, 0)
  const tbtLike = data.longTasks.reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0)
  const r = {
    run,
    commits: data.commits,
    commitsWhileDehydrated: data.commitsWhileDehydrated,
    emptyCommitsWhileDehydrated: data.emptyCommitsWhileDehydrated,
    rootLayoutClientRenders: data.renderCounter,
    firstCommitAt: Math.round(data.firstCommitAt),
    hydratedAt: Math.round(data.hydratedAt),
    lastJsResponseEnd: data.lastJsResponseEnd,
    scriptDurationMs: metric('ScriptDuration'),
    taskDurationMs: metric('TaskDuration'),
    longTasks: data.longTasks.length,
    longTaskMs,
    tbtLike,
    heavyChunk: heavyChunk && heavyChunk.split('/').pop(),
    largestJs: data.largestJs,
    errors,
    rx: data.rx,
  }
  results.push(r)
  console.log(
    `run ${run}: commits=${r.commits} (while dehydrated=${r.commitsWhileDehydrated}, empty=${r.emptyCommitsWhileDehydrated})` +
      ` rootLayoutClientRenders=${r.rootLayoutClientRenders} hydratedAt=${r.hydratedAt}ms lastJs=${r.lastJsResponseEnd}ms` +
      ` script=${r.scriptDurationMs}ms task=${r.taskDurationMs}ms longTasks=${r.longTasks} tbtLike=${r.tbtLike}ms errors=${errors.length}`
  )
  await context.close()
}
await browser.close()

const keys = ['commits', 'commitsWhileDehydrated', 'emptyCommitsWhileDehydrated', 'rootLayoutClientRenders', 'hydratedAt', 'lastJsResponseEnd', 'scriptDurationMs', 'taskDurationMs', 'tbtLike']
const summary = Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k]))]))
console.log(`median of ${runs} (cpu ${cpu}x, network ${network}, hold ${holdMs} ms):`, JSON.stringify(summary))
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true })
  writeFileSync(args.json, JSON.stringify({ url, cpu, network, holdMs, settleMs, summary, results }, null, 2))
}
