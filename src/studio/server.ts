import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, requireCondition } from '../core/errors.ts';
import { readCatalog } from '../catalog.ts';
import { StudioCore } from './core.ts';
import { StudioStore } from './store.ts';
import { defaults, librarySchema, limits, patternDraftSchema, preferencesSchema, revisionSchema } from './schema.ts';
import { connectionLabels } from './catalog.ts';

interface Session { id: string; csrf: string; browser: string; expires: number; lastUse: number; windowStart: number; requests: number }
const deviceId = z.enum(['virtual-one', 'virtual-duo']);
const channel = z.number().int().min(0).max(1);
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});

export async function createStudio(options: { file: string; webRoot?: URL; sessionMs?: number; leaseMs?: number } ) {
  const store = await StudioStore.load(options.file);
  const core = new StudioCore(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs });
  const catalog = readCatalog();
  const transports = connectionLabels(catalog);
  const sessions = new Map<string, Session>();
  let port = 0; let closing = false; let pending = 0;
  const counts = { rejected: 0, requests: 0 };
  const cleanup = setInterval(() => {
    for (const [key, session] of sessions) if (session.expires <= Date.now() || Date.now() - session.lastUse > 30000) { core.expire(key); sessions.delete(key); }
  }, 250);
  cleanup.unref();
  function json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  }
  function browserFor(req: IncomingMessage): string | undefined {
    const browser = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('hb_studio_browser='))?.slice(18);
    return browser && /^[a-f0-9]{64}$/.test(browser) ? browser : undefined;
  }
  function sessionFor(req: IncomingMessage, emergency = false): Session {
    const id = req.headers['x-studio-session'];
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    requireCondition(session && session.browser === browserFor(req), 'SESSION', '会话已过期，请点击“重新连接本地服务”。', 401);
    if (session.expires <= Date.now()) {
      core.expire(session.id); sessions.delete(session.id);
      throw new AppError('SESSION', '会话已过期，请点击“重新连接本地服务”。', 401);
    }
    if (Date.now() - session.windowStart >= 10000) { session.requests = 0; session.windowStart = Date.now(); }
    if (!emergency) requireCondition(++session.requests <= 160, 'RATE_LIMIT', '操作过于频繁，请稍后再试。', 429);
    session.lastUse = Date.now();
    return session;
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    requireCondition(req.headers['content-type']?.split(';')[0]?.trim() === 'application/json', 'CONTENT_TYPE', '仅接受 JSON 文件内容。', 415);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      requireCondition(bytes <= limits.fileBytes, 'BODY_LIMIT', '内容过大，文件不能超过 128 KiB。', 413);
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('JSON', 'JSON 格式不正确，已有资料没有改变。'); }
  }
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(error => {
      counts.rejected++;
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AppError) json(res, { error: { code: error.code, message: error.message } }, error.status);
      else if (error instanceof z.ZodError) json(res, { error: { code: 'VALIDATION', message: '资料格式或数值不正确。最多 20 个模式、每个 64 步，总时长不超过十分钟。' } }, 400);
      else json(res, { error: { code: 'INTERNAL', message: '本地操作失败，请重新连接后再试。' } }, 500);
    });
  });
  server.maxConnections = 64; server.maxRequestsPerSocket = 100;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'bluetooth=(), serial=(), usb=(), camera=(), microphone=(), geolocation=()');
    requireCondition(!closing, 'CLOSING', '本地工作台正在关闭。', 503);
    const host = req.headers.host;
    requireCondition(host === `127.0.0.1:${port}` || host === `localhost:${port}`, 'HOST', '此访问地址不被允许。', 403);
    const origin = `http://${host}`;
    requireCondition(!req.headers.origin || req.headers.origin === origin, 'ORIGIN', '只接受当前本地工作台的请求。', 403);
    const url = new URL(req.url ?? '/', origin);
    counts.requests++;
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, { application: 'haptic-bridge-studio', version: 1, simulation: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      let session: Session | undefined;
      try { session = sessionFor(req); } catch (error) { if (!(error instanceof AppError && error.code === 'SESSION')) throw error; }
      if (!session) {
        for (const [key, previous] of sessions) if (previous.expires <= Date.now() || Date.now() - previous.lastUse > 30000) { core.expire(key); sessions.delete(key); }
        requireCondition(sessions.size < 16, 'SESSION_LIMIT', '本地窗口数量已达上限。请关闭闲置窗口后稍后再试。', 429);
        session = { id: randomBytes(32).toString('hex'), browser: browserFor(req) ?? randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), expires: Date.now() + (options.sessionMs ?? 7200000), lastUse: Date.now(), windowStart: Date.now(), requests: 0 };
        sessions.set(session.id, session);
      }
      res.setHeader('Set-Cookie', `hb_studio_browser=${session.browser}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);
      json(res, { session: session.id, csrf: session.csrf, state: core.snapshot(session.id), library: store.snapshot() }); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const session = sessionFor(req, url.pathname === '/api/stop');
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') { json(res, { state: core.snapshot(session.id), revision: store.revision }); return; }
        if (url.pathname === '/api/library') { json(res, store.snapshot()); return; }
        if (url.pathname === '/api/catalog') {
          json(res, { source: catalog.source, sha256: catalog.sha256, fetchedAt: catalog.fetchedAt, hardwareVerified: false,
            profiles: catalog.profiles.map(item => ({ id: item.id, name: item.name, models: item.models, source: item.source, evidence: item.evidence,
              connectionMethods: transports.get(item.id) ?? ['资料未同步，连接方式待核对'],
              tools: ['Buttplug 公开设备资料', 'Intiface Central（本工作台未接入）', ...(item.id === 'lovense' ? ['Lovense 官方 API（本工作台未接入）'] : [])] })) }); return;
        }
        if (url.pathname === '/api/export') {
          res.setHeader('Content-Disposition', 'attachment; filename="haptic-studio-library.json"'); json(res, store.snapshot().data); return;
        }
        if (url.pathname === '/api/diagnostics') {
          const snapshot = core.snapshot(session.id);
          res.setHeader('Content-Disposition', 'attachment; filename="haptic-studio-diagnostics.json"');
          json(res, { version: 1, generatedAt: new Date().toISOString(), environment: 'local-simulation', hardwareAccess: false, credentialsIncluded: false,
            devices: snapshot.devices.map(item => ({ id: item.id, connected: item.connected, armed: item.armed, values: item.values })),
            playback: snapshot.playback ? { status: snapshot.playback.status, elapsedMs: snapshot.playback.elapsedMs, totalMs: snapshot.playback.totalMs } : null,
            library: { revision: store.revision, patternCount: store.patternCount },
            resources: { ...snapshot.resources, sessions: sessions.size, pendingRequests: pending },
            counters: counts, history: snapshot.history }); return;
        }
      }
      if (req.method === 'POST') {
        requireCondition(req.headers.origin === origin, 'ORIGIN', '请从本地工作台发起操作。', 403);
        const token = req.headers['x-csrf-token'];
        requireCondition(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf)), 'CSRF', '会话校验失败，请重新连接本地服务。', 403);
        requireCondition(pending < (url.pathname === '/api/stop' ? 18 : 16), 'BUSY', '正在处理其他操作，请稍后重试。', 429);
        pending++;
        try {
          const input = await body(req);
          // An expired session cannot complete a slow upload and acquire or retain control.
          requireCondition(session.expires > Date.now(), 'SESSION', '会话已过期，请重新连接本地服务。', 401);
          switch (url.pathname) {
            case '/api/control': {
              const { action } = z.strictObject({ action: z.enum(['claim', 'release']) }).parse(input);
              if (action === 'claim') core.claim(session.id); else core.release(session.id); break;
            }
            case '/api/heartbeat': empty.parse(input); core.heartbeat(session.id); break;
            case '/api/end': empty.parse(input); core.expire(session.id); sessions.delete(session.id); break;
            case '/api/device': {
              const request = z.strictObject({ id: deviceId, action: z.enum(['connect', 'disconnect', 'arm', 'stop']) }).parse(input);
              core.deviceAction(session.id, request.id, request.action); break;
            }
            case '/api/output': {
              const request = z.strictObject({ id: deviceId, channel, epoch, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), value: z.number().int().min(0).max(100) }).parse(input);
              core.output(session.id, request.id, request.channel, request.epoch, request.sequence, request.value); break;
            }
            case '/api/play': {
              const request = z.strictObject({ id: deviceId, channel, epoch, patternId: z.uuid() }).parse(input);
              const pattern = store.snapshot().data.patterns.find(item => item.id === request.patternId);
              requireCondition(pattern, 'PATTERN', '这个模式已不存在，请刷新模式库。', 404);
              core.play(session.id, request.id, request.channel, request.epoch, pattern); break;
            }
            case '/api/playback': {
              const { action } = z.strictObject({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(input); core.playbackAction(session.id, action); break;
            }
            case '/api/stop': empty.parse(input); core.stop(); break;
            case '/api/library/save': {
              const request = z.strictObject({ revision: revisionSchema, pattern: patternDraftSchema }).parse(input);
              await store.update(request.revision, data => {
                core.requireOwner(session.id);
                if (request.pattern.id) {
                  const index = data.patterns.findIndex(item => item.id === request.pattern.id);
                  requireCondition(index >= 0, 'PATTERN', '这个模式已不存在，请刷新模式库。', 404);
                  data.patterns[index] = { ...request.pattern, id: request.pattern.id };
                } else {
                  requireCondition(data.patterns.length < limits.patterns, 'LIBRARY_FULL', '模式库已满，请删除不需要的模式后重试。', 409);
                  data.patterns.push({ ...request.pattern, id: randomUUID() });
                }
              }); core.record('library-save'); break;
            }
            case '/api/library/delete': {
              const request = z.strictObject({ revision: revisionSchema, id: z.uuid() }).parse(input);
              await store.update(request.revision, data => {
                core.requireOwner(session.id);
                requireCondition(!core.snapshot(session.id).playback, 'PLAYBACK_ACTIVE', '请先取消模式播放。', 409);
                const index = data.patterns.findIndex(item => item.id === request.id);
                requireCondition(index >= 0, 'PATTERN', '这个模式已不存在。', 404); data.patterns.splice(index, 1);
              }); core.record('library-delete'); break;
            }
            case '/api/import': {
              const request = z.strictObject({ revision: revisionSchema, data: librarySchema }).parse(input);
              await store.update(request.revision, data => {
                core.requireOwner(session.id);
                requireCondition(!core.snapshot(session.id).playback, 'PLAYBACK_ACTIVE', '请先取消模式播放，再导入资料。', 409);
                data.patterns = request.data.patterns; data.preferences = request.data.preferences;
              }); core.record('import'); break;
            }
            case '/api/import/preview': {
              const { data } = z.strictObject({ data: librarySchema }).parse(input);
              json(res, { preview: { patterns: data.patterns.length, steps: data.patterns.reduce((count, item) => count + item.steps.length, 0) } }); return;
            }
            case '/api/preferences': {
              const request = z.strictObject({ revision: revisionSchema, preferences: preferencesSchema }).parse(input);
              await store.update(request.revision, data => { core.requireOwner(session.id); data.preferences = request.preferences; }); core.record('preferences'); break;
            }
            case '/api/preferences/reset': {
              const { revision } = z.strictObject({ revision: revisionSchema }).parse(input);
              await store.update(revision, data => { core.requireOwner(session.id); data.preferences = { ...defaults }; }); core.record('preferences'); break;
            }
            default: throw new AppError('NOT_FOUND', '本地工作台没有此功能。', 404);
          }
          json(res, { state: core.snapshot(session.id), library: store.snapshot() }); return;
        } finally { pending--; }
      }
      throw new AppError('NOT_FOUND', '本地工作台没有此功能。', 404);
    }
    const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/studio.js': ['studio.js', 'text/javascript'], '/android-waveform.js': ['android-waveform.js', 'text/javascript'], '/studio.css': ['studio.css', 'text/css'] };
    const file = files[url.pathname]; requireCondition(req.method === 'GET' && file, 'NOT_FOUND', '页面不存在。', 404);
    const content = await readFile(new URL(file[0], options.webRoot ?? new URL('./web/', import.meta.url)));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(content);
  }
  return {
    core, server, store,
    async listen(requestedPort = 18766): Promise<string> {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      const address = server.address(); requireCondition(address && typeof address !== 'string', 'BIND', '无法获取本地工作台地址。');
      port = address.port; return `http://127.0.0.1:${port}`;
    },
    async close(): Promise<void> {
      closing = true; clearInterval(cleanup); core.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      sessions.clear(); await store.flush();
    },
  };
}
