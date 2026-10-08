/**
 * Dispatcher webhook: push peristiwa ACS ke sistem lain (OSS/BSS, bot
 * Telegram, Zabbix, n8n, dsb) secara real-time — tanpa penerima harus polling.
 *
 * Prinsip desain, dan alasannya:
 *
 *  - **Kegagalan penerima tidak boleh mengganggu ACS.** Semua pengiriman
 *    terjadi di luar jalur permintaan (fire-and-forget) dan setiap error
 *    ditangkap. ACS tetap melayani CPE walau endpoint webhook mati.
 *  - **Bertanda tangan (HMAC-SHA256).** Penerima bisa memastikan payload
 *    benar dari ACS ini dan tidak diubah pihak ketiga. Tanpa ini, siapa pun
 *    yang tahu URL-nya bisa mengirim payload palsu.
 *  - **Anti-banjir.** Setiap perangkat Inform tiap beberapa menit; kalau tiap
 *    peristiwa langsung dikirim ke jaringan, antrean bisa membengkak. Ada
 *    antrean berbatas dan retry berjenjang, bukan kirim tanpa henti.
 *  - **Tanpa dependensi.** Memakai `fetch` bawaan Node — tidak menambah
 *    paket, tidak memperbesar permukaan serangan.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Database, WebhookRow } from '@acs/core';

export interface WebhookEvent {
  /** Jenis peristiwa (mis. 'inform', 'fault', 'preset', 'reboot', 'login'). */
  kind: string;
  deviceId?: string | null;
  message: string;
  /** Data tambahan (opsional) — mis. product_class, ip, status RPC. */
  data?: Record<string, unknown>;
}

