'use client';

/** Daftar perangkat: pencarian, filter online/redaman, kolom redaman & PPPoE. */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { api, type DeviceRow } from '@/lib/api';
import { rxLevel, RX_LABEL, fmtDbm, loadLevel, fmtPct } from '@/lib/optical';

function timeAgo(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

export default function DevicesPage() {
  return <Shell><DevicesBody /></Shell>;
}

/** Ambang filter redaman (dBm) — '' = semua. */
const RX_FILTERS: [string, string][] = [
  ['', 'Semua redaman'],
  ['-25', 'Perhatian (< -25 dBm)'],
  ['-27', 'Buruk (< -27 dBm)'],
];

function RxCell({ rx }: { rx: number | null }) {
  const lvl = rxLevel(rx);
  return (
    <span className={`rx-badge ${lvl}`} title={RX_LABEL[lvl]}>
      {lvl === 'none' ? '—' : fmtDbm(rx)}
    </span>
  );
}

function DevicesBody() {
  const [q, setQ] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [rxMax, setRxMax] = useState('');
  const [items, setItems] = useState<DeviceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (q) params.set('q', q);
      if (onlyOnline) params.set('online', '1');
      if (rxMax) params.set('rxmax', rxMax);
      const r = await api<{ items: DeviceRow[]; total: number }>(`/api/devices?${params}`);
      setItems(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyOnline, rxMax]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const COLS = 10;

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h4 mb-0 fw-bold">Perangkat <span className="text-muted fs-6">({total})</span></h1>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <input
            type="search" className="form-control form-control-sm"
            placeholder="Cari serial / model / PPPoE / IP / SSID…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 260 }}
          />
          <select className="form-select form-select-sm" style={{ width: 'auto' }}
            value={rxMax} onChange={(e) => setRxMax(e.target.value)}>
            {RX_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input" type="checkbox" id="onlyOnline"
              checked={onlyOnline} onChange={(e) => setOnlyOnline(e.target.checked)}
            />
            <label className="form-check-label small" htmlFor="onlyOnline">Online saja</label>
          </div>
          <button className="btn btn-sm btn-outline-secondary" onClick={() => void load()} title="Muat ulang">
            <i className="fa-solid fa-rotate" />
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card">
        <div className="card-body p-0 table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th style={{ width: 32 }}></th>
                <th>Serial / ID</th>
                <th>Model</th>
                <th>PPPoE</th>
                <th>IP WAN</th>
                <th className="text-end">Redaman RX<div className="small fw-normal text-muted">dBm</div></th>
                <th className="text-end">TX<div className="small fw-normal text-muted">dBm</div></th>
                <th>CPU / RAM</th>
                <th>Terakhir Inform</th>
                <th className="text-center">Antre</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr><td colSpan={COLS} className="text-center text-muted py-4">Memuat…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={COLS} className="text-center text-muted py-4">
                  {q || rxMax || onlyOnline
                    ? 'Tidak ada perangkat yang cocok dengan filter.'
                    : <>Tidak ada perangkat. Set ACS URL ONT ke <code>http://&lt;ip-acs&gt;:7547/</code></>}
                </td></tr>
              )}
              {items.map((d) => (
                <tr key={d.id}>
                  <td><span className={`online-dot ${d.online ? 'on' : 'off'}`} title={d.online ? 'Online' : 'Offline'} /></td>
                  <td>
                    <Link href={`/device?id=${encodeURIComponent(d.id)}`} className="fw-semibold">
                      {d.serial_number}
                    </Link>
                    <div className="text-muted small param-path">{d.id}</div>
                  </td>
                  <td>
                    <div>{d.product_class || '—'}</div>
                    <div className="small text-muted">
                      {d.manufacturer || '—'}{d.software_version ? ` · ${d.software_version}` : ''}
                    </div>
                  </td>
                  <td className="small">
                    {d.pppoe_user
                      ? <>
                          <div className="font-monospace">{d.pppoe_user}</div>
                          {d.pppoe_status && (
                            <span className={`badge ${/^connected$/i.test(d.pppoe_status) ? 'text-bg-success' : 'text-bg-warning'}`}
                              style={{ fontSize: '.68rem' }}>{d.pppoe_status}</span>
                          )}
                        </>
                      : <span className="text-muted">—</span>}
                  </td>
                  <td className="small font-monospace">{d.wan_ip || <span className="text-muted">—</span>}</td>
                  <td className="text-end"><RxCell rx={d.rx_power} /></td>
                  <td className="text-end small num">{fmtDbm(d.tx_power)}</td>
                  <td className="small num text-nowrap">
                    {d.cpu_usage === null && d.mem_usage === null
                      ? <span className="text-muted">—</span>
                      : <>
                          <span className={`load-${loadLevel(d.cpu_usage)}`} title="Beban CPU">{fmtPct(d.cpu_usage)}</span>
                          <span className="text-muted"> / </span>
                          <span className={`load-${loadLevel(d.mem_usage)}`} title="RAM terpakai">{fmtPct(d.mem_usage)}</span>
                        </>}
                  </td>
                  <td className="small text-muted">{timeAgo(d.last_inform_at)}</td>
                  <td className="text-center">
                    {d.pending_tasks > 0
                      ? <span className="badge text-bg-warning text-dark">{d.pending_tasks}</span>
                      : <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
