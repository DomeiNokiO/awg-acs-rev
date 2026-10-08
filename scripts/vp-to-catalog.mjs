#!/usr/bin/env node
/**
 * Eksportir mapping parameter kaya (virtualParameters paimo54) -> ACS custom.
 *
 * GenieACS menyimpan parameter kustom di dua koleksi dump:
 *   - virtualParameters.bson : definisi VP (script/ekspresi eval GenieACS)
 *   - config.bson            : nilai parameter per device (_id = deviceId)
 *
 * PAKAIAN:  node scripts/vp-to-catalog.mjs <repo-parameter-dir> [out-mapping.json]
 *
 * Menghasilkan JSON:
 *   {
 *     "version": "1.0.0",
 *     "generatedAt": "...",
 *     "virtualParameters": [ { name, label, kind, path, unit, deviceHint, script } ],
 *     "configSample": { deviceId: { name: value } },
 *     "deviceFields": { "Optic Rx Power": { path, ... }, ... }   // peta kolom UI
 *   }
 *
 * Tabel kolom UI custom dibangun dari virtualParameters + config: nama VP
 * (RXPower, gettemp, pppoeUsername, ...) dipetakan ke label ramah
 * (Optic Rx Power, Temperatur, PPPoE Username, ...) lewat kamus kecil.
 * Nilai aktual diambil dari config (per-device) atau dari devices.bson
 * (pohon TR-069) — skrip ini hanya membuat MAP, bukan menulis ke DB.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSON } from 'bson';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('Pemakaian: node scripts/vp-to-catalog.mjs <repo-parameter-dir> [out-mapping.json]');
  process.exit(2);
}

function readBsonSeq(file) {
  const buf = readFileSync(file);
  const docs = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const size = buf.readInt32LE(offset);
    if (size < 5 || offset + size > buf.length) break;
    docs.push(BSON.deserialize(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return docs;
}

// Kamus nama VP (paimo54) -> label ramah + unit
const LABELS = {
  RXPower: { label: 'Optic Rx Power', unit: 'dBm' },
  gettemp: { label: 'Temperatur', unit: '°C' },
  getdeviceuptime: { label: 'Device Uptime', unit: '' },
  getpppuptime: { label: 'PPP Uptime', unit: '' },
  pppoeUsername: { label: 'PPPoE Username', unit: '' },
  pppoeUsername2: { label: 'PPPoE Username 2', unit: '' },
  pppoePassword: { label: 'PPPoE Password', unit: '' },
  pppoeIP: { label: 'IP PPPoE', unit: '' },
  pppoeMac: { label: 'MAC PPPoE', unit: '' },
  PonMac: { label: 'PON MAC', unit: '' },
  activedevices: { label: 'Perangkat Wifi Aktif', unit: '' },
  WlanPassword: { label: 'WiFi Password', unit: '' },
  userPassword: { label: 'Password User', unit: '' },
  userAdmin: { label: 'User Admin', unit: '' },
  superAdmin: { label: 'User SuperAdmin', unit: '' },
  superPassword: { label: 'Password SuperAdmin', unit: '' },
  getSerialNumber: { label: 'SN ONT', unit: '' },
  getponmode: { label: 'PON Mode', unit: '' },
  IPTR069: { label: 'IP TR069', unit: '' },
};

const virtualParameters = [];
const vpBson = join(dirArg, 'virtualParameters.bson');
try {
  const vps = readBsonSeq(vpBson);
  for (const vp of vps) {
    const name = vp?._id;
    if (!name) continue;
    const lkp = LABELS[name] || {};
    virtualParameters.push({
      name,
      label: lkp.label || name,
      unit: lkp.unit ?? '',
      script: typeof vp.script === 'string' ? vp.script.slice(0, 300) : '',
      raw: vp,
    });
  }
} catch (e) {
  console.error(`[vp] tidak bisa baca ${vpBson}:`, e.message);
}

// config.bson: sample per device (ambil 1 device pertama yg punya nilai VP)
const configSample = {};
const cfgBson = join(dirArg, 'config.bson');
try {
  const cfgs = readBsonSeq(cfgBson);
  for (const cfg of cfgs) {
    const id = cfg?._id;
    if (!id || typeof id !== 'string') continue;
    if (!configSample[id]) configSample[id] = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'object' && v !== null && '_value' in v) {
        configSample[id][k] = v._value;
      } else if (typeof v !== 'object') {
        configSample[id][k] = v;
      }
    }
    if (Object.keys(configSample).length >= 3) break;
  }
} catch (e) {
  console.error(`[cfg] tidak bisa baca ${cfgBson}:`, e.message);
}

// deviceFields: mapping label UI -> info (untuk kolom Devices listing)
const deviceFields = {};
for (const vp of virtualParameters) {
  if (!vp.label) continue;
  deviceFields[vp.label] = {
    vpName: vp.name,
    path: vp.name,
    unit: vp.unit,
    source: 'virtualParameter',
  };
}

const mapping = {
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  sources: ['https://github.com/paimo54/parameter (virtualParameters.bson, config.bson)'],
  virtualParameters,
  configSample,
  deviceFields,
};

const out = outArg || 'vp-mapping.json';
writeFileSync(out, `${JSON.stringify(mapping, null, 2)}\n`);
console.log(`[vp] selesai: ${virtualParameters.length} virtualParameters, ${Object.keys(configSample).length} sample config, ${Object.keys(deviceFields).length} deviceFields -> ${out}`);