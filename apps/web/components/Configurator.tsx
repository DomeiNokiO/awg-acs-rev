'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type DeviceInsight, type WanConn } from '@/lib/api';

/**
 * Konfigurasi terstruktur perangkat: WiFi, PPPoE, VLAN, WAN internet
 * (PPPoE/IPoE), dan perintah perangkat (reboot, reset pabrik, interval Inform).
 *
 * Form hanya mengirim NILAI + lokasi. Nama parameter vendor
 * (X_HW_VLAN, X_ZTE-COM_VLANID, X_FH_WANGponLinkConfig, X_CMCC_VLANIDMark, …)
 * dipilih server (configure.ts + vendorwan.ts) dari path yang terbukti ada
 * di perangkat, sehingga teknisi tidak perlu hafal struktur tiap merek ONU.
 */

export type ConfigMode = 'wifi' | 'pppoe' | 'vlan' | 'wan-add' | 'device';

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

/** Slot WAN yang belum terisi kredensial/konfigurasi (biasanya dibuat OLT). */
const isEmptySlot = (c: WanConn): boolean =>
  c.kind === 'ppp' ? !c.username : !c.externalIp || c.externalIp === '0.0.0.0';

export function Configurator({ deviceId, serial, insight, preset, onQueued }: {
  deviceId: string;
  serial: string;
  insight: DeviceInsight;
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
    setLocation(empty ? `existing|${empty.base}` : 'new');
  }, [mode, wanKind, locations]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } else if (mode === 'pppoe') {
      body.target = target;
      if (user && user !== conn?.username) body.username = user;
      if (pppPass) body.password = pppPass;
      if (vlanId && vlanId !== conn?.vlan) body.vlanId = Number(vlanId);
      if (service && service !== conn?.serviceList) body.serviceName = service;
    } else if (mode === 'vlan') {
      body.target = target;
      body.vlanId = Number(vlanId);
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
      if (bindLan.length || bindSsid.length) { body.bindLan = bindLan; body.bindSsid = bindSsid; }
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
    ['device', 'Perangkat', 'fa-power-off'],
  ];

  const is181 = insight.dataModel === 'TR-181';
  const toggle = (list: number[], set: (v: number[]) => void, n: number) =>
    set(list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort());
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
                  <input className={inputCls} value={service} maxLength={64} onChange={(e) => setService(e.target.value)} placeholder="INTERNET" />
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
                <div className="col-md-8">
                  <label className="form-label small mb-1 d-block">Binding port (opsional)</label>
                  {[1, 2, 3, 4].map((n) => (
                    <label key={`l${n}`} className="form-check form-check-inline small mb-0">
                      <input className="form-check-input" type="checkbox" checked={bindLan.includes(n)} onChange={() => toggle(bindLan, setBindLan, n)} />
                      LAN{n}
                    </label>
                  ))}
                  {[1, 2, 3, 4].map((n) => (
                    <label key={`s${n}`} className="form-check form-check-inline small mb-0">
                      <input className="form-check-input" type="checkbox" checked={bindSsid.includes(n)} onChange={() => toggle(bindSsid, setBindSsid, n)} />
                      SSID{n}
                    </label>
                  ))}
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

            <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
              <button className="btn btn-primary btn-sm px-4"
                disabled={busy || ((mode === 'pppoe' || mode === 'vlan') && !target)}>
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
