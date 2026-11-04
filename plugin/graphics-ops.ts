import { bootstrapLimits } from '../shared/bootstrap-limits';
import { stepSchema } from '../shared/contracts';
import type { BatchStep } from '../shared/batch-refs';
import { nodePreconditions } from './resource-expected';

type Changes = { nodeIds: string[]; resourceIds: string[]; details?: unknown[] };
const tags = new Set(['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'text', 'tspan', 'title', 'desc']);
const attrs = new Set(['xmlns', 'xmlns:xlink', 'id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'transform', 'gradientTransform', 'gradientUnits', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask', 'maskUnits', 'maskContentUnits', 'href', 'xlink:href', 'preserveAspectRatio', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'visibility', 'display']);
const localRef = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;
const localUrl = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
function utf8Size(value: string) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) throw new Error('INVALID_ARGUMENT'); bytes += 4; }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('INVALID_ARGUMENT');
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}
function validateSvg(svg: string) {
  if (/[&\\\x00-\x08\x0b\x0c\x0e-\x1f]/.test(svg)) throw new Error('INVALID_ARGUMENT');
  const stack: string[] = []; let index = 0, seen = false, closed = false;
  while (index < svg.length) {
    if (svg[index] !== '<') {
      const end = svg.indexOf('<', index), text = svg.slice(index, end < 0 ? svg.length : end);
      if (!stack.length && text.trim()) throw new Error('INVALID_ARGUMENT');
      index = end < 0 ? svg.length : end; continue;
    }
    const end = svg.indexOf('>', index + 1);
    if (end < 0) throw new Error('INVALID_ARGUMENT');
    const body = svg.slice(index + 1, end); index = end + 1;
    const close = /^\/([A-Za-z][A-Za-z0-9]*)\s*$/.exec(body);
    if (close) { if (stack.pop() !== close[1]) throw new Error('INVALID_ARGUMENT'); if (!stack.length) closed = true; continue; }
    const open = /^([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)$/.exec(body);
    if (!open || closed || (!stack.length && (seen || open[1] !== 'svg'))) throw new Error('INVALID_ARGUMENT');
    if (!tags.has(open[1])) { if (/^(script|foreignObject|iframe|object|embed|image|animate|animateTransform|animateMotion|set)$/i.test(open[1]) || /(?:url|javascript|data|https?|file)\s*[:(]|@import|on[a-z]+\s*=/i.test(open[2])) throw new Error('INVALID_ARGUMENT'); throw new Error('CAPABILITY_UNAVAILABLE'); }
    if (!stack.length) seen = true;
    let rest = open[2], names = new Set<string>();
    while (rest.length) {
      const attr = /^\s+([A-Za-z][A-Za-z0-9:.-]*)\s*=\s*("[^"]*"|'[^']*')/.exec(rest);
      if (!attr) { if (!rest.trim()) break; throw new Error('INVALID_ARGUMENT'); }
      if (names.has(attr[1])) throw new Error('INVALID_ARGUMENT');
      if (!attrs.has(attr[1])) { if (/^on/i.test(attr[1]) || /(?:url|javascript|data|https?|file)\s*[:(]|@import/i.test(attr[2])) throw new Error('INVALID_ARGUMENT'); throw new Error('CAPABILITY_UNAVAILABLE'); }
      names.add(attr[1]); const value = attr[2].slice(1, -1);
      if (/[<>]/.test(value) || !attr[1].startsWith('xmlns') && /(?:url|javascript|data|https?|file)\s*[:(]/i.test(value) && !localUrl.test(value)) throw new Error('INVALID_ARGUMENT');
      if ((attr[1] === 'href' || attr[1] === 'xlink:href') && !localRef.test(value)) throw new Error('INVALID_ARGUMENT');
      if (attr[1] === 'xmlns' && value !== 'http://www.w3.org/2000/svg' || attr[1] === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') throw new Error('INVALID_ARGUMENT');
      rest = rest.slice(attr[0].length);
    }
    if (!open[3]) stack.push(open[1]); else if (!stack.length) closed = true;
  }
  if (!seen || !closed || stack.length) throw new Error('INVALID_ARGUMENT');
}
function imageBytes(figma: any, data: string, mime: string, max: number) {
  if (data.length > Math.ceil(max / 3) * 4) throw new Error('RESOURCE_LIMIT');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('INVALID_ARGUMENT');
  let bytes: Uint8Array;
  try { bytes = figma.base64Decode(data); if (figma.base64Encode(bytes) !== data) throw new Error(); } catch { throw new Error('INVALID_ARGUMENT'); }
  if (bytes.length > max) throw new Error('RESOURCE_LIMIT');
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  if (mime === 'image/png' && !png || mime === 'image/jpeg' && !jpeg || mime === 'image/webp' && !webp) throw new Error('INVALID_ARGUMENT');
  if (mime === 'image/webp') throw new Error('CAPABILITY_UNAVAILABLE');
  return bytes;
}
export function graphicsOperations(figma: any, limits: { maxImportBytes: number } = bootstrapLimits) {
  const checks = nodePreconditions(figma);
  let targets: any[] = [], parent: any, original: BatchStep;
  const find = async (id: string) => { const n = await figma.getNodeByIdAsync(id); if (!n || n.removed) throw new Error('NODE_NOT_FOUND'); let page = n; while (page && page.type !== 'PAGE') page = page.parent; if (page) await page.loadAsync(); return n; };
  const within = (node: any, ancestor: any) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; };
  const insideInstance = (node: any) => { for (let n = node; n; n = n.parent) if (n.type === 'INSTANCE') return true; return false; };
  const pageOf = (node: any) => { for (let n = node; n; n = n.parent) if (n.type === 'PAGE') return n; };
  function preflight(step: BatchStep) {
    if (!stepSchema.safeParse(step).success) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'importSvg') { if (utf8Size(step.svg as string) > limits.maxImportBytes) throw new Error('RESOURCE_LIMIT'); validateSvg(step.svg as string); }
    else if (step.op === 'importImage') { imageBytes(figma, step.data as string, step.mimeType as string, limits.maxImportBytes); const p = step.placement as any; if (p.width < 0.01 || p.height < 0.01) throw new Error('INVALID_ARGUMENT'); }
    else if (step.op !== 'booleanNodes') throw new Error('CAPABILITY_UNAVAILABLE');
  }
  function validate(step: BatchStep) {
    if (!parent || parent.removed || targets.some(n => n.removed)) throw new Error('NODE_NOT_FOUND');
    if (!['PAGE','FRAME','GROUP','COMPONENT','SECTION'].includes(parent.type) || typeof parent.appendChild !== 'function' || insideInstance(parent)) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'booleanNodes') {
      if (new Set(targets).size !== targets.length || targets.some(n => !n.parent || insideInstance(n.parent) || pageOf(n) !== pageOf(parent) || within(parent, n)) || targets.some((a,i) => targets.some((b,j) => i !== j && within(a,b)))) throw new Error('INVALID_ARGUMENT');
    }
  }
  return {
    preflight,
    async prepare(step: BatchStep, raw: BatchStep = step) {
      checks.reset();
      original = raw; preflight(original);
      parent = await find((step.parent as { nodeId: string }).nodeId);
      targets = step.op === 'booleanNodes' ? await Promise.all((step.targets as {nodeId:string}[]).map(ref => find(ref.nodeId))) : [];
      validate(step);
    },
    async readExpected(step: BatchStep) { return checks.read(targets[0] ?? parent, step.expected as Record<string, any>); },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      checks.verify();
      validate(step); preflight(original);
      const mark = (ids: string[]) => record({ nodeIds: ids, resourceIds: [] });
      if (step.op === 'booleanNodes') {
        const ids = new Set<string>(); for (const n of [...targets, parent]) for (let p = n; p && p.type !== 'DOCUMENT'; p = p.parent) ids.add(p.id);
        const containers = [...new Set([parent, ...targets.map(n => n.parent)])];
        const before = containers.map(n => n.children.map((child: any) => child.id));
        let result: any;
        try { result = figma[step.kind as string](targets, parent); }
        catch (error) {
          let changed = false;
          containers.forEach((n, i) => {
            if (n.removed) { changed = true; return; }
            const after = n.children.map((child: any) => child.id);
            if (JSON.stringify(before[i]) !== JSON.stringify(after)) { changed = true; after.filter((id: string) => !before[i].includes(id)).forEach((id: string) => ids.add(id)); }
          });
          if (changed) mark([...ids]);
          throw error;
        }
        ids.add(result.id); mark([...ids]); return { nodeId: result.id };
      }
      if (step.op === 'importSvg') {
        const result = figma.createNodeFromSvg(step.svg); mark([result.id]); parent.appendChild(result); mark([parent.id]); return { nodeId: result.id };
      }
      const bytes = imageBytes(figma, step.data as string, step.mimeType as string, limits.maxImportBytes);
      const image = figma.createImage(bytes);
      record({ nodeIds: [], resourceIds: [], details: [{ kind: 'image', imageHash: image.hash }] });
      const node = figma.createRectangle(); mark([node.id]); parent.appendChild(node); mark([parent.id]);
      const placement = step.placement as any;
      node.resize(placement.width, placement.height); mark([node.id]); node.x = placement.x; mark([node.id]); node.y = placement.y; mark([node.id]);
      node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]; mark([node.id]);
      return { nodeId: node.id };
    },
  };
}
