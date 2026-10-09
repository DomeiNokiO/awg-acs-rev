'use client';

/**
 * Trafik internet live (Mbps) dari ONU.
 *
 * ACS membaca counter byte WAN berulang selama sesi CWMP ditahan
 * (apps/server/src/live.ts); panel ini hanya menampilkan sampel.
 * Grafik: dua seri (Download slot 1 biru, Upload slot 2 oranye — palet
 * tervalidasi CVD terang & gelap), garis 2px, legenda + label langsung di
 * ujung garis, crosshair + tooltip, dan tabel data sebagai alternatif.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Sample { t: number; down: number; up: number }
interface LiveState {
  status: 'idle' | 'waiting' | 'live' | 'done' | 'error' | 'stopped';
  message?: string | null;
  intervalMs?: number;
  source?: { label: string; rx: string; tx: string } | null;
  samples: Sample[];
  cr?: { ok: boolean; error?: string };
}

const fmt = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(1));

/** Batas atas sumbu Y yang "bulat" (1, 2, 5 × 10^n). */
function niceMax(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function Chart({ samples }: { samples: Sample[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const H = 200;
  const pad = { l: 44, r: 78, t: 12, b: 24 };
  const iw = w - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const t0 = samples[0]?.t ?? 0;
  const tEnd = Math.max(samples.at(-1)?.t ?? 0, t0 + 10_000);
  const ymax = niceMax(Math.max(1, ...samples.map((s) => Math.max(s.down, s.up))) * 1.1);
  const x = (t: number) => pad.l + ((t - t0) / (tEnd - t0)) * iw;
  const y = (v: number) => pad.t + ih - (v / ymax) * ih;
  const path = (k: 'down' | 'up') => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[k]).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const span = (tEnd - t0) / 1000;
  const step = span > 120 ? 30 : span > 50 ? 15 : span > 20 ? 5 : 2;
  const xticks: number[] = [];
  for (let s = 0; s <= span; s += step) xticks.push(s);
  const last = samples.at(-1);
  const h = hover !== null ? samples[hover] : null;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left + pad.l;
    let best = 0;
    samples.forEach((s, i) => { if (Math.abs(x(s.t) - px) < Math.abs(x(samples[best]!.t) - px)) best = i; });
    setHover(samples.length ? best : null);
  };

  // Label ujung garis: bila terlalu dekat, geser terpisah dengan garis penghubung.
  let ld = last ? y(last.down) : 0;
  let lu = last ? y(last.up) : 0;
  if (last && Math.abs(ld - lu) < 16) { const mid = (ld + lu) / 2; ld = last.down >= last.up ? mid - 9 : mid + 9; lu = last.down >= last.up ? mid + 9 : mid - 9; }

  return (
    <div ref={wrap} className="traffic-chart" style={{ position: 'relative' }}>
      <svg width={w} height={H} role="img" aria-label="Grafik trafik download dan upload (Mbps)">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 6} y={y(v)} className="axis" textAnchor="end" dominantBaseline="middle">{ymax >= 4 ? Math.round(v) : v.toFixed(1)}</text>
          </g>
        ))}
        {xticks.map((s) => (
          <text key={s} x={x(t0 + s * 1000)} y={H - 6} className="axis" textAnchor="middle">{s}s</text>
        ))}
        {samples.length > 1 && <path d={path('down')} className="line down" />}
        {samples.length > 1 && <path d={path('up')} className="line up" />}
        {last && (
          <>
            <circle cx={x(last.t)} cy={y(last.down)} r={4} className="dot down" />
            <circle cx={x(last.t)} cy={y(last.up)} r={4} className="dot up" />
            {Math.abs(ld - y(last.down)) > 1 && <line x1={x(last.t) + 5} x2={x(last.t) + 12} y1={y(last.down)} y2={ld} className="leader" />}
            {Math.abs(lu - y(last.up)) > 1 && <line x1={x(last.t) + 5} x2={x(last.t) + 12} y1={y(last.up)} y2={lu} className="leader" />}
            <text x={x(last.t) + 14} y={ld} className="end-label" dominantBaseline="middle">↓ {fmt(last.down)}</text>
            <text x={x(last.t) + 14} y={lu} className="end-label" dominantBaseline="middle">↑ {fmt(last.up)}</text>
          </>
        )}
        {h && (
          <g>
            <line x1={x(h.t)} x2={x(h.t)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
            <circle cx={x(h.t)} cy={y(h.down)} r={4} className="dot down" />
            <circle cx={x(h.t)} cy={y(h.up)} r={4} className="dot up" />
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: Math.min(x(h.t) + 10, w - 170), top: 8 }}>
          <div className="small text-muted">{new Date(h.t).toLocaleTimeString('id-ID')} · {((h.t - t0) / 1000).toFixed(0)}s</div>
          <div><span className="key down" /> Download <b className="num">{fmt(h.down)}</b> Mbps</div>
          <div><span className="key up" /> Upload <b className="num">{fmt(h.up)}</b> Mbps</div>
        </div>
      )}
    </div>
  );
}

