import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from './core/errors.ts';

const profile = z.object({ id: z.string().max(80), name: z.string().max(120), source: z.string().url(),
  evidence: z.literal('catalog-only'), models: z.array(z.string().max(160)).max(2000), protocolIds: z.array(z.string().max(100)).max(2000) });
const schema = z.object({ source: z.string().url(), fetchedAt: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  protocolEntries: z.number().int().positive().max(2000), hardwareVerified: z.literal(false), profiles: z.array(profile).max(100),
  protocols: z.array(z.object({ id: z.string().max(100), models: z.array(z.string().max(160)).max(2000) })).max(2000) });
export type Catalog = z.infer<typeof schema>;
export interface VendorPlan {
  id: string; name: string; protocolIds: string[]; evidence: 'catalog-only';
  connector: 'intiface-v4'; guidance: string[];
  alternatives: { label: string; state: 'requires-authorization' | 'research-only' }[];
}
const advice: Record<string, string[]> = {
  lovense: ['优先使用本机 Intiface 蓝牙连接，无需默认购买专用接收器。', '若设备被官方 App 占用，先在原 App 断开，再重新搜索。'],
  'we-vibe': ['按具体型号进入配对状态，再由 Intiface 匹配对应协议。', 'Jive、Nova、Chorus 等设备属于不同协议分组，不按品牌统一套用指令。'],
  satisfyer: ['部分型号不在广播中提供设备名，请使用 Intiface 的设备搜索。', 'App 配对、伙伴邀请与本地设备连接分别处理。'],
  monsterpub: ['先确认小怪兽型号和代际；较新代际包含额外认证握手。', '使用引擎已适配的 MonsterPub / LiBo 协议，不尝试通用猜测指令。'],
  svakom: ['SVAKOM 存在多个协议版本，按设备实际能力选择电机。', '相似外观或 App 名称不代表设备协议相同。'],
  lelo: ['按具体型号处理配对步骤，优先匹配引擎中的型号记录。', '只开放设备上报的振动能力，其他功能保留待验证。'],
  'magic-motion': ['同品牌存在多个命令格式，优先使用型号匹配结果。', '多电机设备分别显示控制项。'],
  mysteryvibe: ['Crescendo 等不同代际分别匹配对应协议。', '读取能力后再启用，重新连接不恢复上次输出。'],
  tryfun: ['区分春风 Yuan 系列与其他型号的协议记录。', '未匹配型号只展示资料与下一步，不套用其他型号控制参数。'],
  muse: ['先确认是蓝牙连接型还是需要广播桥接的具体型号。', '特殊硬件桥接候选尚未验证，不自动安装或发送广播控制包。'],
  joyhub: ['多个销售型号及代工别名需要按设备记录匹配。', '按实际上报能力展示电机，附加功能不默认开放。'],
  galaku: ['Galaku 包含不同连接方案；先以具体型号识别。', '需要额外桥接的型号会单独列为待验证。'],
};
export function readCatalog(): Catalog {
  const raw = readFileSync(new URL('../data/catalog.json', import.meta.url));
  if (raw.length > 2000000) throw new Error('Catalog exceeds the local size bound');
  const data = schema.parse(JSON.parse(raw.toString('utf8')));
  if (data.protocolEntries !== data.protocols.length || new Set(data.protocols.map(item => item.id)).size !== data.protocolEntries) throw new Error('Catalog protocol inventory is inconsistent');
  return data;
}
export function vendorPlan(catalog: Catalog, id: string): VendorPlan {
  if (id === 'auto') return { id, name: '自动识别', protocolIds: [], evidence: 'catalog-only', connector: 'intiface-v4',
    guidance: ['由 Intiface 识别具体设备协议，再显示可用功能。', '无法识别时保留待验证状态，不尝试未知控制指令。'], alternatives: [] };
  const selected = catalog.profiles.find(item => item.id === id);
  if (!selected) throw new AppError('VENDOR_UNKNOWN', '暂未登记此品牌，请使用自动识别。');
  return { id, name: selected.name, protocolIds: selected.protocolIds, evidence: 'catalog-only', connector: 'intiface-v4',
    guidance: advice[id] ?? ['按设备上报能力连接；具体型号仍需实机验证。'],
    alternatives: id === 'lovense' ? [{ label: 'Lovense 官方授权 API', state: 'requires-authorization' }]
      : id === 'muse' ? [{ label: '专用硬件桥接', state: 'research-only' }] : [] };
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const prefixes: Record<string, RegExp> = {
  lovense: /^lovense/, 'we-vibe': /^wevibe/, satisfyer: /^satisfyer/, monsterpub: /^(sistalk|monsterpub|libo)/,
  svakom: /^svakom/, lelo: /^lelo/, 'magic-motion': /^magicmotion/, mysteryvibe: /^mysteryvibe/,
  tryfun: /^(tryfun|春风)/, muse: /^(muse|lovespouse|dreamlover)/, joyhub: /^joyhub/, galaku: /^galaku/,
};
export function recognizeVendor(catalog: Catalog, model: string): string | null {
  const normalized = normalize(model);
  const matching = Object.entries(prefixes).filter(([, expression]) => expression.test(normalized));
  if (matching.length === 1) return matching[0]![0];
  const exact = catalog.profiles.filter(item => item.models.some(name => normalize(name) === normalized));
  return exact.length === 1 ? exact[0]!.id : null;
}
