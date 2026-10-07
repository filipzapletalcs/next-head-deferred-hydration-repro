// Optional: adds counters to the react-dom build that Next.js bundles into the
// client (next/dist/compiled/react-dom/cjs/react-dom-client.production.js).
// The counters end up in window.__rx and scripts/measure.mjs prints them.
// Rebuild the app (npm run build) after apply/revert.
//
// Usage: node scripts/instrument-react.mjs apply|revert
//
// Counters (keyed by lane bitmask):
//   work        performWorkOnRoot calls
//   freshStack  prepareFreshStack calls (each one is a render started from the root)
//   commit      commits
//   spawned     markSpawnedDeferredLane calls (a deferred lane was made pending)
//   mountDeferred  useDeferredValue mounts that returned initialValue and requested a deferred lane
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const file = require.resolve('next/dist/compiled/react-dom/cjs/react-dom-client.production.js')

const HELPER = `
function __rxInc(kind, key) {
  if (typeof window === "undefined") return;
  var rx = window.__rx || (window.__rx = { work: {}, freshStack: {}, commit: {}, spawned: 0, mountDeferred: 0 });
  if (key === undefined) rx[kind]++;
  else rx[kind][key] = (rx[kind][key] || 0) + 1;
}
`

const PATCHES = [
  [
    'function markSpawnedDeferredLane(root, spawnedLane, entangledLanes) {\n',
    HELPER + 'function markSpawnedDeferredLane(root, spawnedLane, entangledLanes) {\n  __rxInc("spawned");\n',
  ],
  [
    '  hook.memoizedState = initialValue;\n  hook = requestDeferredLane();\n',
    '  hook.memoizedState = initialValue;\n  __rxInc("mountDeferred");\n  hook = requestDeferredLane();\n',
  ],
  [
    'function performWorkOnRoot(root$jscomp$0, lanes, forceSync) {\n',
    'function performWorkOnRoot(root$jscomp$0, lanes, forceSync) {\n  __rxInc("work", lanes);\n',
  ],
  [
    'function prepareFreshStack(root, lanes) {\n',
    'function prepareFreshStack(root, lanes) {\n  __rxInc("freshStack", lanes);\n',
  ],
  [
    '  var remainingLanes = finishedWork.lanes | finishedWork.childLanes;\n  pendingEffectsRemainingLanes = remainingLanes;\n',
    '  __rxInc("commit", lanes);\n  var remainingLanes = finishedWork.lanes | finishedWork.childLanes;\n  pendingEffectsRemainingLanes = remainingLanes;\n',
  ],
]

const mode = process.argv[2]
let src = readFileSync(file, 'utf8')
if (mode === 'apply') {
  if (src.includes('function __rxInc(')) {
    console.log('already instrumented')
    process.exit(0)
  }
  for (const [from, to] of PATCHES) {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${JSON.stringify(from.slice(0, 80))}`)
    src = src.replace(from, to)
  }
  writeFileSync(file, src)
  console.log(`instrumented ${file} (${PATCHES.length} patches)`)
} else if (mode === 'revert') {
  for (const [from, to] of PATCHES) src = src.replace(to, from)
  writeFileSync(file, src)
  console.log(`reverted ${file}`)
} else {
  console.error('usage: node scripts/instrument-react.mjs apply|revert')
  process.exit(1)
}
