import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'

export const metadata: Metadata = {
  title: 'naturism 管理画面',
  description: 'naturism 公式LINE CRM 管理画面',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <head>
        {/* ビルドの出所。CI の deploy 検証 (本番が今ビルドしたものを配っているかの照合) が
            静的 HTML だけを見て判定できるよう、AuthGuard の内側ではなくここに置く。
            サイドバー下部にも同じ値を出しているが、あちらは認証後にしか描画されない。 */}
        <meta name="build-sha" content={process.env.BUILD_SHA || 'local'} />
      </head>
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
