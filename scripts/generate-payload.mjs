// Writes app/payload.generated.js: an array of pseudo-random strings that
// makes the client chunk of app/heavy.jsx large (PAYLOAD_KB, default 400 KB).
import { writeFileSync } from 'node:fs'

const kb = Number(process.env.PAYLOAD_KB || 400)
let seed = 1
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const items = []
let size = 0
while (size < kb * 1024) {
  let s = ''
  for (let i = 0; i < 64; i++) s += Math.floor(rand() * 36).toString(36)
  items.push(s)
  size += s.length + 3
}
writeFileSync(
  new URL('../app/payload.generated.js', import.meta.url),
  `export const PAYLOAD = ${JSON.stringify(items)}\n`
)
console.log(`app/payload.generated.js: ${items.length} strings, ~${Math.round(size / 1024)} KB`)
