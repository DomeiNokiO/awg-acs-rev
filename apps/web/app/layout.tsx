import type { Metadata, Viewport } from 'next';
// Bootstrap 5.3 (lokal dari node_modules, tanpa CDN) — fondasi grid/komponen.
import 'bootstrap/dist/css/bootstrap.min.css';
// Ikon: Font Awesome tetap dipakai karena seluruh markup sudah pakai `fa-*`,
// tapi di-bundel LOKAL (bukan CDN jsDelivr) supaya CT tanpa internet tetap utuh.
import '@fortawesome/fontawesome-free/css/all.min.css';
// Font Inter self-hosted — hanya subset latin + latin-ext (jauh lebih ringan).
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'ACS — TR-069 Management',
  description: 'Auto Configuration Server untuk manajemen ONT/Router TR-069',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
