'use client'

// Diagnostic only: counts how many times React renders this component.
// It sits in the root layout, above the page segment, so every attempt to
// hydrate the root renders it again.
export function RenderCounter() {
  if (typeof window !== 'undefined') {
    window.__renderCounter = (window.__renderCounter || 0) + 1
  }
  return null
}
