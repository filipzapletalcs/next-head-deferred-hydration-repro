'use client'

// Stands in for a large client bundle. The generated module makes this
// component's chunk large enough to arrive after the framework chunks on a
// throttled connection, so the page's RSC payload is still "blocked" on it
// when hydration starts.
import { PAYLOAD } from './payload.generated'

export function Heavy() {
  return <p id="heavy">HEAVY_CLIENT_CHUNK {PAYLOAD.length}</p>
}
