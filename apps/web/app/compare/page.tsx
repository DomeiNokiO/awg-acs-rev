'use client';

/**
 * Bandingkan dua katalog parameter.
 *
 * Dua kolom input:
 *  - Kolom A: "Katalog aktif" (GET /api/catalog, sudah termuat di klien)
 *    ATAU JSON katalog yang ditempel.
 *  - Kolom B: JSON katalog lain — tempel atau pilih berkas .json.
 *
 * Keduanya di-parse di klien SEBELUM dikirim (JSON tidak valid = tombol
 * tidak jalan, pesan error tampil), lalu dikirim apa adanya ke
 * POST /api/catalog/compare sebagai { a, b }.
 *
 * Sengaja rute statis (/compare, tanpa [id] & tanpa useSearchParams)
 * karena UI diekspor statis (output: 'export').
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import { api, type CatalogSummary } from '@/lib/api';

/** Bentuk hasil POST /api/catalog/compare. */
interface CompareResult {
  modelOnlyA: string[];
  modelOnlyB: string[];
  same: string[];
  diff: { model: string; onlyA: string[]; onlyB: string[] }[];
  summary: {
    modelsA: number; modelsB: number;
    sameModels: number; diffModels: number;
    added: number; removed: number;
  };
}

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Parse + normalisasi JSON katalog. Toleran terhadap dua bentuk yang
 * wajar ditemui pengguna:
 *   - { "catalog": { ... } }  (bungkusan /api/catalog/import)
 *   - [ { model }, ... ]      (array model mentah)
 * Lalu wajibkan ada array `models` — kalau tidak, hasilnya katalog
 * kosong dan perbandingan terlihat "identik" padahal salah tempel.
 */
function parseCatalog(text: string): ParseResult {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Belum ada JSON yang ditempel.' };

  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: `JSON tidak valid — ${(e as Error).message}` };
  }

  let obj: unknown = raw;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (!('models' in rec) && rec.catalog && typeof rec.catalog === 'object') {
      obj = rec.catalog;
    }
  }
  if (Array.isArray(obj)) obj = { models: obj };

  const models = (obj as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    return { ok: false, error: 'Tidak ada array `models` — ini tampaknya bukan berkas katalog parameter.' };
  }
  const bad = models.filter(
    (m) => !(m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'),
  );
  if (bad.length) {
    return { ok: false, error: `${bad.length} entri model tidak punya "id" yang valid.` };
  }
  return { ok: true, value: obj };
}

/** Peta model -> daftar path, dipakai untuk menampilkan path model yang hanya ada di satu sisi. */
function modelPathMap(cat: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const root = (cat ?? null) as { models?: { id?: unknown; params?: { path?: unknown }[] }[] } | null;
  const models = Array.isArray(root?.models) ? root.models : [];
  for (const m of models) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
    const params = Array.isArray(m.params) ? m.params : [];
    out.set(
      m.id,
      params
        .map((p) => (p && typeof p.path === 'string' ? p.path : ''))
        .filter((p) => p !== ''),
    );
  }
  return out;
}

export default function ComparePage() {
  return <Shell><CompareBody /></Shell>;
}

