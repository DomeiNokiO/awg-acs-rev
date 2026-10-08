/**
 * State machine sesi CWMP.
 *
 * Protokolnya begini: CPE menyalakan HTTP POST ke ACS, ACS membalas satu
 * RPC, CPE membalas hasilnya, begitu seterusnya sampai dua-duanya kosong.
 * Salah urutan = sesi menggantung dan perangkat diam selamanya.
 *
 *   Inform  ->  InformResponse
 *   POST kosong / Response  ->  RPC berikutnya dari antrean, atau envelope kosong
 *   keduanya kosong -> sesi selesai
 *
 * Setiap sesi terikat ke satu device (diambil dari DeviceId di Inform).
 */
import {
  parseEnvelope, buildEnvelope, emptyEnvelope, text, type ParsedEnvelope,
} from './soap.ts';
import {
  type Rpc, type ParamValue, parseCwmpFault,
  handleGetParameterValuesResponse, handleGetParameterNamesResponse,
  handleSetParameterValuesResponse, handleAddObjectResponse,
  handleTransferComplete, CWMP_FAULTS,
} from './rpc.ts';

export interface DeviceIdentity {
  manufacturer: string;
  oui: string;
  productClass: string;
  serialNumber: string;
}

export interface InformInfo {
  identity: DeviceIdentity;
  events: string[];
  maxEnvelopes: number;
  currentTime: string;
  retryCount: number;
  parameterList: string[];
  /** Nilai ParameterList Inform (ConnectionRequestURL, IP WAN, versi SW…). */
  parameterValues: Record<string, string>;
}

export type SessionState =
  | 'awaiting_inform'   // baru dibuka, belum ada Inform
  | 'in_session'        // Inform diterima, CPE sedang bolak-balik
  | 'finished'          // kedua sisi sudah kosong
  | 'fault';            // sesi dibuang karena error

export interface SessionOutcome {
  /** XML yang harus dikirim sebagai balasan HTTP. */
  responseXml: string;
  /** Kode status HTTP. */
  status: number;
  /** Info Inform kalau sesi ini membuka dengan Inform. */
  inform?: InformInfo;
  /** Hasil respons RPC yang barusan diproses. */
  rpcResult?: RpcResult;
  /** Error fatal dari sesi. */
  error?: string;
  /** Selesai (tidak ada lagi yang perlu diproses). */
  done: boolean;
}

export type RpcResult =
  | { kind: 'gpv'; values: Record<string, string>; types?: Record<string, string>; errors: { name: string; code: number; message: string }[]; commandKey?: string }
  | { kind: 'gpn'; nodes: { name: string; writable: boolean }[]; askedPath?: string }
  | { kind: 'spv'; status: number; parameterKey?: string }
  | { kind: 'add_object'; instanceNumber: number; status: number; commandKey?: string }
  | { kind: 'delete_object'; status: number; commandKey?: string }
  | { kind: 'reboot' }
  | { kind: 'factory_reset' }
  | { kind: 'download'; status: number; startTime: string; retry: number }
  | { kind: 'transfer_complete'; commandKey: string; faultCode: number; faultString: string; completeTime: string; fileSize: number }
  | { kind: 'fault'; code: number; message: string; method?: string; askedPath?: string; commandKey?: string };

export interface SessionHooks {
  /** Ambil RPC berikutnya untuk device ini, atau null kalau antrean kosong. */
  dequeue(device: DeviceIdentity): Rpc | null;
  /** Catat hasil RPC ke penyimpanan. */
  record(device: DeviceIdentity, result: RpcResult): void;
}

export class CwmpSession {
  state: SessionState = 'awaiting_inform';
  identity: DeviceIdentity | null = null;
  /** ID yang dipakai ACS untuk request terakhir (dicocokkan di respons CPE). */
  private acsRequestId: string | null = null;
  /** Method yang sedang ditunggu balasannya. */
  private pendingMethod: string | null = null;
  /** Path dari RPC terakhir yang dikirim; dipakai saat perangkat membalas Fault. */
  /** RPC terakhir yang dikirim. Diperlukan supaya pemroses hasil tahu
   *  path mana yang sedang dipetakan saat ini (untuk discovery bertingkat). */
  lastSentXml: string | null = null;
  lastSentMethod: string | null = null;
  /** `Rpc.key` dari RPC terakhir — penghubung balasan/fault ke batch asal. */
  lastSentKey: string | null = null;
  private requestCounter = 0;
  private emptyFromCpe = 0;
  readonly createdAt = Date.now();
  lastSeen = Date.now();

