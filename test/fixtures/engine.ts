import { WebSocketServer } from 'ws';
export const rawDevice = {
  DeviceName: 'Synthetic dual-motor device', DeviceIndex: 7, DeviceMessageTimingGap: 0,
  DeviceFeatures: {
    '2': { FeatureIndex: 2, FeatureDescription: 'Motor A', Output: { Vibrate: { Value: [0, 20] } } },
    '5': { FeatureIndex: 5, FeatureDescription: 'Motor B', Output: { Vibrate: { Value: [0, 100] } } },
    '9': { FeatureIndex: 9, FeatureDescription: 'Other actuator', Output: { Rotate: { Value: [0, 10] } } },
  },
};
export async function fakeEngine(options: { name?: string; recordLimit?: number } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  const messages: Record<string, any>[] = [];
  server.on('connection', socket => socket.on('message', data => {
    for (const message of JSON.parse(data.toString()) as Record<string, any>[]) {
      messages.push(message);
      if (messages.length > (options.recordLimit ?? 4096)) messages.shift();
      const [type, payload] = Object.entries(message)[0]!;
      if (type === 'RequestServerInfo') socket.send(JSON.stringify([{ ServerInfo: { Id: payload.Id, ServerName: 'Isolated synthetic engine', MaxPingTime: 0, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 } }]));
      else if (type === 'RequestDeviceList') socket.send(JSON.stringify([{ DeviceList: { Id: payload.Id, Devices: { '7': { ...rawDevice, DeviceName: options.name ?? rawDevice.DeviceName } } } }]));
      else {
        socket.send(JSON.stringify([{ Ok: { Id: payload.Id } }]));
        if (type === 'StartScanning') setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify([{ ScanningFinished: { Id: 0 } }])); }, 5);
      }
    }
  }));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (typeof address === 'string' || !address) throw new Error('No test address');
  return { url: `ws://127.0.0.1:${address.port}`, messages,
    close: async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
