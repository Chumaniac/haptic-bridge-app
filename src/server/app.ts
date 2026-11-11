import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DemoAdapter } from '../adapters/demo.ts';
import { IntifaceAdapter } from '../adapters/intiface.ts';
import { Hub } from '../core/hub.ts';
import { AppError, requireCondition } from '../core/errors.ts';
import { extensions, inspectInvitation } from '../extensions.ts';
import type { DeviceAdapter, Mode } from '../contracts.ts';
import { readCatalog, vendorPlan } from '../catalog.ts';
import { Diagnostics } from '../diagnostics.ts';

interface Session { id: string; csrf: string; expires: number; windowStart: number; requests: number }
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const deviceBody = z.strictObject({ id: idSchema });
const outputBody = z.strictObject({ id: idSchema, feature: z.number().int().min(0).max(2147483647),
  value: z.number().min(0).max(1), epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export function createApp(options: { factory?: (mode: Mode) => DeviceAdapter; endpoint?: string; heartbeatTimeout?: number; webRoot?: URL } = {}) {
  const factory = options.factory ?? (mode => mode === 'demo' ? new DemoAdapter() : new IntifaceAdapter(options.endpoint));
  const hub = new Hub(factory, options.heartbeatTimeout === undefined ? {} : { heartbeatTimeout: options.heartbeatTimeout });
  const catalog = readCatalog();
  const diagnostics = new Diagnostics(hub, catalog);
  const sessions = new Map<string, Session>();
  const streams = new Set<ServerResponse>();
  let port = 0;
  let closing = false;
  const cleanup = setInterval(() => { for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key); }, 60000);
  cleanup.unref();

  function headers(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  function json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  }
  function getSession(req: IncomingMessage): Session {
    const id = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('hb_session='))?.slice(11);
    const session = id ? sessions.get(id) : undefined;
    requireCondition(session && session.expires > Date.now(), 'SESSION', '请刷新页面重新建立本地会话。', 401);
    if (Date.now() - session.windowStart > 10000) { session.windowStart = Date.now(); session.requests = 0; }
    requireCondition(++session.requests <= 300, 'RATE_LIMIT', '操作过于频繁，请稍后再试。', 429);
    return session;
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    requireCondition(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE', '请求格式不正确。', 415);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes <= 4096) chunks.push(Buffer.from(chunk));
    }
    if (bytes > 4096) throw new AppError('BODY_LIMIT', '请求内容过大。', 413);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('JSON', '请求内容格式不正确。'); }
  }
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AppError) json(res, { error: { code: error.code, message: error.message } }, error.status);
      else if (error instanceof z.ZodError) json(res, { error: { code: 'VALIDATION', message: '请求参数不正确。' } }, 400);
      else json(res, { error: { code: 'INTERNAL', message: '操作未完成，请检查连接状态。' } }, 500);
    });
  });
  server.maxConnections = 64;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    headers(res);
    requireCondition(!closing, 'CLOSING', '服务正在关闭。', 503);
    const host = req.headers.host;
    requireCondition(host === `127.0.0.1:${port}` || host === `localhost:${port}`, 'HOST', '不允许此访问地址。', 403);
    const origin = `http://${host}`;
    requireCondition(!req.headers.origin || req.headers.origin === origin, 'ORIGIN', '只允许本地页面发起此操作。', 403);
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      let session: Session | undefined;
      try { session = getSession(req); }
      catch (error) { if (!(error instanceof AppError && error.code === 'SESSION')) throw error; }
      if (!session) {
        for (const [key, old] of sessions) if (old.expires < Date.now()) sessions.delete(key);
        requireCondition(sessions.size < 16, 'SESSION_LIMIT', '本地窗口数量已达上限。', 429);
        session = { id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), expires: Date.now() + 7200000, windowStart: Date.now(), requests: 0 };
        sessions.set(session.id, session);
      }
      res.setHeader('Set-Cookie', `hb_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);
      json(res, { csrf: session.csrf, state: hub.snapshot(session.id) }); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const session = getSession(req);
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') { json(res, hub.snapshot(session.id)); return; }
        if (url.pathname === '/api/extensions') { json(res, extensions); return; }
        if (url.pathname === '/api/vendors') { json(res, { ...catalog, plans: catalog.profiles.map(profile => vendorPlan(catalog, profile.id)) }); return; }
        if (url.pathname === '/api/diagnostics/report') {
          res.setHeader('Content-Disposition', 'attachment; filename="connection-report.json"');
          json(res, diagnostics.latest(session.id)); return;
        }
        if (url.pathname === '/api/events') {
          requireCondition(streams.size < 16, 'STREAM_LIMIT', '实时连接数量已达上限。', 429);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          streams.add(res);
          const send = () => {
            if (res.destroyed || res.writableEnded) return;
            if (session.expires < Date.now() || res.writableLength > 65536) { res.end(); return; }
            res.write(`data: ${JSON.stringify(hub.snapshot(session.id))}\n\n`);
          };
          const unsubscribe = hub.subscribe(send);
          const ping = setInterval(() => {
            if (res.destroyed || res.writableEnded) return;
            if (session.expires < Date.now()) res.end(); else res.write(': keepalive\n\n');
          }, 15000);
          ping.unref();
          res.on('close', () => { unsubscribe(); clearInterval(ping); streams.delete(res); });
          send(); return;
        }
      }
      if (req.method === 'POST') {
        requireCondition(req.headers.origin === origin, 'ORIGIN', '请从本地控制页面发起操作。', 403);
        const token = req.headers['x-csrf-token'];
        requireCondition(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf)),
          'CSRF', '会话校验失败，请刷新页面。', 403);
        const input = await body(req);
        switch (url.pathname) {
          case '/api/connect': await hub.connect(session.id, z.strictObject({ mode: z.enum(['demo', 'intiface']) }).parse(input).mode); break;
          case '/api/disconnect': z.strictObject({}).parse(input); await hub.disconnect(session.id); break;
          case '/api/scan': z.strictObject({}).parse(input); await hub.scan(session.id); break;
          case '/api/arm': await hub.arm(session.id, deviceBody.parse(input).id); break;
          case '/api/output': {
            const result = await hub.output(session.id, outputBody.parse(input));
            json(res, { result, state: hub.snapshot(session.id) }); return;
          }
          case '/api/stop-device': await hub.stopDevice(deviceBody.parse(input).id); break;
          case '/api/stop': z.strictObject({}).parse(input); await hub.stopAll(); break;
          case '/api/heartbeat': z.strictObject({}).parse(input); hub.heartbeat(session.id); break;
          case '/api/diagnostics': {
            const request = z.strictObject({ mode: z.enum(['demo', 'intiface']), vendorId: z.string().regex(/^[a-z0-9-]{1,80}$/), allowScan: z.boolean().default(false) }).parse(input);
            const report = await diagnostics.run(session.id, request);
            json(res, { report, state: hub.snapshot(session.id) }); return;
          }
          case '/api/exercise': {
            const request = outputBody.extend({ value: z.number().gt(0).max(.3) }).parse(input);
            const result = await hub.exercise(session.id, request);
            json(res, { test: result, state: hub.snapshot(session.id) }); return;
          }
          case '/api/invites/inspect': {
            const invite = z.strictObject({ value: z.string().max(1024), provider: z.enum(['lovense', 'we-vibe', 'satisfyer']).optional() }).parse(input);
            json(res, inspectInvitation(invite.value, invite.provider)); return;
          }
          case '/api/pairings': case '/api/pairings/redeem': case '/api/invites/resolve':
            throw new AppError('NOT_IMPLEMENTED', '该扩展功能尚未开放。', 501);
          default: throw new AppError('NOT_FOUND', '此接口不存在。', 404);
        }
        json(res, { state: hub.snapshot(session.id) }); return;
      }
      throw new AppError('NOT_FOUND', '此接口不存在。', 404);
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'],
      '/checks.js': ['checks.js', 'text/javascript'],
    };
    const file = files[url.pathname];
    requireCondition(req.method === 'GET' && file, 'NOT_FOUND', '页面不存在。', 404);
    const content = await readFile(new URL(file[0], options.webRoot ?? new URL('../web/', import.meta.url)));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(content);
  }
  return {
    hub, server,
    async listen(requestedPort = 18765): Promise<string> {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      const address = server.address(); requireCondition(address && typeof address !== 'string', 'BIND', '无法获取本地地址。');
      port = address.port; return `http://127.0.0.1:${port}`;
    },
    async close(): Promise<void> {
      closing = true; clearInterval(cleanup);
      for (const stream of streams) stream.end();
      await hub.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      sessions.clear();
    },
  };
}
