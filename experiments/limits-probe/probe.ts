import { readTree } from '../../shared/read-tree';


let running = false;
let stoppedAt: number | undefined;
let yieldId = 0;
let pendingYield: { id: number; resolve: () => void } | undefined;
const yieldToUI = () => new Promise<void>(resolve => {
  pendingYield = { id: ++yieldId, resolve };
  figma.ui.postMessage({ type: 'yield', id: yieldId });
});
const limits = { maxDepth: 8, maxNodes: 1000, maxResponseBytes: 262144, chunkSize: 50 };
export const handleLimits = async (message: { type?: string; id?: number } | null) => {
  if (message?.type === 'yield') {
    if (pendingYield && message.id === pendingYield.id) {
      const { resolve } = pendingYield;
      pendingYield = undefined;
      resolve();
    }
    return;
  }
  if (message?.type === 'stop') { if (running) stoppedAt = Date.now(); return; }
  if (message?.type !== 'measure' || running) return;
  running = true;
  stoppedAt = undefined;
  let fixture: FrameNode | undefined;
  const report: Record<string, unknown> = { provisionalLimits: limits, scheduler: 'ui-message' };
  const progress = (action: string) => figma.ui.postMessage({ type: 'progress', action });
  try {
    progress('Создание фикстуры (5000 прямоугольников)');
    await figma.currentPage.loadAsync();
    fixture = figma.createFrame();
    fixture.name = 'MCP limits probe';
    fixture.resize(1000, 1000);
    const start = Date.now();
    for (let index = 0; index < 5000; index++) {
      if (stoppedAt !== undefined) break;
      const rect = figma.createRectangle();
      fixture.appendChild(rect);
      rect.resize(8, 8);
      rect.x = (index % 100) * 10;
      rect.y = Math.floor(index / 100) * 10;
      if (index % 50 === 49) await yieldToUI();
    }
    report.fixture = { count: fixture.children.length, createMs: Date.now() - start };
    if (stoppedAt === undefined) {
      progress('Ограниченное чтение');
      const readStart = Date.now();
      let yieldMs = 0, yields = 0;
      const result = await readTree(fixture, limits, {
        stopped: () => stoppedAt !== undefined,
        yieldControl: async () => {
          const start = Date.now();
          await yieldToUI();
          yieldMs += Date.now() - start;
          yields++;
        },
      });
      const ms = Date.now() - readStart;
      report.read = { count: result.nodes.length, bytes: result.bytes, truncated: result.truncated, cancelled: result.cancelled, ms, yieldMs, yields, workMs: ms - yieldMs };
    }
    if (stoppedAt === undefined) {
      progress('Границы depth/node/byte на той же фикстуре');
      const node = await readTree(fixture, { ...limits, maxNodes: 1 });
      const depth = await readTree(fixture, { ...limits, maxDepth: 0 });
      const exactBytes = await readTree(fixture, { ...limits, maxResponseBytes: node.bytes });
      const belowBytes = await readTree(fixture, { ...limits, maxResponseBytes: node.bytes - 1 });
      report.boundaries = {
        nodeLimit: node.nodes.length === 1 && node.truncated,
        depthLimit: depth.nodes.length === 1 && depth.truncated,
        exactByteLimit: exactBytes.nodes.length === 1 && exactBytes.bytes === node.bytes && exactBytes.truncated,
        belowByteLimit: belowBytes.nodes.length === 0 && belowBytes.truncated,
      };
    }
    if (stoppedAt === undefined) {
      progress('PNG 1000 × 1000 (экспорт API не прерывается)');
      const exportStart = Date.now();
      const png = await fixture.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      report.export = { bytes: png.length, pixels: 1000000, ms: Date.now() - exportStart };
    }
  } catch (error) {
    report.error = String(error);
  } finally {
    if (stoppedAt !== undefined) report.stop = { mainObservedAt: stoppedAt, stopToCleanupMs: Date.now() - stoppedAt };
    try { fixture?.remove(); report.cleanup = 'removed'; }
    catch (error) { report.cleanupError = String(error); }
    figma.ui.postMessage({ type: 'report', report });
    running = false;
  }
};
