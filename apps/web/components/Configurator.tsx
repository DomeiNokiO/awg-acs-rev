'use client';

import { useEffect, useState } from 'react';
import { api, type DeviceInsight, type WanConn } from '@/lib/api';

/**
 * Konfigurasi terstruktur perangkat: WiFi, PPPoE, VLAN, buat WAN.
 *
 * Form hanya mengirim NILAI + target koneksi. Penentuan nama parameter
 * vendor (X_HW_VLAN, X_ZTE-COM_VLANID, X_CT-COM_WANGponLinkConfig, …)
 * dilakukan server (configure.ts) berdasarkan path yang terbukti ada di
 * perangkat, sehingga teknisi tidak perlu hafal struktur tiap merek ONU.
 *
 * Tidak ada tombol reboot / factory reset di panel ini — perintah itu
 * memutus pelanggan dan sengaja dijauhkan dari alur konfigurasi biasa.
 */

export type ConfigMode = 'wifi' | 'pppoe' | 'vlan' | 'wan-add';

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
}

const inputCls = 'form-control form-control-sm';

export function wanLabel(c: WanConn): string {
  const kind = c.kind === 'ppp' ? 'PPPoE' : 'IP';
  const where = c.wcd !== null ? `WCD ${c.wcd}` : `#${c.instance}`;
  const who = c.name || c.username || '';
  return `${kind} · ${where}${who ? ` · ${who}` : ''}${c.vlan ? ` · VLAN ${c.vlan}` : ''}`;
}

