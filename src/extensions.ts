import type { OfficialInvitePort, PairingPort } from './contracts.ts';
import { AppError } from './core/errors.ts';

const unavailable = async (): Promise<never> => { throw new AppError('NOT_IMPLEMENTED', '此功能已预留接口，当前阶段尚未开放。', 501); };
export const futurePairing: PairingPort = { create: unavailable, redeem: unavailable, approve: unavailable, revoke: unavailable };
export const futureInvites: OfficialInvitePort = { resolve: unavailable };
export const extensions = [
  { id: 'pairing', name: '数字码配对', available: false, contract: 'PairingPort' },
  { id: 'official-invites', name: '官方分享入口', available: false, contract: 'OfficialInvitePort' },
  { id: 'brand-adapters', name: '更多品牌连接器', available: false, contract: 'AdapterRegistration' },
];
// Offline classification only: never fetch, redeem, open or persist an invitation.
export function inspectInvitation(value: string, provider?: string): { kind: string; provider?: string } {
  if (value.length > 1024) throw new AppError('INPUT_TOO_LONG', '输入内容过长。');
  const input = value.trim();
  if (/^\d{1,32}$/.test(input)) return provider ? { kind: 'provider-code', provider } : { kind: 'needs-provider' };
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError('INVITE_FORMAT', '请输入完整官方链接，或注明数字码的来源。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new AppError('INVITE_FORMAT', '请输入 HTTPS 官方分享链接。');
  const providers: Record<string, string> = { 'c.lovense.com': 'lovense', 'www.lovense.com': 'lovense', 'lovense.com': 'lovense' };
  const identified = providers[url.hostname];
  if (!identified) throw new AppError('UNKNOWN_PROVIDER', '此链接的官方来源尚未登记。');
  if (provider && provider !== identified) throw new AppError('PROVIDER_MISMATCH', '链接与所选来源不一致。');
  return { kind: 'provider-link', provider: identified };
}
