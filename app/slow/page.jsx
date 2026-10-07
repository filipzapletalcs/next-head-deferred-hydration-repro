import Link from 'next/link'
import { connection } from 'next/server'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function generateMetadata() {
  await connection()
  await wait(500)
  return { title: 'Slow' }
}

export default async function SlowPage() {
  await connection()
  await wait(1000)
  return (
    <main>
      <h1 id="slow">Slow</h1>
      <Link href="/">Home</Link>
    </main>
  )
}
