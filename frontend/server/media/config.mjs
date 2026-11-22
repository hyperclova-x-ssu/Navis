import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const credentialFiles = {
  speech: {
    NAVIS_CLOVASPEECH_INVOKE_URL: 'NCP_CLOVASPEECH_INVOKE_URL',
    NAVIS_CLOVASPEECH_SECRET: 'NCP_CLOVASPEECH_SECRET',
  },
  receipt: {
    NAVIS_CLOVA_OCR_URL: 'NCP_CLOVA_OCR_URL',
    NAVIS_CLOVA_OCR_SECRET: 'NCP_CLOVA_OCR_SECRET',
  },
};

export function readMediaCredentials(service, secretsDir) {
  const settings = {};
  for (const [name, file] of Object.entries(credentialFiles[service])) {
    try {
      settings[name] = readFileSync(join(secretsDir, file), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read Navis secret file ${file}`, { cause: error });
    }
  }
  return settings;
}

export function mediaLiveOptions(env) {
  return {
    receiptUrl: env.NAVIS_CLOVA_OCR_URL?.trim(),
    receiptSecret: env.NAVIS_CLOVA_OCR_SECRET?.trim(),
    speechUrl: env.NAVIS_CLOVASPEECH_INVOKE_URL?.trim(),
    speechSecret: env.NAVIS_CLOVASPEECH_SECRET?.trim(),
  };
}
