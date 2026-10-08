/**
 * Penilaian redaman (RX power GPON/EPON, dBm) untuk tampilan.
 *
 * Ambang mengikuti praktik umum ISP FTTH (sensitivitas ONU kelas B+ ≈ -28 dBm):
 *   > -8         terlalu kuat (risiko saturasi receiver)
 *   -8 … -24.99  baik
 *   -25 … -27    perlu perhatian
 *   < -27        buruk
 */
export type RxLevel = 'none' | 'los' | 'hot' | 'good' | 'warn' | 'bad';

export function rxLevel(rx: number | null | undefined, los = false): RxLevel {
  if (los) return 'los';
  if (rx === null || rx === undefined || !Number.isFinite(rx)) return 'none';
  if (rx > -8) return 'hot';
  if (rx >= -25) return 'good';
  if (rx >= -27) return 'warn';
  return 'bad';
}

export const RX_LABEL: Record<RxLevel, string> = {
  none: 'belum terbaca',
  los: 'LOS',
  hot: 'terlalu kuat',
  good: 'baik',
  warn: 'perhatian',
  bad: 'buruk',
};

export function fmtDbm(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

export function fmtUptime(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}h ${h}j ${m}m` : h ? `${h}j ${m}m` : `${m}m`;
}
