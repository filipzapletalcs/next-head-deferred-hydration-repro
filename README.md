# App Router hydration restarts in a loop while a client chunk is still loading

Minimal reproduction for a Next.js App Router issue: if the root starts
hydrating before the client chunk of a component on the page has loaded,
React re-renders and commits the root in a tight loop until the chunk arrives,
instead of waiting for it.

The loop is a React bug ([react/react#37682](https://github.com/react/react/issues/37682),
fix in review in [react/react#37689](https://github.com/react/react/pull/37689)),
but the App Router triggers it on every cold page load. `Head` (app-router.tsx) and
`InnerLayoutRouter` (layout-router.tsx) call `useDeferredValue(value, initialValue)`.
When there is no prefetched value, `initialValue` is the same object as `value`.
That is always the case during hydration. React still schedules a deferred render
for each of these calls. When the hydration render suspends, that deferred render
commits an empty tree, which clears the suspended lane, so hydration restarts at
once and schedules another deferred render.

## The app

- `app/page.jsx` renders `<Heavy />`, a client component (`app/heavy.jsx`). Its
  chunk is made large (~400 KB of generated strings, see
  `scripts/generate-payload.mjs`), so on a throttled connection it arrives after
  the framework chunks. Hydration reaches the page segment while the segment's
  RSC chunk is still `blocked` on that client reference, so it suspends outside
  any Suspense boundary.
- `app/render-counter.jsx` in the root layout counts its own renders. It renders
  once per hydration attempt.
- `/other` and `/slow` (with `loading.jsx` and a slow `generateMetadata`) are only
  used by `scripts/check-navigation.mjs`, which checks that a fix keeps titles and
  loading states correct during client-side navigation.

## Steps

```sh
npm install
npx playwright install chromium
npm run build
npm start                      # http://localhost:3460

# in a second terminal
# slow 4G (Lighthouse values) + 4x CPU throttling, 3 cold loads
npm run measure -- --cpu 4 --network slow4g --runs 3
# deterministic variant: no throttling, hold only the chunk of <Heavy /> for 1.5 s
npm run measure -- --cpu 1 --network none --hold-ms 1500 --runs 3
```

`scripts/measure.mjs` does not patch React. Before the page loads it installs a
minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__`; production `react-dom` calls
`onCommitFiberRoot` on every commit. The script reports:

- `commits`: all commits until 3 s after hydration finished.
- `commitsWhileDehydrated`: commits while `root.current.memoizedState.isDehydrated`
  is still `true`, i.e. commits that hydrated nothing. `empty` counts the ones
  that committed an empty tree (`root.current.child === null`).
- `rootLayoutClientRenders`: renders of the client component in the root layout.
- `hydratedAt`: time of the first commit after which the root is hydrated.
- `script` / `task`: CDP `Performance.getMetrics` `ScriptDuration` /
  `TaskDuration` for the whole load, in ms of throttled main-thread time.

## Current vs. expected behavior

Expected: the hydration render suspends once on the pending chunk and waits for it
(a ping), as it does when the segment is inside a Suspense boundary. The root should
commit 0 times before it hydrates, and the root layout client component should render
1–2 times.

Actual, `next start`, headless Chromium (Playwright 1.63), medians of 3 cold loads
(range in parentheses):

| next | scenario | commits before the root hydrated (all empty) | root layout client renders | `ScriptDuration` | hydrated at / last JS received |
|---|---|---|---|---|---|
| 16.5.0-canary.2 | chunk held 1.5 s, CPU 1× | **101,119** (100,636–101,332) | 101,120 | 1,218 ms | 1,530 / 1,527 ms |
| 16.5.0-canary.2 | slow 4G + CPU 4× | **577** (442–617) | 578 | 109 ms | 2,191 / 2,178 ms |
| 16.3.8 | chunk held 1.5 s, CPU 1× | **94,770** (94,325–94,791) | 94,771 | 1,217 ms | 1,537 / 1,534 ms |
| 16.3.8 | slow 4G + CPU 4× | **611** (589–674) | 612 | 117 ms | 2,190 / 2,178 ms |

There are no errors, and hydration completes right after the chunk arrives. The loop
only burns main-thread time while the page loads. Here each restart is cheap because
the tree above the suspended segment is tiny. In a real app the cost grows with the
size of the layouts.

With the React counters from `scripts/instrument-react.mjs` (16.3.8, chunk held
1.5 s, one load), each hydration attempt mounts two `useDeferredValue(value,
initialValue)` hooks (`Head` and `InnerLayoutRouter`), spawns a deferred lane, and
suspends. That deferred lane then commits an empty tree. The load had 92,301 renders
from the root in the hydration lane (128) and 92,301 empty commits spread evenly over
the four transition deferred lanes (262144, 524288, 1048576, 2097152). There was 1
hydration commit.

### Why

`Head` (`app-router.tsx`) and `InnerLayoutRouter` (`layout-router.tsx`) call
`useDeferredValue(rsc, prefetchRsc !== null ? prefetchRsc : rsc)`. During hydration
`prefetchRsc` is always `null`, so `initialValue === value`, and React still schedules
a deferred render for it. When the hydration render suspends, that deferred render
commits an empty tree. The commit clears the root's `suspendedLanes`, so hydration
restarts at once and spawns the next deferred render (react/react#37682).

### Either fix removes the loop

Both were applied as patches to the published files in `node_modules`, same
conditions:

| next | scenario | unpatched | Next: no `initialValue` when `prefetchRsc === null` | React: react/react#37689 ported to the vendored `react-dom` |
|---|---|---|---|---|
| 16.5.0-canary.2 | chunk held 1.5 s | 101,119 commits, 1,218 ms script | 0 commits, 8 ms | 0 commits, 9 ms |
| 16.5.0-canary.2 | slow 4G + CPU 4× | 577, 109 ms | 0, 39 ms | 0, 39 ms |
| 16.3.8 | chunk held 1.5 s | 94,770, 1,217 ms | 0, 8 ms | 0, 9 ms |
| 16.3.8 | slow 4G + CPU 4× | 611, 117 ms | 0, 38 ms | 0, 42 ms |

Hydration time doesn't change. `scripts/check-navigation.mjs` passes on every
variant: titles update on client navigation, `/slow` shows its prefetched loading
state and then its content and title, and back navigation restores the title.

Next.js-side change (compiled form, in both `dist/client` and `dist/esm/client`):

```diff
 // app-router.js, Head
-const resolvedPrefetchRsc = prefetchHead !== null ? prefetchHead : head;
+const resolvedPrefetchRsc = prefetchHead !== null ? prefetchHead : undefined;
 // layout-router.js, InnerLayoutRouter
-const resolvedPrefetchRsc = renderTree.data.prefetchRsc !== null ? renderTree.data.prefetchRsc : renderTree.data.rsc;
+const resolvedPrefetchRsc = renderTree.data.prefetchRsc !== null ? renderTree.data.prefetchRsc : undefined;
```

## Optional: React-internal counters

`node scripts/instrument-react.mjs apply && npm run build` adds counters to
`next/dist/compiled/react-dom/cjs/react-dom-client.production.js` (renders started
from the root, commits by lane, deferred lanes spawned). `measure.mjs` prints them
in the `rx` field of the JSON output (`--json results/x.json`).
`node scripts/instrument-react.mjs revert` undoes it.

## Environment

macOS 27 (arm64, 18 cores), Node 22.23.1, Chromium from Playwright 1.63.0.
`next@16.5.0-canary.2` (vendored `react-dom` `19.3.0-canary-278794d7-20261002`) and
`next@16.3.8` (vendored `19.3.0-canary-cbb046ab-20260731`), both with `react@19.3.0`
installed. Production build (`next build`, Turbopack) served with `next start`.
