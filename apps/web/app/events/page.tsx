'use client';

/** Log peristiwa ACS. */
import { useEffect, useState, useCallback } from 'react';
import Shell from '@/components/Shell';
import { api, type EventRow } from '@/lib/api';

export default function EventsPage() {
  return <Shell><EventsBody /></Shell>;
}

function EventsBody() {
  const [items, setItems] = useState<EventRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [onlyError, setOnlyError] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: EventRow[] }>('/api/events');
      setItems(r.items);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 12000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = onlyError
    ? items.filter((e) => e.kind.includes('error') || e.kind === 'fault' || e.kind === 'login_failed')
    : items;

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0 fw-bold">Peristiwa</h1>
        <div className="d-flex gap-3 align-items-center">
          <div className="form-check form-switch">
            <input className="form-check-input" type="checkbox" id="onlyErr"
              checked={onlyError} onChange={(e) => setOnlyError(e.target.checked)} />
            <label className="form-check-label small" htmlFor="onlyErr">Hanya error</label>
          </div>
          <button className="btn btn-sm btn-outline-secondary" onClick={() => void load()}>
            <i className="fa-solid fa-sync me-1" />Segarkan
          </button>
        </div>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}

      <div className="card">
        <div className="card-body p-0 table-responsive">
          <table className="table table-sm table-hover mb-0">
            <thead className="table-light">
              <tr><th style={{ width: 160 }}>Waktu</th><th style={{ width: 130 }}>Jenis</th><th>Perangkat</th><th>Pesan</th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="text-center text-muted py-4">Tidak ada peristiwa.</td></tr>
              )}
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="small text-muted text-nowrap">{new Date(e.created_at).toLocaleString('id-ID')}</td>
                  <td>
                    <span className={`badge ${
                      e.kind.includes('error') || e.kind === 'fault' ? 'text-bg-danger'
                        : e.kind === 'login_failed' ? 'text-bg-warning text-dark' : 'text-bg-secondary bg-opacity-25 text-dark'
                    }`}>{e.kind}</span>
                  </td>
                  <td className="small param-path">{e.device_id ?? '—'}</td>
                  <td className="small">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
