import Link from 'next/link'

export const metadata = { title: 'Other' }

export default function OtherPage() {
  return (
    <main>
      <h1>Other</h1>
      <Link href="/">Home</Link>
    </main>
  )
}
