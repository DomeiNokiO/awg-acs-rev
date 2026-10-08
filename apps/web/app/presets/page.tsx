'use client';

/** Daftar preset dengan pencarian dan filter. */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

interface Condition {
  attr: 'manufacturer' | 'oui' | 'productClass' | 'serialNumber' | 'softwareVersion' | 'groupName' | 'tags' | 'param';
  op: 'eq' | 'neq' | 'contains' | 'startsWith' | 'exists' | 'gt' | 'lt';
  value: string;
  path?: string;
}

interface Action {
  kind: 'get' | 'set' | 'refresh' | 'reboot' | 'factoryReset';
  path?: string;
  value?: string;
  type?: string;
}

interface Preset {
  id: number;
  name: string;
  enabled: 0 | 1;
  priority: number;
  intervalHours: number;
  conditions: Condition[];
  actions: Action[];
  lastAppliedAt: number | null;
  createdAt: number;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

export default function PresetsPage() {
  return <Shell><PresetsBody /></Shell>;
}

function PresetsBody() {
  const [items, setItems] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const [applyMsg, setApplyMsg] = useState<{ id: number; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Preset[] }>('/api/presets');
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doDelete = async (id: number) => {
    if (!confirm('Hapus preset ini?')) return;
    try {
      await api(`/api/presets/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const doApply = async (id: number) => {
    setApplying(id);
    setApplyMsg(null);
    try {
      const res = await api<{ matched: number; queued: number }>(`/api/presets/${id}/apply`, { method: 'POST' });
      setApplyMsg({ id, msg: `Diterapkan ke ${res.matched} perangkat, ${res.queued} tugas diantrekan.` });
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setApplying(null);
      setTimeout(() => setApplyMsg(null), 5000);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1 className="h4 mb-0 fw-bold">Preset</h1>
        <Link href="/presets/edit?id=new" className="btn btn-sm btn-primary">
          <i className="fa-solid fa-plus me-1" /> Tambah Preset
        </Link>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card">
        <div className="card-body p-0 table-responsive">
          <table className="table table-hover mb-0">
            <thead className="table-light">
              <tr>
                <th style={{ width: 40 }}>Status</th>
                <th>Nama</th>
                <th>Prioritas</th>
                <th>Interval</th>
                <th>Kondisi</th>
                <th>Aksi</th>
                <th>Terakhir Diterapkan</th>
                <th style={{ width: 280 }}>Operasi</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="text-center text-muted py-4">Memuat…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={8} className="text-center text-muted py-4">Belum ada preset.</td></tr>
              )}
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className={`online-dot ${p.enabled === 1 ? 'on' : 'off'}`} title={p.enabled ? 'Aktif' : 'Mati'} />
                  </td>
                  <td className="fw-semibold">{p.name}</td>
                  <td>{p.priority}</td>
                  <td>{p.intervalHours} jam</td>
                  <td><span className="badge text-bg-secondary bg-opacity-25 text-dark">{p.conditions.length}</span></td>
                  <td><span className="badge text-bg-secondary bg-opacity-25 text-dark">{p.actions.length}</span></td>
                  <td className="small text-muted">
                    {timeAgo(p.lastAppliedAt)}
                    {applyMsg?.id === p.id && <div className="text-success mt-1">{applyMsg.msg}</div>}
                  </td>
                  <td>
                    <div className="d-flex gap-2">
                      <button
                        className="btn btn-sm btn-outline-success"
                        onClick={() => doApply(p.id)}
                        disabled={applying === p.id}
                        title="Terapkan Sekarang"
                      >
                        {applying === p.id ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-play" />}
                      </button>
                      <Link href={`/presets/edit?id=${p.id}`} className="btn btn-sm btn-outline-primary">
                        <i className="fa-solid fa-edit me-1" /> Edit
                      </Link>
                      <button className="btn btn-sm btn-outline-danger" onClick={() => doDelete(p.id)}>
                        <i className="fa-solid fa-trash me-1" /> Hapus
                      </button>
                    </div>
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