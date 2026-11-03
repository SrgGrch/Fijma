import { exportChunkBytes, pngDimensions } from '../shared/export-wire';

export async function exportNode(api: PluginAPI, query: { nodeId: string; format: 'PNG' | 'SVG'; scale?: number },
  limits: { maxExportPixels: number; maxExportBytes: number }, checkScope: () => void, chunkBytes: number,
  send: (message: { type: 'exportStart'; nodeId: string; format: 'PNG' | 'SVG'; bytes: number; total: number; chunkBytes: number; width?: number; height?: number } |
    { type: 'exportChunk'; index: number; total: number; data: string }) => void, yieldControl: () => Promise<void>) {
  const scale = query.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || (query.format === 'SVG' && scale !== 1)) throw new Error('INVALID_ARGUMENT');
  const node = await api.getNodeByIdAsync(query.nodeId);
  checkScope();
  if (!node) throw new Error('NODE_NOT_FOUND');
  if (node.type === 'PAGE' || node.type === 'DOCUMENT' || !('exportAsync' in node)) throw new Error('CAPABILITY_UNAVAILABLE');
  if (query.format === 'PNG') {
    const bounds = 'absoluteRenderBounds' in node ? node.absoluteRenderBounds : null;
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) throw new Error('CAPABILITY_UNAVAILABLE');
    const width = Math.ceil(bounds.width * scale), height = Math.ceil(bounds.height * scale);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > Math.floor(limits.maxExportPixels / height)) throw new Error('RESOURCE_LIMIT');
  }
  const bytes = await node.exportAsync(query.format === 'PNG' ? { format: 'PNG', constraint: { type: 'SCALE', value: scale } } : { format: 'SVG' });
  checkScope();
  if (!bytes.length || bytes.length > limits.maxExportBytes) throw new Error('RESOURCE_LIMIT');
  const dimensions = query.format === 'PNG' ? pngDimensions(bytes) : undefined;
  if (dimensions && dimensions.width > Math.floor(limits.maxExportPixels / dimensions.height)) throw new Error('RESOURCE_LIMIT');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 3 || chunkBytes > exportChunkBytes || chunkBytes % 3) throw new Error('INVALID_ARGUMENT');
  const total = Math.ceil(bytes.length / chunkBytes);
  send({ type: 'exportStart', nodeId: query.nodeId, format: query.format, bytes: bytes.length, total, chunkBytes, ...dimensions });
  for (let index = 0; index < total; index++) {
    checkScope();
    send({ type: 'exportChunk', index, total, data: api.base64Encode(bytes.slice(index * chunkBytes, (index + 1) * chunkBytes)) });
    if (index + 1 < total) await yieldControl();
  }
}