  // Catatan: Node menjalankan TS dalam strip-only mode, jadi parameter
  // property (constructor(private x)) tidak didukung — tulis eksplisit.
  private readonly hooks: SessionHooks;

  constructor(hooks: SessionHooks) {
    this.hooks = hooks;
  }

  /** Satu siklus: terima body POST dari CPE, keluarkan XML balasan. */
  handle(xml: string): SessionOutcome {
    this.lastSeen = Date.now();

    if (!xml || !xml.trim()) {
      // CPE bilang "saya tidak punya apa-apa" — saatnya kirim RPC atau tutup.
      return this.nextRpcOrClose();
    }

    const parsed: ParsedEnvelope = parseEnvelope(xml);

    if (parsed.fault) {
      const f = parseCwmpFault(parsed.fault);
      // Method yang Fault ini jawab. Tanpa ini kita tidak tahu RPC mana
      // yang ditolak — dan satu fault 9005 menghapuskan seluruh batch,
      // jadi tidak tahu path mana berarti tidak bisa-whoosh.
      const method = this.pendingMethod;
      // Isi RPC yang dikirim harus dibaca SEBELUM lastSentXml di-reset.
      // Membaca setelah reset selalu menghasilkan undefined — path yang
      // ditolak jadi tak pernah diketahui dan batch gagal tak bisa dilacak.
      const askedPath = this.lastSentMethod === 'GetParameterNames'
        ? readParameterName(this.lastSentXml)
        : undefined;
      // CommandKey = kunci batch GetParameterValues/SetParameterValues.
      // Dialah yang memungkinkan ACS memecah batch yang ditolak 9005 untuk
      // menemukan path bermasalah tanpa harus menebak-nebak.
      const commandKey = this.lastSentKey ?? readCommandKey(this.lastSentXml);
      this.pendingMethod = null;
      this.lastSentMethod = null;
      this.lastSentXml = null;
      this.lastSentKey = null;
      const message = f.message || CWMP_FAULTS[f.code] || 'Fault';
      const result: RpcResult = {
        kind: 'fault', code: f.code,
        ...(method ? { message: `${message} (saat ${method})`, method } : { message }),
        // Path yang ditolak ikut dibawa. Tanpa ini devices yang menolak
        // banyak subtree akan mencoba path yang sama berulang kali.
        ...(askedPath ? { askedPath } : {}),
        ...(commandKey ? { commandKey } : {}),
      };
      if (this.identity) this.hooks.record(this.identity, result);
      const resp = this.nextRpcOrClose();
      return { ...resp, rpcResult: result };
    }

    if (!parsed.method) {
      // Envelope tanpa method — kemungkinan body kosong yang dibungkus.
      return this.nextRpcOrClose();
    }

    if (parsed.method === 'Inform') {
      return this.handleInform(parsed);
    }

    // Sisanya adalah balasan atas RPC yang kita kirim.
    if (!this.identity) {
      // Inform belum pernah datang — sesi tidak sah.
      this.state = 'fault';
      return {
        responseXml: buildEnvelope(parsed.id ?? '0', this.faultXml(9012, 'Inform tidak ditemukan')),
        status: 500, done: true, error: 'RPC sebelum Inform',
      };
    }

    const result = this.handleRpcResponse(parsed);
    this.lastSentKey = null;
    if (result) this.hooks.record(this.identity, result);
    this.pendingMethod = null;

    const next = this.nextRpcOrClose();
    return { ...next, ...(result ? { rpcResult: result } : {}) };
  }

  /* ---------------- Inform ---------------- */

