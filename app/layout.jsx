import { RenderCounter } from './render-counter'

export const metadata = { title: 'Home' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <RenderCounter />
        {children}
      </body>
    </html>
  )
}
