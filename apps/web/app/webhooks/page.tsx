'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import Shell from '@/components/Shell';

interface WebhookRow {
  id: number;
  name: string;
  url: string;
  events: string;      // JSON array
  enabled: number;
  created_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  ok_count: number;
  fail_count: number;
}

interface DeliveryEntry {
  id: string;
  webhookId: number;
  webhookName: string;
  kind: string;
  attempt: number;
  status: number | null;
  ok: boolean;
  error?: string;
  at: number;
  ms: number;
}

const EVENT_OPTIONS: Array<[string, string]> = [
  ['inform', 'Inform perangkat (koneksi)'],
  ['fault', 'Fault / RPC gagal'],
  ['reboot', 'Perintah reboot dikirim'],
  ['factory_reset', 'Factory reset dikirim'],
  ['transfer', 'Download firmware/config'],
  ['preset', 'Preset diterapkan'],
  ['task', 'Tugas diantrekan'],
  ['catalog', 'Katalog diimpor'],
  ['login', 'Login berhasil'],
  ['login_failed', 'Login gagal'],
  ['user', 'Pengguna dibuat'],
];

function fmtTs(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function WebhooksPage() {
  return <Shell><WebhooksBody /></Shell>;
}

function WebhooksBody() {
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [log, setLog] = useState<DeliveryEntry[]>([]);
  const [stats, setStats] = useState<{ pending: number; dropped: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const [editing, setEditing] = useState<WebhookRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', secret: '', events: [] as string[], enabled: true });

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: WebhookRow[]; stats: { pending: number; dropped: number } | null }>('/api/webhooks');
      setRows(data.items);
      setStats(data.stats);
      setLoading(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'gagal memuat');
      setLoading(false);
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const data = await api<{ items: DeliveryEntry[] }>('/api/webhooks/log');
      setLog(data.items);
    } catch { /* log opsional */ }
  }, []);

  useEffect(() => {
    load(); loadLog();
    const t = setInterval(() => { load(); loadLog(); }, 15000);
    return () => clearInterval(t);
  }, [load, loadLog]);

  const toggleEvent = (ev: string) => {
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev],
    }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setMsg('');
    try {
      if (editing) {
        await api(`/api/webhooks/${editing.id}`, {
          method: 'PUT',
          body: { ...form, secret: form.secret || undefined },
        });
      } else {
        await api('/api/webhooks', {
          method: 'POST',
          body: form,
        });
      }
      setShowForm(false); setEditing(null); setForm({ name: '', url: '', secret: '', events: [], enabled: true });
      setMsg('Webhook disimpan ✓'); await load();
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : 'gagal menyimpan');
    }
  };

  const remove = async (id: number, name: string) => {
    if (!window.confirm(`Hapus webhook "${name}"?`)) return;
    try {
      await api(`/api/webhooks/${id}`, { method: 'DELETE' });
      setMsg('Webhook dihapus'); await load();
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : 'gagal menghapus');
    }
  };

  const test = async (id: number) => {
    setErr(''); setMsg('');
    try {
      const r = await api<{ entry: DeliveryEntry }>(`/api/webhooks/${id}/test`, { method: 'POST' });
      setMsg(r.entry.ok ? `Uji OK — HTTP ${r.entry.status} (${r.entry.ms} ms)` : `Uji gagal — ${r.entry.status ?? r.entry.error}`);
      await loadLog();
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : 'uji gagal');
    }
  };

  const totalOk = useMemo(() => rows.reduce((s, r) => s + r.ok_count, 0), [rows]);
  const totalFail = useMemo(() => rows.reduce((s, r) => s + r.fail_count, 0), [rows]);

  const openCreate = () => { setEditing(null); setForm({ name: '', url: '', secret: '', events: [], enabled: true }); setShowForm(true); };
  const openEdit = (r: WebhookRow) => {
    let events: string[] = [];
    try { events = JSON.parse(r.events || '[]'); } catch { /* abaikan */ }
    setEditing(r); setForm({ name: r.name, url: r.url, secret: '', events, enabled: !!r.enabled });
    setShowForm(true);
  };

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h1 className="h3 mb-1">Webhook</h1>
          <div className="text-muted small">
            Kirim peristiwa ACS ke sistem lain (OSS/BSS, Telegram, n8n, Zabbix…)
            secara real-time — tanpa sistem tersebut harus polling.
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <i className="fa-solid fa-plus me-1" /> Tambah Webhook
        </button>
      </div>

      {err && <div className="alert alert-danger py-2 small">{err}</div>}
      {msg && <div className="alert alert-success py-2 small">{msg}</div>}

      {/* statistik */}
      <div className="d-flex flex-wrap gap-3 mb-3">
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0"><div className="card-body py-3">
            <div className="text-muted small">Target aktif</div>
            <div className="h4 mb-0">{rows.filter((r) => r.enabled).length}<span className="text-muted fs-6 ms-1">/ {rows.length}</span></div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0"><div className="card-body py-3">
            <div className="text-muted small">Antrean menunggu</div>
            <div className="h4 mb-0">{stats?.pending ?? 0}</div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0"><div className="card-body py-3">
            <div className="text-muted small">Terkirim (OK)</div>
            <div className="h4 text-success mb-0">{totalOk}</div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0"><div className="card-body py-3">
            <div className="text-muted small">Gagal</div>
            <div className="h4 text-danger mb-0">{totalFail}</div>
          </div></div>
        </div>
      </div>

      {/* form tambah/edit */}
      {showForm && (
        <div className="card mb-3 border-primary">
          <div className="card-header py-2 d-flex justify-content-between align-items-center">
            <h2 className="h6 mb-0">{editing ? `Ubah: ${editing.name}` : 'Webhook baru'}</h2>
            <button className="btn btn-sm btn-light" onClick={() => { setShowForm(false); setEditing(null); }}>✕</button>
          </div>
          <div className="card-body">
            <form onSubmit={save} className="row g-3">
              <div className="col-12 col-md-6">
                <label className="form-label small mb-1">Nama</label>
                <input className="form-control" required maxLength={64} value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="mis. Bot Telegram" />
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label small mb-1">URL tujuan</label>
                <input className="form-control" required type="url" value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…/acs-webhook" />
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label small mb-1">Secret (opsional, untuk HMAC)</label>
                <input className="form-control" type="password" value={form.secret} autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder={editing ? '(biarkan kosong = pertahankan)' : 'acak panjang'} />
              </div>
              <div className="col-12 col-md-6 form-check form-switch mt-4">
                <input className="form-check-input" type="checkbox" id="wh-enabled" checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                <label className="form-check-label small" htmlFor="wh-enabled">Aktif</label>
              </div>
              <div className="col-12">
                <label className="form-label small mb-1">Peristiwa (kosong = semua)</label>
                <div className="d-flex flex-wrap gap-2">
                  {EVENT_OPTIONS.map(([v, label]) => (
                    <button key={v} type="button"
                      className={`btn btn-sm ${form.events.includes(v) ? 'btn-primary' : 'btn-outline-secondary'}`}
                      onClick={() => toggleEvent(v)}>
                      {v} {form.events.includes(v) && <i className="fa-solid fa-check ms-1" />}
                    </button>
                  ))}
                </div>
                <div className="form-text">Klik untuk pilih. Kosongkan semua = semua jenis peristiwa dikirim.</div>
              </div>
              <div className="col-12 d-flex gap-2">
                <button className="btn btn-primary" type="submit"><i className="fa-solid fa-save me-1" /> Simpan</button>
                <button className="btn btn-light" type="button" onClick={() => { setShowForm(false); setEditing(null); }}>Batal</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* daftar target */}
      <div className="card">
        <div className="card-header py-2 d-flex justify-content-between align-items-center">
          <h2 className="h6 mb-0">Target ({rows.length})</h2>
          <button className="btn btn-sm btn-outline-secondary" onClick={() => { load(); loadLog(); }}><i className="fa-solid fa-sync me-1" /> Muat ulang</button>
        </div>
        <div className="card-body p-0 table-responsive">
          <table className="table table-hover align-middle mb-0 table-webhooks">
            <thead className="table-light">
              <tr>
                <th>Nama</th><th>Tujuan</th><th>Peristiwa</th><th>Status</th><th className="text-end">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="text-center text-muted py-4">
                  Belum ada webhook. Tambahkan target pertama untuk mulai menerima push.
                </td></tr>
              )}
              {rows.map((r) => {
                let evs: string[] = [];
                try { evs = JSON.parse(r.events || '[]'); } catch { /* */ }
                const okRate = r.ok_count + r.fail_count > 0
                  ? Math.round((r.ok_count / (r.ok_count + r.fail_count)) * 100) : null;
                return (
                  <tr key={r.id} className={r.enabled ? '' : 'table-secondary'}>
                    <td>
                      <div className="fw-semibold">{r.name}</div>
                      <div className="text-muted small">{r.enabled ? 'aktif' : 'nonaktif'}</div>
                    </td>
                    <td className="text-break small">{r.url}</td>
                    <td>
                      {evs.length === 0
                        ? <span className="badge text-bg-secondary bg-opacity-25 text-dark">semua</span>
                        : <div className="d-flex flex-wrap gap-1">{evs.slice(0, 4).map((e) => (
                            <span key={e} className="badge bg-info-subtle text-info-emphasis">{e}</span>
                          ))}{evs.length > 4 && <span className="badge bg-light">+{evs.length - 4}</span>}</div>}
                    </td>
                    <td>
                      {r.last_status === null
                        ? <span className="text-muted small">belum kirim</span>
                        : (
                          <div>
                            <span className={`badge ${r.last_status >= 200 && r.last_status < 300 ? 'text-bg-success' : 'text-bg-danger'}`}>
                              HTTP {r.last_status}
                            </span>
                            {okRate !== null && (
                              <div className="text-muted small mt-1">OK {r.ok_count} / gagal {r.fail_count}</div>
                            )}
                          </div>
                        )}
                    </td>
                    <td className="text-end text-nowrap">
                      <button className="btn btn-sm btn-outline-primary me-1" onClick={() => test(r.id)} title="Kirim uji"><i className="fa-solid fa-paper-plane" /></button>
                      <button className="btn btn-sm btn-outline-secondary me-1" onClick={() => openEdit(r)}><i className="fa-solid fa-pencil" /></button>
                      <button className="btn btn-sm btn-outline-danger" onClick={() => remove(r.id, r.name)}><i className="fa-solid fa-trash" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* log pengiriman */}
      <div className="card mt-3">
        <div className="card-header py-2">
          <h2 className="h6 mb-0">Log pengiriman terakhir</h2>
        </div>
        <div className="card-body table-responsive">
          <table className="table table-sm table-striped mb-0">
            <thead className="table-light">
              <tr><th>Waktu</th><th>Webhook</th><th>Peristiwa</th><th>Percobaan</th><th>Hasil</th><th>Laten (ms)</th></tr>
            </thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={6} className="text-center text-muted py-3">Belum ada kiriman.</td></tr>}
              {log.map((e) => (
                <tr key={e.id}>
                  <td className="small">{fmtTs(e.at)}</td>
                  <td className="small">{e.webhookName}</td>
                  <td><span className="badge bg-info-subtle text-info-emphasis">{e.kind}</span></td>
                  <td className="small">{e.attempt}</td>
                  <td>
                    {e.ok
                      ? <span className="badge text-bg-success">OK {e.status}</span>
                      : <span className="badge text-bg-danger">{e.status ?? 'err'}{e.error ? ` ${e.error}` : ''}</span>}
                  </td>
                  <td className="small">{e.ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}