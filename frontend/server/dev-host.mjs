import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startPreview } from './preview.mjs';
const root = fileURLToPath(new URL('./dev', import.meta.url));
const output = JSON.stringify({ status: 'SUCCESS', structured_output: { answer: '예상 손님은 92명입니다.', panels: [] } });
const spawnProcess = (_command, _args, options) => spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(output)}), 1200)`], options);
const server = await startPreview({ root, port: 5191, bridgeOptions: { spawnProcess } });
process.stdout.write('Fake bridge host: http://127.0.0.1:5191\n');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.stop());
