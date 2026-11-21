/* global process */
// Shared paths, data loading and tool discovery for the T-084 reference tools.
// Discovery order follows ARCHITECTURE 12.10 (env var -> PATH -> fixed locations).
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCES_DIR = path.resolve(here, '..', '..');
export const PROMO_DIR = path.resolve(REFERENCES_DIR, '..');
export const APP_DIR = path.resolve(PROMO_DIR, '..', '..');
export const PHOTOS_DIR = path.join(PROMO_DIR, 'assets', 'photos');
export const MUSIC_DIR = path.join(PROMO_DIR, 'assets', 'music');
export const FONTS_DIR = path.join(REFERENCES_DIR, 'fonts');
export const CATALOG_PATH = path.join(APP_DIR, 'src', 'data', 'marketing', 'promo-catalog.json');

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const loadRules = () => readJson(path.join(REFERENCES_DIR, 'rules.json'));
export const loadCatalog = () => readJson(CATALOG_PATH);
export const loadFonts = () => readJson(path.join(FONTS_DIR, 'fonts.json'));
export const refDir = (id) => path.join(REFERENCES_DIR, id);

export function loadReference(id) {
  const dir = refDir(id);
  return {
    id,
    dir,
    meta: readJson(path.join(dir, 'meta.json')),
    html: readFileSync(path.join(dir, 'example.html'), 'utf8'),
    story: readJson(path.join(dir, 'example-story.json')),
  };
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

export function findFfmpeg() {
  const fromEnv = process.env.NAVIS_FFMPEG_PATH;
  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);
  const p = onPath('ffmpeg');
  if (p) candidates.push(p);
  candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  for (const c of candidates) {
    if (isExecutable(c)) {
      const probe = path.join(path.dirname(c), 'ffprobe');
      return { ffmpeg: c, ffprobe: isExecutable(probe) ? probe : null };
    }
  }
  return null;
}

export function findChrome() {
  const candidates = [
    process.env.NAVIS_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || null;
}

// playwright-core is T-082's devDependency. Before it lands, NAVIS_PLAYWRIGHT_PATH may point at
// another install (a folder containing node_modules/playwright-core or the package folder itself).
export async function loadPlaywright() {
  const tries = [];
  try {
    const req = createRequire(path.join(APP_DIR, 'package.json'));
    tries.push(req.resolve('playwright-core'));
  } catch {
    /* not installed in the app yet */
  }
  const extra = process.env.NAVIS_PLAYWRIGHT_PATH;
  if (extra) {
    try {
      const req = createRequire(path.join(extra, 'package.json'));
      tries.push(req.resolve('playwright-core'));
    } catch {
      /* ignore */
    }
  }
  for (const entry of tries) {
    try {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default?.chromium ? mod.default : mod;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function photoFileMap(catalog) {
  const map = new Map();
  for (const p of catalog.photos) map.set(p.photoId, { ...p, path: path.join(PHOTOS_DIR, p.file) });
  return map;
}