  private handleInform(parsed: ParsedEnvelope): SessionOutcome {
    const b = parsed.body ?? {};

    const deviceId = (b['DeviceId'] ?? {}) as Record<string, unknown>;
    const identity: DeviceIdentity = {
      manufacturer: text(deviceId['Manufacturer']),
      oui: text(deviceId['OUI']),
      productClass: text(deviceId['ProductClass']),
      serialNumber: text(deviceId['SerialNumber']),
    };

    if (!identity.serialNumber || !identity.oui) {
      this.state = 'fault';
      return {
        responseXml: buildEnvelope(parsed.id ?? '0', this.faultXml(9015, 'DeviceId tidak lengkap')),
        status: 400, done: true, error: 'DeviceId tidak lengkap',
      };
    }

    // Event berbentuk <Event><EventStruct><EventCode>1 BOOT</EventCode>…
    // (bisa satu objek atau array, kadang dibungkus soap-enc:Array/string).
    const events: string[] = [];
    const collect = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if ('EventCode' in o) { const t = text(o['EventCode']); if (t) events.push(t); return; }
        if ('EventStruct' in o) { collect(o['EventStruct']); return; }
        if ('string' in o) { collect(o['string']); return; }
      }
      const t = text(v);
      if (t) events.push(t);
    };
    collect(b['Event']);

    const paramList = Array.isArray(b['ParameterList']) ? (b['ParameterList'] as unknown[]) : [];
    // ParameterList Inform berbentuk ParameterValueStruct, sama dengan
    // balasan GetParameterValues — jadi pemrosesnya dipakai ulang.
    const informValues = handleGetParameterValuesResponse(b).values;

    this.identity = identity;
    this.state = 'in_session';
    this.emptyFromCpe = 0;

    const inform: InformInfo = {
      identity,
      events,
      maxEnvelopes: Number(text(b['MaxEnvelopes'])) || 1,
      currentTime: text(b['CurrentTime']),
      retryCount: Number(text(b['RetryCount'])) || 0,
      parameterList: paramList.filter((p): p is string => typeof p === 'string'),
      parameterValues: informValues,
    };

    // InformResponse wajib dikirim dulu; RPC baru di POST berikutnya.
    const acsId = this.newRequestId();
    return {
      responseXml: buildEnvelope(parsed.id ?? acsId, '<cwmp:InformResponse><MaxEnvelopes>1</MaxEnvelopes></cwmp:InformResponse>'),
      status: 200,
      inform,
      done: false,
    };
  }

  /* ---------------- Balasan RPC ---------------- */

  private handleRpcResponse(parsed: ParsedEnvelope): RpcResult | null {
    const b = parsed.body ?? {};
    switch (parsed.method) {
      case 'GetParameterValuesResponse': {
        const r = handleGetParameterValuesResponse(b);
        // CommandKey dicatat supaya hanya batch INI yang dihapus dari
        // catatan. Menghapus semua batch perangkat justru menghapus batch
        // yang masih menunggu di antrean — fault berikutnya jadi tak bisa
        // dilacak (terbukti: 'batch=TIDAK KETEMU' berulang di log uji).
        const gpvKey = this.lastSentKey ?? readCommandKey(this.lastSentXml);
        this.lastSentMethod = null;
        this.lastSentXml = null;
        this.lastSentKey = null;
        return {
          kind: 'gpv', values: r.values, types: r.types, errors: r.errors,
          ...(gpvKey ? { commandKey: gpvKey } : {}),
        };
      }
      case 'GetParameterNamesResponse': {
        const r = handleGetParameterNamesResponse(b);
        // Path yang ditanyakan diambil dari RPC terakhir: inilah yang
        // memungkinkan discovery berjalan bertingkat (root -> anak -> cucu).
        const asked = this.lastSentMethod === 'GetParameterNames'
          ? readParameterName(this.lastSentXml)
          : undefined;
        this.lastSentMethod = null;
        this.lastSentXml = null;
        return { kind: 'gpn', nodes: r.nodes, askedPath: asked };
      }
      case 'SetParameterValuesResponse': {
        const spvKey = readTagText(this.lastSentXml, 'ParameterKey');
        this.lastSentMethod = null;
        this.lastSentXml = null;
        // parameterKey membawa identitas task (satu per penerapan konfigurasi)
        // sehingga jawaban ini bisa langsung menandai task selesai/gagal.
        return {
          kind: 'spv',
          status: handleSetParameterValuesResponse(b).status,
          ...(spvKey ? { parameterKey: spvKey } : {}),
        };
      }
      case 'AddObjectResponse': {
        const r = handleAddObjectResponse(b);
        // CommandKey diperlukan agar tugas AddObject bisa dicocokkan:
      // tanpanya, isi parameter rencana (username PPPoE, VLAN, dst)
      // tidak pernah sampai ke instance yang baru dibuat.
      // AddObject menulis identitasnya di <ParameterKey> (bukan CommandKey);
      // membaca tag yang salah membuat commandKey selalu kosong sehingga
      // task tidak pernah ditutup dan isi rencana tidak pernah dikirim.
      const aoKey = readTagText(this.lastSentXml, 'ParameterKey')
        ?? readCommandKey(this.lastSentXml);
      this.lastSentMethod = null;
      this.lastSentXml = null;
      return {
        kind: 'add_object', instanceNumber: r.instanceNumber, status: r.status,
        ...(aoKey ? { commandKey: aoKey } : {}),
      };
      }
      case 'DeleteObjectResponse':
      {
        // Sama seperti AddObject: identitas task ada di <ParameterKey>.
        const doKey = readTagText(this.lastSentXml, 'ParameterKey');
        this.lastSentMethod = null;
        this.lastSentXml = null;
        return {
          kind: 'delete_object', status: Number(text(b['Status'])) || 0,
          ...(doKey ? { commandKey: doKey } : {}),
        };
      }
      case 'RebootResponse':
        return { kind: 'reboot' };
      case 'FactoryResetResponse':
        return { kind: 'factory_reset' };
      case 'DownloadResponse':
        return {
          kind: 'download',
          status: Number(text(b['Status'])) || 0,
          startTime: text(b['StartTime']),
          retry: Number(text(b['Retry'])) || 0,
        };
      case 'TransferComplete': {
        const r = handleTransferComplete(b);
        const out: RpcResult = {
          kind: 'transfer_complete', commandKey: r.commandKey, faultCode: r.faultCode,
          faultString: r.faultString, completeTime: r.completeTime, fileSize: r.fileSize,
        };
        // TransferComplete harus dibalas TransferCompleteResponse, bukan RPC baru.
        this.pendingResponseOverride = buildEnvelope(parsed.id ?? this.newRequestId(), emptyElXml('TransferCompleteResponse'));
        return out;
      }
      default:
        // Method yang tidak dikenal: jangan crash, catat dan lanjut.
        return null;
    }
  }

  private pendingResponseOverride: string | null = null;

  /* ---------------- Kirim RPC berikutnya ---------------- */

  private nextRpcOrClose(): SessionOutcome {
    if (this.pendingResponseOverride) {
      const xml = this.pendingResponseOverride;
      this.pendingResponseOverride = null;
      // Penting: respons TransferComplete boleh membatalkan RPC berikutnya,
      // jadi penanda "apa yang terakhir dikirim" harus ikut dibersihkan —
      // kalau tidak, pemroses hasil akan salah mengira respons itu menjawab
      // GetParameterNames.
      this.lastSentMethod = null;
      this.lastSentXml = null;
      this.lastSentKey = null;
      return { responseXml: xml, status: 200, done: false };
    }

    if (!this.identity) {
      this.state = 'fault';
      return { responseXml: emptyEnvelope('0'), status: 400, done: true, error: 'tanpa identitas' };
    }

    const rpc = this.hooks.dequeue(this.identity);
    if (rpc) {
      this.pendingMethod = rpc.method;
      this.lastSentMethod = rpc.method;
      this.lastSentKey = rpc.key;
      this.lastSentXml = `<cwmp:${rpc.method}>${rpc.xml.replace(
        new RegExp(`^<cwmp:${rpc.method}>|</cwmp:${rpc.method}>$`, 'g'),
        '',
      )}</cwmp:${rpc.method}>`;
      this.acsRequestId = this.newRequestId();
      return { responseXml: buildEnvelope(this.acsRequestId, rpc.xml), status: 200, done: false };
    }

    // Tidak ada antrean. Kalau CPE juga kosong dua kali berturut-turut, tutup.
    this.emptyFromCpe++;
    if (this.emptyFromCpe >= 2) {
      this.state = 'finished';
      return { responseXml: emptyEnvelope(this.newRequestId()), status: 200, done: true };
    }
    // Beri satu kesempatan: balas kosong, biarkan CPE POST lagi.
    return { responseXml: emptyEnvelope(this.newRequestId()), status: 200, done: false };
  }

  private newRequestId(): string {
    return String(++this.requestCounter);
  }

  private faultXml(code: number, message: string): string {
    return (
      '<Fault><faultcode>Client</faultcode><faultstring>CWMP Fault</faultstring>' +
      `<detail><cwmp:Fault><FaultCode>${code}</FaultCode>` +
      `<FaultString>${escapeBasic(message)}</FaultString></cwmp:Fault></detail></Fault>`
    );
  }
}

