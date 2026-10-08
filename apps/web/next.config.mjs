/** @type {import('next').NextConfig} */
const API = process.env.ACS_API_URL ?? 'http://127.0.0.1:8080';
// Mode hemat memori untuk build di CT/VPS kecil (diset installer bila RAM
// < 2 GB): satu worker, tanpa worker thread paralel. Build lebih lambat,
// tetapi tidak di-OOM-kill di cgroup 1 GB.
const LOW_MEM = process.env.ACS_BUILD_LOWMEM === '1';

const nextConfig = {
  // Output statis supaya UI bisa disajikan langsung oleh proses ACS
  // tanpa menjalankan Next.js terpisah di produksi.
  output: 'export',
  images: { unoptimized: true },
  ...(LOW_MEM ? {
    experimental: { cpus: 1, workerThreads: false, webpackBuildWorker: false, webpackMemoryOptimizations: true },
  } : {}),
  async rewrites() {
    // Hanya dipakai saat `next dev`. Di produksi (output:export) tidak aktif,
    // dan ACS menyajikan file statis + API di port yang sama.
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default nextConfig;
