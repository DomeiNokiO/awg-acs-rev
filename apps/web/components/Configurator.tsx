'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type DeviceInsight, type WanConn, type WanCaps } from '@/lib/api';

/**
 * Konfigurasi terstruktur perangkat: WiFi, PPPoE, VLAN, WAN internet
 * (PPPoE/IPoE), dan perintah perangkat (reboot, reset pabrik, interval Inform).
 *
 * Form hanya mengirim NILAI + lokasi. Nama parameter vendor
 * (X_HW_VLAN, X_ZTE-COM_VLANID, X_FH_WANGponLinkConfig, X_CMCC_VLANIDMark, …)
 * dipilih server (configure.ts + vendorwan.ts) dari path yang terbukti ada
 * di perangkat, sehingga teknisi tidak perlu hafal struktur tiap merek ONU.
 */

export type ConfigMode = 'wifi' | 'pppoe' | 'vlan' | 'wan-add' | 'bind' | 'device';

export interface ConfigPreset {
  mode: ConfigMode;
  target?: string;
  wlanIndex?: number;
  /** Berubah tiap klik supaya preset yang sama tetap diterapkan ulang. */
  nonce: number;
}

interface Report {
  queued?: number;
  plan?: string[];
  skipped?: string[];
  guessed?: string[];
  error?: string;
  task?: string;
}

const inputCls = 'form-control form-control-sm';
const selectCls = 'form-select form-select-sm';

/** Label koneksi, mis. "PPPoE · WCD 2 · #1 · PPPoE_Routed · INTERNET". */
export function wanLabel(c: WanConn): string {
  const kind = c.kind === 'ppp' ? 'PPPoE' : 'IP';
  const where = c.wcd !== null ? `WCD ${c.wcd} · #${c.instance}` : `#${c.instance}`;
  const who = c.name || c.username || '';
  return `${kind} · ${where}${c.connectionType ? ` · ${c.connectionType}` : ''}${who ? ` · ${who}` : ''}${c.vlan ? ` · VLAN ${c.vlan}` : ''}`;
}

/** Nilai ServiceList umum (Huawei/FiberHome/ZTE/CMCC); input tetap bebas. */
const SERVICE_OPTIONS = ['INTERNET', 'TR069', 'VOIP', 'IPTV', 'OTHER', 'TR069_INTERNET', 'TR069_VOIP', 'TR069_VOIP_INTERNET'];

/** Default NAT per layanan — sama dengan server (vendorwan.ts natDefault). */
const natDefault = (service: string): boolean => {
  const s = (service || 'INTERNET').toUpperCase();
  return s.includes('INTERNET') || !/TR069|VOIP|IPTV|OTHER/.test(s);
};

/** Slot WAN yang belum terisi kredensial/konfigurasi (biasanya dibuat OLT). */
const isEmptySlot = (c: WanConn): boolean =>
  c.kind === 'ppp' ? !c.username : !c.externalIp || c.externalIp === '0.0.0.0';

