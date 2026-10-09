'use client';

/**
 * Katalog Parameter — "kumpulan parameter all modem".
 *
 * Tiga sumber digabung jadi satu tampilan:
 *  1. Standard TR-098 / TR-181 (path yang dijamin ada di hampir semua CPE)
 *  2. Path vendor per model (X_ZTE-COM_, X_HW_, X_CT-COM_, dst.)
 *  3. Parameter yang benar-benar dipelajari dari perangkat di jaringan Anda
 *     (tab "Dipelajari" di halaman perangkat) — sumber kebenaran tertinggi
 *
 * Prinsipnya: katalog statis adalah perkiraan, bukan kebenaran. Vendor
 * bebas menambah node ekstensi sendiri, jadi jalur paling andal adalah
 * membaca struktur dari perangkatnya sendiri lalu menyimpannya.
 */
import { useEffect, useMemo, useState, useRef } from 'react';
import Shell from '@/components/Shell';
import { api, type CatalogSummary, type CatalogParam } from '@/lib/api';

const GROUP_LABEL: Record<string, string> = {
  device_info: 'Device Info', wan: 'WAN', lan: 'LAN', wifi: 'Wi-Fi', wlan: 'WLAN', ssid: 'SSID',
  pppoe: 'PPPoE', ppp: 'PPP', optical: 'Optik / PON', pon: 'PON', voip: 'VoIP', system: 'Sistem',
  security: 'Keamanan', diagnostic: 'Diagnostik', other: 'Lainnya', nat: 'NAT', vlan: 'VLAN',
  management_server: 'Management Server', time: 'Waktu', dns: 'DNS', ip: 'IP', service: 'Layanan',
  ethernet: 'Ethernet', qos: 'QoS', tr069: 'TR-069', download: 'Download', dhcp: 'DHCP',
  layer3_forwarding: 'Routing', firewall: 'Firewall', port_mapping: 'Port Mapping',
};
const groupLabel = (g: string): string =>
  GROUP_LABEL[g] ?? g.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function CatalogPage() {
  return <Shell><CatalogBody /></Shell>;
}

/** Satu baris katalog: path unik + model yang mendukungnya. */
type Row = CatalogParam & { models: string[]; std: string | null };

/** Sumber yang dipilih di panel kiri. */
type Source = { kind: 'all' } | { kind: 'std'; dm: 'TR-098' | 'TR-181' } | { kind: 'model'; id: string };

const PAGE = 50;

