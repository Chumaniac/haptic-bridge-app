export type Mode = 'demo' | 'intiface';
export type Receipt = 'idle' | 'sending' | 'sent' | 'stopped' | 'unconfirmed';
export interface Feature { index: number; label: string; range?: [number, number] }
export interface DeviceInfo { id: string; name: string; model?: string; features: Feature[]; otherCapabilities: string[] }
export interface DeviceState extends DeviceInfo {
  epoch: number;
  armed: boolean;
  values: Record<string, number>;
  receipt: Receipt;
  testing: boolean;
}
export interface Snapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'disconnecting' | 'fault';
  mode: Mode | null;
  scanning: boolean;
  devices: DeviceState[];
  message: string;
  revision: number;
  canControl: boolean;
  diagnosing: boolean;
}
export type AdapterEvent =
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'disconnected' }
  | { type: 'scan'; active: boolean };
export interface DeviceAdapter {
  readonly mode: Mode;
  connect(): Promise<DeviceInfo[]>;
  scan(): Promise<void>;
  stopScan(): Promise<void>;
  vibrate(id: string, feature: number, value: number): Promise<void>;
  stop(id?: string): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
}

// These contracts reserve future integrations without granting remote control today.
export interface PairingPort {
  create(request: { ownerId: string; deviceIds: string[] }): Promise<{ code: string; expiresAt: number }>;
  redeem(code: string, requesterId: string): Promise<{ requestId: string; state: 'awaiting-owner' }>;
  approve(requestId: string, ownerId: string): Promise<{ sessionId: string }>;
  revoke(sessionId: string, ownerId: string): Promise<void>;
}
export type InviteResult =
  | { kind: 'needs-provider'; candidates: string[] }
  | { kind: 'handoff'; provider: string; url: string }
  | { kind: 'controlled'; provider: string; sessionId: string };
export interface OfficialInvitePort {
  resolve(input: { value: string; provider?: string }): Promise<InviteResult>;
}
export interface BrandProfile {
  id: string;
  name: string;
  source: string;
  evidence: 'catalog-only' | 'synthetic-tested' | 'hardware-verified';
  models: string[];
  protocolIds: string[];
  firmware?: string;
  verifiedAt?: string;
}
export interface AdapterRegistration {
  id: string;
  transport: 'intiface' | 'official-api' | 'native-ble' | 'hardware-bridge';
  profiles: BrandProfile[];
  create(): DeviceAdapter;
}
