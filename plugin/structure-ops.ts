import { nodePreconditions } from './resource-expected';
import { stepSchema } from '../shared/contracts';
import type { BatchStep } from '../shared/batch-refs';

type Changes = { nodeIds: string[]; resourceIds: string[] };

export function structureOperations(figma: any) {
  let targets: any[] = [], parent: any, original: BatchStep;
  const checks = nodePreconditions(figma);
  const find = async (id: string) => {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
    let page = node;
    while (page && page.type !== 'PAGE') page = page.parent;
    if (page) await page.loadAsync();
    return node;
  };
  const within = (node: any, ancestor: any) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; };
  const inInstance = (node: any) => { for (let n = node; n; n = n.parent) if (n.type === 'INSTANCE') return true; return false; };
  const validate = (step: BatchStep) => {
    if (!stepSchema.safeParse(original).success) throw new Error('INVALID_ARGUMENT');
    if (targets.some(n => !n || n.removed) || parent?.removed) throw new Error('NODE_NOT_FOUND');
    if (step.op === 'movePage') {
      if (targets[0].type !== 'PAGE' || (step.index as number) >= figma.root.children.length) throw new Error('INVALID_ARGUMENT');
      return;
    }
    if (new Set(targets).size !== targets.length || targets.some(n => !n.parent || ['PAGE', 'DOCUMENT'].includes(n.type) || inInstance(n.parent))) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'ungroupNode') {
      if (targets[0].type !== 'GROUP' || inInstance(targets[0])) throw new Error('INVALID_ARGUMENT');
      return;
    }
    if (!parent || !['PAGE', 'FRAME', 'GROUP', 'COMPONENT', 'SECTION', 'COMPONENT_SET'].includes(parent.type) || typeof parent.insertChild !== 'function' || inInstance(parent)) throw new Error('INVALID_ARGUMENT');
    if (targets.some(n => within(parent, n)) || targets.some((a, i) => targets.some((b, j) => i !== j && within(a, b)))) throw new Error('INVALID_ARGUMENT');
    if (parent.type === 'COMPONENT_SET' && (step.op !== 'moveNode' || targets[0].type !== 'COMPONENT')) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'moveNode' && (step.index as number) > parent.children.length - (targets[0].parent === parent ? 1 : 0)) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'groupNodes' && targets.some(n => pageOf(n) !== pageOf(parent))) throw new Error('INVALID_ARGUMENT');
  };
  function pageOf(node: any) { for (let n = node; n; n = n.parent) if (n.type === 'PAGE') return n; return undefined; }
  return {
    async prepare(step: BatchStep, raw: BatchStep = step) {
      checks.reset();
      original = raw;
      if (!['movePage', 'moveNode', 'groupNodes', 'ungroupNode'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (!stepSchema.safeParse(original).success) throw new Error('INVALID_ARGUMENT');
      targets = await Promise.all((step.op === 'groupNodes' ? step.targets as { nodeId: string }[] : [step.op === 'movePage' ? step.pageId as { nodeId: string } : step.target as { nodeId: string }]).map(ref => find(ref.nodeId)));
      parent = step.op === 'ungroupNode' || step.op === 'movePage' ? undefined : await find((step.parent as { nodeId: string }).nodeId);
      validate(step);
    },
    async readExpected(step: BatchStep) {
      return checks.read(targets[0], step.expected as Record<string, any>);
    },
    async execute(step: BatchStep, record: (change: Changes) => void) {
      checks.verify();
      validate(step);
      const ids = new Set<string>();
      for (const node of targets) { ids.add(node.id); for (let p = node.parent; p && p.type !== 'DOCUMENT'; p = p.parent) ids.add(p.id); }
      if (parent) for (let p = parent; p && p.type !== 'DOCUMENT'; p = p.parent) ids.add(p.id);
      if (step.op === 'movePage') { figma.root.insertChild(step.index, targets[0]); ids.add(figma.root.id); }
      else if (step.op === 'moveNode') parent.insertChild(step.index, targets[0]);
      else if (step.op === 'groupNodes') {
        const group = figma.group(targets, parent);
        ids.add(group.id);
        record({ nodeIds: [...ids], resourceIds: [] });
        return { nodeId: group.id };
      } else {
        for (const child of targets[0].children) ids.add(child.id);
        figma.ungroup(targets[0]);
      }
      record({ nodeIds: [...ids], resourceIds: [] });
      return {};
    },
  };
}
