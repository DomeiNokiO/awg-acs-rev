'use client';

/**
 * Halaman Pengguna & Setelan.
 * Tersedia hanya untuk peran admin.
 */
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

interface UserRow {
  username: string;
  role: string;
  created_at: number;
  last_login_at: number | null;
}

export default function SettingsPage() {
  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Pengguna &amp; Setelan</h1>
          <p>Kelola akses akun dan konfigurasi sistem ACS.</p>
        </div>
      </div>
      <SettingsBody />
    </Shell>
  );
}

function SettingsBody() {
  const [tab, setTab] = useState<'users' | 'sys'>('users');

  return (
    <div className="row">
      <div className="col-lg-3 col-md-4 mb-3">
        <div className="card">
          <div className="list-group list-group-flush" style={{ borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <button
              className={`list-group-item list-group-item-action border-0 ${tab === 'users' ? 'active' : ''}`}
              onClick={() => setTab('users')}
            >
              <i className="fa-solid fa-users me-2" />Akun Pengguna
            </button>
            <button
              className={`list-group-item list-group-item-action border-0 ${tab === 'sys' ? 'active' : ''}`}
              onClick={() => setTab('sys')}
            >
              <i className="fa-solid fa-sliders me-2" />Sistem (.env)
            </button>
          </div>
        </div>
      </div>
      <div className="col-lg-9 col-md-8">
        {tab === 'users' && <UsersTab />}
        {tab === 'sys' && <SystemTab />}
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [formUser, setFormUser] = useState('');
  const [formPass, setFormPass] = useState('');
  const [formRole, setFormRole] = useState('operator');
  const [formBusy, setFormBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const r = await api<{ items: UserRow[] }>('/api/users');
      setUsers(r.items);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setFormBusy(true);
    setFormErr(null);
    try {
      await api('/api/users', {
        method: 'POST',
        body: { username: formUser, password: formPass, role: formRole },
      });
      setFormUser('');
      setFormPass('');
      setFormRole('operator');
      await load();
    } catch (e) {
      const m = (e as Error).message;
      setFormErr(
        m === 'password_too_short' ? 'Password minimal 12 karakter.'
          : m === 'user_exists' ? 'Username sudah dipakai.'
            : m === 'invalid_username' ? 'Username hanya boleh huruf, angka, titik, strip, garis bawah.'
              : m === 'admin_required' ? 'Hanya admin yang boleh melakukan ini.'
                : m);
    } finally {
      setFormBusy(false);
    }
  }

  async function deleteUser(username: string) {
    if (!confirm(`Hapus pengguna ${username}?`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert(`Gagal: ${(e as Error).message}`);
    }
  }

  return (
    <>
      <div className="card mb-3">
        <div className="card-header">
          <h3 className="card-title">Daftar Akun</h3>
        </div>
        <div className="card-body p-0 table-responsive">
          {err ? (
            <div className="p-3 text-danger">{err}</div>
          ) : (
            <table className="table table-hover align-middle mb-0">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Peran</th>
                  <th>Login Terakhir</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td className="fw-bold">{u.username}</td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'badge-soft' : 'text-bg-secondary bg-opacity-25 text-dark'}`}>
                        {u.role === 'admin' ? 'Admin' : 'Operator'}
                      </span>
                    </td>
                    <td className="small text-muted">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString('id-ID') : 'Belum pernah'}
                    </td>
                    <td className="text-end">
                      <button
                        className="btn btn-sm btn-outline-danger border-0"
                        title="Hapus"
                        onClick={() => deleteUser(u.username)}
                      >
                        <i className="fas fa-trash" />
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-muted py-4">Belum ada data</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Tambah Pengguna</h3>
        </div>
        <div className="card-body">
          {formErr && <div className="alert alert-danger py-2 small">{formErr}</div>}
          <form onSubmit={createUser}>
            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label">Username</label>
                <input
                  type="text" className="form-control" required
                  pattern="[a-zA-Z0-9_.-]+" title="Alfanumerik, titik, strip, garis bawah"
                  value={formUser} onChange={(e) => setFormUser(e.target.value)}
                />
              </div>
              <div className="col-md-4">
                <label className="form-label">Password</label>
                <input
                  type="password" className="form-control" required minLength={12}
                  value={formPass} onChange={(e) => setFormPass(e.target.value)}
                />
                <div className="form-text" style={{ fontSize: '.7rem' }}>Minimal 12 karakter.</div>
              </div>
              <div className="col-md-4">
                <label className="form-label">Peran</label>
                <select
                  className="form-select" required
                  value={formRole} onChange={(e) => setFormRole(e.target.value)}
                >
                  <option value="operator">Operator — baca &amp; perintah</option>
                  <option value="admin">Admin — sistem penuh</option>
                </select>
              </div>
            </div>
            <div className="mt-3 text-end">
              <button type="submit" className="btn btn-primary" disabled={formBusy}>
                {formBusy ? 'Menyimpan…' : 'Tambah Akun'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function SystemTab() {
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const r = await api<Record<string, string>>('/api/settings');
      setCfg(r);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setToast(null);
    try {
      const r = await api<{ ok: boolean; note: string }>('/api/settings', {
        method: 'PUT',
        body: cfg,
      });
      setToast(r.note);
      setTimeout(() => setToast(null), 8000);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setVal = (k: string, v: string) => setCfg((prev) => ({ ...prev, [k]: v }));

  if (err) return <div className="alert alert-danger py-2">{err}</div>;

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Konfigurasi Sistem (.env)</h3>
      </div>
      <div className="card-body">
        {toast && (
          <div className="alert alert-success py-2 small mb-3">
            <i className="fa-solid fa-circle-check me-2" />
            {toast}
          </div>
        )}
        <form onSubmit={save}>
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">CWMP Port (ACS ← CPE)</label>
              <input
                type="number" className="form-control form-control-sm" required
                value={cfg.ACS_CWMP_PORT ?? ''} onChange={(e) => setVal('ACS_CWMP_PORT', e.target.value)}
              />
            </div>
            <div className="col-md-6">
              <label className="form-label">API/UI Port</label>
              <input
                type="number" className="form-control form-control-sm" required
                value={cfg.ACS_API_PORT ?? ''} onChange={(e) => setVal('ACS_API_PORT', e.target.value)}
              />
            </div>
            <div className="col-md-6">
              <label className="form-label">File Kredensial Global CWMP</label>
              <input
                type="text" className="form-control form-control-sm font-monospace" placeholder="Kosong = terima semua"
                value={cfg.ACS_CWMP_CREDENTIALS ?? ''} onChange={(e) => setVal('ACS_CWMP_CREDENTIALS', e.target.value)}
              />
              <div className="form-text" style={{ fontSize: '.7rem' }}>Path absolut (mis. /opt/acs/cwmp.creds)</div>
            </div>
            <div className="col-md-6">
              <label className="form-label">File Katalog Eksternal</label>
              <input
                type="text" className="form-control form-control-sm font-monospace" placeholder="Kosong = katalog bawaan"
                value={cfg.ACS_CATALOG ?? ''} onChange={(e) => setVal('ACS_CATALOG', e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label">Sesi Web (jam)</label>
              <input
                type="number" className="form-control form-control-sm" min={1} required
                value={cfg.ACS_SESSION_TTL ?? ''} onChange={(e) => setVal('ACS_SESSION_TTL', e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label">Listener CWMP</label>
              <select className="form-select form-select-sm" value={cfg.ACS_ENABLE_CWMP ?? '1'} onChange={(e) => setVal('ACS_ENABLE_CWMP', e.target.value)}>
                <option value="1">Aktif</option>
                <option value="0">Mati</option>
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">Listener API/UI</label>
              <select className="form-select form-select-sm" value={cfg.ACS_ENABLE_NBI ?? '1'} onChange={(e) => setVal('ACS_ENABLE_NBI', e.target.value)}>
                <option value="1">Aktif</option>
                <option value="0">Mati</option>
              </select>
            </div>
          </div>
          <div className="mt-4 pt-3 border-top text-end">
            <button type="submit" className="btn btn-primary" disabled={busy || !cfg.ACS_CWMP_PORT}>
              {busy ? 'Menyimpan…' : 'Simpan Perubahan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