function emptyElXml(name: string): string {
  return `<cwmp:${name}/>`;
}

/** Ambil <ParameterName> dari XML GetParameterNames yang kita kirim. */
/**
 * Ambil isi <CommandKey> dari XML terakhir yang dikirim.
 * CWMP tidak mengulang CommandKey di balasan Fault, jadi satu-satunya cara
 * mengetahui batch mana yang ditolak adalah dari RPC yang barusan dikirim.
 */
/** Baca isi tag apa pun dari XML kirim terakhir (null kalau tak ada). */
function readTagText(xml: string | null, tag: string): string | undefined {
  if (!xml) return undefined;
  // tag di-escape dulu supaya aman walau ada tanda khusus, lalu pola
  // dibangun lewat RegExp (bukan template literal) agar tidak pecah.
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<[^>]*${esc}>\\s*([^<]*)\\s*</[^>]*${esc}>`).exec(xml);
  if (!m) return undefined;
  const v = (m[1] ?? '').trim();
  return v ? v : undefined;
}

function readCommandKey(xml: string | null): string | undefined {
  return readTagText(xml, 'CommandKey');
}

/**
 * Baca <ParameterNames> (tag CWMP jamak; pola lama yang mencari
 * <ParameterName> tanpa 's?' tidak pernah cocok) dari XML GPN terakhir.
 * Inilah yang menentukan root mana yang sedang ditanya — tanpa nilai ini
 * path yang ditolak tidak pernah dibuang dari antrean.
 */
function readParameterName(xml: string | null): string | undefined {
  if (!xml) return undefined;
  const m = /<(?:[A-Za-z0-9_-]+:)?Parameter(?:Path|Names?)>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Parameter(?:Path|Names?)>/
    .exec(xml);
  if (!m) return undefined;
  return m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function escapeBasic(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/* ------------------------------------------------------------------ *
 * Antrean RPC per device (penyimpanan sementara di memori)
 * ------------------------------------------------------------------ */

export interface QueuedTask {
  id: string;
  deviceId: string;
  rpc: Rpc;
  createdAt: number;
  /** Kalau lewat waktu ini, task dibuang (perangkat mungkin mati). */
  expiresAt: number;
  meta?: Record<string, unknown>;
}

export class TaskQueue {
  private queues = new Map<string, QueuedTask[]>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * `ttlMs` opsional per antrean. Tulisan (SetParameterValues, AddObject,
   * Reboot, Download) HARUS diberi TTL panjang: ONU yang Inform tiap
   * 30–60 menit akan menerima tulisan itu pada Inform berikutnya, jauh
   * setelah TTL bawaan 5 menit terlewat — tanpa ini konfigurasi dari UI
   * kedaluwarsa sebelum sempat terkirim (terbukti di uji: task permanen
   * 'pending'). Bacaan (GPN/GPV) tetap memakai TTL pendek bawaan.
   */
  enqueue(
    deviceId: string, rpc: Rpc, meta?: Record<string, unknown>, ttlMs?: number,
  ): QueuedTask {
    const task: QueuedTask = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      deviceId, rpc, createdAt: Date.now(),
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs), meta,
    };
    const q = this.queues.get(deviceId) ?? [];
    q.push(task);
    this.queues.set(deviceId, q);
    return task;
  }

  dequeue(deviceId: string): QueuedTask | null {
    const q = this.queues.get(deviceId);
    if (!q || q.length === 0) return null;
    const now = Date.now();
    while (q.length && q[0]!.expiresAt < now) q.shift();
    const task = q.shift() ?? null;
    if (q.length === 0) this.queues.delete(deviceId);
    return task;
  }

  pending(deviceId: string): QueuedTask[] {
    const q = this.queues.get(deviceId) ?? [];
    const now = Date.now();
    return q.filter((t) => t.expiresAt >= now);
  }

  size(deviceId?: string): number {
    if (deviceId) return this.pending(deviceId).length;
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  clear(deviceId: string): void {
    this.queues.delete(deviceId);
  }
}

export type { ParamValue };
