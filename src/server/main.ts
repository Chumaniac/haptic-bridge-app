import { createApp } from './app.ts';
const rawPort = process.env.HB_PORT ?? '18765';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error('HB_PORT must be an integer between 1024 and 65535');
const app = createApp(process.env.HB_INTIFACE_URL ? { endpoint: process.env.HB_INTIFACE_URL } : {});
const url = await app.listen(Number(rawPort));
console.log(`Haptic Bridge 已启动：${url}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
