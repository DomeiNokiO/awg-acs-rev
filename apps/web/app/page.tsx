'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { api, type DeviceRow, type EventRow } from '@/lib/api';

interface Stats {
  devices: { total: number; online: number };
  queue: number;
  sessions: number;
  recentEvents: EventRow[];
  discoveredClasses: { product_class: string; vendor: string; n: number }[];
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'pernah';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Selamat malam';
  if (h < 11) return 'Selamat pagi';
  if (h < 15) return 'Selamat siang';
  if (h < 19) return 'Selamat sore';
  return 'Selamat malam';
}

const fmt = (n: number) => n.toLocaleString('id-ID');

export default function Dashboard() {
  return (
    <Shell>
      <DashboardBody />
    </Shell>
  );
}

function DashboardBody() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<DeviceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([
        api<Stats>('/api/stats'),
        api<{ items: DeviceRow[] }>('/api/devices?limit=8&online=1'),
      ]).then(([s, d]) => {
        if (!alive) return;
        setStats(s);
        setRecent(d.items);
      }).catch((e) => alive && setErr(String(e.message ?? e)));
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div className="alert alert-danger py-2">{err}</div>;
  if (!stats) {
    return (
      <div className="d-flex justify-content-center align-items-center min-vh-100">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Memuat…</span>
        </div>
      </div>
    );
  }

  const offline = stats.devices.total - stats.devices.online;
  const onlinePct = stats.devices.total
    ? Math.round((stats.devices.online / stats.devices.total) * 100)
    : 0;

  const cards = [
    {
      label: 'Total perangkat', value: fmt(stats.devices.total), icon: 'fa-server',
      grad: 'linear-gradient(135deg, #3b82f6, #6366f1)', footer: 'Terdaftar di ACS',
      href: '/devices', badge: 'total',
    },
    {
      label: 'Online', value: fmt(stats.devices.online), icon: 'fa-wifi',
      grad: 'linear-gradient(135deg, #10b981, #059669)', footer: '30 menit terakhir',
      href: '/devices?online=1', badge: `${onlinePct}%`,
    },
    {
      label: 'Offline', value: fmt(offline), icon: 'fa-plug',
      grad: 'linear-gradient(135deg, #ef4444, #b91c1c)', footer: 'Butuh perhatian',
      href: '/devices', badge: offline > 0 ? 'periksa' : 'aman',
    },
    {
      label: 'Antrean tugas', value: fmt(stats.queue), icon: 'fa-tasks',
      grad: stats.queue > 0
        ? 'linear-gradient(135deg, #f59e0b, #d97706)'
        : 'linear-gradient(135deg, #64748b, #475569)',
      footer: `${stats.sessions} sesi aktif`, href: '/tasks',
      badge: stats.queue > 0 ? 'menunggu' : 'lancar',
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>{greeting()} 👋 {stats.devices.total === 0 ? 'Belum ada perangkat terhubung.' : `${stats.devices.online} dari ${stats.devices.total} perangkat aktif.`}</p>
        </div>
      </div>

      <div className="row g-3 mb-4">
        {cards.map((c) => (
          <div className="col-xl-3 col-md-6" key={c.label}>
            <Link href={c.href}>
              <div className="metric-card" style={{ background: c.grad }}>
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <div className="metric-label">{c.label}</div>
                    <div className="metric-value">{c.value}</div>
                    <div className="metric-footer">
                      <i className="fa-solid fa-circle me-1" style={{ fontSize: '.35rem', verticalAlign: 'middle' }} />
                      {c.footer}
                    </div>
                  </div>
                  <div className="metric-icon">
                    <i className={`fa-solid ${c.icon}`} />
                  </div>
                </div>
                <div className="metric-badge">{c.badge}</div>
              </div>
            </Link>
          </div>
        ))}
      </div>

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card h-100">
            <div className="card-header">
              <h3 className="card-title">Perangkat online terbaru</h3>
              <div className="ms-auto h-sub">
                <Link href="/devices">Lihat semua →</Link>
              </div>
            </div>
            <div className="card-body p-0 table-responsive">
              <table className="table table-hover mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Status</th><th>Serial</th><th>Model</th><th>Terakhir Inform</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 && (
                    <tr><td colSpan={4} className="text-muted text-center py-5">
                      <i className="fa-solid fa-inbox fa-2x d-block mb-2 opacity-50" />
                      Belum ada perangkat terhubung. Arahkan ACS URL ONT ke
                      <code className="mx-1">http://&lt;ip&gt;:7547/</code>
                    </td></tr>
                  )}
                  {recent.map((d) => (
                    <tr key={d.id}>
                      <td><span className={`online-dot ${d.online ? 'on' : 'off'}`} /></td>
                      <td>
                        <Link href={`/device?id=${encodeURIComponent(d.id)}`} className="fw-bold">
                          {d.serial_number}
                        </Link>
                      </td>
                      <td className="small">{d.product_class}</td>
                      <td className="small text-muted">{timeAgo(d.last_inform_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card h-100">
            <div className="card-header">
              <h3 className="card-title">Peristiwa terakhir</h3>
              <div className="ms-auto h-sub">
                <Link href="/events">Riwayat lengkap →</Link>
              </div>
            </div>
            <div className="card-body p-0">
              <ul className="list-group list-group-flush">
                {stats.recentEvents.length === 0 && (
                  <li className="list-group-item text-muted text-center py-4">Belum ada peristiwa</li>
                )}
                {stats.recentEvents.map((e) => (
                  <li className="list-group-item" key={e.id}>
                    <div className="d-flex w-100 justify-content-between">
                      <b className="small text-truncate me-2" style={{ maxWidth: 200 }}>
                        {e.device_id || 'Sistem'}
                      </b>
                      <small className="text-muted text-nowrap">{timeAgo(e.created_at)}</small>
                    </div>
                    <p className="mb-0 small text-muted text-truncate">
                      <span className={`badge me-2 ${e.kind.includes('error') || e.kind === 'failed' ? 'bg-danger' : 'badge-soft'}`}>
                        {e.kind}
                      </span>
                      {e.message}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {stats.discoveredClasses.length > 0 && (
        <div className="mt-4">
          <h5 className="mb-3">Model terdeteksi</h5>
          <div className="row g-2">
            {stats.discoveredClasses.map((c) => (
              <div className="col-auto" key={c.product_class}>
                <div className="border rounded-pill px-3 py-1 bg-white shadow-sm small">
                  <span className="fw-bold me-1">{c.vendor}</span> {c.product_class}
                  <span className="text-muted ms-2">({c.n})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
