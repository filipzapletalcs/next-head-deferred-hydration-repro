import Link from 'next/link'
import { Heavy } from './heavy'

export const metadata = { title: 'Home' }

export default function Page() {
  return (
    <main>
      <h1>Home</h1>
      <Heavy />
      <p>
        <Link href="/other">Other page</Link> · <Link href="/slow">Slow page</Link>
      </p>
    </main>
  )
}