export function Configurator({ deviceId, insight, preset, onQueued }: {
  deviceId: string;
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
  // wan-add
  const [wanKind, setWanKind] = useState<'pppoe' | 'ip'>('pppoe');
  const [bridge, setBridge] = useState(false);
  const [wanName, setWanName] = useState('INTERNET');
  const [ipStatic, setIpStatic] = useState('');
  const [netmask, setNetmask] = useState('255.255.255.0');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');
  const [extra, setExtra] = useState('');

  // Isi otomatis dari kondisi perangkat saat target berganti.
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

  // Preset dari tombol "Ubah" di tab Ringkasan.
  useEffect(() => {
    if (!preset) return;
    setMode(preset.mode);
    setMsg(null);
    if (preset.wlanIndex) setWlanIndex(preset.wlanIndex);
    if (preset.target) setTarget(preset.target);
  }, [preset]);

  // Target default: PPPoE utama untuk mode PPPoE, koneksi pertama untuk VLAN.
  useEffect(() => {
    if (mode === 'pppoe' && !pppConns.some((c) => c.base === target)) {
      setTarget((pppConns.find((c) => c.username) ?? pppConns[0])?.base ?? '');
    } else if (mode === 'vlan' && !insight.wan.some((c) => c.base === target)) {
      setTarget(insight.wan[0]?.base ?? '');
    }
  }, [mode, insight]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
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
      } else {
        body.type = wanKind === 'pppoe' ? 'wan-add' : 'wan-ip-add';
        body.name = wanName;
        body.bridge = bridge;
        if (vlanId) body.vlanId = Number(vlanId);
        if (service) body.serviceName = service;
        if (extra.trim()) body.extra = extra;
        if (wanKind === 'pppoe') {
          body.username = user;
          body.password = pppPass;
        } else if (ipStatic) {
          body.staticIp = ipStatic;
          body.netmask = netmask;
          if (gateway) body.gateway = gateway;
          if (dns) body.dns = dns;
        }
      }
      const r = await api<Report>(`/api/devices/${encodeURIComponent(deviceId)}/config`, {
        method: 'POST', body,
      });
      setMsg(r);
      if (r.queued) {
        setPass(''); setPppPass('');
        onQueued();
      }
    } catch (err) {
      setMsg({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const tabs: [ConfigMode, string, string][] = [
    ['wifi', 'WiFi', 'fa-wifi'],
    ['pppoe', 'PPPoE', 'fa-user-lock'],
    ['vlan', 'VLAN', 'fa-tags'],
    ['wan-add', 'Buat WAN', 'fa-plus'],
  ];

  const is181 = insight.dataModel === 'TR-181';

  return (
    <div className="card border-0 shadow-sm mb-3">
      <div className="card-body">
        <div className="d-flex align-items-center mb-2">
          <i className="fa-solid fa-sliders text-primary me-2" />
          <strong className="small text-uppercase">Konfigurasi ONU</strong>
          <span className="badge badge-soft ms-2" style={{ fontSize: '.68rem' }}>tanpa reboot</span>
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

        <form onSubmit={submit}>
          {mode === 'wifi' && (
            <div className="row g-2">
              <div className="col-md-4">
                <label className="form-label small mb-1">SSID</label>
                <select className="form-select form-select-sm" value={wlanIndex}
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
                <input className={inputCls} value={ssid} maxLength={32}
                  onChange={(e) => setSsid(e.target.value)} />
              </div>
              <div className="col-md-4">
                <label className="form-label small mb-1">Sandi WiFi baru</label>
                <input className={inputCls} type="text" value={pass} maxLength={63} autoComplete="off"
                  onChange={(e) => setPass(e.target.value)} placeholder="min. 8 karakter, kosong = tetap" />
              </div>
              <div className="col-md-4">
                <label className="form-label small mb-1">Status SSID</label>
                <select className="form-select form-select-sm" value={wifiEnable}
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
                  <select className="form-select form-select-sm" value={target}
                    onChange={(e) => setTarget(e.target.value)}>
                    {(mode === 'pppoe' ? pppConns : insight.wan).map((c) => (
                      <option key={c.base} value={c.base}>{wanLabel(c)}</option>
                    ))}
                  </select>
                ) : (
                  <div className="alert alert-warning py-2 small mb-0">
                    Belum ada koneksi {mode === 'pppoe' ? 'PPPoE' : 'WAN'} terdeteksi. Tekan <b>Segarkan</b> /
                    <b> Pelajari struktur</b>, atau gunakan <b>Buat WAN</b>.
                  </div>
                )}
                {target && <div className="form-text font-monospace small">{target}</div>}
              </div>
              {mode === 'pppoe' && (
                <>
                  <div className="col-md-6">
                    <label className="form-label small mb-1">Username PPPoE</label>
                    <input className={inputCls} value={user} maxLength={128}
                      onChange={(e) => setUser(e.target.value)} placeholder="user@isp" />
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
                <input className={inputCls} type="number" min={1} max={4094} value={vlanId}
                  required={mode === 'vlan'}
                  onChange={(e) => setVlanId(e.target.value)} placeholder="1..4094" />
              </div>
              {mode === 'pppoe' && !is181 && (
                <div className="col-md-3">
                  <label className="form-label small mb-1">Service List</label>
                  <input className={inputCls} value={service} maxLength={64}
                    onChange={(e) => setService(e.target.value)} placeholder="INTERNET" />
                </div>
              )}
              {conn?.vlanPath && (
                <div className="col-md-6 small text-muted align-self-end">
                  VLAN ditulis ke <code>{conn.vlanPath.split('.').slice(-2).join('.')}</code>
                </div>
              )}
            </div>
          )}

          {mode === 'wan-add' && (
            is181 ? (
              <div className="alert alert-warning py-2 small mb-0">
                Buat WAN otomatis belum didukung untuk perangkat TR-181. Gunakan tab <b>Perintah → AddObject</b>.
              </div>
            ) : (
              <div className="row g-2">
                <div className="col-md-3">
                  <label className="form-label small mb-1">Jenis</label>
                  <select className="form-select form-select-sm" value={wanKind}
                    onChange={(e) => setWanKind(e.target.value as 'pppoe' | 'ip')}>
                    <option value="pppoe">PPPoE</option>
                    <option value="ip">IP (DHCP/Static)</option>
                  </select>
                </div>
                <div className="col-md-3">
                  <label className="form-label small mb-1">Mode</label>
                  <select className="form-select form-select-sm" value={bridge ? 'bridge' : 'route'}
                    onChange={(e) => setBridge(e.target.value === 'bridge')}>
                    <option value="route">Route (NAT)</option>
                    <option value="bridge">Bridge</option>
                  </select>
                </div>
                <div className="col-md-3">
                  <label className="form-label small mb-1">Nama koneksi</label>
                  <input className={inputCls} value={wanName} maxLength={32}
                    onChange={(e) => setWanName(e.target.value)} />
                </div>
                <div className="col-md-3">
                  <label className="form-label small mb-1">VLAN ID</label>
                  <input className={inputCls} type="number" min={1} max={4094} value={vlanId}
                    onChange={(e) => setVlanId(e.target.value)} placeholder="mis. 100" />
                </div>
                {wanKind === 'pppoe' && (
                  <>
                    <div className="col-md-4">
                      <label className="form-label small mb-1">Username PPPoE</label>
                      <input className={inputCls} value={user} maxLength={128} required
                        onChange={(e) => setUser(e.target.value)} placeholder="user@isp" />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small mb-1">Password PPPoE</label>
                      <input className={inputCls} value={pppPass} maxLength={128} required autoComplete="off"
                        onChange={(e) => setPppPass(e.target.value)} />
                    </div>
                  </>
                )}
                {wanKind === 'ip' && !bridge && (
                  <>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">IP statis</label>
                      <input className={inputCls} value={ipStatic} maxLength={45}
                        onChange={(e) => setIpStatic(e.target.value)} placeholder="kosong = DHCP" />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">Netmask</label>
                      <input className={inputCls} value={netmask} maxLength={18}
                        onChange={(e) => setNetmask(e.target.value)} />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">Gateway</label>
                      <input className={inputCls} value={gateway} maxLength={45}
                        onChange={(e) => setGateway(e.target.value)} />
                    </div>
                    <div className="col-md-3">
                      <label className="form-label small mb-1">DNS</label>
                      <input className={inputCls} value={dns} maxLength={64}
                        onChange={(e) => setDns(e.target.value)} placeholder="8.8.8.8,1.1.1.1" />
                    </div>
                  </>
                )}
                <div className="col-md-4">
                  <label className="form-label small mb-1">Service List</label>
                  <input className={inputCls} value={service} maxLength={64}
                    onChange={(e) => setService(e.target.value)} placeholder="INTERNET" />
                </div>
                <div className="col-12">
                  <details>
                    <summary className="small text-muted">Parameter tambahan (lanjutan)</summary>
                    <textarea className="form-control font-monospace mt-2" rows={3} style={{ fontSize: '.78rem' }}
                      value={extra} onChange={(e) => setExtra(e.target.value)}
                      placeholder={'# satu per baris, relatif ke koneksi baru atau path absolut\nX_HW_LANBIND.Lan1Enable = 1\nX_ZTE-COM_IPMode = 1'} />
                  </details>
                </div>
              </div>
            )
          )}

          <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
            <button className="btn btn-primary btn-sm px-4"
              disabled={busy || ((mode === 'pppoe' || mode === 'vlan') && !target) || (mode === 'wan-add' && is181)}>
              {busy ? 'Mengantre…' : 'Terapkan'}
            </button>
            <small className="text-muted">
              Dikirim saat ONU berikutnya Inform — tekan <b>Hubungi</b> agar segera.
            </small>
          </div>
        </form>

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
              <ul className="small text-danger mb-0 ps-3">
                {msg.skipped.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
