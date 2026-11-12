import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createStudio } from './server.ts';
const rawPort = process.env.HB_STUDIO_PORT ?? '18766';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) throw new Error('HB_STUDIO_PORT must be between 1024 and 65535');
const file = resolve(process.env.HB_STUDIO_FILE ?? '.local/studio.json');
const legacy = process.env.HB_STUDIO_LEGACY_FILE;
async function present(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('无法核对配置位置，已停止启动；请保留资料并检查权限。'); }
}
if (legacy && resolve(legacy) !== file && !await present(file) && await present(resolve(legacy))) throw new Error('发现旧路径资料，已保留；请先验证并恢复到用户资料目录，再启动工作台。');
const app = await createStudio({ file });
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
