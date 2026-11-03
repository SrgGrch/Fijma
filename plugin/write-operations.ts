import type { BatchStep } from '../shared/batch-refs';
import { pageOperations } from './scene-ops';
import { textOperations } from './text-ops';
import { geometryOperations } from './geometry-ops';
import { textRangeOperations } from './text-range-ops';

type Handler = { prepare(step: BatchStep): Promise<void>; readExpected(step: BatchStep): Promise<Record<string, unknown>>; execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void): Promise<any> };

// A BatchExecutor executes one step at a time, so the selected handler stays fixed through the step.
export function writeOperations(figma: any) {
  const scene = pageOperations(figma), text = textOperations(figma), geometry = geometryOperations(figma), ranges = textRangeOperations(figma);
  let current: Handler;
  return {
    async prepare(step: BatchStep) {
      current = step.op === 'createText' || (step.op === 'createNode' || step.op === 'updateNode') && step.type === 'TEXT' ? text : step.op === 'setGeometry' ? geometry : step.op === 'replaceTextRange' || step.op === 'formatTextRange' ? ranges : scene;
      await current.prepare(step);
    },
    readExpected(step: BatchStep) { return current.readExpected(step); },
    execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void) { return current.execute(step, record); },
  };
}
