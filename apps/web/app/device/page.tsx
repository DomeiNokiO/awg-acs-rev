'use client';

/** Detail perangkat tunggal. */
import { useEffect, useState, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { api, type DeviceRow, type ParamRow, type EventRow, type DeviceInsight } from '@/lib/api';
import { Configurator, wanLabel, type ConfigPreset } from '@/components/Configurator';
import { rxLevel, RX_LABEL, fmtDbm, fmtUptime } from '@/lib/optical';
import { connectionError } from '@/lib/wan';

type Tab = 'summary' | 'config' | 'params' | 'commands' | 'discovered' | 'events' | 'tasks';

interface Detail {
  insight: DeviceInsight;
  device: DeviceRow;
  params: ParamRow[];
  events: EventRow[];
  tasks: any[];
  discovered: { path: string; writable: boolean }[];
}

export default function DevicePage() {
  return (
    <Shell>
      <Suspense fallback={<div>Memuat…</div>}>
        <DeviceBody />
      </Suspense>
    </Shell>
  );
}

function DeviceBody() {
  const search = useSearchParams();
  const id = search.get('id');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [filter, setFilter] = useState('');
  // Notifikasi: hijau = berhasil, kuning = sebagian/peringatan, merah = gagal.
  type ToastKind = 'ok' | 'warn' | 'err';
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const [editTarget, setEditTarget] = useState<{ path: string; value: string } | null>(null);

  const onEditParam = useCallback((path: string, value: string) => {
    setEditTarget({ path, value });
    setTab('commands');
  }, []);

  // Tombol "Ubah" di Ringkasan membuka tab Konfigurasi dengan target terisi.
  const [preset, setPreset] = useState<ConfigPreset | null>(null);
  const openConfig = useCallback((p: Omit<ConfigPreset, 'nonce'>) => {
    setPreset({ ...p, nonce: Date.now() });
    setTab('config');
  }, []);
  const flash = useCallback((msg: string, kind: ToastKind = 'ok', ms = kind === 'ok' ? 5000 : 9000) => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), ms);
  }, []);

  const [crUrl, setCrUrl] = useState('');
  const [crUser, setCrUser] = useState('');
  const [crPass, setCrPass] = useState('');
  const [crGroup, setCrGroup] = useState('');
  const [cwUser, setCwUser] = useState('');
  const [cwPass, setCwPass] = useState('');
  const [metaBusy, setMetaBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);

  useEffect(() => {
    if (!detail) return;
    setCrUrl(detail.device.connection_request_url ?? '');
    setCrUser(detail.device.connection_request_user ?? '');
    setCrPass('');
    setCrGroup(detail.device.group_name ?? '');
    setCwUser(detail.device.cwmp_user ?? '');
    setCwPass('');
  }, [detail]);

  const saveMeta = async () => {
    if (!id) return;
    setMetaBusy(true);
    try {
      const body: Record<string, string> = {
        connection_request_url: crUrl,
        connection_request_user: crUser,
        group_name: crGroup,
        cwmp_user: cwUser,
      };
      if (crPass !== '') body.connection_request_pass = crPass;
      if (cwPass !== '') body.cwmp_pass = cwPass;
      await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'PUT', body });
      flash('Metadata akses tersimpan');
      void load();
    } catch (e) {
      flash(`Gagal menyimpan: ${(e as Error).message}`, 'err');
    } finally {
      setMetaBusy(false);
    }
  };

  const resetMeta = () => {
    if (!detail) return;
    setCrUrl(detail.device.connection_request_url ?? '');
    setCrUser(detail.device.connection_request_user ?? '');
    setCrPass('');
    setCrGroup(detail.device.group_name ?? '');
    setCwUser(detail.device.cwmp_user ?? '');
    setCwPass('');
  };

  const connectNow = async () => {
    if (!id) return;
    setConnectBusy(true);
    try {
      const r = await api<{ ok: boolean; status?: number; auth?: string }>(
        `/api/devices/${encodeURIComponent(id)}/connect`, { method: 'POST' });
      flash(`Connection Request diterima ONU (HTTP ${r.status ?? '-'}, ${r.auth ?? '-'}) — ONU akan Inform dalam beberapa detik.`);
      setTimeout(() => void load(), 6000);
    } catch (e) {
      flash(`Gagal hubungi: ${(e as Error).message}`, 'err');
    } finally {
      setConnectBusy(false);
    }
  };

  /** Antrekan pembacaan ulang lalu panggil perangkat agar segera Inform. */
  const refreshNow = async () => {
    if (!id) return;
    setConnectBusy(true);
    try {
      const r = await api<{ paths: number }>(`/api/devices/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
      const note = `${r.paths} parameter diantrekan untuk dibaca.`;
      try {
        await api(`/api/devices/${encodeURIComponent(id)}/connect`, { method: 'POST' });
        flash(`${note} Connection Request diterima — data diperbarui dalam beberapa detik.`);
        setTimeout(() => void load(), 6000);
      } catch (e) {
        flash(`${note} Data dibaca saat Inform berikutnya. ${(e as Error).message}`, 'warn');
      }
    } catch (e) {
      flash(`Gagal menyegarkan: ${(e as Error).message}`, 'err');
    } finally {
      setConnectBusy(false);
    }
  };

  const rediscover = async () => {
    if (!id) return;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/discover`, { method: 'POST' });
      flash('Pemetaan struktur ulang diantrekan — berjalan saat Inform berikutnya.');
    } catch (e) {
      flash(`Gagal: ${(e as Error).message}`, 'err');
    }
  };

  const deleteWan = async (base: string, label: string) => {
    if (!id) return;
    if (!window.confirm(`Hapus koneksi WAN ini?\n\n${label}\n${base}\n\nPelanggan bisa terputus bila ini koneksi internet aktif.`)) return;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/config`, { method: 'POST', body: { type: 'wan-delete', target: base } });
      flash('Penghapusan WAN diantrekan.');
      void load();
    } catch (e) {
      flash(`Gagal: ${(e as Error).message}`, 'err');
    }
  };

  const toggleWan = async (base: string, enable: boolean, label: string) => {
    if (!id) return;
    if (!enable && !window.confirm(`Nonaktifkan koneksi WAN ini?\n\n${label}\n\nPelanggan terputus bila ini koneksi internet aktif.`)) return;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/config`, { method: 'POST', body: { type: 'wan-enable', target: base, enable } });
      flash(`${enable ? 'Aktifkan' : 'Nonaktifkan'} WAN diantrekan.`);
      void load();
    } catch (e) {
      flash(`Gagal: ${(e as Error).message}`, 'err');
    }
  };

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setDetail(await api<Detail>(`/api/devices/${encodeURIComponent(id)}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!id) return <div className="alert alert-warning">ID tidak diberikan.</div>;
  if (error) return <div className="alert alert-danger py-2">{error}</div>;
  if (!detail) return (
    <div className="d-flex align-items-center justify-content-center min-vh-100">
      <div className="spinner-border text-primary" role="status"><span className="visually-hidden">Memuat…</span></div>
    </div>
  );

  const params = filter
    ? detail.params.filter((p) => p.path.toLowerCase().includes(filter.toLowerCase()))
    : detail.params;

  return (
    <>
      <div className="page-head d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <h1>Detail Perangkat</h1>
          <p className="font-monospace text-muted small mb-0">{detail.device.id}</p>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-sm btn-primary" onClick={refreshNow} disabled={connectBusy}
            title="Baca ulang redaman, PPPoE, WiFi lalu panggil perangkat">
            <i className="fa-solid fa-rotate me-1" />Segarkan
          </button>
          <button className="btn btn-sm btn-outline-secondary" onClick={rediscover}
            title="Petakan ulang struktur parameter (WAN/WiFi) perangkat">
            <i className="fa-solid fa-diagram-project me-1" />Pelajari struktur
          </button>
        </div>
      </div>

      {toast && (
        <div className={`alert ${toast.kind === 'ok' ? 'alert-success' : toast.kind === 'warn' ? 'alert-warning' : 'alert-danger'} d-flex align-items-start gap-2 mb-3`} role="alert">
          <i className={`fa-solid mt-1 ${toast.kind === 'ok' ? 'fa-circle-check' : toast.kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-xmark'}`} />
          <div className="flex-grow-1">{toast.msg}</div>
          <button type="button" className="btn-close" aria-label="Tutup" onClick={() => setToast(null)} />
        </div>
      )}

      <div className="row g-3">
        <div className="col-lg-4">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Informasi</h3>
            </div>
            <div className="card-body p-0 table-responsive">
              <table className="table mb-0">
                <tbody>
                  <tr>
                    <th style={{ width: 140 }}>Status</th>
                    <td>
                      <span className={`badge ${detail.device.online ? 'badge-soft' : 'text-bg-danger'}`}>
                        {detail.device.online ? 'Online' : 'Offline'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th>Redaman</th>
                    <td>
                      <span className={`rx-badge ${rxLevel(detail.insight.optical.rx, detail.insight.optical.los)}`}>
                        {detail.insight.optical.los ? 'LOS' : `${fmtDbm(detail.insight.optical.rx)} dBm`}
                      </span>
                    </td>
                  </tr>
                  <tr><th>Vendor</th><td>{detail.device.manufacturer || '-'}</td></tr>
                  <tr><th>OUI</th><td>{detail.device.oui}</td></tr>
                  <tr><th>Produk</th><td>{detail.device.product_class}</td></tr>
                  <tr><th>Serial</th><td><span className="font-monospace">{detail.device.serial_number}</span></td></tr>
                  <tr><th>IP (terakhir)</th><td>{detail.device.ip_address ?? '-'}</td></tr>
                  <tr><th>Firmware</th><td>{detail.device.software_version ?? '-'}</td></tr>
                  <tr><th>Data model</th><td>{detail.insight.dataModel ?? '-'}</td></tr>
                  <tr><th>Uptime</th><td>{fmtUptime(detail.insight.general.uptime)}</td></tr>
                  <tr><th>Inform terakhir</th><td>{detail.device.last_inform_at ? new Date(detail.device.last_inform_at).toLocaleString('id-ID') : '-'}</td></tr>
                  <tr>
                    <th>Grup</th>
                    <td>
                      <span className={`badge ${detail.device.group_name ? 'text-bg-secondary bg-opacity-25 text-dark' : 'bg-light text-muted'}`}>
                        {detail.device.group_name || 'Tanpa grup'}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">
              <h3 className="card-title">Akses ACS → CPE</h3>
              <div className="ms-auto h-sub">
                <button className="btn btn-sm btn-primary" onClick={connectNow} disabled={connectBusy}>
                  <i className="fa-solid fa-bolt me-1" />Hubungi
                </button>
              </div>
            </div>
            <div className="card-body small">
              <div className="vstack gap-2">
                <div>
                  <label className="form-label mb-1">URL Connection Request</label>
                  <input className="form-control form-control-sm font-monospace"
                    value={crUrl} onChange={(e) => setCrUrl(e.target.value)} />
                </div>
                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label mb-1">User</label>
                    <input className="form-control form-control-sm" autoComplete="off"
                      value={crUser} onChange={(e) => setCrUser(e.target.value)} />
                  </div>
                  <div className="col-6">
                    <label className="form-label mb-1">Password</label>
                    <input className="form-control form-control-sm" type="password" autoComplete="new-password"
                      placeholder={detail.device.has_connection_request_pass ? '•••••• (tersimpan)' : 'belum diisi'}
                      value={crPass} onChange={(e) => setCrPass(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">
              <h3 className="card-title">Akses CPE → ACS (port 7547)</h3>
            </div>
            <div className="card-body small">
              <div className="row g-2">
                <div className="col-6">
                  <label className="form-label mb-1">User</label>
                  <input className="form-control form-control-sm" autoComplete="off"
                    value={cwUser} onChange={(e) => setCwUser(e.target.value)} />
                </div>
                <div className="col-6">
                  <label className="form-label mb-1">Password</label>
                  <input className="form-control form-control-sm" type="password" autoComplete="new-password"
                    placeholder={detail.device.has_cwmp_pass ? '•••••• (tersimpan)' : 'kosong = bebas'}
                    value={cwPass} onChange={(e) => setCwPass(e.target.value)} />
                </div>
              </div>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-body small">
              <div className="d-flex flex-wrap align-items-center gap-2">
                <label className="form-label mb-0">Grup</label>
                <input className="form-control form-control-sm" style={{ maxWidth: 160 }}
                  value={crGroup} onChange={(e) => setCrGroup(e.target.value)} />
                <button className="btn btn-sm btn-outline-primary" onClick={saveMeta} disabled={metaBusy}>
                  <i className="fa-solid fa-save me-1" />Simpan
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="col-lg-8">
          <div className="card h-100">
            <div className="card-header p-0 pt-2 border-bottom-0">
              <ul className="nav nav-tabs nav-tabs-scroll" role="tablist">
                {([
                  ['summary', 'Ringkasan'],
                  ['config', 'Konfigurasi'],
                  ['params', `Parameter (${detail.params.length})`],
                  ['commands', 'Perintah'],
                  ['discovered', `Dipelajari (${detail.discovered.length})`],
                  ['events', `Peristiwa (${detail.events.length})`],
                  ['tasks', `Antrean Tugas (${detail.tasks.length})`],
                ] as [Tab, string][]).map(([k, label]) => (
                  <li className="nav-item" key={k}>
                    <button
                      className={`nav-link ${tab === k ? 'active' : ''}`}
                      onClick={() => setTab(k)}
                    >{label}</button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card-body border-top">
              {tab === 'summary' && (
                <SummaryPanel insight={detail.insight} onEdit={openConfig} onDeleteWan={deleteWan} onToggleWan={toggleWan} />
              )}

              {tab === 'config' && (
                <Configurator deviceId={id} serial={detail.device.serial_number} insight={detail.insight} preset={preset} onQueued={load} />
              )}

              {tab === 'params' && (
                <>
                  <input
                    type="search" className="form-control form-control-sm mb-3"
                    placeholder="Filter path parameter…" value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <div className="table-responsive">
                    <table className="table table-sm table-hover table-param mb-0">
                      <thead><tr><th>PATH</th><th>NILAI</th><th style={{ width: 44 }}></th></tr></thead>
                      <tbody>
                        {params.map((p) => {
                          const vendor = p.path.includes('.X_');
                          return (
                            <tr key={p.path}>
                              <td className={`param-path ${vendor ? 'param-vendorext' : ''}`}>{p.path}</td>
                              <td>
                                <div className="value-text">{p.value}</div>
                                <div className="small text-muted">{p.type}</div>
                              </td>
                              <td className="text-end">
                                <button className="btn btn-sm text-secondary border-0" title="Edit nilai"
                                  onClick={() => onEditParam(p.path, p.value)}>
                                  <i className="fa-solid fa-pencil" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {tab === 'commands' && (
                <>
                <Commands
                  deviceId={id}
                  onRun={load}
                  editTarget={editTarget}
                  clearEditTarget={() => setEditTarget(null)}
                />
                </>
              )}

              {tab === 'discovered' && (
                <div className="table-responsive">
                  <table className="table table-sm table-param mb-0">
                    <thead><tr><th>PATH</th><th>AKSES</th></tr></thead>
                    <tbody>
                      {detail.discovered.map((p) => (
                        <tr key={p.path}>
                          <td className="param-path">{p.path}</td>
                          <td>
                            <span className={`badge ${p.writable ? 'badge-soft' : 'bg-light text-muted'}`}>
                              {p.writable ? 'W' : 'RO'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'events' && (
                <ul className="list-group list-group-flush">
                  {detail.events.map((e) => (
                    <li className="list-group-item" key={e.id}>
                      <div className="d-flex justify-content-between mb-1">
                        <span className={`badge ${e.kind.includes('error') ? 'text-bg-danger' : 'badge-soft'}`}>{e.kind}</span>
                        <small className="text-muted">{new Date(e.created_at).toLocaleString('id-ID')}</small>
                      </div>
                      <div className="small">{e.message}</div>
                    </li>
                  ))}
                </ul>
              )}

              {tab === 'tasks' && (
                <ul className="list-group list-group-flush">
                  {detail.tasks.map((t) => (
                    <li className="list-group-item" key={t.id}>
                      <div className="d-flex justify-content-between mb-1">
                        <span className="badge badge-soft text-uppercase">{t.kind}</span>
                        <small className="text-muted">{new Date(t.created_at).toLocaleString('id-ID')}</small>
                      </div>
                      <div className="small font-monospace text-muted mb-2">{t.payload}</div>
                      {t.status === 'done' && <div className="small text-success"><i className="fa-solid fa-check me-1" />{t.result || 'OK'}</div>}
                      {(t.status === 'failed' || t.status === 'error') && <div className="small text-danger"><i className="fa-solid fa-times me-1" />Ditolak perangkat: {t.result}</div>}
                      {t.status === 'pending' && <div className="small text-warning text-dark"><i className="fa-solid fa-clock me-1" />Menunggu Inform</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Commands({ deviceId, onRun, editTarget, clearEditTarget }: {
  deviceId: string;
  onRun: () => void;
  editTarget: { path: string; value: string } | null;
  clearEditTarget: () => void;
}) {
  const [kind, setKind] = useState('read');
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok?: boolean; error?: string; task?: string } | null>(null);

  useEffect(() => {
    if (editTarget) {
      setKind('write');
      setPaths(`${editTarget.path} = ${editTarget.value}`);
    }
  }, [editTarget]);

  const onTabChange = (k: string) => {
    setKind(k);
    if (editTarget) clearEditTarget();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setRes(null);
    try {
      if (kind === 'read') {
        const arr = paths.split('\n').map((p) => p.trim()).filter(Boolean);
        if (!arr.length) throw new Error('Path tidak boleh kosong');
        setRes(await api(`/api/devices/${encodeURIComponent(deviceId)}/read`, { method: 'POST', body: { paths: arr } }));
      } else if (kind === 'write') {
        const values: Record<string, string> = {};
        for (const line of paths.split('\n')) {
          const l = line.trim();
          if (!l || l.startsWith('#')) continue;
          const i = l.indexOf('=');
          if (i > 0) values[l.slice(0, i).trim()] = l.slice(i + 1).trim();
        }
        if (!Object.keys(values).length) throw new Error('Format salah (harus Path = Nilai)');
        setRes(await api(`/api/devices/${encodeURIComponent(deviceId)}/write`, { method: 'POST', body: { values } }));
      } else if (kind === 'addObject' || kind === 'deleteObject') {
        const obj = paths.trim();
        if (!obj) throw new Error('ObjectName tidak boleh kosong');
        const endpoint = kind === 'addObject' ? 'add-object' : 'delete-object';
        setRes(await api(`/api/devices/${encodeURIComponent(deviceId)}/${endpoint}`, { method: 'POST', body: { objectName: obj } }));
      } else if (kind === 'factory-reset') {
        const confirm = window.prompt('Reset pabrik menghapus seluruh konfigurasi ONU.\nKetik serial number perangkat untuk konfirmasi:') ?? '';
        if (!confirm) throw new Error('Dibatalkan');
        setRes(await api(`/api/devices/${encodeURIComponent(deviceId)}/${kind}`, { method: 'POST', body: { confirm: confirm.trim() } }));
      } else {
        setRes(await api(`/api/devices/${encodeURIComponent(deviceId)}/${kind}`, { method: 'POST' }));
      }
      onRun();
    } catch (err) {
      setRes({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ul className="nav nav-pills mb-3 gap-2">
        {[['read', 'Baca Parameter'], ['write', 'Tulis Parameter'], ['discover', 'Pelajari Struktur'], ['addObject', 'Tambah Objek (AddObject)'], ['deleteObject', 'Hapus Objek (DeleteObject)'], ['reboot', 'Reboot'], ['factory-reset', 'Reset Pabrik']].map(([k, label]) => (
          <li className="nav-item" key={k}>
            <button
              className={`nav-link py-1 px-3 border ${kind === k ? 'active' : 'text-dark bg-light border-0'}`}
              onClick={() => onTabChange(k)}
              style={{ borderRadius: '999px', fontSize: '.8rem' }}
            >{label}</button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        {(kind === 'read' || kind === 'write') && (
          <div className="mb-3">
            <textarea
              className="form-control font-monospace text-nowrap"
              rows={6} style={{ fontSize: '.8rem', overflowX: 'auto' }}
              value={paths} onChange={(e) => setPaths(e.target.value)}
              placeholder={
                kind === 'read'
                  ? 'InternetGatewayDevice.DeviceInfo.SoftwareVersion\nInternetGatewayDevice.WANDevice.'
                  : kind === 'write'
                    ? 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID = WiFi_Baru\nInternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable = 1'
                    : kind === 'addObject'
                      ? 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
                      : kind === 'deleteObject'
                        ? 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.'
                        : ''
              }
            />
          </div>
        )}
        {(kind === 'addObject' || kind === 'deleteObject') && (
          <div className="mb-3">
            <label className="form-label small mb-1">Object Name</label>
            <input
              className="form-control form-control-sm font-monospace"
              placeholder="InternetGatewayDevice.WANDevice.1.WANConnectionDevice."
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
            />
            <div className="form-text small mt-1">
              Tambah object baru (AddObject) akan mengembalikan InstanceNumber saat device Inform berikutnya.
            </div>
          </div>
        )}
        <button type="submit" className={`btn ${kind.includes('reset') || kind === 'reboot' ? 'btn-outline-danger' : 'btn-primary'}`} disabled={busy}>
          {busy ? 'Mengantrekan…' : 'Antrekan Tugas'}
        </button>
      </form>
      {res?.task && <div className="alert alert-success mt-3 py-2 small">Tugas diantrekan (ID: <code>{res.task}</code>) — akan dijalankan saat perangkat Inform berikutnya.</div>}
      {res?.error && <div className="alert alert-danger mt-3 py-2 small">{res.error}</div>}
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * Ringkasan: redaman, koneksi WAN, dan WiFi dari `insight` server.
 *
 * Insight dihitung server dari parameter berbasis POLA (bukan nomor
 * instans tetap), sehingga PPPoE di WANConnectionDevice.2/.3 dan redaman
 * di subtree vendor mana pun (ZTE/Huawei/FiberHome/Nokia/TR-181) tampil
 * tanpa konfigurasi per model.
 * ------------------------------------------------------------------ */

function Tile({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="stat-tile h-100">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

function statusBadge(s: string | null) {
  if (!s) return <span className="text-muted">—</span>;
  const ok = /^(connected|up)$/i.test(s);
  return <span className={`badge ${ok ? 'text-bg-success' : 'text-bg-warning'}`}>{s}</span>;
}

function SummaryPanel({ insight, onEdit, onDeleteWan, onToggleWan }: {
  insight: DeviceInsight;
  onEdit: (p: Omit<ConfigPreset, 'nonce'>) => void;
  onDeleteWan: (base: string, label: string) => void;
  onToggleWan: (base: string, enable: boolean, label: string) => void;
}) {
  const o = insight.optical;
  const lvl = rxLevel(o.rx, o.los);
  const g = insight.general;

  return (
    <>
      <h4 className="small text-uppercase text-muted fw-semibold mb-2">
        <i className="fa-solid fa-wave-square me-2" />Redaman optik
      </h4>
      <div className="row g-2 mb-1">
        <div className="col-6 col-md-3">
          <div className="stat-tile h-100">
            <div className="k">RX (dBm)</div>
            <div className="v"><span className={`rx-badge ${lvl}`} style={{ fontSize: '1rem' }}>
              {o.los ? 'LOS' : fmtDbm(o.rx)}
            </span></div>
            <div className="small text-muted">{RX_LABEL[lvl]}</div>
          </div>
        </div>
        <div className="col-6 col-md-3"><Tile k="TX (dBm)" v={fmtDbm(o.tx)} /></div>
        <div className="col-6 col-md-2"><Tile k="Suhu (°C)" v={o.temperature === null ? '—' : String(o.temperature)} /></div>
        <div className="col-6 col-md-2"><Tile k="Tegangan (V)" v={o.voltage === null ? '—' : String(o.voltage)} /></div>
        <div className="col-6 col-md-2"><Tile k="Bias (mA)" v={o.bias === null ? '—' : String(o.bias)} /></div>
      </div>
      <div className="small text-muted mb-3">
        {o.source
          ? <>Sumber: <code>{o.source}</code>{o.raw.rx !== null && <> (nilai mentah {o.raw.rx})</>}</>
          : 'Redaman belum terbaca. Tekan Segarkan; bila tetap kosong, cek tab Peristiwa untuk path yang ditolak perangkat.'}
        {g.ponStatus && <> · Status PON: <b>{g.ponStatus}</b></>}
      </div>

      <div className="d-flex align-items-center mb-2">
        <h4 className="small text-uppercase text-muted fw-semibold mb-0">
          <i className="fa-solid fa-network-wired me-2" />Koneksi WAN ({insight.wan.length})
        </h4>
        <button className="btn btn-sm btn-outline-primary ms-auto" onClick={() => onEdit({ mode: 'wan-add' })}>
          <i className="fa-solid fa-plus me-1" />WAN Internet
        </button>
      </div>
      <div className="table-responsive mb-3">
        <table className="table table-sm table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>Koneksi</th><th>Username</th><th>Status</th><th>IP</th><th>VLAN / Service</th>
            </tr>
          </thead>
          <tbody>
            {insight.wan.length === 0 && (
              <tr><td colSpan={5} className="text-center text-muted py-3">
                Belum ada koneksi WAN terdeteksi — tekan <b>Pelajari struktur</b> lalu <b>Segarkan</b>.
              </td></tr>
            )}
            {insight.wan.map((c) => {
              const on = /^(1|true)$/i.test(c.enable ?? '');
              return (
                <tr key={c.base}>
                  <td>
                    <span className={`badge ${c.kind === 'ppp' ? 'text-bg-primary' : 'text-bg-secondary'} me-1`}>
                      {c.kind === 'ppp' ? 'PPPoE' : 'IP'}
                    </span>
                    <span className="small">{c.name || '—'}</span>
                    <div className="small text-muted font-monospace">
                      {c.wcd !== null ? `WCD ${c.wcd} · #${c.instance}` : `#${c.instance}`}
                      {c.connectionType ? ` · ${c.connectionType}` : ''}
                    </div>
                    <div className="btn-group btn-group-sm mt-1">
                      {c.enable !== null && (
                        <button className={`btn ${on ? 'btn-outline-success' : 'btn-outline-secondary'}`}
                          title={on ? 'Aktif — klik untuk menonaktifkan' : 'Nonaktif — klik untuk mengaktifkan'}
                          onClick={() => onToggleWan(c.base, !on, wanLabel(c))}>
                          <i className={`fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}`} />
                        </button>
                      )}
                      <button className="btn btn-outline-primary" title="Isi / konfigurasi ulang WAN ini (PPPoE/IPoE, VLAN, binding)"
                        onClick={() => onEdit({ mode: 'wan-add', target: c.base })}>
                        <i className="fa-solid fa-sliders" />
                      </button>
                      <button className="btn btn-outline-secondary" title="Ubah PPPoE / VLAN cepat"
                        onClick={() => onEdit({ mode: c.kind === 'ppp' ? 'pppoe' : 'vlan', target: c.base })}>
                        <i className="fa-solid fa-pen" />
                      </button>
                      <button className="btn btn-outline-danger" title="Hapus koneksi"
                        onClick={() => onDeleteWan(c.base, wanLabel(c))}>
                        <i className="fa-solid fa-trash" />
                      </button>
                    </div>
                  </td>
                  <td className="small font-monospace">{c.username || '—'}</td>
                  <td>
                    {statusBadge(c.status)}
                    {(() => {
                      const err = connectionError(c.status, c.lastError);
                      return err && <div className="small text-danger" title={err.code}>{err.text}</div>;
                    })()}
                  </td>
                  <td className="small font-monospace">{c.externalIp || '—'}</td>
                  <td className="small">
                    <div className="num">{c.vlan && c.vlan !== '0' ? c.vlan : '—'}</div>
                    <div className="text-muted">{c.serviceList || ''}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h4 className="small text-uppercase text-muted fw-semibold mb-2">
        <i className="fa-solid fa-wifi me-2" />WiFi ({insight.wlan.length})
      </h4>
      <div className="table-responsive mb-3">
        <table className="table table-sm table-hover align-middle mb-0">
          <thead>
            <tr><th>#</th><th>Band</th><th>SSID</th><th>Aktif</th><th>Keamanan</th><th>Kanal</th><th>Klien</th><th style={{ width: 60 }}></th></tr>
          </thead>
          <tbody>
            {insight.wlan.length === 0 && (
              <tr><td colSpan={8} className="text-center text-muted py-3">Belum ada data WiFi.</td></tr>
            )}
            {insight.wlan.map((w) => (
              <tr key={w.base}>
                <td className="num">{w.index}</td>
                <td className="small">{w.band ?? '—'}</td>
                <td className="fw-semibold">{w.ssid || '—'}</td>
                <td>{w.enable === null ? '—' : /^(1|true)$/i.test(w.enable)
                  ? <span className="badge text-bg-success">ya</span>
                  : <span className="badge text-bg-secondary">tidak</span>}</td>
                <td className="small">{w.security ?? '—'}</td>
                <td className="small num">{w.channel ?? '—'}</td>
                <td className="small num">{w.clients ?? '—'}</td>
                <td className="text-end">
                  <button className="btn btn-sm btn-outline-secondary" title="Ganti SSID / sandi"
                    onClick={() => onEdit({ mode: 'wifi', wlanIndex: w.index })}>
                    <i className="fa-solid fa-pen" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="small text-uppercase text-muted fw-semibold mb-2">
        <i className="fa-solid fa-circle-info me-2" />Perangkat
      </h4>
      <div className="row g-2">
        <div className="col-6 col-md-3"><Tile k="Model" v={g.model ?? '—'} /></div>
        <div className="col-6 col-md-3"><Tile k="Uptime" v={fmtUptime(g.uptime)} /></div>
        <div className="col-6 col-md-3"><Tile k="IP LAN" v={g.lanIp ?? '—'} /></div>
        <div className="col-6 col-md-3"><Tile k="Host LAN" v={g.hosts ?? '—'} /></div>
      </div>
    </>
  );
}