function CatalogBody() {
  const [cat, setCat] = useState<CatalogSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [src, setSrc] = useState<Source>({ kind: 'all' });
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [vendorOnly, setVendorOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);

  const reload = () => {
    api<CatalogSummary>('/api/catalog').then(setCat).catch((e) => setErr((e as Error).message));
  };
  useEffect(reload, []);

  /* Path yang sama muncul di standar DAN di banyak model; satu baris per
     path, model pendukung disimpan sebagai atribut (kolom Dukungan). */
  const rows = useMemo<Row[]>(() => {
    if (!cat) return [];
    const by = new Map<string, Row>();
    const put = (p: CatalogParam, model: string | null, std: string | null) => {
      const cur = by.get(p.path);
      if (cur) {
        if (model && !cur.models.includes(model)) cur.models.push(model);
        if (std && !cur.std) cur.std = std;
        return;
      }
      by.set(p.path, { ...p, vendorExt: p.vendorExt ?? /\.X_[^.]+/.test(p.path), models: model ? [model] : [], std });
    };
    for (const p of cat.standard?.['TR-098'] ?? []) put(p, null, 'TR-098');
    for (const p of cat.standard?.['TR-181'] ?? []) put(p, null, 'TR-181');
    for (const m of cat.models) for (const p of m.params ?? []) put(p as CatalogParam, m.id, null);
    return [...by.values()];
  }, [cat]);

  const modelName = useMemo(() => new Map((cat?.models ?? []).map((m) => [m.id, m.productClass])), [cat]);

  // Baris sesuai sumber terpilih (sebelum filter teks/grup).
  const scoped = useMemo(() => rows.filter((r) => {
    if (src.kind === 'std') return r.std === src.dm;
    if (src.kind === 'model') return r.models.includes(src.id);
    return true;
  }), [rows, src]);

  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of scoped) m.set(r.group || 'other', (m.get(r.group || 'other') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return scoped.filter((r) => (!group || (r.group || 'other') === group)
      && (!vendorOnly || r.vendorExt)
      && (!t || r.path.toLowerCase().includes(t) || r.label.toLowerCase().includes(t)));
  }, [scoped, q, group, vendorOnly]);

  useEffect(() => setPage(0), [src, q, group, vendorOnly]);
  useEffect(() => { if (group && !groups.some(([g]) => g === group)) setGroup(''); }, [groups, group]);

  if (err) return <div className="alert alert-danger">Katalog gagal dimuat: {err}</div>;
  if (!cat) return <div className="text-muted py-4">Memuat…</div>;

  const model = src.kind === 'model' ? cat.models.find((m) => m.id === src.id) ?? null : null;
  const srcKey = src.kind === 'all' ? 'all' : src.kind === 'std' ? `std:${src.dm}` : `model:${src.id}`;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const slice = shown.slice(page * PAGE, page * PAGE + PAGE);
  const sources: { key: string; label: string; sub: string; n: number; src: Source }[] = [
    { key: 'all', label: 'Semua parameter', sub: 'standar + vendor', n: rows.length, src: { kind: 'all' } },
    { key: 'std:TR-098', label: 'Standar TR-098', sub: 'InternetGatewayDevice.', n: rows.filter((r) => r.std === 'TR-098').length, src: { kind: 'std', dm: 'TR-098' } },
    { key: 'std:TR-181', label: 'Standar TR-181', sub: 'Device.', n: rows.filter((r) => r.std === 'TR-181').length, src: { kind: 'std', dm: 'TR-181' } },
  ];
  const models = [...cat.models].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.productClass.localeCompare(b.productClass));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Katalog Parameter</h1>
          <p>{rows.length} path unik · {cat.counts.models} model · katalog v{cat.version} ({cat.generatedAt})</p>
        </div>
        <button className="btn btn-outline-secondary btn-sm" onClick={() => setImportOpen(true)}>
          <i className="fa-solid fa-upload me-1" />Impor katalog
        </button>
      </div>

      <div className="row g-3">
        {/* Sumber: standar & model */}
        <div className="col-lg-3">
          <select className="form-select form-select-sm d-lg-none" value={srcKey}
            onChange={(e) => setSrc([...sources, ...models.map((m) => ({ key: `model:${m.id}`, src: { kind: 'model', id: m.id } as Source }))]
              .find((x) => x.key === e.target.value)!.src)}>
            {sources.map((x) => <option key={x.key} value={x.key}>{x.label} ({x.n})</option>)}
            {models.map((m) => <option key={m.id} value={`model:${m.id}`}>{m.vendor} {m.productClass || m.id} ({m.paramCount})</option>)}
          </select>
          <div className="card catalog-sources d-none d-lg-block">
            <div className="card-header">Sumber</div>
            <div className="list-group list-group-flush">
              {sources.map((x) => (
                <button key={x.key} type="button" onClick={() => setSrc(x.src)}
                  className={`list-group-item list-group-item-action ${srcKey === x.key ? 'active' : ''}`}>
                  <span className="d-flex justify-content-between align-items-center gap-2">
                    <span className="fw-semibold">{x.label}</span><span className="num small">{x.n}</span>
                  </span>
                  <span className="d-block small sub">{x.sub}</span>
                </button>
              ))}
              <div className="list-group-item catalog-sources-label">Model ({models.length})</div>
              {models.map((m) => (
                <button key={m.id} type="button" onClick={() => setSrc({ kind: 'model', id: m.id })}
                  className={`list-group-item list-group-item-action ${srcKey === `model:${m.id}` ? 'active' : ''}`}>
                  <span className="d-flex justify-content-between align-items-center gap-2">
                    <span className="fw-semibold text-truncate">{m.productClass || m.id}</span><span className="num small">{m.paramCount}</span>
                  </span>
                  <span className="d-block small sub">{m.vendor} · {m.dataModel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Daftar parameter */}
        <div className="col-lg-9">
          <div className="card">
            <div className="card-header">
              <span>{model ? `${model.vendor} ${model.productClass || model.id}` : sources.find((x) => x.key === srcKey)?.label}</span>
              <span className="h-sub">{shown.length === scoped.length ? `${scoped.length} path` : `${shown.length} dari ${scoped.length} path`}</span>
              {model && <span className="badge text-bg-light border ms-auto">{model.dataModel}</span>}
            </div>
            <div className="card-body py-3">
              {model?.notes && <p className="small text-muted mb-3">{model.notes}</p>}
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <input type="search" className="form-control form-control-sm flex-grow-1" style={{ minWidth: 220, maxWidth: 420 }}
                  placeholder="Cari path atau label — SSID, RXPower, VLAN…" value={q} onChange={(e) => setQ(e.target.value)} />
                <select className="form-select form-select-sm" style={{ width: 'auto' }} value={group}
                  onChange={(e) => setGroup(e.target.value)} aria-label="Grup parameter">
                  <option value="">Semua grup ({scoped.length})</option>
                  {groups.map(([g, n]) => <option key={g} value={g}>{groupLabel(g)} ({n})</option>)}
                </select>
                <div className="form-check form-switch mb-0">
                  <input className="form-check-input" type="checkbox" id="cat-vendor" checked={vendorOnly}
                    onChange={(e) => setVendorOnly(e.target.checked)} />
                  <label className="form-check-label small" htmlFor="cat-vendor">Hanya ekstensi vendor (X_…)</label>
                </div>
              </div>
            </div>
            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0 table-catalog">
                <thead className="table-light">
                  <tr>
                    <th>Parameter</th>
                    <th style={{ width: 90 }}>Tipe</th>
                    <th style={{ width: 70 }}>Akses</th>
                    {src.kind !== 'model' && <th style={{ width: 120 }}>Dukungan</th>}
                  </tr>
                </thead>
                <tbody>
                  {slice.length === 0 && (
                    <tr><td colSpan={4} className="text-center text-muted py-4">
                      {q ? <>Tidak ada parameter yang cocok dengan “{q}”.</> : 'Tidak ada parameter di sumber ini.'}
                    </td></tr>
                  )}
                  {slice.map((r) => (
                    <tr key={r.path}>
                      <td>
                        <PathCell path={r.path} vendorExt={!!r.vendorExt} />
                        <div className="small text-muted">{r.label}{r.unit ? ` (${r.unit})` : ''}</div>
                      </td>
                      <td><span className="badge text-bg-light border fw-normal">{(r.type || '').replace('xsd:', '') || '—'}</span></td>
                      <td><AccessBadge access={r.access} /></td>
                      {src.kind !== 'model' && (
                        <td className="small">
                          {r.std && <span className="badge text-bg-light border fw-normal me-1">{r.std}</span>}
                          {r.models.length > 0 && (
                            <span className="badge text-bg-primary fw-normal" title={r.models.map((m) => modelName.get(m) ?? m).join(', ')}>
                              {r.models.length} model
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length > PAGE && (
              <div className="card-footer d-flex align-items-center gap-2 small">
                <span className="text-muted">{page * PAGE + 1}–{Math.min(shown.length, (page + 1) * PAGE)} dari {shown.length}</span>
                <div className="btn-group btn-group-sm ms-auto">
                  <button className="btn btn-outline-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    <i className="fa-solid fa-chevron-left" />
                  </button>
                  <button className="btn btn-outline-secondary" disabled>{page + 1} / {pages}</button>
                  <button className="btn btn-outline-secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                    <i className="fa-solid fa-chevron-right" />
                  </button>
                </div>
              </div>
            )}
          </div>
          <p className="small text-muted mt-2 mb-0">
            Katalog ini rujukan, bukan jaminan: vendor bebas menambah node sendiri (<code>X_ZTE-COM_*</code>, <code>X_HW_*</code>,
            <code> X_FH_*</code>…). Struktur pasti suatu ONU ada di tab <b>Dipelajari</b> halaman perangkat (tombol <b>Pelajari struktur</b>).
          </p>
        </div>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={reload} />}
    </>
  );
}

/** Path dengan induk diredam dan nama leaf ditebalkan; tombol salin. */
function PathCell({ path, vendorExt }: { path: string; vendorExt: boolean }) {
  const [copied, setCopied] = useState(false);
  const i = path.lastIndexOf('.', path.length - 2);
  const parent = path.slice(0, i + 1);
  const leaf = path.slice(i + 1);
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* izin ditolak */ }
  };
  return (
    <div className="catalog-path">
      {/* <wbr> setelah tiap titik: path panjang patah di batas segmen, bukan di tengah kata. */}
      <span className="pfx">{parent.split('.').filter(Boolean).map((seg, k) => <span key={k}>{seg}.<wbr /></span>)}</span>
      <span className="leaf">{leaf}</span>
      {vendorExt && <span className="badge text-bg-warning ms-1 align-middle">vendor</span>}
      <button type="button" className="btn btn-link btn-sm p-0 ms-1 copy" title="Salin path" onClick={() => void copy()}>
        <i className={`fa-solid ${copied ? 'fa-check text-success' : 'fa-copy'}`} />
      </button>
    </div>
  );
}

function AccessBadge({ access }: { access: string }) {
  const a = (access || '').toUpperCase();
  if (!a) return <span className="text-muted">—</span>;
  const rw = /W/.test(a);
  return <span className={`badge fw-normal ${rw ? 'text-bg-success' : 'text-bg-light border'}`} title={rw ? 'Bisa dibaca & ditulis' : 'Hanya baca'}>{rw ? 'RW' : 'R'}</span>;
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [jsonStr, setJsonStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{
    ok?: boolean; error?: string; fatal?: string[]; warnings?: string[];
    counts?: { tr098: number; tr181: number; models: number; params: number };
    dropped?: number; target?: string;
  } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result) setJsonStr(ev.target.result as string);
    };
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!jsonStr.trim()) return;
    setBusy(true); setRes(null);
    try {
      let catalog = null;
      try { catalog = JSON.parse(jsonStr); } catch { throw new Error('Format JSON tidak valid.'); }
      
      const out = await api<typeof res>('/api/catalog/import', { method: 'POST', body: { catalog } });
      setRes(out);
      if (out?.ok) onDone();
    } catch (e) {
      setRes({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop show" style={{ zIndex: 1040 }} onClick={onClose} />
      <div className="modal show d-block" style={{ zIndex: 1050 }} tabIndex={-1}>
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">Impor Katalog</h5>
              <button type="button" className="btn-close" onClick={onClose} />
            </div>
            <div className="modal-body">
              {!res?.ok ? (
                <>
                  <div className="alert alert-warning small">
                    <b>Perhatian:</b> Impor akan MENIMPA seluruh katalog yang ada saat ini.
                    Katalog sebelumnya akan dicadangkan dengan ekstensi <code>.bak</code> di server.
                  </div>
                  
                  {res?.error && (
                    <div className="alert alert-danger small mb-3">
                      Gagal: {res.error}
                      {res.fatal && res.fatal.length > 0 && (
                        <ul className="mb-0 mt-2">
                          {res.fatal.map((f, i) => <li key={i}>{f}</li>)}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className="mb-2 d-flex justify-content-between align-items-end">
                    <label className="form-label small mb-0">Tempel JSON Katalog</label>
                    <button type="button" className="btn btn-sm btn-outline-secondary py-0" onClick={() => fileRef.current?.click()}>
                      Pilih File
                    </button>
                    <input type="file" ref={fileRef} className="d-none" accept=".json,application/json" onChange={handleFile} />
                  </div>
                  <textarea
                    className="form-control text-monospace small"
                    rows={12}
                    value={jsonStr}
                    onChange={(e) => setJsonStr(e.target.value)}
                    placeholder='{ "version": "...", "standard": { ... }, "models": [ ... ] }'
                  />
                </>
              ) : (
                <>
                  <div className="alert alert-success small">
                    Katalog berhasil diimpor dan disimpan ke <code>{res.target}</code>.
                  </div>
                  <div className="row text-center mb-3">
                    <div className="col-3 border-end">
                      <div className="h4 mb-0">{res.counts?.tr098}</div>
                      <div className="small text-muted">TR-098</div>
                    </div>
                    <div className="col-3 border-end">
                      <div className="h4 mb-0">{res.counts?.tr181}</div>
                      <div className="small text-muted">TR-181</div>
                    </div>
                    <div className="col-3 border-end">
                      <div className="h4 mb-0">{res.counts?.models}</div>
                      <div className="small text-muted">Model</div>
                    </div>
                    <div className="col-3">
                      <div className="h4 mb-0">{res.counts?.params}</div>
                      <div className="small text-muted">Param</div>
                    </div>
                  </div>
                  
                  {res.dropped ? (
                    <div className="text-warning small mb-2">
                      <i className="fa-solid fa-exclamation-triangle me-1" />
                      Dibuang {res.dropped} entri karena tidak sesuai struktur.
                    </div>
                  ) : null}

                  {res.warnings && res.warnings.length > 0 && (
                    <div className="alert alert-light border small">
                      <b>Peringatan:</b>
                      <ul className="mb-0 ps-3 mt-1">
                        {res.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
                        {res.warnings.length > 20 && <li>... dan {res.warnings.length - 20} lainnya</li>}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              {!res?.ok ? (
                <>
                  <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Batal</button>
                  <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !jsonStr.trim()}>
                    {busy ? 'Mengirim...' : 'Kirim'}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-primary" onClick={onClose}>Tutup</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
