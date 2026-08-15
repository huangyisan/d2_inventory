/*
 * Cross-check the browser parser against the Python reference parser.
 * Run: python3 dump_reference.py && node verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCharacter, parseStash, locationLabel, Catalog } from './src/parser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE_DIR = path.join(HERE, 'Diablo_2_Resurrected');
const catalog = new Catalog(JSON.parse(fs.readFileSync(path.join(HERE, 'data/catalog.json'), 'utf8')));

const out = [];
for (const fn of fs.readdirSync(SAVE_DIR).sort()) {
  const full = path.join(SAVE_DIR, fn);
  if (!fs.statSync(full).isFile()) continue;
  const lower = fn.toLowerCase();
  if (!lower.endsWith('.d2s') && !lower.endsWith('.d2i')) continue;
  const data = new Uint8Array(fs.readFileSync(full));
  let src;
  try {
    src = lower.endsWith('.d2s') ? parseCharacter(data, fn, catalog) : parseStash(data, fn, catalog);
  } catch (err) {
    out.push({ source: fn, error: `${err.name}: ${err.message}` });
    continue;
  }
  out.push({
    source: src.source,
    type: src.sourceType,
    cls: src.cls || '',
    level: src.level || 0,
    declared: src.declaredItemCount ?? null,
    warnings: src.warnings,
    chronicle: src.chronicle ?? null,
    items: src.items.map(it => ({
      code: it.code,
      quality: it.quality,
      uniqueId: it.uniqueId,
      setId: it.setId,
      where: locationLabel(it),
      ilvl: it.itemLevel,
      eth: it.ethereal,
      sockets: it.sockets,
      socketedIn: it.socketedIn || null,
      stackCount: it.stackCount || 1,
      stats: (it.stats || []).map(s => [s.id, s.param, s.value]),
    })),
  });
}

fs.writeFileSync(path.join(HERE, 'js_dump.json'), JSON.stringify(out, null, 1));
console.log('js items:', out.reduce((n, s) => n + (s.items?.length || 0), 0));
