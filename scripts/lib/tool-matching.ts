import type { Catalog } from '../../src/catalog.ts';

export interface ToolEvidence {
  nativeSoftwareInteroperability: string;
  intifaceCentralGuiTested: boolean;
  lovenseOfficialApiImplemented: boolean;
  physicalDevicesTested: number;
}
export function buildToolMatchingReport(catalog: Catalog, evidence: ToolEvidence, query = '') {
  if (query.length > 120) throw new Error('查询只接受120字以内的品牌或型号关键词。');
  const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]+/g, '');
  const needle = normalized(query.trim());
  const numeric = /^\d+$/.test(needle);
  const matches = numeric ? [] : catalog.profiles.filter(profile => !needle || normalized(profile.id).includes(needle)
    || normalized(profile.name).includes(needle) || profile.models.some(model => normalized(model).includes(needle)));
  const nativeStatus = evidence.nativeSoftwareInteroperability === 'passed' ? 'software-evidence-recorded' : 'not-verified';
  return {
    scope: 'read-only catalog and software evidence', connectsDevices: false, networkRequests: 0, validatesControlCodes: false,
    queryKind: numeric ? 'numeric-code-not-supported' : needle ? 'catalog-text' : 'all-catalog-groups',
    snapshot: { source: catalog.source, fetchedAt: catalog.fetchedAt, sha256: catalog.sha256, protocolRecords: catalog.protocolEntries, brandGroups: catalog.profiles.length },
    tools: [
      { id: 'buttplug', name: 'Buttplug', role: '协议基础', status: nativeStatus, scope: '实际引擎/上游软件测试回执；不代表实体设备验收' },
      { id: 'intiface-engine', name: 'Intiface Engine', role: '本机连接后端', status: nativeStatus, scope: '官方原生引擎通信回执；不查询当前运行服务' },
      { id: 'intiface-central', name: 'Intiface Central', role: '连接管理图形程序', status: evidence.intifaceCentralGuiTested ? 'software-evidence-recorded' : 'not-verified', scope: 'GUI与Engine分别验收' },
      { id: 'zendrex-js', name: 'Zendrex/buttplug.js', role: '当前产品客户端', status: nativeStatus, scope: '正式前端到原生引擎的空设备通信回执' },
      { id: 'buttplug-py', name: 'buttplug-py', role: '独立离线复测客户端', status: nativeStatus, scope: '上游Python测试和独立组件通信；不参与当前主控制流程' },
      { id: 'lovense-api', name: 'Lovense 官方 API', role: '厂商官方接口', status: evidence.lovenseOfficialApiImplemented ? 'implementation-recorded-not-accepted' : 'not-integrated', scope: '没有实际授权业务验收结论' },
      { id: 'audit-tools', name: 'REA / PentAGI / Strix / RedAmon', role: '分析与审计工具', status: 'not-integrated', scope: '不提供设备授权；不在当前产品连接流程中' },
    ],
    matches: matches.map(profile => {
      const names = needle ? profile.models.filter(model => normalized(model).includes(needle)) : profile.models;
      return { id: profile.id, name: profile.name, catalogNameRecords: profile.models.length,
        examples: (names.length ? names : profile.models).slice(0, 5), softwareFamily: 'Buttplug / Intiface 资料归属',
        evidence: 'catalog-only' as const, physicalCompatibility: 'unverified' as const };
    }),
    recordedPhysicalDeviceCount: evidence.physicalDevicesTested,
    warning: '匹配结果来自公开资料，不能证明可连接、获授权或已完成实机验收。数字码不用于此资料查询。',
  };
}
