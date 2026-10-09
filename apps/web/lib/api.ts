/**
 * Klien API untuk UI.
 *
 * Tiga hal yang ditangani di sini:
 *  1. CSRF — setiap request non-GET menyertakan header x-csrf yang diambil
 *     dari /api/me (token dihasilkan server dari cookie sesi).
 *  2. 401 → anggap sesi habis, lempar ke halaman login. Tanpa itu UI akan
 *     diam menampilkan data kosong ketika sesi 8 jam-nya habis.
 *  3. Tanpa cache untuk endpoint data — selalu minta terbaru.
 */

let csrfCache: string | null = null;

export function setCsrf(t: string | null): void {
  csrfCache = t;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getCsrf(): Promise<string | null> {
  if (csrfCache) return csrfCache;
  try {
    const r = await fetch('/api/me', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { csrf?: string };
    csrfCache = j.csrf ?? null;
    return csrfCache;
  } catch {
    return null;
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (method !== 'GET' && method !== 'HEAD') {
    // Content-Type JSON hanya bila memang ada body: Fastify menolak
    // "application/json" dengan body kosong (400 FST_ERR_CTP_EMPTY_JSON_BODY)
    // — penyebab "Bad Request" pada tombol Hubungi/Pelajari struktur/Reboot.
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const c = await getCsrf();
    if (c) headers['x-csrf'] = c;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    csrfCache = null;
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Sesi berakhir');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const d = data as { error?: string; message?: string; detail?: string } | null;
    // Pesan paling informatif dulu: Fastify menaruh alasan di `message`,
    // sedangkan `error` sering hanya "Bad Request".
    const generic = !d?.error || /^(Bad Request|Internal Server Error|Not Found)$/.test(d.error);
    const msg = (generic ? d?.message : undefined) ?? d?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export async function login(username: string, password: string): Promise<{ username: string; role: string; csrf: string }> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'same-origin',
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'login_failed');
  csrfCache = data.csrf;
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-csrf': csrfCache ?? '' },
      credentials: 'same-origin',
    });
  } catch {
    /* abaikan — cookie akan dibuang server */
  }
  csrfCache = null;
}

/* ---------------- tipe data ---------------- */

export interface DeviceRow {
  id: string;
  manufacturer: string;
  oui: string;
  product_class: string;
  serial_number: string;
  ip_address: string | null;
  protocol: string | null;
  software_version: string | null;
  hardware_version: string | null;
  connection_request_url: string | null;
  connection_request_user: string | null;
  has_connection_request_pass: boolean;
  cwmp_user: string | null;
  has_cwmp_pass: boolean;
  last_inform_at: number | null;
  registered_at: number;
  group_name: string | null;
  tags: string;
  online: boolean;
  pending_tasks: number;
  // Ringkasan operasional (dihitung server dari parameter, lihat insight.ts)
  data_model: 'TR-098' | 'TR-181' | null;
  rx_power: number | null;   // dBm
  tx_power: number | null;   // dBm
  optical_temp: number | null;
  pppoe_user: string | null;
  pppoe_status: string | null;
  wan_ip: string | null;
  ssid: string | null;
  summary_at: number | null;
  cpu_usage: number | null;  // %
  mem_usage: number | null;  // % RAM terpakai
}

/* ---- insight perangkat (GET /api/devices/:id → insight) ---- */

export interface OpticalInfo {
  rx: number | null;
  tx: number | null;
  temperature: number | null;
  voltage: number | null;
  bias: number | null;
  los: boolean;
  source: string | null;
  raw: { rx: string | null; tx: string | null };
}

export interface WanConn {
  base: string;
  kind: 'ppp' | 'ip';
  wcd: number | null;
  instance: number;
  name: string | null;
  enable: string | null;
  status: string | null;
  username: string | null;
  externalIp: string | null;
  gateway: string | null;
  dns: string | null;
  connectionType: string | null;
  addressingType: string | null;
  vlan: string | null;
  vlanPath: string | null;
  serviceList: string | null;
  serviceListPath: string | null;
  mac: string | null;
  uptime: string | null;
  lastError: string | null;
  nat: string | null;
  /** Sandi PPPoE terbuka; null = ONU tidak mengirimnya & belum pernah disetel ACS. */
  password: string | null;
  passwordPath: string | null;
  passwordSource: 'onu' | 'acs' | null;
  passwordAt: number | null;
}

export interface WlanInfo {
  index: number;
  base: string;
  ssid: string | null;
  enable: string | null;
  status: string | null;
  band: '2.4GHz' | '5GHz' | null;
  channel: string | null;
  security: string | null;
  clients: string | null;
  passphrasePaths: string[];
  hasPassphrase: boolean;
  /** Sandi WiFi terbuka; null = ONU tidak mengirimnya & belum pernah disetel ACS. */
  passphrase: string | null;
  passphraseSource: 'onu' | 'acs' | null;
  passphraseAt: number | null;
  /** SSID disembunyikan (siaran mati); null = ONU tidak melaporkan. */
  hidden: boolean | null;
  hiddenPath: string | null;
  apBase: string | null;
}

export interface WcdInfo {
  index: number;
  base: string;
  conns: number;
  linkVlan: string | null;
}

export interface SystemInfo {
  cpu: number | null;
  cpuSource: string | null;
  memTotalKb: number | null;
  memFreeKb: number | null;
  memUsedPct: number | null;
  memSource: string | null;
}

export interface DeviceInsight {
  dataModel: 'TR-098' | 'TR-181' | null;
  optical: OpticalInfo;
  wan: WanConn[];
  wcds: WcdInfo[];
  /** ConnectionType yang dipakai perangkat (mis. "PPPoE_Routed"). */
  connTypes: { ppp: string[]; ip: string[] };
  system: SystemInfo;
  wlan: WlanInfo[];
  general: {
    model: string | null;
    uptime: number | null;
    softwareVersion: string | null;
    hardwareVersion: string | null;
    lanIp: string | null;
    hosts: string | null;
    ponStatus: string | null;
  };
}

export interface ParamRow {
  device_id: string;
  path: string;
  value: string;
  type: string;
  updated_at: number;
}

export interface EventRow {
  id: number;
  device_id: string | null;
  kind: string;
  message: string;
  created_at: number;
}

export interface CatalogParam {
  path: string;
  label: string;
  type: string;
  access: string;
  group: string;
  unit?: string | null;
  vendorExt?: boolean;
  source?: string;
}

export interface CatalogModel {
  id: string;
  vendor: string;
  productClass: string;
  dataModel: string;
  notes?: string;
  params: CatalogParam[];
}

export interface CatalogSummary {
  version: string;
  generatedAt: string;
  standard: Record<string, CatalogParam[]>;
  models: {
    id: string; vendor: string; productClass: string;
    dataModel: string; notes?: string; paramCount: number;
    params?: { path: string; label: string; type: string; access: string; group: string; source?: string }[];
  }[];
  counts: { tr098: number; tr181: number; models: number; params: number };
}