export function Configurator({ deviceId, serial, insight, caps, preset, onQueued }: {
  deviceId: string;
  serial: string;
  insight: DeviceInsight;
  caps: WanCaps;
  preset?: ConfigPreset | null;
  onQueued: () => void;
}) {
  const pppConns = insight.wan.filter((c) => c.kind === 'ppp');
  const [mode, setMode] = useState<ConfigMode>('wifi');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Report | null>(null);

  // wifi
  const [wlanIndex, setWlanIndex] = useState(insight.wlan[0]?.index ?? 1);
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [wifiEnable, setWifiEnable] = useState<'' | 'on' | 'off'>('');
  // Siaran SSID: '' = tidak diubah. WiFi tetap aktif saat disembunyikan.
  const [wifiHide, setWifiHide] = useState<'' | 'show' | 'hide'>('');
  // pppoe / vlan
  const [target, setTarget] = useState('');
  const [user, setUser] = useState('');
  const [pppPass, setPppPass] = useState('');
  const [vlanId, setVlanId] = useState('');
  const [service, setService] = useState('');
  // wan internet
  const [wanKind, setWanKind] = useState<'pppoe' | 'ip'>('pppoe');
  const [bridge, setBridge] = useState(false);
  const [location, setLocation] = useState('new');
  /** Operator sudah memilih lokasi sendiri — jangan timpa dengan default. */
  const [locTouched, setLocTouched] = useState(false);
  const [connType, setConnType] = useState('');
  const [wanName, setWanName] = useState('');
  const [ipStatic, setIpStatic] = useState('');
  const [netmask, setNetmask] = useState('255.255.255.0');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');
  const [bindLan, setBindLan] = useState<number[]>([]);
  const [bindSsid, setBindSsid] = useState<number[]>([]);
  /** Operator mengubah centang binding — kirim apa adanya (termasuk kosong). */
  const [bindTouched, setBindTouched] = useState(false);
  const [nat, setNat] = useState(true);
  const [natTouched, setNatTouched] = useState(false);
  const [sequential, setSequential] = useState<'' | 'yes' | 'no'>('');
  const [extra, setExtra] = useState('');
  // perangkat
  const [interval, setInterval_] = useState('300');
  const [resetConfirm, setResetConfirm] = useState('');

  const conn = insight.wan.find((c) => c.base === target) ?? null;

  useEffect(() => {
    if (mode === 'pppoe' || mode === 'vlan') {
      setUser(conn?.username ?? '');
      setPppPass('');
      setVlanId(conn?.vlan && conn.vlan !== '0' ? conn.vlan : '');
      setService(conn?.serviceList ?? '');
    }
  }, [target, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const w = insight.wlan.find((x) => x.index === wlanIndex);
    setSsid(w?.ssid ?? '');
    setPass('');
    setWifiEnable('');
  }, [wlanIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pilihan lokasi WAN: slot yang ada (isi/timpa), WCD yang ada, atau WCD baru.
  const locations = useMemo(() => {
    const kindWanted = wanKind === 'pppoe' ? 'ppp' : 'ip';
    const opts: { value: string; label: string }[] = [
      { value: 'new', label: 'WANConnectionDevice baru (otomatis)' },
    ];
    for (const c of insight.wan.filter((x) => x.kind === kindWanted)) {
      opts.push({ value: `existing|${c.base}`, label: `Isi ${isEmptySlot(c) ? '(kosong)' : '(timpa)'}: ${wanLabel(c)}` });
    }
    for (const w of insight.wcds) {
      opts.push({ value: `wcd|${w.index}`, label: `Tambah koneksi di WCD ${w.index} (${w.conns} koneksi${w.linkVlan ? `, VLAN ${w.linkVlan}` : ''})` });
    }
    return opts;
  }, [insight, wanKind]);

  // Default lokasi: slot kosong yang disiapkan OLT (mis. FiberHome
  // "WCD 2 · #1 · PPPoE_Routed"), selain itu WCD baru.
  useEffect(() => {
    if (mode !== 'wan-add') return;
    if (locTouched && locations.some((o) => o.value === location)) return;
    const kindWanted = wanKind === 'pppoe' ? 'ppp' : 'ip';
    const empty = insight.wan.find((c) => c.kind === kindWanted && isEmptySlot(c) && c.wcd !== 1);
    // WCD tanpa koneksi yang disiapkan OLT (alur FiberHome: tambah koneksi
    // PPP di WCD itu lalu diisi) lebih tepat daripada WCD baru.
    const emptyWcd = insight.wcds.find((w) => w.conns === 0 && w.index !== 1);
    setLocation(empty ? `existing|${empty.base}` : emptyWcd ? `wcd|${emptyWcd.index}` : 'new');
  }, [mode, wanKind, locations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Binding default: koneksi yang diisi → binding-nya sekarang; vendor yang
  // wajib binding (FiberHome) → semua LAN + SSID; lainnya → tanpa binding.
  const locConn = location.startsWith('existing|') ? insight.wan.find((c) => c.base === location.slice(9)) ?? null : null;
  useEffect(() => {
    if (mode !== 'wan-add' || bindTouched) return;
    const cur = locConn?.binding;
    if (cur && cur.lan.length + cur.ssid.length > 0) { setBindLan(cur.lan); setBindSsid(cur.ssid); }
    else if (caps.bindingRequired && !bridge && /INTERNET/i.test(service || 'INTERNET')) {
      setBindLan(caps.lanPorts); setBindSsid(caps.ssids.map((s) => s.index));
    } else { setBindLan([]); setBindSsid([]); }
  }, [mode, location, bridge, service, caps]); // eslint-disable-line react-hooks/exhaustive-deps

  // NAT mengikuti layanan sampai operator mengubahnya sendiri.
  useEffect(() => {
    if (!natTouched) setNat(natDefault(service));
  }, [service, natTouched]);

  // Mode binding: centang awal = binding koneksi saat ini.
  useEffect(() => {
    if (mode !== 'bind') return;
    const c = insight.wan.find((x) => x.base === target);
    const cur = c?.binding;
    if (cur && cur.lan.length + cur.ssid.length > 0) { setBindLan(cur.lan); setBindSsid(cur.ssid); }
    else if (caps.bindingRequired) { setBindLan(caps.lanPorts); setBindSsid(caps.ssids.map((s) => s.index)); }
    else { setBindLan([]); setBindSsid([]); }
  }, [mode, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const connTypeOptions = useMemo(() => {
    const observed = wanKind === 'pppoe' ? insight.connTypes.ppp : insight.connTypes.ip;
    const std = wanKind === 'pppoe' ? ['IP_Routed', 'PPPoE_Bridged'] : ['IP_Routed', 'IP_Bridged'];
    return [...new Set([...observed, ...std])];
  }, [insight, wanKind]);

  // Preset dari tombol di tab Ringkasan.
  useEffect(() => {
    if (!preset) return;
    setMode(preset.mode);
    setMsg(null);
    if (preset.wlanIndex) setWlanIndex(preset.wlanIndex);
    if (preset.mode === 'wan-add' && preset.target) {
      const c = insight.wan.find((x) => x.base === preset.target);
      if (c) {
        setWanKind(c.kind === 'ppp' ? 'pppoe' : 'ip');
        setLocation(`existing|${c.base}`);
        setLocTouched(true);
        setUser(c.username ?? '');
        setVlanId(c.vlan && c.vlan !== '0' ? c.vlan : '');
        setService(c.serviceList ?? '');
      }
    } else if (preset.target) setTarget(preset.target);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === 'pppoe' && !pppConns.some((c) => c.base === target)) {
      setTarget((pppConns.find((c) => c.username) ?? pppConns[0])?.base ?? '');
    } else if (mode === 'bind' && !insight.wan.some((c) => c.base === target)) {
      setTarget((insight.wan.find((c) => c.kind === 'ppp' && c.username) ?? insight.wan[0])?.base ?? '');
    } else if (mode === 'vlan' && !insight.wan.some((c) => c.base === target)) {
      setTarget(insight.wan[0]?.base ?? '');
    }
  }, [mode, insight]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<Report>(`/api/devices/${encodeURIComponent(deviceId)}/${path}`, { method: 'POST', ...(body ? { body } : {}) });
      setMsg(r.plan ? r : { queued: 1, plan: [r.task ? `Diantrekan (tugas ${r.task})` : 'Terkirim ke perangkat'] });
      onQueued();
      return true;
    } catch (err) {
      setMsg({ error: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { type: mode };
    if (mode === 'wifi') {
      body.wlanIndex = wlanIndex;
      const cur = insight.wlan.find((x) => x.index === wlanIndex)?.ssid ?? '';
      if (ssid && ssid !== cur) body.ssid = ssid;
      if (pass) body.passphrase = pass;
      if (wifiEnable) body.wifiEnable = wifiEnable === 'on';
      if (wifiHide) body.hidden = wifiHide === 'hide';
    } else if (mode === 'pppoe') {
      body.target = target;
      if (user && user !== conn?.username) body.username = user;
      if (pppPass) body.password = pppPass;
      if (vlanId && vlanId !== conn?.vlan) body.vlanId = Number(vlanId);
      if (service && service !== conn?.serviceList) body.serviceName = service;
    } else if (mode === 'vlan') {
      body.target = target;
      body.vlanId = Number(vlanId);
    } else if (mode === 'bind') {
      body.type = 'wan-bind';
      body.target = target;
      body.bindLan = bindLan;
      body.bindSsid = bindSsid;
    } else if (mode === 'wan-add') {
      body.type = wanKind === 'pppoe' ? 'wan-add' : 'wan-ip-add';
      const [placement, ref] = location.split('|');
      body.placement = placement;
      if (placement === 'existing') body.target = ref;
      if (placement === 'wcd') body.wcd = Number(ref);
      body.bridge = bridge;
      if (connType) body.connectionType = connType;
      if (wanName) body.name = wanName;
      if (vlanId) body.vlanId = Number(vlanId);
      if (service) body.serviceName = service;
      if (extra.trim()) body.extra = extra;
      if (bindTouched || bindLan.length || bindSsid.length) { body.bindLan = bindLan; body.bindSsid = bindSsid; }
      if (!bridge) body.nat = nat;
      if (sequential) body.sequential = sequential === 'yes';
      if (wanKind === 'pppoe') {
        if (user) body.username = user;
        if (pppPass) body.password = pppPass;
      } else if (ipStatic) {
        body.staticIp = ipStatic;
        body.netmask = netmask;
        if (gateway) body.gateway = gateway;
        if (dns) body.dns = dns;
      }
    } else {
      return;
    }
    if (await send('config', body)) { setPass(''); setPppPass(''); }
  };

  const tabs: [ConfigMode, string, string][] = [
    ['wifi', 'WiFi', 'fa-wifi'],
    ['pppoe', 'PPPoE', 'fa-user-lock'],
    ['vlan', 'VLAN', 'fa-tags'],
    ['wan-add', 'WAN Internet', 'fa-globe'],
    ['bind', 'Binding', 'fa-link'],
    ['device', 'Perangkat', 'fa-power-off'],
  ];

  const is181 = insight.dataModel === 'TR-181';
  const locExisting = location.startsWith('existing|');

  return (
    <div className="card border-0 shadow-sm mb-3">
      <div className="card-body">
        <div className="d-flex align-items-center mb-2">
          <i className="fa-solid fa-sliders text-primary me-2" />
          <strong className="small text-uppercase">Konfigurasi ONU</strong>
          {insight.dataModel && <span className="badge bg-light text-muted ms-2" style={{ fontSize: '.68rem' }}>{insight.dataModel}</span>}
        </div>

        <ul className="nav nav-pills mb-3 gap-2 flex-wrap">
          {tabs.map(([k, label, icon]) => (
            <li className="nav-item" key={k}>
              <button
                type="button"
                className={`nav-link py-1 px-3 border ${mode === k ? 'active' : 'text-body bg-body-tertiary border-0'}`}
                onClick={() => { setMode(k); setMsg(null); }}
                style={{ borderRadius: '999px', fontSize: '.8rem' }}
              ><i className={`fa-solid ${icon} me-1`} />{label}</button>
            </li>
          ))}
        </ul>

        {mode === 'device' ? (
          <div className="vstack gap-3">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <button type="button" className="btn btn-sm btn-outline-primary" disabled={busy}
                onClick={() => void send('connect')}>
                <i className="fa-solid fa-bolt me-1" />Hubungi sekarang
              </button>
              <button type="button" className="btn btn-sm btn-outline-warning" disabled={busy}
                onClick={() => { if (window.confirm('Reboot ONU? Pelanggan terputus ±1–3 menit.')) void send('reboot'); }}>
                <i className="fa-solid fa-rotate-right me-1" />Reboot
              </button>
              <small className="text-muted">Perintah dikirim saat sesi berikutnya — tekan Hubungi agar segera.</small>
            </div>

            <div className="row g-2 align-items-end">
              <div className="col-sm-4">
                <label className="form-label small mb-1">Interval Inform periodik (detik)</label>
                <input className={inputCls} type="number" min={60} max={86400} value={interval}
                  onChange={(e) => setInterval_(e.target.value)} />
              </div>
              <div className="col-sm-8">
                <button type="button" className="btn btn-sm btn-outline-secondary" disabled={busy}
                  onClick={() => void send('config', { type: 'inform-interval', informInterval: Number(interval) })}>
                  Terapkan interval
                </button>
                <small className="text-muted ms-2">300–3600 disarankan; terlalu kecil membebani ONU &amp; ACS.</small>
              </div>
            </div>

            <div className="border border-danger-subtle rounded p-2">
              <div className="small fw-semibold text-danger mb-1"><i className="fa-solid fa-triangle-exclamation me-1" />Reset pabrik</div>
              <div className="small text-muted mb-2">
                Menghapus PPPoE, WiFi, dan seluruh konfigurasi ONU. Bila URL ACS tidak dipasok OLT, ONU bisa
                tidak kembali ke ACS. Hanya admin. Ketik serial <code>{serial}</code> untuk konfirmasi.
              </div>
              <div className="d-flex gap-2">
                <input className={inputCls} style={{ maxWidth: 240 }} value={resetConfirm} placeholder="serial number"
                  onChange={(e) => setResetConfirm(e.target.value)} />
                <button type="button" className="btn btn-sm btn-danger" disabled={busy || resetConfirm !== serial}
                  onClick={() => void send('factory-reset', { confirm: resetConfirm }).then((ok) => ok && setResetConfirm(''))}>
                  Reset pabrik
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            {mode === 'wifi' && (
              <div className="row g-2">
                <div className="col-md-4">
                  <label className="form-label small mb-1">SSID</label>
                  <select className={selectCls} value={wlanIndex}
                    onChange={(e) => setWlanIndex(Number(e.target.value))}>
                    {(insight.wlan.length ? insight.wlan : [{ index: 1, band: null, ssid: null }]).map((w) => (
                      <option key={w.index} value={w.index}>
                        #{w.index}{w.band ? ` · ${w.band}` : ''}{w.ssid ? ` · ${w.ssid}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Nama WiFi (SSID)</label>
                  <input className={inputCls} value={ssid} maxLength={32} onChange={(e) => setSsid(e.target.value)} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Sandi WiFi baru</label>
                  <input className={inputCls} type="text" value={pass} maxLength={63} autoComplete="off"
                    onChange={(e) => setPass(e.target.value)} placeholder="min. 8 karakter, kosong = tetap" />
                  {(() => {
                    const cw = insight.wlan.find((x) => x.index === wlanIndex);
                    return cw?.passphrase
                      ? <div className="small text-muted mt-1">Saat ini: <code className="user-select-all">{cw.passphrase}</code>
                        {cw.passphraseSource === 'acs' ? ' (disetel via ACS)' : ''}</div>
                      : <div className="small text-muted mt-1">Sandi saat ini tidak dikirim ONU.</div>;
                  })()}
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Status SSID</label>
                  <select className={selectCls} value={wifiEnable}
                    onChange={(e) => setWifiEnable(e.target.value as '' | 'on' | 'off')}>
                    <option value="">Tidak diubah</option>
                    <option value="on">Aktifkan</option>
                    <option value="off">Nonaktifkan</option>
                  </select>
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Siaran SSID</label>
                  <select className={selectCls} value={wifiHide}
                    onChange={(e) => setWifiHide(e.target.value as '' | 'show' | 'hide')}>
                    <option value="">Tidak diubah</option>
                    <option value="show">Tampilkan SSID</option>
                    <option value="hide">Sembunyikan SSID (hidden)</option>
                  </select>
                  <div className="small text-muted mt-1">
                    {(() => {
                      const h = insight.wlan.find((x) => x.index === wlanIndex)?.hidden;
                      return h === null || h === undefined ? 'Status siaran belum terbaca.' : `Saat ini: ${h ? 'tersembunyi' : 'tampil'}.`;
                    })()} WiFi tetap aktif; perangkat harus mengetik nama SSID secara manual.
                  </div>
                </div>
              </div>
            )}

            {(mode === 'pppoe' || mode === 'vlan') && (
              <div className="row g-2">
                <div className="col-12">
                  <label className="form-label small mb-1">Koneksi WAN</label>
                  {(mode === 'pppoe' ? pppConns : insight.wan).length ? (
                    <select className={selectCls} value={target} onChange={(e) => setTarget(e.target.value)}>
                      {(mode === 'pppoe' ? pppConns : insight.wan).map((c) => (
                        <option key={c.base} value={c.base}>{wanLabel(c)}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="alert alert-warning py-2 small mb-0">
                      Belum ada koneksi {mode === 'pppoe' ? 'PPPoE' : 'WAN'} terdeteksi. Tekan <b>Segarkan</b> /
                      <b> Pelajari struktur</b>, atau gunakan tab <b>WAN Internet</b>.
                    </div>
                  )}
                  {target && <div className="form-text font-monospace small">{target}</div>}
                </div>
                {mode === 'pppoe' && (
                  <>
                    <div className="col-md-6">
                      <label className="form-label small mb-1">Username PPPoE</label>
                      <input className={inputCls} value={user} maxLength={128} onChange={(e) => setUser(e.target.value)} placeholder="user@isp" />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small mb-1">Password PPPoE baru</label>
                      <input className={inputCls} value={pppPass} maxLength={128} autoComplete="off"
                        onChange={(e) => setPppPass(e.target.value)} placeholder="kosong = tetap" />
                      <div className="small text-muted mt-1">
                        {conn?.password
                          ? <>Saat ini: <code className="user-select-all">{conn.password}</code>{conn.passwordSource === 'acs' ? ' (disetel via ACS)' : ''}</>
                          : 'Sandi saat ini tidak dikirim ONU.'}
                      </div>
                    </div>
                  </>
                )}
                <div className="col-md-3">
                  <label className="form-label small mb-1">VLAN ID</label>
                  <input className={inputCls} type="number" min={1} max={4094} value={vlanId} required={mode === 'vlan'}
                    onChange={(e) => setVlanId(e.target.value)} placeholder="1..4094" />
                </div>
                {mode === 'pppoe' && !is181 && (
                  <div className="col-md-3">
                    <label className="form-label small mb-1">Service List</label>
                    <input className={inputCls} value={service} maxLength={64} onChange={(e) => setService(e.target.value)} placeholder="INTERNET" />
                  </div>
                )}
                {conn?.vlanPath && (
                  <div className="col-md-6 small text-muted align-self-end">
                    VLAN terbaca di <code>{conn.vlanPath.split('.').slice(-2).join('.')}</code>
                  </div>
                )}
              </div>
            )}

            {mode === 'wan-add' && (
              <div className="row g-2">
                <div className="col-md-3">
                  <label className="form-label small mb-1">Jenis</label>
                  <select className={selectCls} value={wanKind} onChange={(e) => { setWanKind(e.target.value as 'pppoe' | 'ip'); setConnType(''); setLocTouched(false); }}>
                    <option value="pppoe">PPPoE</option>
                    <option value="ip">IPoE (DHCP / Static)</option>
                  </select>
                </div>
                <div className="col-md-3">
                  <label className="form-label small mb-1">Mode</label>
                  <select className={selectCls} value={bridge ? 'bridge' : 'route'} onChange={(e) => { setBridge(e.target.value === 'bridge'); setConnType(''); }}>
                    <option value="route">Route (NAT)</option>
                    <option value="bridge">Bridge</option>
                  </select>
                </div>
                <div className="col-md-6">
                  <label className="form-label small mb-1">ConnectionType</label>
                  <select className={selectCls} value={connType} onChange={(e) => setConnType(e.target.value)}>
                    <option value="">Otomatis (ikuti nilai yang dipakai ONU)</option>
                    {connTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="col-12">
                  <label className="form-label small mb-1">Lokasi WAN</label>
                  <select className={selectCls} value={location} onChange={(e) => { setLocation(e.target.value); setLocTouched(true); }}>
                    {locations.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <div className="form-text small">
                    {is181
                      ? 'TR-181: hanya pengisian koneksi PPP yang sudah ada yang didukung.'
                      : locExisting
                        ? 'Koneksi ini dinonaktifkan sebentar, diisi, lalu diaktifkan lagi.'
                        : 'ONU yang slot WAN-nya disiapkan OLT (mis. FiberHome WCD 2 · #1) sebaiknya diisi, bukan dibuat baru.'}
                  </div>
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Nama koneksi</label>
                  <input className={inputCls} value={wanName} maxLength={32} onChange={(e) => setWanName(e.target.value)}
                    placeholder={locExisting ? 'kosong = tetap' : wanKind === 'pppoe' ? 'INTERNET' : 'WAN_IP'} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">VLAN ID</label>
                  <input className={inputCls} type="number" min={1} max={4094} value={vlanId} onChange={(e) => setVlanId(e.target.value)} placeholder="mis. 100" />
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Service List</label>
                  <input className={inputCls} value={service} maxLength={64} onChange={(e) => setService(e.target.value)}
                    placeholder="INTERNET" list="cfg-services" />
                  <datalist id="cfg-services">{SERVICE_OPTIONS.map((o) => <option key={o} value={o} />)}</datalist>
                </div>
                {wanKind === 'pppoe' && (
                  <>
                    <div className="col-md-6">
                      <label className="form-label small mb-1">Username PPPoE</label>
                      <input className={inputCls} value={user} maxLength={128} required={!locExisting}
                        onChange={(e) => setUser(e.target.value)} placeholder="user@isp" />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small mb-1">Password PPPoE</label>
                      <input className={inputCls} value={pppPass} maxLength={128} required={!locExisting} autoComplete="off"
                        onChange={(e) => setPppPass(e.target.value)} placeholder={locExisting ? 'kosong = tetap' : ''} />
                    </div>
                  </>
                )}
                {wanKind === 'ip' && !bridge && (
                  <>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">IP statis</label>
                      <input className={inputCls} value={ipStatic} maxLength={45} onChange={(e) => setIpStatic(e.target.value)} placeholder="kosong = DHCP" />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">Netmask</label>
                      <input className={inputCls} value={netmask} maxLength={18} onChange={(e) => setNetmask(e.target.value)} />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">Gateway</label>
                      <input className={inputCls} value={gateway} maxLength={45} onChange={(e) => setGateway(e.target.value)} />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">DNS</label>
                      <input className={inputCls} value={dns} maxLength={64} onChange={(e) => setDns(e.target.value)} placeholder="8.8.8.8,1.1.1.1" />
                    </div>
                  </>
                )}
                {!bridge && (
                  <div className="col-12">
                    <div className="form-check form-switch mb-0">
                      <input className="form-check-input" type="checkbox" id="cfg-nat" checked={nat}
                        onChange={(e) => { setNat(e.target.checked); setNatTouched(true); }} />
                      <label className="form-check-label small" htmlFor="cfg-nat">
                        NAT <span className="text-muted">— aktif untuk WAN internet; matikan untuk layanan TR069 / VOIP</span>
                      </label>
                    </div>
                  </div>
                )}
                <div className="col-12">
                  <BindingPicker caps={caps} lan={bindLan} ssid={bindSsid}
                    onChange={(l, w) => { setBindLan(l); setBindSsid(w); setBindTouched(true); }} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1">Pengiriman</label>
                  <select className={selectCls} value={sequential} onChange={(e) => setSequential(e.target.value as '' | 'yes' | 'no')}>
                    <option value="">Otomatis (bertahap untuk CMCC)</option>
                    <option value="yes">Bertahap (1 parameter per perintah)</option>
                    <option value="no">Dikelompokkan</option>
                  </select>
                </div>
                <div className="col-12">
                  <details>
                    <summary className="small text-muted">Parameter tambahan (lanjutan)</summary>
                    <textarea className="form-control font-monospace mt-2" rows={3} style={{ fontSize: '.78rem' }}
                      value={extra} onChange={(e) => setExtra(e.target.value)}
                      placeholder={'# satu per baris, relatif ke koneksi atau path absolut\nX_HW_PRI = 0\nX_ZTE-COM_IPMode = 1'} />
                  </details>
                </div>
              </div>
            )}

            {mode === 'bind' && (
              <div className="row g-2">
                <div className="col-12">
                  <label className="form-label small mb-1">Koneksi WAN</label>
                  {insight.wan.length ? (
                    <select className={selectCls} value={target} onChange={(e) => { setTarget(e.target.value); setBindTouched(false); }}>
                      {insight.wan.map((c) => <option key={c.base} value={c.base}>{wanLabel(c)}</option>)}
                    </select>
                  ) : (
                    <div className="alert alert-warning py-2 small mb-0">Belum ada koneksi WAN terdeteksi.</div>
                  )}
                  {conn?.binding && (
                    <div className="form-text small">
                      Saat ini: LAN {conn.binding.lan.join(',') || '—'} · SSID {conn.binding.ssid.join(',') || '—'}
                      {conn.bindingPath && <> · <code>{conn.bindingPath.replace(/\.$/, '').split('.').pop()}</code></>}
                    </div>
                  )}
                </div>
                <div className="col-12">
                  <BindingPicker caps={caps} lan={bindLan} ssid={bindSsid}
                    onChange={(l, w) => { setBindLan(l); setBindSsid(w); setBindTouched(true); }} />
                </div>
              </div>
            )}

            <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
              <button className="btn btn-primary btn-sm px-4"
                disabled={busy || ((mode === 'pppoe' || mode === 'vlan' || mode === 'bind') && !target)}>
                {busy ? 'Mengantre…' : 'Terapkan'}
              </button>
              <small className="text-muted">Dikirim saat ONU berikutnya Inform — tekan <b>Hubungi</b> agar segera.</small>
            </div>
          </form>
        )}

        {msg && (
          <div className="mt-3">
            {msg.error && <div className="alert alert-danger py-2 small mb-2">{msg.error}</div>}
            {msg.queued ? (
              <div className="alert alert-success py-2 small mb-1">
                <i className="fa-solid fa-check me-1" />Diantrekan:
                <ul className="mb-0 ps-3">{msg.plan?.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            ) : null}
            {msg.guessed?.length ? (
              <div className="small text-warning mb-1">
                <i className="fa-solid fa-triangle-exclamation me-1" />
                Nama parameter vendor belum terbukti di perangkat ini (tebakan): <code>{msg.guessed.join(', ')}</code>
              </div>
            ) : null}
            {msg.skipped?.length ? (
              <ul className="small text-danger mb-0 ps-3">{msg.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pilihan port yang di-binding ke WAN: LAN fisik dan SSID yang ada di ONU.
 * FiberHome wajib binding (X_FH_LanInterface) — WAN internet tanpa binding
 * tidak meneruskan trafik klien.
 */
function BindingPicker({ caps, lan, ssid, onChange }: {
  caps: WanCaps;
  lan: number[];
  ssid: number[];
  onChange: (lan: number[], ssid: number[]) => void;
}) {
  const flip = (list: number[], n: number) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b));
  const allSsid = caps.ssids.map((s) => s.index);
  return (
    <div className="binding-picker">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
        <span className="form-label small mb-0">Binding port</span>
        {caps.bindingRequired
          ? <span className="badge text-bg-warning">wajib untuk {caps.family === 'fiberhome' ? 'FiberHome' : caps.family}</span>
          : <span className="badge text-bg-light border">opsional</span>}
        {caps.bindingParam && <code className="small">{caps.bindingParam}</code>}
        <span className="ms-auto d-flex gap-1">
          <button type="button" className="btn btn-sm btn-link py-0" onClick={() => onChange(caps.lanPorts, allSsid)}>Semua</button>
          <button type="button" className="btn btn-sm btn-link py-0 text-muted" onClick={() => onChange([], [])}>Kosongkan</button>
        </span>
      </div>
      <div className="d-flex flex-wrap gap-1 mb-1" role="group" aria-label="Port LAN">
        {caps.lanPorts.map((n) => (
          <button key={`l${n}`} type="button" aria-pressed={lan.includes(n)}
            className={`btn btn-sm ${lan.includes(n) ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => onChange(flip(lan, n), ssid)}>
            <i className="fa-solid fa-ethernet me-1" />LAN{n}
          </button>
        ))}
      </div>
      <div className="d-flex flex-wrap gap-1" role="group" aria-label="SSID">
        {caps.ssids.map((w) => (
          <button key={`s${w.index}`} type="button" aria-pressed={ssid.includes(w.index)}
            className={`btn btn-sm ${ssid.includes(w.index) ? 'btn-primary' : 'btn-outline-secondary'}`}
            title={w.ssid ?? undefined} onClick={() => onChange(lan, flip(ssid, w.index))}>
            <i className="fa-solid fa-wifi me-1" />SSID{w.index}{w.band ? <span className="opacity-75"> · {w.band}</span> : null}
          </button>
        ))}
      </div>
      {caps.bindingRequired && !lan.length && !ssid.length && (
        <div className="small text-danger mt-1">
          <i className="fa-solid fa-triangle-exclamation me-1" />Tanpa binding, klien LAN/WiFi tidak mendapat internet dari WAN ini.
        </div>
      )}
    </div>
  );
}
