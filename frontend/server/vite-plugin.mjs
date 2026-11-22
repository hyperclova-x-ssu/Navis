import { loadEnv } from 'vite';
import { bridgeOptionsFromEnv } from './bridge-env.mjs';
import { createBridge } from './bridge.mjs';
import { createMediaService } from './media/middleware.mjs';
import { parseAllowedOrigins } from './private-origin.mjs';
import { createPromoService } from './promo/service.mjs';

export function readBridgeEnv({ root, envDir, mode }, readEnv = loadEnv) {
  const directory = envDir || root;
  const clova = readEnv(mode, directory, 'CLOVASTUDIO_');
  const navis = readEnv(mode, directory, 'NAVIS_');
  const sens = readEnv(mode, directory, ['SENS_SMS_', 'NCP_APIGW_KEY']);
  return bridgeOptionsFromEnv({ ...clova, ...navis, ...sens });
}

export function navisPlugin(options = {}) {
  const readEnv = options.loadEnv ?? loadEnv;
  const buildBridge = options.createBridge ?? createBridge;
  const buildPromo = options.createPromoService ?? createPromoService;
  const buildMedia = options.createMediaService ?? createMediaService;
  function mount(server) {
    const bridgeOptions = readBridgeEnv(server.config, readEnv);
    const allowedOrigins = parseAllowedOrigins(bridgeOptions.allowedOrigins);
    const media = buildMedia({ ...options.media, allowedOrigins });
    const promo = buildPromo({ ...options.promo, allowedOrigins });
    const bridge = buildBridge({ ...bridgeOptions, ...(options.resolveAgentScope && { resolveAgentScope: options.resolveAgentScope }) });
    server.middlewares.use(media);
    server.middlewares.use(promo);
    server.middlewares.use(bridge);
    server.httpServer?.once('close', () => { bridge.close(); promo.close(); media.close(); });
  }
  return { name: 'navis-local-bridge', configureServer: mount, configurePreviewServer: mount };
}
