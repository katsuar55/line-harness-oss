import type { NextConfig } from 'next'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'))

const nextConfig: NextConfig = {
  output: 'export',
  transpilePackages: ['@line-crm/shared'],
  env: {
    APP_VERSION: pkg.version,
    // ビルドの出所を成果物に焼き込む。CI の deploy 検証 (本番が「今ビルドしたもの」を配っているかの照合) と、
    // 「画面が古いのでは?」という疑いを人間が 5 秒で潰すための両方に使う。
    // chunk 名ハッシュでの照合は、依存が変わらないと同名になる webpack runtime chunk を拾って
    // 素通りするため当てにならない (2026-07-28 に実際に空振りした)。
    BUILD_SHA: (process.env.GITHUB_SHA || 'local').slice(0, 12),
  },
}
export default nextConfig
