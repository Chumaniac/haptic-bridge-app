import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/studio/main.ts', import.meta.url));
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const value = (server.address() as {port:number}).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child,'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'),3000);
  try { await ended; } finally { clearTimeout(timer); }
}

test('the startup entry writes the selected data file and keeps the checkout path untouched', async () => {
  const root = await mkdtemp(join(tmpdir(),'studio-location-')), file = join(root,'selected.json'), selectedPort = await port();
  const child = spawn(process.execPath,[main],{cwd:root,env:{PATH:dirname(process.execPath),HB_STUDIO_FILE:file,HB_STUDIO_PORT:String(selectedPort),HB_STUDIO_OPEN:'0',HB_STUDIO_LEGACY_FILE:''},stdio:'ignore'});
  try {
    const url = 'http://127.0.0.1:'+selectedPort;
    let ready = false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error('Owned startup process exited before readiness');
      try { const response = await fetch(url+'/health',{signal:AbortSignal.timeout(500)}); if(response.status===200 && (await response.text()).includes('haptic-bridge-studio')) {ready=true;break;} } catch { /* Own server is still starting. */ }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(ready,true);
    const response = await fetch(url+'/api/session'), session = await response.json() as {session:string;csrf:string};
    const headers = {origin:url,cookie:response.headers.get('set-cookie')!.split(';')[0]!,'content-type':'application/json','x-studio-session':session.session,'x-csrf-token':session.csrf};
    assert.equal((await fetch(url+'/api/control',{method:'POST',headers,body:JSON.stringify({action:'claim'})})).status,200);
    assert.equal((await fetch(url+'/api/preferences',{method:'POST',headers,body:JSON.stringify({revision:0,preferences:{defaultIntensity:34,defaultDurationMs:1000}})})).status,200);
    assert.equal(JSON.parse(await readFile(file,'utf8')).data.preferences.defaultIntensity,34);
    await assert.rejects(stat(join(root,'.local/studio.json')),{code:'ENOENT'});
  } finally { await stop(child); await rm(root,{recursive:true,force:true}); }
});

test('a declared legacy file is preserved and blocks an unnoticed empty-path transition', async () => {
  const root = await mkdtemp(join(tmpdir(),'studio-legacy-')), legacy=join(root,'legacy.json'), output=join(root,'new.json');
  await writeFile(legacy,'preserve retained legacy file');
  const child=spawn(process.execPath,[main],{cwd:root,env:{PATH:dirname(process.execPath),HB_STUDIO_FILE:output,HB_STUDIO_LEGACY_FILE:legacy,HB_STUDIO_PORT:'18766',HB_STUDIO_OPEN:'0'},stdio:'ignore'});
  try {
    const [code]=await once(child,'exit'); assert.notEqual(code,0);
    assert.equal(await readFile(legacy,'utf8'),'preserve retained legacy file');
    await assert.rejects(stat(output),{code:'ENOENT'});
  } finally { await stop(child); await rm(root,{recursive:true,force:true}); }
});
