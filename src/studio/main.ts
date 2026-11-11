import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createStudio } from './server.ts';
const rawPort = process.env.HB_STUDIO_PORT ?? '18766';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error('HB_STUDIO_PORT must be between 1024 and 65535');
const app = await createStudio({ file: resolve(process.env.HB_STUDIO_FILE ?? '.local/studio.json') });
try {
  const url = await app.listen(Number(rawPort));
  console.log(`Haptic Bridge 本地工作台：${url}`);
  if (process.platform === 'darwin' && process.env.HB_STUDIO_OPEN === '1') {
    const opener = spawn('open', [url], { stdio: 'ignore', detached: true });
    opener.on('error', () => console.log('请在浏览器中手动打开上述本地地址。')); opener.unref();
  }
}
catch (error) { await app.close(); throw error; }
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
