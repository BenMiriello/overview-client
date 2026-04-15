/**
 * Downloads GeoNames data and builds src/data/places.json for place search.
 *
 * Sources (public domain):
 *   https://download.geonames.org/export/dump/cities5000.zip
 *   https://download.geonames.org/export/dump/countryInfo.txt
 *
 * Run: npx tsx scripts/build-places.ts
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createWriteStream } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DATA_DIR = path.join(import.meta.dirname, 'data');
const OUT_FILE = path.join(import.meta.dirname, '../public/data/places.json');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities5000.zip';
const COUNTRY_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';

interface Place {
  name: string;
  lat: number;
  lng: number;
  countryCode: string;
  country: string;
  type: 'city' | 'country' | 'region';
  population: number;
}

async function download(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    console.log(`  already exists: ${path.basename(dest)}`);
    return;
  }
  console.log(`  downloading ${path.basename(dest)}...`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
  });
}

async function unzip(zipPath: string, outDir: string): Promise<void> {
  console.log(`  unzipping ${path.basename(zipPath)}...`);
  await execAsync(`unzip -o "${zipPath}" -d "${outDir}"`);
}

async function parseCountryInfo(filePath: string): Promise<Map<string, { name: string; population: number }>> {
  const map = new Map<string, { name: string; population: number }>();
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('#') || !line.trim()) continue;
    const cols = line.split('\t');
    const iso2 = cols[0];
    const name = cols[4];
    const population = parseInt(cols[7] ?? '0', 10) || 0;
    if (iso2 && name) map.set(iso2, { name, population });
  }
  return map;
}

async function parseCities(
  filePath: string,
  countryMap: Map<string, { name: string; population: number }>
): Promise<Place[]> {
  const places: Place[] = [];
  // Track one PPLC per country to generate country-level entries
  const capitalByCountry = new Map<string, Place>();

  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const name = cols[2] || cols[1]; // prefer asciiname
    const lat = parseFloat(cols[4]);
    const lng = parseFloat(cols[5]);
    const featureCode = cols[7];
    const countryCode = cols[8];
    const population = parseInt(cols[14] ?? '0', 10) || 0;

    if (!name || isNaN(lat) || isNaN(lng)) continue;

    const country = countryMap.get(countryCode)?.name ?? countryCode;

    places.push({ name, lat, lng, countryCode, country, type: 'city', population });

    if (featureCode === 'PPLC' && !capitalByCountry.has(countryCode)) {
      capitalByCountry.set(countryCode, { name, lat, lng, countryCode, country, type: 'city', population });
    }
  }

  // Add country-level entries using capital coordinates
  for (const [countryCode, capital] of capitalByCountry) {
    const countryInfo = countryMap.get(countryCode);
    if (!countryInfo) continue;
    places.push({
      name: countryInfo.name,
      lat: capital.lat,
      lng: capital.lng,
      countryCode,
      country: countryInfo.name,
      type: 'country',
      population: countryInfo.population,
    });
  }

  return places;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  console.log('Fetching GeoNames data...');

  const zipPath = path.join(DATA_DIR, 'cities5000.zip');
  const countryInfoPath = path.join(DATA_DIR, 'countryInfo.txt');

  await download(CITIES_URL, zipPath);
  await download(COUNTRY_URL, countryInfoPath);
  await unzip(zipPath, DATA_DIR);

  const citiesPath = path.join(DATA_DIR, 'cities5000.txt');
  if (!fs.existsSync(citiesPath)) {
    throw new Error(`Expected ${citiesPath} after unzip`);
  }

  console.log('Parsing data...');
  const countryMap = await parseCountryInfo(countryInfoPath);
  const places = await parseCities(citiesPath, countryMap);

  // Sort by population descending so the biggest places sort first in search
  places.sort((a, b) => b.population - a.population);

  console.log(`Writing ${places.length} places to ${OUT_FILE}...`);
  fs.writeFileSync(OUT_FILE, JSON.stringify(places));
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
