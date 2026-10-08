'use client';

/** Antrean tugas — apa yang menunggu dikirim ke perangkat. */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

interface Task {
  id: string; device_id: string; kind: string; status: string;
  payload: string; result: string | null; created_at: number; updated_at: number;
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-bg-warning text-dark',
  done: 'text-bg-success',
  error: 'text-bg-danger',
};

export default function TasksPage() {
  return <Shell><TasksBody /></Shell>;
}

function TasksBody() {
  const [items, setItems] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Task[] }>('/api/tasks');
      setItems(r.items);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1 className="h4 mb-0 fw-bold">Tugas</h1>
        <button className="btn btn-sm btn-outline-secondary" onClick={() => void load()}>
          <i className="fa-solid fa-sync me-1" />Segarkan
        </button>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}

      <div className="card">
        <div className="card-body p-0 table-responsive">
          <table className="table table-hover mb-0">
            <thead className="table-light">
              <tr>
                <th>Status</th><th>Jenis</th><th>Perangkat</th>
                <th>Isi</th><th>Dibuat</th><th>Diperbarui</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={6} className="text-center text-muted py-4">Belum ada tugas.</td></tr>
              )}
              {items.map((t) => (
                <tr key={t.id}>
                  <td><span className={`badge ${STATUS_COLOR[t.status] ?? 'text-bg-secondary bg-opacity-25 text-dark'}`}>{t.status}</span></td>
                  <td>{t.kind}</td>
                  <td className="small">
                    <Link href={`/device?id=${encodeURIComponent(t.device_id)}`}>{t.device_id}</Link>
                  </td>
                  <td className="small param-path" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.payload}
                  </td>
                  <td className="small text-muted text-nowrap">{new Date(t.created_at).toLocaleTimeString('id-ID')}</td>
                  <td className="small text-muted text-nowrap">{new Date(t.updated_at).toLocaleTimeString('id-ID')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
