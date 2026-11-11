import { z } from 'zod';

export const requiredGateIds = Array.from({ length: 12 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`);
export const matrixSchema = z.strictObject({
  schemaVersion: z.literal(1), updated: z.string(), product: z.string(),
  candidate: z.strictObject({ version: z.string().min(1), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).nullable(), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }),
  scope: z.strictObject({ authorizedDevicesOnly: z.literal(true), codeGuessingAllowed: z.literal(false), unauthorizedAccessAllowed: z.literal(false), declaredSupportFrozen: z.boolean() }),
  gates: z.array(z.strictObject({ id: z.string(), title: z.string(), required: z.literal(true), status: z.enum(['pass', 'partial', 'missing', 'blocked', 'not-run']), evidence: z.array(z.string()).min(1), gap: z.string() })).length(12),
});
export type AcceptanceMatrix = z.infer<typeof matrixSchema>;
export interface AcceptanceFacts {
  foundationVerified: boolean;
  realDeviceCount: number;
  centralGuiVerified: boolean;
  officialApiImplemented: boolean;
  officialAuthorizedFlowVerified: boolean;
  authorizedCodeFlowVerified: boolean;
  physicalAcceptanceVerified: boolean;
  completeSecurityReviewVerified: boolean;
  cleanInstallVerified: boolean;
  humanSignoffVerified: boolean;
}
const factsSchema = z.strictObject({
  foundationVerified: z.boolean(), realDeviceCount: z.number().int().min(0), centralGuiVerified: z.boolean(),
  officialApiImplemented: z.boolean(), officialAuthorizedFlowVerified: z.boolean(), authorizedCodeFlowVerified: z.boolean(),
  physicalAcceptanceVerified: z.boolean(), completeSecurityReviewVerified: z.boolean(), cleanInstallVerified: z.boolean(), humanSignoffVerified: z.boolean(),
});
export function evaluateAcceptance(input: unknown, facts: AcceptanceFacts, missingEvidence: string[] = []) {
  const matrix = matrixSchema.parse(input);
  facts = factsSchema.parse(facts);
  if (new Set(matrix.gates.map(gate => gate.id)).size !== 12 || requiredGateIds.some(id => !matrix.gates.some(gate => gate.id === id))) throw new Error('Required acceptance gates are missing or duplicated');
  const reasons: string[] = [];
  const gateResults = matrix.gates.map(gate => {
    let verified = gate.status === 'pass';
    let reason = gate.gap;
    const reject = (detail: string) => { verified = false; reason = detail; };
    if (verified) {
      if (gate.id === 'G01' && !facts.foundationVerified) reject('软件基础证据缺失或不通过。');
      if (gate.id === 'G02' && !facts.centralGuiVerified) reject('没有Central GUI实际验收证据。');
      if (gate.id === 'G03' && (!facts.officialApiImplemented || !facts.officialAuthorizedFlowVerified)) reject('没有官方授权业务验收证据。');
      if (gate.id === 'G06' && !facts.authorizedCodeFlowVerified) reject('没有实际授权代码流程证据。');
      if (['G02', 'G03', 'G04', 'G05', 'G07', 'G09', 'G10', 'G12'].includes(gate.id) && (facts.realDeviceCount < 1 || !facts.physicalAcceptanceVerified)) reject('缺少真实设备及对应完整验收证据。');
      if (gate.id === 'G08' && !facts.completeSecurityReviewVerified) reject('只有局部检查，缺少完整授权安全复核。');
      if (gate.id === 'G11' && !facts.cleanInstallVerified) reject('缺少干净环境交付证据。');
      if (gate.id === 'G12' && !facts.humanSignoffVerified) reject('缺少必要人工验收确认。');
      if (gate.evidence.some(path => missingEvidence.includes(path))) reject('引用的证据缺失或无效。');
    }
    if (!verified) reasons.push(`${gate.id} ${reason || '门槛未通过。'}`);
    return { id: gate.id, title: gate.title, declaredStatus: gate.status, verified, reason };
  });
  if (!matrix.scope.declaredSupportFrozen) reasons.push('声明支持范围未冻结。');
  if (!matrix.candidate.sourceRevision || !matrix.candidate.artifactSha256) reasons.push('候选源码/制品身份未冻结。');
  return { accepted: reasons.length === 0, verdict: reasons.length ? '未通过' : '通过', passedGates: gateResults.filter(gate => gate.verified).length,
    requiredGates: 12, realDeviceCount: facts.realDeviceCount, reasons, gateResults,
    limitation: '证据门槛检查不能替代实物观察、授权真实性核实或人工签核。' };
}