export function TrafficLive({ deviceId }: { deviceId: string }) {
  const [st, setSt] = useState<LiveState>({ status: 'idle', samples: [] });
  const [seconds, setSeconds] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [crWarn, setCrWarn] = useState<string | null>(null);
  const active = st.status === 'waiting' || st.status === 'live';
  const url = `/api/devices/${encodeURIComponent(deviceId)}/live`;

  const poll = useCallback(async () => {
    try { setSt(await api<LiveState>(url)); } catch { /* sementara */ }
  }, [url]);

  useEffect(() => { void poll(); }, [poll]);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => void poll(), 1500);
    return () => clearInterval(h);
  }, [active, poll]);

  const start = async () => {
    setBusy(true); setErr(null); setCrWarn(null);
    try {
      const r = await api<LiveState>(url, { method: 'POST', body: { seconds, intervalSec: 3 } });
      setSt(r);
      if (r.cr && !r.cr.ok) setCrWarn(`${r.cr.error} — pemantauan dimulai saat ONU membuka sesi (Inform berikutnya).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => { try { setSt(await api<LiveState>(url, { method: 'DELETE' })); } catch (e) { setErr((e as Error).message); } };

  const s = st.samples;
  const last = s.at(-1);
  const peak = (k: 'down' | 'up') => (s.length ? Math.max(...s.map((x) => x[k])) : undefined);
  const avg = (k: 'down' | 'up') => (s.length ? s.reduce((a, x) => a + x[k], 0) / s.length : undefined);
  const chip = {
    idle: ['bg-light text-muted', 'Belum dipantau'],
    waiting: ['text-bg-warning', 'Menunggu ONU…'],
    live: ['text-bg-success', 'Live'],
    done: ['bg-light text-muted', 'Selesai'],
    stopped: ['bg-light text-muted', 'Dihentikan'],
    error: ['text-bg-danger', 'Gagal'],
  }[st.status];

  return (
    <div className="mb-3">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h4 className="small text-uppercase text-muted fw-semibold mb-0">
          <i className="fa-solid fa-chart-line me-2" />Trafik internet (live)
        </h4>
        <span className={`badge ${chip[0]}`}>
          {st.status === 'live' && <span className="live-dot me-1" />}{chip[1]}
        </span>
        <div className="ms-auto d-flex gap-2 align-items-center">
          {!active && (
            <select className="form-select form-select-sm" style={{ width: 'auto' }} value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))} aria-label="Durasi pemantauan">
              <option value={30}>30 detik</option>
              <option value={60}>1 menit</option>
              <option value={120}>2 menit</option>
              <option value={300}>5 menit</option>
            </select>
          )}
          {active
            ? <button className="btn btn-sm btn-outline-danger" onClick={stop}><i className="fa-solid fa-stop me-1" />Hentikan</button>
            : <button className="btn btn-sm btn-primary" onClick={start} disabled={busy}><i className="fa-solid fa-play me-1" />Mulai live</button>}
        </div>
      </div>

      {err && <div className="alert alert-danger py-2 small mb-2">{err}</div>}
      {crWarn && st.status === 'waiting' && <div className="alert alert-warning py-2 small mb-2">{crWarn}</div>}
      {st.status === 'error' && st.message && <div className="alert alert-danger py-2 small mb-2">{st.message}</div>}

      {st.status === 'idle' ? (
        <div className="small text-muted">
          Tekan <b>Mulai live</b> untuk melihat trafik download/upload ONU per 3 detik. ACS membaca counter byte WAN
          selama durasi yang dipilih, lalu berhenti sendiri.
        </div>
      ) : (
        <>
          <div className="row g-2 mb-2">
            <div className="col-6">
              <div className="stat-tile">
                <div className="k"><span className="key down" /> Download</div>
                <div className="v">{fmt(last?.down)} <span className="small fw-normal text-muted">Mbps</span></div>
                <div className="small text-muted num">rata-rata {fmt(avg('down'))} · puncak {fmt(peak('down'))}</div>
              </div>
            </div>
            <div className="col-6">
              <div className="stat-tile">
                <div className="k"><span className="key up" /> Upload</div>
                <div className="v">{fmt(last?.up)} <span className="small fw-normal text-muted">Mbps</span></div>
                <div className="small text-muted num">rata-rata {fmt(avg('up'))} · puncak {fmt(peak('up'))}</div>
              </div>
            </div>
          </div>
          <div className="d-flex gap-3 small text-muted mb-1">
            <span><span className="key down" /> Download</span>
            <span><span className="key up" /> Upload</span>
            <span className="ms-auto">Mbps</span>
          </div>
          {s.length > 0
            ? <Chart samples={s} />
            : <div className="text-muted small py-4 text-center">{st.message ?? 'Mengukur…'}</div>}
          <div className="d-flex flex-wrap gap-2 small text-muted mt-1">
            {st.source && <span title={`${st.source.rx}\n${st.source.tx}`}>Sumber: {st.source.label}</span>}
            {s.length > 0 && (
              <details className="ms-auto">
                <summary>Tabel data ({s.length})</summary>
                <table className="table table-sm mb-0 mt-1 num">
                  <thead><tr><th>Waktu</th><th className="text-end">Download</th><th className="text-end">Upload</th></tr></thead>
                  <tbody>
                    {s.slice(-30).reverse().map((x) => (
                      <tr key={x.t}><td>{new Date(x.t).toLocaleTimeString('id-ID')}</td><td className="text-end">{fmt(x.down)}</td><td className="text-end">{fmt(x.up)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        </>
      )}
    </div>
  );
}
