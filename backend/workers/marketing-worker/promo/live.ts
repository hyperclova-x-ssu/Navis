import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSceneCheck } from '../../../../frontend/server/promo/check-scene.mjs';
import { detectTools } from '../../../../frontend/server/promo/config.mjs';
import { PromoError } from '../../../../frontend/server/promo/errors.mjs';
import { checkVideo, recordVideo } from '../../../../frontend/server/promo/recorder.mjs';
import { loadReferences, REFERENCE_IDS } from '../../../../frontend/server/promo/references.mjs';
import { readPromoKey } from '../../../../frontend/server/promo/scene-provider.mjs';
import { loadPlanningTemplates } from '../../../../frontend/server/promo/templates/runtime.mjs';
import { createLivePromoProvider } from './providers.ts';
import type { createPromoWorker } from './worker.ts';

type WorkerOptions = Parameters<typeof createPromoWorker>[0];
type Runtime = Pick<WorkerOptions, 'provider' | 'references' | 'musicDir' | 'music' | 'checkScene' | 'renderVideo' | 'checkVideo' | 'templates'>;

export async function loadLivePromo(env: NodeJS.ProcessEnv): Promise<Runtime> {
  const provider = createLivePromoProvider({
    env,
    clovaKey: readPromoKey(env.CLOVASTUDIO_API_KEY_FILE),
    anthropicKey: readPromoKey(env.ANTHROPIC_API_KEY_FILE),
  });
  const { browser, ffmpeg } = await detectTools({ env });
  if (!browser || !ffmpeg) throw new PromoError('TOOL_MISSING', undefined);
  const references = loadReferences();
  if (!references.rules || !REFERENCE_IDS.every(id => references.refs.has(id))) {
    throw new PromoError('TOOL_MISSING', 'PROMO_REFERENCES_MISSING');
  }
  const musicDir = fileURLToPath(new URL('../../../../frontend/server/promo/assets/music/', import.meta.url));
  const music: WorkerOptions['music'] = JSON.parse(await readFile(join(musicDir, 'music.json'), 'utf8'));
  return {
    provider, references, musicDir, music,
    templates: loadPlanningTemplates(),
    checkScene: options => runSceneCheck({ ...options, browserPath: browser }),
    renderVideo: options => recordVideo({ ...(options as Parameters<typeof recordVideo>[0]), browserPath: browser, ffmpeg }),
    checkVideo: ({ file, lengthSec, rules }) => checkVideo({ file, lengthSec, rules, ffmpeg }),
  };
}
