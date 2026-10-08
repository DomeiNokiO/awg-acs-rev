#!/usr/bin/env node
/**
 * Konverter dump MongoDB GenieACS (repo paimo54/parameter) -> models.json ACS.
 *
 * Latar belakang: repo https://github.com/paimo54/parameter berisi BUKAN
 * JSON, melainkan dump BSON `mongorestore` — tabel parameter GenieACS utuh.
 *
 * Alih-alih memaksa user menginstal mongod/mongoimport hanya untuk impor
 * ke ACS ini (bertentangan dengan semangat "tanpa server DB terpisah"),
 * skrip ini membaca BSON langsung dan menghasilkan models.json yang
 * dipahami ACS.
 *
 *   node scripts/bson-to-catalog.mjs <direktori-parameter> [out.json]
 *
 * Struktur dokumen `devices.bson` (dari repo paimo54, 19 perangkat):
 *   { _id, InternetGatewayDevice: { DeviceInfo: { HardwareVersion: {
 *       _value, _type, _writable, _object, _timestamp } } }, ... }
 *
 * Jadi tabel parameter adalah pohon BERSARANG di bawah nama data model,
 * bukan map `devices`. Tiap daun = objek ber-`_value` (nilai tersimpan),
 * `_writable` (boleh ditulis), dst. Skrip ini menelusuri pohon, melewatkan
 * simpul non-daun (yang punya `_object:true`), dan memakai jalur penuh
 * sebagai path parameter.
 *
 * `_id` perangkat (mis. "7089CC-H1s%2D2-CMDCA60285A7") biasanya adalah
 * serial, TIDAK cocok dijadikan productClass. Nama data model (kunci lama
 * `InternetGatewayDevice`) tidak memuat vendor/model — makanya productClass
 * diisi dari `_id` dengan heuristik kecil, dan field vendor dikosongkan;
 * operator boleh mengisinya di models.json setelah impor.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSON } from 'bson';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('Pemakaian: node scripts/bson-to-catalog.mjs <repo-parameter-dir> [out.json]');
  process.exit(2);
}

const devicesBson = join(dirArg, 'devices.bson');
let devices;
try {
  // Dump `mongorestore` adalah RANGKAIAN dokumen BSON dalam satu file.
  const buf = readFileSync(devicesBson);
  devices = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const size = buf.readInt32LE(offset);
    if (size < 5 || offset + size > buf.length) {
      console.error(`[bson] ukuran dokumen tidak valid di offset ${offset} (${size})`);
      break;
    }
    devices.push(BSON.deserialize(buf.subarray(offset, offset + size)));
    offset += size;
  }
} catch (e) {
  console.error(`[bson] tidak bisa membaca ${devicesBson}:`, e.message);
  process.exit(1);
}

function inferType(v, explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (v === null || v === undefined || v === '') return 'xsd:string';
  if (typeof v === 'boolean') return 'xsd:boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'xsd:int' : 'xsd:string';
  if (/^-?\d{1,12}$/.test(String(v))) return 'xsd:int';
  return 'xsd:string';
}

/**
 * Telusuri pohon parameter (objek ber-`_value` = daun; `_object:true` =
 * cabang). Mengembalikan array { path, value, type, writable }.
 */
function walk(node, prefix, out) {
  if (!node || typeof node !== 'object') return;
  if (node._object === true) {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue;            // metadata, bukan cabang
      walk(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  // Daun parameter: wajib punya _value untuk dianggap parameter nyata.
  if ('_value' in node) {
    out.push({
      path: prefix,
      value: node._value,
      type: inferType(node._value, node._type),
      writable: Boolean(node._writable),
    });
  }
}

const models = [];
const seenIds = new Set();

for (const dev of devices) {
  const id = dev?._id;
  if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
  seenIds.add(id);

  // Data model utama: kunci selain _* dan VirtualParameters.
  const modelKey = Object.keys(dev).find((k) => !k.startsWith('_') && k !== 'VirtualParameters');
  const tree = modelKey ? dev[modelKey] : null;
  if (!tree || typeof tree !== 'object') continue;

  const rawParams = [];
  walk(tree, modelKey ?? '', rawParams);
  const params = [];
  const pset = new Set();
  for (const item of rawParams) {
    if (pset.has(item.path)) continue;
    pset.add(item.path);
    params.push({
      path: item.path,
      label: item.path.split('.').pop() ?? item.path,
      type: item.type,
      access: item.writable ? 'readWrite' : 'read',
      group: 'parameter',
      unit: null,
      vendorExt: item.path.includes('X_'),
      source: 'https://github.com/paimo54/parameter (BSON)',
    });
  }

  // productClass dari _id pakai heuristik kecil (bagian sebelum tanda hubung
  // atau "-"; banyak perangkat memakai <VENDOR>-<serial>). Kalau tidak
  // ketemu, null — operator bisa isi manual.
  const pcHint = id.split(/[-%]/)[0] || id;
  models.push({
    id: id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60),
    vendor: '',
    productClass: pcHint.length >= 3 ? pcHint : null,
    oui: null,
    dataModel: modelKey ?? 'TR-098',
    aliases: [],
    notes: 'Diimpor dari GenieACS BSON dump (paimo54/parameter).',
    params,
  });
}

const catalog = {
  version: '1.0.0-paimo54',
  generatedAt: new Date().toISOString(),
  sources: ['https://github.com/paimo54/parameter (devices.bson)'],
  standard: { 'TR-098': [], 'TR-181': [] },
  models,
};

const out = outArg || 'models.json';
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
const totalParams = models.reduce((s, m) => s + m.params.length, 0);
console.log(`[bson] selesai: ${models.length} model, ${totalParams} parameter -> ${out}`);