export interface DeliveryLogEntry {
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

export interface DispatcherOptions {
  /** Percobaan maksimum per pengiriman (termasuk percobaan pertama). */
  maxAttempts?: number;
  /** Jeda antar percobaan (ms); indeks = percobaan ke-N. */
  backoffMs?: number[];
  /** Waktu tunggu satu request (ms). */
  timeoutMs?: number;
  /** Maksimum item dalam antrean; kelebihan dibuang (yang terlama). */
  queueLimit?: number;
  /** Berapa log pengiriman yang disimpan di memori untuk UI. */
  logLimit?: number;
}

const DEFAULTS: Required<DispatcherOptions> = {
  maxAttempts: 3,
  backoffMs: [1000, 5000, 15000],
  timeoutMs: 8000,
  queueLimit: 500,
  logLimit: 200,
};

/**
 * Jenis yang TIDAK pernah dikirim ke webhook.
 *
 * `webhook` dikecualikan supaya kegagalan pengiriman (yang dicatat sebagai
 * peristiwa `webhook`) tidak memicu pengiriman baru — itu akan jadi loop tak
 * berujung saat endpoint penerima sedang mati.
 */
const NEVER_PUSH = new Set(['webhook']);

function filterFor(hook: WebhookRow): Set<string> {
  try {
    const arr = JSON.parse(hook.events || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export class WebhookDispatcher {
  private readonly db: Database;
  private readonly opts: Required<DispatcherOptions>;
  private readonly queue: Array<{ hook: WebhookRow; payload: Record<string, unknown>; raw: string }> = [];
  private readonly log: DeliveryLogEntry[] = [];
  private running = false;
  private dropped = 0;

  constructor(db: Database, opts: DispatcherOptions = {}) {
    this.db = db;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * Kirim satu peristiwa ke semua target yang cocok. Non-blocking: masuk
   * antrean lalu segera kembali. Aman dipanggil dari jalur hot (Inform).
   */
  emit(ev: WebhookEvent): void {
    if (NEVER_PUSH.has(ev.kind)) return;

    let hooks: WebhookRow[];
    try {
      hooks = this.db.listEnabledWebhooks();
    } catch {
      return; // DB bermasalah bukan alasan ACS ikut tumbang
    }
    if (!hooks.length) return;

    const matched = hooks.filter((h) => {
      const kinds = filterFor(h);
      return kinds.size === 0 || kinds.has(ev.kind);
    });
    if (!matched.length) return;

    const envelope = {
      id: randomUUID(),
      event: ev.kind,
      deviceId: ev.deviceId ?? null,
      message: ev.message,
      data: ev.data ?? {},
      at: Date.now(),
    };
    const raw = JSON.stringify(envelope);

    for (const hook of matched) {
      if (this.queue.length >= this.opts.queueLimit) {
        // Buang yang paling lama, catat sekali — lebih baik kehilangan
        // peristiwa lama daripada menahan semua karena antrean penuh.
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push({ hook, payload: envelope, raw });
    }
    void this.drain();
  }

  /** Jumlah item menunggu + berapa yang pernah dibuang karena penuh. */
  stats(): { pending: number; dropped: number; inflight: boolean } {
    return { pending: this.queue.length, dropped: this.dropped, inflight: this.running };
  }

  recentLog(limit = 50): DeliveryLogEntry[] {
    return this.log.slice(-Math.min(limit, this.opts.logLimit)).reverse();
  }

  /** Kirim langsung (dipakai tombol "Uji" di UI) — mengembalikan hasilnya. */
  async sendTest(id: number): Promise<DeliveryLogEntry> {
    const hook = this.db.getWebhook(id);
    if (!hook) throw new Error('webhook_tidak_ditemukan');
    const envelope = {
      id: randomUUID(),
      event: 'test',
      deviceId: null,
      message: 'Uji webhook dari UI ACS',
      data: { test: true },
      at: Date.now(),
    };
    const started = Date.now();
    const entry = await this.attempt(hook, envelope, JSON.stringify(envelope), 1, started);
    return entry;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        await this.deliver(item.hook, item.payload, item.raw);
      }
    } finally {
      this.running = false;
    }
  }

  /** Coba beberapa kali dengan jeda berjenjang sebelum menyerah. */
  private async deliver(
    hook: WebhookRow,
    payload: Record<string, unknown>,
    raw: string,
  ): Promise<void> {
    const started = Date.now();
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const entry = await this.attempt(hook, payload, raw, attempt, started);
      if (entry.ok) return;
      // 4xx (selain 400 dari penerima yang jelas salah) hampir selalu
      // permanen — mengulanginya hanya membuang waktu dan mengganggu
      // penerima. 429 adalah pengecualian: kita memang diminta menunggu.
      if (entry.status !== null && entry.status >= 400 && entry.status < 500 && entry.status !== 429) {
        return;
      }
      const wait = this.opts.backoffMs[attempt - 1];
      if (wait === undefined) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async attempt(
    hook: WebhookRow,
    _payload: Record<string, unknown>,
    raw: string,
    attempt: number,
    startedAt: number,
  ): Promise<DeliveryLogEntry> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = hook.secret
      ? `sha256=${createHmac('sha256', hook.secret).update(`${ts}.${raw}`).digest('hex')}`
      : '';

    const entry: DeliveryLogEntry = {
      id: randomUUID(), webhookId: hook.id, webhookName: hook.name,
      kind: String((JSON.parse(raw) as { event?: string }).event ?? ''),
      attempt, status: null, ok: false, at: startedAt, ms: 0,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ACS-TR069-Webhook/1.0',
          'x-acs-event': entry.kind,
          'x-acs-delivery': entry.id,
          'x-acs-timestamp': ts,
          ...(sig ? { 'x-acs-signature': sig } : {}),
        },
        body: raw,
        signal: ctrl.signal,
      });
      entry.status = res.status;
      entry.ok = res.ok;
      entry.ms = Date.now() - startedAt;
    } catch (e) {
      entry.ok = false;
      entry.error = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : 'error';
      entry.ms = Date.now() - startedAt;
    } finally {
      clearTimeout(timer);
    }

    this.pushLog(entry);
    try {
      this.db.recordWebhookDelivery(hook.id, entry.status, entry.ok);
      // Catat tiap pengiriman yang selesai (sukses atau gagal total).
      // `webhook` dikecualikan dari push (NEVER_PUSH), jadi tidak ada loop.
      if (entry.ok || attempt >= this.opts.maxAttempts) {
        this.db.addEvent(
          null, 'webhook',
          entry.ok
            ? `Webhook "${hook.name}" terkirim (HTTP ${entry.status})`
            : `Webhook "${hook.name}" gagal setelah ${attempt} percobaan` +
              (entry.status ? ` (HTTP ${entry.status})` : ` (${entry.error})`),
        );
      }
    } catch { /* pencatatan log tidak boleh menggagalkan pengiriman */ }

    return entry;
  }

  private pushLog(entry: DeliveryLogEntry): void {
    this.log.push(entry);
    if (this.log.length > this.opts.logLimit) this.log.splice(0, this.log.length - this.opts.logLimit);
  }
}

/**
 * Verifikasi tanda tangan di sisi PENERIMA (contoh nyata untuk dokumentasi):
 *
 *   const ts = req.headers['x-acs-timestamp'];
 *   const expected = 'sha256=' + createHmac('sha256', SECRET)
 *     .update(ts + '.' + rawBody).digest('hex');
 *   if (!timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-acs-signature'])))
 *     return res.status(401).end();
 *
 * Penting: verifikasi atas BODY MENTAH (sebelum JSON.parse), bukan hasil
 * parse ulang — urutan kunci bisa berbeda dan tanda tangan jadi tidak cocok.
 */
export const SIGNATURE_HEADER = 'x-acs-signature';
export const TIMESTAMP_HEADER = 'x-acs-timestamp';
