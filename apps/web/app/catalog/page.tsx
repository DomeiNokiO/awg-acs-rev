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
import { api, type CatalogSummary, type CatalogModel, type CatalogParam } from '@/lib/api';

type Tab = 'search' | 'tr098' | 'tr181' | 'models';

const GROUP_LABEL: Record<string, string> = {
  device_info: 'Device Info', wan: 'WAN', lan: 'LAN', wifi: 'Wi-Fi',
  pppoe: 'PPPoE', optical: 'Optical / PON', voip: 'VoIP', system: 'Sistem',
  security: 'Keamanan', diagnostic: 'Diagnostik', other: 'Lainnya',
};

export default function CatalogPage() {
  return <Shell><CatalogBody /></Shell>;
}

function CatalogBody() {
  const [cat, setCat] = useState<CatalogSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('search');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{
    path: string; label: string; type: string; source: string; model?: string;
  }[]>([]);
  const [modelDetail, setModelDetail] = useState<CatalogModel | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const reload = () => {
    api<CatalogSummary>('/api/catalog')
      .then(setCat)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      api<{ items: typeof results }>(`/api/catalog/search?q=${encodeURIComponent(q)}`)
        .then((r) => setResults(r.items))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const std098 = cat?.standard?.['TR-098'] ?? [];
  const std181 = cat?.standard?.['TR-181'] ?? [];

  /* Kumpulan lengkap, sudah dedupe.
     Path yang sama sering muncul di daftar standard DAN di beberapa model
     (mis. InternetGatewayDevice.DeviceInfo.SoftwareVersion ada di TR-098,
     TR-181, dan hampir tiap model). Menumpuknya mentah membuat tabel penuh
     baris kembar, jadi kunci berdasarkan path: entri pertama menang, lalu
     model berikutnya disimpan sebagai atribut sehingga pengguna tetap tahu
     perangkat mana yang mendukung path itu. */
  const merged = (() => {
    const byPath = new Map<string, CatalogParam & { models: string[] }>();
    const put = (p: CatalogParam, model?: string) => {
      const cur = byPath.get(p.path);
      if (cur) {
        if (model && !cur.models.includes(model)) cur.models.push(model);
        return;
      }
      byPath.set(p.path, { ...p, models: model ? [model] : [] });
    };
    for (const p of std098) put(p);
    for (const p of std181) put(p);
    for (const m of cat?.models ?? []) for (const p of m.params ?? []) put(p, m.id);
    return [...byPath.values()];
  })();

  // Semua param vendor (per model), disatukan untuk tampilan "kumpulan lengkap".
  const vendorAll = (cat?.models ?? []).flatMap((m) =>
    (m.params ?? []).map((p) => ({ ...p, model: m.id })),
  );
  const vendorCount = vendorAll.length;

  if (err) return <div className="alert alert-danger">Katalog gagal dimuat: {err}</div>;
  if (!cat) return <div className="text-muted py-4">Memuat…</div>;

  if (modelDetail) {
    return (
      <>
        <button className="btn btn-sm btn-outline-secondary mb-3"
          onClick={() => setModelDetail(null)}>
          ← Kembali ke katalog
        </button>
        <ModelDetail model={modelDetail} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Katalog Parameter</h1>
          <p className="text-muted small mb-0">v{cat.version} · {cat.generatedAt}</p>
        </div>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <button className="btn btn-outline-secondary btn-sm" onClick={() => document.getElementById('file-upload')?.click()}>
            <i className="fa-solid fa-upload me-1" />Impor
          </button>
        </div>
      </div>

      {/* Statistik — kartu tertata seperti webhook */}
      <div className="d-flex flex-wrap gap-3 mb-3">
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0 stat-card"><div className="card-body py-3 d-flex align-items-center gap-3">
            <div className="stat-icon bg-primary-soft"><i className="fa-solid fa-layer-group" /></div>
            <div>
              <div className="stat-label">TR-098</div>
              <div className="stat-value">{cat.counts.tr098}</div>
            </div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0 stat-card"><div className="card-body py-3 d-flex align-items-center gap-3">
            <div className="stat-icon bg-info-soft"><i className="fa-solid fa-diagram-project" /></div>
            <div>
              <div className="stat-label">TR-181</div>
              <div className="stat-value">{cat.counts.tr181}</div>
            </div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0 stat-card"><div className="card-body py-3 d-flex align-items-center gap-3">
            <div className="stat-icon bg-success-soft"><i className="fa-solid fa-server" /></div>
            <div>
              <div className="stat-label">Model</div>
              <div className="stat-value">{cat.counts.models}</div>
            </div>
          </div></div>
        </div>
        <div className="flex-fill" style={{ minWidth: '140px' }}>
          <div className="card mb-0 stat-card"><div className="card-body py-3 d-flex align-items-center gap-3">
            <div className="stat-icon bg-warning-soft"><i className="fa-solid fa-microchip" /></div>
            <div>
              <div className="stat-label">Param Vendor</div>
              <div className="stat-value">{cat.counts.params}</div>
            </div>
          </div></div>
        </div>
      </div>

      <div className="alert alert-info small py-2">
        Katalog ini perkiraan berdasarkan riset. Vendor boleh menambah node sendiri
        (<code>X_ZTE-COM_*</code>, <code>X_HW_*</code>, <code>X_CT-COM_*</code>, dst).
        Untuk kebenaran pasti atas suatu perangkat, jalankan
        <b> Petakan struktur</b> di halaman perangkat — jalurnya dibaca langsung dari perangkat.
      </div>

      <ul className="nav nav-tabs nav-tabs-scroll mb-3">
        {([
          ['search', 'Pencarian'],
          ['tr098', `TR-098 (${std098.length})`],
          ['tr181', `TR-181 (${std181.length})`],
          ['models', `Per Model (${cat.models.length})`],
        ] as [Tab, string][]).map(([k, label]) => (
          <li className="nav-item" key={k}>
            <button className={`nav-link ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {label}
            </button>
          </li>
        ))}
      </ul>

      {tab === 'search' && (
        <>
          <input
            type="search" className="form-control mb-3"
            placeholder="Cari path atau label — mis. SSID, optical, VLAN, PPPoE…"
            value={q} onChange={(e) => setQ(e.target.value)}
          />
          {q && results.length === 0 && (
            <p className="text-muted">Tidak ada hasil untuk “{q}”.</p>
          )}

          {q ? (
            <ParamTable
              items={results.map((r) => ({
                path: r.path, label: r.label, type: r.type,
                access: '', group: '', source: r.source,
              }))}
              showModel
              modelOf={(i) => results.find((r) => r.path === i.path)?.model}
            />
          ) : (
            /* Kueri kosong: tampilkan SEMUA parameter (standard + vendor)
               sebagai satu kumpulan lengkap. Sebelumnya tabel dibiarkan
               kosong tanpa pesan sehingga terlihat seperti rusak. */
            <>
              <p className="text-muted small mb-2">
                Menampilkan seluruh kumpulan parameter — {merged.length} path unik
                (dari {std098.length + std181.length + vendorCount} entri, path kembar
                digabung). Kolom Model menandai perangkat mana yang mendukungnya.
                Ketik untuk menyaring.
              </p>
              <ParamTable
                items={merged}
                showModel
                modelOf={(i) => {
                  const models = (i as CatalogParam & { models?: string[] }).models;
                  if (models?.length) return models.join(', ');
                  // Path standard tanpa model: jangan biarkan sel kosong
                  // tanpa keterangan, pengguna perlu tahu itu berasal dari
                  // spesifikasi, bukan dari daftar perangkat tertentu.
                  return i.source || 'Standard';
                }}
              />
            </>
          )}
        </>
      )}

      {tab === 'tr098' && <ParamTable items={std098} grouped />}
      {tab === 'tr181' && <ParamTable items={std181} grouped />}

      {tab === 'models' && (
        <div className="row">
          {cat.models.map((m) => (
            <div className="col-md-6 col-xl-4 mb-3" key={m.id}>
              <div className="card h-100">
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-start">
                    <div>
                      <h5 className="mb-1">{m.productClass}</h5>
                      <div className="text-muted small">{m.vendor} · {m.dataModel}</div>
                    </div>
                    <span className="badge bg-light text-dark border">{m.paramCount} param</span>
                  </div>
                  {m.notes && <p className="small text-muted mt-2 mb-2">{m.notes}</p>}
                  <button className="btn btn-sm btn-outline-primary"
                    onClick={async () =>
                      setModelDetail(await api<CatalogModel>(`/api/catalog/models/${m.id}`))}>
                    Lihat parameter
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={reload} />}
    </>
  );
}

function ModelDetail({ model }: { model: CatalogModel }) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title mb-1">{model.productClass}</h3>
        <div className="text-muted small">
          {model.vendor} · {model.dataModel} · {model.params.length} parameter vendor
        </div>
      </div>
      <div className="card-body">
        {model.notes && <p className="small">{model.notes}</p>}
        <ParamTable items={model.params} grouped />
      </div>
    </div>
  );
}

function ParamTable({ items, grouped, showModel, modelOf }: {
  items: CatalogParam[];
  grouped?: boolean;
  showModel?: boolean;
  modelOf?: (i: CatalogParam) => string | undefined;
}) {
  const groups = useMemo(() => {
    if (!grouped) return null;
    const m = new Map<string, CatalogParam[]>();
    for (const p of items) {
      const g = p.group || 'other';
      const list = m.get(g) ?? [];
      list.push(p);
      m.set(g, list);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items, grouped]);

  if (!items.length) return null;

  if (groups) {
    return (
      <div className="vstack gap-3">
        {groups.map(([g, list]) => (
          <div key={g} className="card">
            <div className="card-header py-2">
              <h4 className="h6 mb-0">
                {GROUP_LABEL[g] ?? g}
                <span className="text-muted ms-2 fw-normal">{list.length}</span>
              </h4>
            </div>
            <div className="card-body p-0 table-responsive">
              <table className="table table-sm table-param mb-0">
                <thead className="table-light">
                  <tr><th>Path</th><th>Label</th><th style={{ width: 130 }}>Tipe</th><th style={{ width: 90 }}>Akses</th></tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.path} className={p.vendorExt ? 'param-vendorext' : ''}>
                      <td className="param-path">{p.path}</td>
                      <td className="small">{p.label}</td>
                      <td className="small text-muted">{p.type.replace('xsd:', '')}</td>
                      <td className="small">{p.access}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm table-param">
        <thead className="table-light">
          <tr>
            <th>Path</th><th>Label</th><th style={{ width: 130 }}>Tipe</th>
            {showModel && <th style={{ width: 130 }}>Model</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((p, i) => (
            <tr key={`${p.path}-${i}`} className={p.vendorExt ? 'param-vendorext' : ''}>
              <td className="param-path">{p.path}</td>
              <td className="small">{p.label}</td>
              <td className="small text-muted">{p.type.replace('xsd:', '')}</td>
              {showModel && <td className="small">{modelOf?.(p) ?? p.source}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