function CompareBody() {
  const [cat, setCat] = useState<CatalogSummary | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [aMode, setAMode] = useState<'active' | 'paste'>('active');
  const [aText, setAText] = useState('');
  const [bText, setBText] = useState('');
  const [bName, setBName] = useState<string | null>(null);
  const [errA, setErrA] = useState<string | null>(null);
  const [errB, setErrB] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reqErr, setReqErr] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  // Katalog yang benar-benar dikirim — disimpan supaya daftar path model
  // yang hanya ada di satu sisi tetap bisa ditampilkan setelah respons.
  const [pair, setPair] = useState<{ a: unknown; b: unknown } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<CatalogSummary>('/api/catalog')
      .then(setCat)
      .catch((e) => setCatErr((e as Error).message));
  }, []);

  const pathsA = useMemo(() => (pair ? modelPathMap(pair.a) : null), [pair]);
  const pathsB = useMemo(() => (pair ? modelPathMap(pair.b) : null), [pair]);

  const resolveA = (): ParseResult => {
    if (aMode === 'active') {
      if (catErr) return { ok: false, error: `Katalog aktif gagal dimuat: ${catErr}` };
      if (!cat) return { ok: false, error: 'Katalog aktif masih dimuat — coba lagi sebentar.' };
      return { ok: true, value: cat };
    }
    return parseCatalog(aText);
  };

  const submit = async () => {
    const ra = resolveA();
    const rb = parseCatalog(bText);
    setErrA(ra.ok ? null : ra.error);
    setErrB(rb.ok ? null : rb.error);
    if (!ra.ok || !rb.ok) {
      setResult(null);
      setPair(null);
      return;
    }

    setBusy(true);
    setReqErr(null);
    setResult(null);
    setPair(null);
    setOpen({});
    try {
      const out = await api<CompareResult>('/api/catalog/compare', {
        method: 'POST',
        body: { a: ra.value, b: rb.value },
      });
      setResult(out);
      setPair({ a: ra.value, b: rb.value });
    } catch (e) {
      setReqErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setResult(null);
    setPair(null);
    setOpen({});
    setErrA(null);
    setErrB(null);
    setReqErr(null);
    setBText('');
    setBName(null);
    setAText('');
    setAMode('active');
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result) {
        setBText(String(ev.target.result));
        setBName(f.name);
        setErrB(null);
      }
    };
    reader.readAsText(f);
    // Kosongkan supaya berkas yang sama bisa dipilih ulang setelah diubah.
    e.target.value = '';
  };

  const identical =
    result && result.diff.length === 0 && result.modelOnlyA.length === 0 && result.modelOnlyB.length === 0;

  return (
    <>
      <div className="mb-3">
        <h1 className="h3 mb-1">Bandingkan Katalog</h1>
        <div className="text-muted small">
          Bandingkan katalog parameter per model — kolom A vs kolom B.
          Perhitungan dilakukan server lewat <code>POST /api/catalog/compare</code>.
        </div>
      </div>

      <div className="row g-3">
        {/* ---------------- Kolom A ---------------- */}
        <div className="col-12 col-lg-6 mb-3 px-lg-2">
          <div className="card h-100">
            <div className="card-header py-2">
              <h2 className="h6 mb-0">Kolom A — acuan</h2>
            </div>
            <div className="card-body">
              <label className="form-label small mb-1" htmlFor="cmp-src-a">Sumber katalog A</label>
              <select
                id="cmp-src-a"
                className="form-select mb-3"
                value={aMode}
                onChange={(e) => {
                  setAMode(e.target.value === 'paste' ? 'paste' : 'active');
                  setErrA(null);
                }}
              >
                <option value="active">
                  Katalog aktif
                  {cat ? ` — v${cat.version}, ${cat.models.length} model` : catErr ? ' (gagal dimuat)' : ' (memuat…)'}
                </option>
                <option value="paste">Tempel JSON katalog</option>
              </select>

              {aMode === 'active' ? (
                cat ? (
                  <div className="alert alert-light border small mb-0">
                    <div><b>{cat.version}</b> · {cat.generatedAt}</div>
                    <div className="text-muted">
                      {cat.models.length} model · {cat.counts.params} param vendor ·{' '}
                      {cat.counts.tr098 + cat.counts.tr181} path standard
                    </div>
                  </div>
                ) : (
                  <div className="text-muted small">
                    {catErr ? `Gagal memuat: ${catErr}` : 'Memuat katalog aktif…'}
                  </div>
                )
              ) : (
                <>
                  <textarea
                    className="form-control text-monospace small"
                    rows={10}
                    value={aText}
                    onChange={(e) => setAText(e.target.value)}
                    placeholder='{ "version": "...", "models": [ { "id": "...", "params": [...] } ] }'
                    aria-label="JSON katalog A"
                  />
                  {aText.trim() ? <JsonStatus text={aText} /> : null}
                </>
              )}
              {errA && <div className="text-danger small mt-2">{errA}</div>}
            </div>
          </div>
        </div>

        {/* ---------------- Kolom B ---------------- */}
        <div className="col-12 col-lg-6 mb-3 px-lg-2">
          <div className="card h-100">
            <div className="card-header py-2 d-flex justify-content-between align-items-center">
              <h2 className="h6 mb-0">Kolom B — pembanding</h2>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary py-0"
                onClick={() => fileRef.current?.click()}
              >
                <i className="fa-solid fa-file-import me-1" />Pilih file .json
              </button>
              <input
                type="file"
                ref={fileRef}
                className="d-none"
                accept=".json,application/json"
                onChange={handleFile}
              />
            </div>
            <div className="card-body">
              <label className="form-label small mb-1" htmlFor="cmp-json-b">Tempel JSON katalog lain</label>
              <textarea
                id="cmp-json-b"
                className="form-control text-monospace small"
                rows={10}
                value={bText}
                onChange={(e) => { setBText(e.target.value); setBName(null); }}
                placeholder='{ "version": "...", "models": [ { "id": "...", "params": [...] } ] }'
              />
              {bName && <div className="text-muted small mt-1">Berkas: <b>{bName}</b></div>}
              {bText.trim() ? <JsonStatus text={bText} /> : null}
              {errB && <div className="text-danger small mt-2">{errB}</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
              Membandingkan…
            </>
          ) : (
            <>
              <i className="fa-solid fa-balance-scale me-1" />Bandingkan
            </>
          )}
        </button>
        {result && (
          <button className="btn btn-outline-secondary" onClick={reset} disabled={busy}>
            Atur ulang
          </button>
        )}
        <span className="text-muted small ms-auto d-none d-md-inline">
          Kedua kolom wajib berisi JSON katalog yang valid.
        </span>
      </div>

      {reqErr && <div className="alert alert-danger small">Perbandingan gagal: {reqErr}</div>}

      {result && (
        <>
          {/* ---------------- 4 kartu ringkasan ---------------- */}
          <div className="row mb-3">
            <SummaryCol n={result.modelOnlyA.length} label="Model di A saja" tone="success" />
            <SummaryCol n={result.modelOnlyB.length} label="Model di B saja" tone="danger" />
            <SummaryCol n={result.same.length} label="Model sama" tone="primary" />
            <SummaryCol n={result.diff.length} label="Model berbeda" tone="warning" />
          </div>

          <div className="text-muted small mb-3">
            A: {result.summary.modelsA} model · B: {result.summary.modelsB} model ·
            path ditambahkan di B: <b>{result.summary.added}</b> ·
            path hilang dari A: <b>{result.summary.removed}</b>
          </div>

          {identical && (
            <div className="alert alert-success small">
              Tidak ada perbedaan — {result.same.length} model identik di kedua katalog.
            </div>
          )}

          {result.modelOnlyA.length === 0 && result.modelOnlyB.length === 0 && result.diff.length === 0 && (
            result.summary.modelsA === 0 || result.summary.modelsB === 0 ? (
              <div className="alert alert-warning small">
                Salah satu katalog tidak punya model — periksa kembali JSON yang dikirim.
              </div>
            ) : null
          )}

          {/* ---------------- Tabel perbedaan ---------------- */}
          {result.diff.length > 0 && (
            <div className="card mb-3">
              <div className="card-header py-2">
                <h2 className="h6 mb-0">Perbedaan per model ({result.diff.length})</h2>
              </div>
              <div className="card-body p-0 table-responsive">
                <table className="table table-sm table-param mb-0">
                  <thead className="table-light">
                    <tr>
                      <th>Model</th>
                      <th style={{ width: 120 }}>Hanya di A</th>
                      <th style={{ width: 120 }}>Hanya di B</th>
                      <th style={{ width: 92 }} className="text-end">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.diff.map((d) => (
                      <Fragment key={d.model}>
                        <tr>
                          <td className="param-path">{d.model}</td>
                          <td>
                            <span className="badge text-bg-success" title={`${d.onlyA.length} path hanya di A`}>
                              {d.onlyA.length}
                            </span>
                          </td>
                          <td>
                            <span className="badge text-bg-danger" title={`${d.onlyB.length} path hanya di B`}>
                              {d.onlyB.length}
                            </span>
                          </td>
                          <td className="text-end">
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary"
                              aria-expanded={Boolean(open[d.model])}
                              onClick={() => setOpen((o) => ({ ...o, [d.model]: !o[d.model] }))}
                            >
                              {open[d.model] ? 'Tutup' : 'Buka'}
                            </button>
                          </td>
                        </tr>
                        {open[d.model] && (
                          <tr>
                            <td colSpan={4} className="bg-light align-top">
                              <div className="row g-3">
                                <div className="col-12 col-md-6">
                                  <div className="small fw-bold text-success mb-1">
                                    Hanya di A ({d.onlyA.length})
                                  </div>
                                  <PathList paths={d.onlyA} />
                                </div>
                                <div className="col-12 col-md-6">
                                  <div className="small fw-bold text-danger mb-1">
                                    Hanya di B ({d.onlyB.length})
                                  </div>
                                  <PathList paths={d.onlyB} />
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---------------- Model yang hanya ada di satu sisi ---------------- */}
          {result.modelOnlyA.length > 0 && (
            <ModelOnlyCard
              title="Hanya di A"
              models={result.modelOnlyA}
              pathsOf={(m) => pathsA?.get(m) ?? []}
              tone="success"
            />
          )}
          {result.modelOnlyB.length > 0 && (
            <ModelOnlyCard
              title="Hanya di B"
              models={result.modelOnlyB}
              pathsOf={(m) => pathsB?.get(m) ?? []}
              tone="danger"
            />
          )}
        </>
      )}
    </>
  );
}

/** Kartu ringkasan hasil perbandingan. */
function SummaryCol({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="col-6 col-md-3 mb-3">
      <div className="card h-100">
        <div className="card-body py-2 px-3 text-center">
          <div className={`h3 mb-0 text-${tone}`}>{n}</div>
          <div className="small text-muted">{label}</div>
        </div>
      </div>
    </div>
  );
}

/** Daftar path dalam kotak yang bisa digulir — jangan meledakkan halaman. */
function PathList({ paths }: { paths: string[] }) {
  if (!paths.length) {
    return <div className="text-muted small fst-italic">Tidak ada path.</div>;
  }
  return (
    <ul
      className="list-unstyled mb-0 param-path border rounded p-2 bg-body"
      style={{ maxHeight: 220, overflowY: 'auto' }}
    >
      {paths.map((p) => <li key={p}>{p}</li>)}
    </ul>
  );
}

/** Model yang hanya ada di satu sisi, lengkap dengan daftar path-nya. */
function ModelOnlyCard({ title, models, pathsOf, tone }: {
  title: string;
  models: string[];
  pathsOf: (model: string) => string[];
  tone: 'success' | 'danger';
}) {
  return (
    <div className="card mb-3">
      <div className="card-header py-2">
        <h2 className="h6 mb-0">{title} — {models.length} model</h2>
      </div>
      <div className="card-body vstack gap-3">
        {models.map((m) => {
          const paths = pathsOf(m);
          return (
            <div key={m}>
              <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                <span className="param-path fw-semibold">{m}</span>
                <span className={`badge bg-${tone}`}>{paths.length} path</span>
              </div>
              <PathList paths={paths} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Umpan balik JSON langsung di bawah textarea (valid / tidak valid). */
function JsonStatus({ text }: { text: string }) {
  const r = parseCatalog(text);
  if (r.ok) {
    return (
      <div className="text-success small mt-1">
        <i className="fa-solid fa-check-circle me-1" />JSON valid.
      </div>
    );
  }
  return (
    <div className="text-danger small mt-1">
      <i className="fa-solid fa-exclamation-circle me-1" />{r.error}
    </div>
  );
}
