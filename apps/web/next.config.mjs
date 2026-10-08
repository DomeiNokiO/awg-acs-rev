/** @type {import('next').NextConfig} */
const API = process.env.ACS_API_URL ?? 'http://127.0.0.1:8080';

const nextConfig = {
  // Output statis supaya UI bisa disajikan langsung oleh proses ACS
  // tanpa menjalankan Next.js terpisah di produksi.
  output: 'export',
  images: { unoptimized: true },
  async rewrites() {
    // Hanya dipakai saat `next dev`. Di produksi (output:export) tidak aktif,
    // dan ACS menyajikan file statis + API di port yang sama.
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default nextConfig;
