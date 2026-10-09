/**
 * Trafik internet live (Mbps) dari ONU.
 *
 * TR-069 tidak punya push statistik, jadi trafik dihitung dari selisih
 * counter byte WAN yang dibaca berulang: ACS membuka sesi (Connection
 * Request), lalu SELAMA sesi itu membaca 2 counter tiap `intervalMs`
 * (sesi ditahan; lihat cwmp.ts). Beban ke ONU: 1 GetParameterValues berisi
 * 2 parameter per interval, hanya selama ada operator yang memantau, dan
 * berhenti otomatis setelah durasi habis.
 *
 * Counter TR-098 (TotalBytes*, Stats.EthernetBytes*) bertipe unsignedInt
 * 32-bit dan berputar balik di 4 GiB — di 100 Mbps tiap ±6 menit — jadi
 * selisih negatif ditangani sebagai wrap, bukan dibuang.
 */
import { buildGetParameterValues, type Rpc } from '@acs/core';

export interface CounterPair {
  /** Label sumber untuk UI, mis. "PPPoE WCD 2 · Stats.EthernetBytes*". */
  label: string;
  /** Path byte diterima (= download) dan dikirim (= upload). */
  rx: string;
  tx: string;
}

export interface LiveSample { t: number; down: number; up: number }

export interface LiveState {
  deviceId: string;
  status: 'waiting' | 'live' | 'done' | 'error' | 'stopped';
  message: string | null;
  startedAt: number;
  until: number;
  intervalMs: number;
  source: CounterPair | null;
  samples: LiveSample[];
  /** Total byte terakhir (untuk ditampilkan). */
  totals: { rx: number; tx: number } | null;
}

interface Internal extends LiveState {
  seconds: number;
  candidates: CounterPair[];
  idx: number;
  last: { t: number; rx: number; tx: number } | null;
  lastPollAt: number;
  pendingKey: string | null;
}

const MAX_SAMPLES = 200;
const MAX_CONCURRENT = 25;
const WRAP32 = 2 ** 32;

/** Selisih counter dengan penanganan wrap 32-bit; null = counter di-reset. */
function delta(prev: number, cur: number): number | null {
  if (cur >= prev) return cur - prev;
  if (prev >= 2 ** 31 && prev < WRAP32) return cur + WRAP32 - prev;
  return null;
}

export class LiveTraffic {
  private m = new Map<string, Internal>();

  start(deviceId: string, candidates: CounterPair[], seconds: number, intervalMs: number): LiveState | { error: string } {
    this.gc();
    const active = [...this.m.values()].filter((s) => this.isActive(s.deviceId)).length;
    if (!this.isActive(deviceId) && active >= MAX_CONCURRENT) {
      return { error: `Maksimal ${MAX_CONCURRENT} pemantauan live bersamaan — hentikan yang lain dulu` };
    }
    if (!candidates.length) return { error: 'ONU belum melaporkan counter trafik WAN' };
    const now = Date.now();
    const st: Internal = {
      deviceId, status: 'waiting', message: 'Menunggu ONU membuka sesi…', startedAt: now,
      // +30 detik: waktu tunggu ONU merespons Connection Request / Inform.
      until: now + seconds * 1000 + 30_000, intervalMs, source: candidates[0]!, samples: [], totals: null,
      seconds, candidates, idx: 0, last: null, lastPollAt: 0, pendingKey: null,
    };
    this.m.set(deviceId, st);
    return this.view(st);
  }

  stop(deviceId: string): void {
    const s = this.m.get(deviceId);
    if (s && (s.status === 'waiting' || s.status === 'live')) { s.status = 'stopped'; s.message = 'Dihentikan operator'; }
  }

  get(deviceId: string): LiveState | null {
    const s = this.m.get(deviceId);
    if (!s) return null;
    this.expire(s);
    return this.view(s);
  }

  isActive(deviceId: string): boolean {
    const s = this.m.get(deviceId);
    if (!s) return false;
    this.expire(s);
    return s.status === 'waiting' || s.status === 'live';
  }

  /** Berapa ms lagi poll berikutnya jatuh tempo. */
  waitMs(deviceId: string): number {
    const s = this.m.get(deviceId);
    return s ? Math.max(0, s.lastPollAt + s.intervalMs - Date.now()) : 0;
  }

  buildRpc(deviceId: string): Rpc | null {
    const s = this.m.get(deviceId);
    if (!s || !this.isActive(deviceId)) return null;
    const c = s.candidates[s.idx];
    if (!c) return null;
    const key = `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    s.pendingKey = key;
    s.lastPollAt = Date.now();
    return buildGetParameterValues(key, [c.rx, c.tx]);
  }

  onValues(deviceId: string, values: Record<string, string>): void {
    const s = this.m.get(deviceId);
    if (!s) return;
    const c = s.candidates[s.idx];
    if (!c) return;
    const rx = Number(values[c.rx]);
    const tx = Number(values[c.tx]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) { this.onFault(deviceId); return; }
    const t = Date.now();
    s.totals = { rx, tx };
    if (s.last) {
      const dt = (t - s.last.t) / 1000;
      const dr = delta(s.last.rx, rx);
      const dtx = delta(s.last.tx, tx);
      if (dt > 0.2 && dr !== null && dtx !== null) {
        const r = (v: number) => Math.round((v * 8) / dt / 10_000) / 100; // Mbps, 2 desimal
        s.samples.push({ t, down: r(dr), up: r(dtx) });
        if (s.samples.length > MAX_SAMPLES) s.samples.shift();
      }
    }
    s.last = { t, rx, tx };
    if (s.status === 'waiting') {
      // Durasi dihitung sejak ONU benar-benar menjawab, bukan sejak tombol
      // ditekan (waktu tunggu Connection Request tidak memotong pemantauan).
      s.until = Date.now() + s.seconds * 1000;
    }
    if (s.status === 'waiting' || s.status === 'live') {
      s.status = 'live';
      s.message = s.samples.length ? null : 'Mengukur…';
    }
  }

  /** Counter ditolak/kosong → coba pasangan counter berikutnya. */
  onFault(deviceId: string): void {
    const s = this.m.get(deviceId);
    if (!s) return;
    s.idx++;
    s.last = null;
    if (s.idx >= s.candidates.length) {
      s.status = 'error';
      s.message = 'ONU tidak menyediakan counter trafik WAN yang bisa dibaca';
      s.source = null;
    } else {
      s.source = s.candidates[s.idx]!;
    }
  }

  private expire(s: Internal): void {
    if ((s.status === 'waiting' || s.status === 'live') && Date.now() > s.until) {
      s.status = s.samples.length ? 'done' : 'error';
      s.message = s.samples.length ? 'Selesai' : 'ONU tidak membuka sesi selama waktu pemantauan — cek Connection Request (tombol Hubungi)';
    }
  }

  private gc(): void {
    const old = Date.now() - 30 * 60_000;
    for (const [k, s] of this.m) if (s.until < old) this.m.delete(k);
  }

  private view(s: Internal): LiveState {
    return {
      deviceId: s.deviceId, status: s.status, message: s.message, startedAt: s.startedAt, until: s.until,
      intervalMs: s.intervalMs, source: s.source, samples: s.samples, totals: s.totals,
    };
  }
}
