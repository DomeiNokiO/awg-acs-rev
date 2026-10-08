'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

interface Condition {
  attr: 'manufacturer' | 'oui' | 'productClass' | 'serialNumber' | 'softwareVersion' | 'groupName' | 'tags' | 'param';
  op: 'eq' | 'neq' | 'contains' | 'startsWith' | 'exists' | 'gt' | 'lt';
  value: string;
  path?: string;
}

interface Action {
  kind: 'get' | 'set' | 'refresh' | 'reboot' | 'factoryReset';
  path?: string;
  value?: string;
  type?: string;
}

interface Preset {
  id?: number;
  name: string;
  enabled: 0 | 1;
  priority: number;
  intervalHours: number;
  conditions: Condition[];
  actions: Action[];
}

export default function PresetEditorPage() {
  return <Shell><Suspense fallback={<div>Memuat...</div>}><PresetEditorBody /></Suspense></Shell>;
}

function PresetEditorBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const idParam = searchParams.get('id');
  const isNew = !idParam || idParam === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [preset, setPreset] = useState<Preset>({
    name: '',
    enabled: 1,
    priority: 10,
    intervalHours: 24,
    conditions: [],
    actions: [],
  });

  useEffect(() => {
    if (isNew) return;
    let alive = true;
    api<{ items: Preset[] }>('/api/presets')
      .then((r) => {
        if (!alive) return;
        const p = r.items.find(x => x.id === Number(idParam));
        if (p) setPreset(p);
        else setErr('Preset tidak ditemukan');
      })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isNew, idParam]);

  const setField = (field: keyof Preset, val: unknown) => setPreset(prev => ({ ...prev, [field]: val }));

  const addCondition = () => setPreset(prev => ({
    ...prev,
    conditions: [...prev.conditions, { attr: 'manufacturer', op: 'eq', value: '' }]
  }));

  const removeCondition = (idx: number) => setPreset(prev => ({
    ...prev,
    conditions: prev.conditions.filter((_, i) => i !== idx)
  }));

  const updateCondition = (idx: number, field: keyof Condition, val: string) => setPreset(prev => {
    const newCond = [...prev.conditions];
    newCond[idx] = { ...newCond[idx], [field]: val };
    return { ...prev, conditions: newCond };
  });

  const addAction = () => setPreset(prev => ({
    ...prev,
    actions: [...prev.actions, { kind: 'get' }]
  }));

  const removeAction = (idx: number) => setPreset(prev => ({
    ...prev,
    actions: prev.actions.filter((_, i) => i !== idx)
  }));

  const updateAction = (idx: number, field: keyof Action, val: string) => setPreset(prev => {
    const newAct = [...prev.actions];
    newAct[idx] = { ...newAct[idx], [field]: val };
    return { ...prev, actions: newAct };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    // Klien validasi
    if (!preset.name.trim()) return setErr('Nama preset wajib diisi.');
    
    for (let i = 0; i < preset.conditions.length; i++) {
      const c = preset.conditions[i];
      if (c.attr === 'param' && !c.path?.trim()) return setErr(`Kondisi #${i + 1}: Path wajib diisi untuk atribut parameter.`);
    }

    for (let i = 0; i < preset.actions.length; i++) {
      const a = preset.actions[i];
      if (['get', 'refresh', 'set'].includes(a.kind) && !a.path?.trim()) return setErr(`Aksi #${i + 1}: Path wajib diisi untuk aksi ${a.kind}.`);
      if (a.kind === 'set' && (a.value === undefined || a.value === '')) return setErr(`Aksi #${i + 1}: Value wajib diisi untuk aksi set.`);
    }

    setBusy(true);
    try {
      if (isNew) {
        await api('/api/presets', { method: 'POST', body: preset });
      } else {
        await api(`/api/presets/${preset.id}`, { method: 'PUT', body: preset });
      }
      router.push('/presets');
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (loading) return <div>Memuat...</div>;

  return (
    <>
      <div className="d-flex align-items-center mb-3">
        <Link href="/presets" className="btn btn-sm btn-outline-secondary me-3">
          <i className="fa-solid fa-arrow-left" />
        </Link>
        <h1 className="h4 mb-0 fw-bold">{isNew ? 'Tambah Preset' : 'Edit Preset'}</h1>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card mb-4">
          <div className="card-header"><h3 className="card-title">Umum</h3></div>
          <div className="card-body">
            <div className="row">
              <div className="col-md-6 mb-3">
                <label className="form-label small">Nama Preset</label>
                <input type="text" className="form-control" value={preset.name} onChange={(e) => setField('name', e.target.value)} required />
              </div>
              <div className="col-md-2 mb-3">
                <label className="form-label small">Prioritas</label>
                <input type="number" className="form-control" value={preset.priority} onChange={(e) => setField('priority', Number(e.target.value))} />
              </div>
              <div className="col-md-2 mb-3">
                <label className="form-label small">Interval (jam)</label>
                <input type="number" className="form-control" value={preset.intervalHours} onChange={(e) => setField('intervalHours', Number(e.target.value))} />
              </div>
              <div className="col-md-2 mb-3 d-flex align-items-end pb-2">
                <div className="form-check form-switch">
                  <input className="form-check-input" type="checkbox" id="presetEnabled" checked={preset.enabled === 1} onChange={(e) => setField('enabled', e.target.checked ? 1 : 0)} />
                  <label className="form-check-label" htmlFor="presetEnabled">Aktif</label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card mb-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <h3 className="card-title">Kondisi</h3>
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={addCondition}>
              <i className="fa-solid fa-plus" /> Tambah
            </button>
          </div>
          <div className="card-body p-0 table-responsive">
            <table className="table mb-0">
              <thead className="table-light">
                <tr>
                  <th style={{ width: '20%' }}>Atribut</th>
                  <th style={{ width: '30%' }}>Path (jika param)</th>
                  <th style={{ width: '15%' }}>Operator</th>
                  <th style={{ width: '25%' }}>Nilai</th>
                  <th style={{ width: '10%' }}></th>
                </tr>
              </thead>
              <tbody>
                {preset.conditions.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-muted py-3">Terapkan ke semua perangkat (tanpa kondisi).</td></tr>
                )}
                {preset.conditions.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <select className="form-select form-select-sm" value={c.attr} onChange={(e) => updateCondition(i, 'attr', e.target.value)}>
                        <option value="manufacturer">Manufacturer</option>
                        <option value="oui">OUI</option>
                        <option value="productClass">Product Class</option>
                        <option value="serialNumber">Serial Number</option>
                        <option value="softwareVersion">Software Version</option>
                        <option value="groupName">Group Name</option>
                        <option value="tags">Tags</option>
                        <option value="param">Parameter (TR-069)</option>
                      </select>
                    </td>
                    <td>
                      {c.attr === 'param' ? (
                        <input type="text" className="form-control form-control-sm param-path" placeholder="InternetGatewayDevice..." value={c.path || ''} onChange={(e) => updateCondition(i, 'path', e.target.value)} />
                      ) : (
                        <span className="text-muted small">—</span>
                      )}
                    </td>
                    <td>
                      <select className="form-select form-select-sm" value={c.op} onChange={(e) => updateCondition(i, 'op', e.target.value)}>
                        <option value="eq">=</option>
                        <option value="neq">!=</option>
                        <option value="contains">contains</option>
                        <option value="startsWith">starts with</option>
                        <option value="exists">exists</option>
                        <option value="gt">&gt;</option>
                        <option value="lt">&lt;</option>
                      </select>
                    </td>
                    <td>
                      {c.op !== 'exists' && (
                        <input type="text" className="form-control form-control-sm" value={c.value} onChange={(e) => updateCondition(i, 'value', e.target.value)} />
                      )}
                    </td>
                    <td className="text-end">
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeCondition(i)}>
                        <i className="fa-solid fa-times" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card mb-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <h3 className="card-title">Aksi</h3>
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={addAction}>
              <i className="fa-solid fa-plus" /> Tambah
            </button>
          </div>
          <div className="card-body p-0 table-responsive">
            <table className="table mb-0">
              <thead className="table-light">
                <tr>
                  <th style={{ width: '15%' }}>Jenis</th>
                  <th style={{ width: '35%' }}>Path</th>
                  <th style={{ width: '15%' }}>Tipe</th>
                  <th style={{ width: '25%' }}>Nilai</th>
                  <th style={{ width: '10%' }}></th>
                </tr>
              </thead>
              <tbody>
                {preset.actions.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-muted py-3">Tidak ada aksi. Tambahkan setidaknya satu.</td></tr>
                )}
                {preset.actions.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <select className="form-select form-select-sm" value={a.kind} onChange={(e) => updateAction(i, 'kind', e.target.value)}>
                        <option value="get">Get</option>
                        <option value="set">Set</option>
                        <option value="refresh">Refresh</option>
                        <option value="reboot">Reboot</option>
                        <option value="factoryReset">Factory Reset</option>
                      </select>
                    </td>
                    <td>
                      {['get', 'set', 'refresh'].includes(a.kind) ? (
                        <input type="text" className="form-control form-control-sm param-path" placeholder="Path..." value={a.path || ''} onChange={(e) => updateAction(i, 'path', e.target.value)} />
                      ) : (
                        <span className="text-muted small">—</span>
                      )}
                    </td>
                    <td>
                      {a.kind === 'set' ? (
                        <select className="form-select form-select-sm" value={a.type || 'xsd:string'} onChange={(e) => updateAction(i, 'type', e.target.value)}>
                          <option value="xsd:string">string</option>
                          <option value="xsd:unsignedInt">unsignedInt</option>
                          <option value="xsd:int">int</option>
                          <option value="xsd:boolean">boolean</option>
                        </select>
                      ) : (
                        <span className="text-muted small">—</span>
                      )}
                    </td>
                    <td>
                      {a.kind === 'set' && (
                        <input type="text" className="form-control form-control-sm" value={a.value || ''} onChange={(e) => updateAction(i, 'value', e.target.value)} />
                      )}
                    </td>
                    <td className="text-end">
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeAction(i)}>
                        <i className="fa-solid fa-times" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Menyimpan...' : 'Simpan Preset'}
        </button>
      </form>
    </>
  );
}