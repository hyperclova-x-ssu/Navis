// 설정·도구 탐지 (ARCHITECTURE 12.10). 탐지는 서버 시작 때 한 번, 결과는 캐시한다.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const FAULT_STAGES = ['look', 'story', 'scenes', 'merge'];
export const PHOTO_SOURCES = ['cafe', 'example', 'example-7', 'example-4'];
// Who writes the scene HTML (stage 3). D-327 Q7: Claude by default; NAVER and the Claude API are opt-in (scene-provider.mjs).
export const SCENE_PROVIDERS = ['claude', 'naver', 'claude-api'];

export function readConfig(env = process.env) {
  const krw = Number(env.NAVIS_PROMO_KRW_PER_USD);
  const hcxPilotFlag = env.NAVIS_PROMO_HCX_PILOT;
  return {
    model: env.NAVIS_PROMO_CLAUDE_MODEL || 'sonnet',
    hcxPilot: hcxPilotFlag === 'true', // Explicit opt-in for the standalone live pilot.
    hcxLookEnabled: hcxPilotFlag !== 'false', // D-328 Q3: default for the service's photo look.
    sceneProvider: SCENE_PROVIDERS.includes(env.NAVIS_PROMO_SCENE_PROVIDER) ? env.NAVIS_PROMO_SCENE_PROVIDER : 'claude',
    claudeApiApproved: env.NAVIS_PROMO_CLAUDE_API_APPROVED === 'true',
    dir: env.NAVIS_PROMO_DIR || join(tmpdir(), 'navis-promo'),
    photoSource: PHOTO_SOURCES.includes(env.NAVIS_PROMO_PHOTO_SOURCE) ? env.NAVIS_PROMO_PHOTO_SOURCE : 'cafe',
    fault: FAULT_STAGES.includes(env.NAVIS_PROMO_FAULT) ? env.NAVIS_PROMO_FAULT : null,
    krwPerUsd: Number.isFinite(krw) && krw > 0 ? krw : 1400,
  };
}

const isExecutable = async file => { try { await access(file, constants.X_OK); return true; } catch { return false; } };

function pathCandidates(name, env) {
  return (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, name));
}

async function firstExecutable(list, exists) {
  for (const file of list) if (file && await exists(file)) return file;
  return null;
}

export function capture(command, args, { timeoutMs = 10000, spawnProcess = spawn } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); } catch { resolve({ code: -1, stdout: '', stderr: '' }); return; }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', c => { stdout += c; });
    child.stderr?.on('data', c => { stderr += c; });
    child.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const CHROME_DEFAULTS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

async function playwrightChromium() {
  try { const { chromium } = await import('playwright-core'); return chromium.executablePath(); } catch { return null; }
}

export async function detectBrowser({ env = process.env, exists = isExecutable, platform = process.platform } = {}) {
  return firstExecutable([env.NAVIS_CHROME_PATH, ...(CHROME_DEFAULTS[platform] || []), await playwrightChromium()], exists);
}

export async function detectTools({ env = process.env, exists = isExecutable, run = capture, platform = process.platform } = {}) {
  const home = env.HOME || homedir();
  const claude = await firstExecutable([env.NAVIS_CLAUDE_PATH, ...pathCandidates('claude', env), join(home, '.local/bin/claude'), join(home, '.claude/local/claude')], exists);
  const browser = await detectBrowser({ env, exists, platform });
  const ffmpegPath = await firstExecutable([env.NAVIS_FFMPEG_PATH, ...pathCandidates('ffmpeg', env), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'], exists);
  let ffmpeg = null;
  if (ffmpegPath) {
    const ffprobe = join(dirname(ffmpegPath), 'ffprobe');
    if (await exists(ffprobe)) {
      const encoders = (await run(ffmpegPath, ['-hide_banner', '-encoders'])).stdout;
      const filters = (await run(ffmpegPath, ['-hide_banner', '-filters'])).stdout;
      const h264 = ['libx264', 'h264_videotoolbox', 'libopenh264'].find(name => new RegExp(`\\s${name}\\s`).test(encoders));
      const hasAac = /\saac\s/.test(encoders);
      const hasFilters = ['fade', 'afade', 'signalstats'].every(name => new RegExp(`\\s${name}\\s`).test(filters));
      if (h264 && hasAac && hasFilters) ffmpeg = { ffmpeg: ffmpegPath, ffprobe, h264 };
    }
  }
  return { claude, browser, ffmpeg };
}

export const availability = tools => ({ claude: !!tools?.claude, browser: !!tools?.browser, ffmpeg: !!tools?.ffmpeg });
