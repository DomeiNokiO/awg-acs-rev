'use client';

/**
 * Kerangka halaman ACS — rombak total mengikuti design system
 * `franchise-management` (Laravel 11):
 *   sidebar gelap #0f172a dengan item aktif satu aksen biru,
 *   topbar sticky blur, konten maks 1440px, tanpa CDN.
 *
 * PENTING: seluruh perilaku (toggle sidebar, dropdown pengguna, scrim)
 * memakai STATE REACT murni — tidak memuat JS global apa pun. Versi lama
 * memakai kelas AdminLTE 4 (.app-wrapper/.app-sidebar/.app-main) yang
 * markup-nya tidak kompatibel dengan CSS-nya sendiri dan sempat membuat
 * navigasi hilang total; sekarang kelasnya mandiri (.sidebar/.main/.topbar)
 * sehingga tidak bisa "diam-diam" bergeser lagi.
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, logout } from '@/lib/api';

interface Me { username: string; role: string }

interface NavItem { href: string; label: string; icon: string }

/* Menu dikelompokkan seperti franchise-management: label seksi + ikon FA. */
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Utama',
    items: [
      { href: '/', label: 'Dashboard', icon: 'fa-solid fa-gauge-high' },
    ],
  },
  {
    section: 'Operasional',
    items: [
      { href: '/devices', label: 'Perangkat', icon: 'fa-solid fa-server' },
      { href: '/tasks', label: 'Tugas', icon: 'fa-solid fa-list-check' },
      { href: '/events', label: 'Peristiwa', icon: 'fa-solid fa-stream' },
    ],
  },
  {
    section: 'Provisioning',
    items: [
      { href: '/presets', label: 'Preset', icon: 'fa-solid fa-sliders' },
      { href: '/webhooks', label: 'Webhook', icon: 'fa-solid fa-paper-plane' },
    ],
  },
  {
    section: 'Katalog',
    items: [
      { href: '/catalog', label: 'Parameter', icon: 'fa-solid fa-database' },
      { href: '/compare', label: 'Bandingkan', icon: 'fa-solid fa-code-compare' },
    ],
  },
];

const PAGE_TITLE: Record<string, string> = {
  '/': 'Dashboard',
  '/devices': 'Perangkat',
  '/device': 'Detail Perangkat',
  '/tasks': 'Tugas',
  '/events': 'Peristiwa',
  '/presets': 'Preset',
  '/presets/edit': 'Editor Preset',
  '/webhooks': 'Webhook',
  '/catalog': 'Katalog Parameter',
  '/compare': 'Bandingkan Katalog',
  '/settings': 'Pengguna & Setelan',
  '/login': 'Masuk',
};

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [openMobile, setOpenMobile] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  // Tutup overlay saat pindah halaman supaya tidak menutupi konten baru.
  useEffect(() => { setOpenMobile(false); setUserMenu(false); }, [pathname]);

  useEffect(() => {
    let alive = true;
    api<Me>('/api/me')
      .then((m) => { if (alive) { setMe(m); setChecked(true); } })
      .catch(() => {
        if (alive) {
          setChecked(true);
          router.replace('/login');
        }
      });
    return () => { alive = false; };
  }, [router]);

  const doLogout = useCallback(async () => {
    await logout();
    router.replace('/login');
  }, [router]);

  // Jangan render isi sebelum sesi dipastikan — mencegah kedip data publik.
  if (!checked) {
    return (
      <div className="d-flex align-items-center justify-content-center min-vh-100">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Memuat…</span>
        </div>
      </div>
    );
  }

  const title = PAGE_TITLE[pathname] ?? 'ACS TR-069';
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');

  return (
    <>
      <div
        className={`sidebar-overlay ${openMobile ? 'show' : ''}`}
        role="presentation"
        onClick={() => setOpenMobile(false)}
      />

      <aside className={`sidebar ${openMobile ? 'open' : ''}`} id="sidebar">
        <div className="brand">
          <div className="logo"><i className="fa-solid fa-network-wired" /></div>
          <div>
            <b>ACS TR-069</b>
            <small>Auto Configuration Server</small>
          </div>
        </div>

        <nav>
          {NAV.map((group) => (
            <div key={group.section}>
              <div className="nav-label">{group.section}</div>
              {group.items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`nav-link ${isActive(n.href) ? 'active' : ''}`}
                >
                  <i className={n.icon} />
                  {n.label}
                </Link>
              ))}
            </div>
          ))}

          {me?.role === 'admin' && (
            <div>
              <div className="nav-label">Admin</div>
              <Link
                href="/settings"
                className={`nav-link ${isActive('/settings') ? 'active' : ''}`}
              >
                <i className="fa-solid fa-shield-halved" />
                Pengguna &amp; Setelan
              </Link>
              <a
                href="/API.md"
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link"
              >
                <i className="fa-solid fa-book" />
                API Docs
              </a>
            </div>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            <div className="avatar">{(me?.username ?? '?').slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <b className="text-truncate d-block">{me?.username ?? '—'}</b>
              <small>{me?.role === 'admin' ? 'Administrator' : 'Operator'}</small>
            </div>
            <button
              type="button"
              className="btn btn-sm text-secondary p-2"
              onClick={doLogout}
              title="Keluar"
              style={{ color: '#64748b' }}
            >
              <i className="fa-solid fa-right-from-bracket" />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            className="menu-btn"
            id="sidebarToggle"
            type="button"
            aria-label="Buka menu"
            onClick={() => setOpenMobile((v) => !v)}
          >
            <i className="fa-solid fa-bars" />
          </button>

          <div className="crumb">
            <b>{title}</b>
            <small>TR-069 Auto Configuration Server</small>
          </div>

          <div className="right">
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="user-chip"
                onClick={() => setUserMenu((v) => !v)}
                aria-expanded={userMenu}
                aria-haspopup="menu"
              >
                <span className="avatar">
                  {(me?.username ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="d-none d-sm-inline">{me?.username}</span>
                <i className="fa-solid fa-chevron-down" style={{ fontSize: '.65rem' }} />
              </button>

              {userMenu && (
                <>
                  <div
                    role="presentation"
                    style={{ position: 'fixed', inset: 0, zIndex: 1040 }}
                    onClick={() => setUserMenu(false)}
                  />
                  <div className="user-menu" role="menu">
                    <div className="px-3 py-2 small text-muted">
                      Masuk sebagai <b>{me?.username}</b> ({me?.role})
                    </div>
                    <div className="sep" />
                    {me?.role === 'admin' && (
                      <Link
                        className="item"
                        href="/settings"
                        onClick={() => setUserMenu(false)}
                        role="menuitem"
                      >
                        <i className="fa-solid fa-shield-halved" />
                        Pengguna &amp; Setelan
                      </Link>
                    )}
                    <button
                      type="button"
                      className="item danger"
                      onClick={doLogout}
                      role="menuitem"
                    >
                      <i className="fa-solid fa-right-from-bracket" />
                      Keluar
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </>
  );
}
