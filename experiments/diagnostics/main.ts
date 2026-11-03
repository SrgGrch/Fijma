import { handleResources } from '../resources-probe/probe';
import { handleLimits } from '../limits-probe/probe';

figma.showUI(__html__, { width: 600, height: 640 });
let active: string | undefined;
figma.ui.onmessage = async message => {
  if (message?.type === 'yield' && active === 'limits' && Number.isSafeInteger(message.id) &&
    Object.keys(message).length === 2) {
    await handleLimits(message);
    return;
  }
  if (!message || typeof message !== 'object' || Object.keys(message).some(key => !['suite', 'type'].includes(key))) return;
  if (message.suite === 'limits' && message.type === 'stop' && active === 'limits') {
    await handleLimits({ type: 'stop' });
    return;
  }
  if (active) return;
  if (!((message.suite === 'resources' && message.type === 'probe') || (message.suite === 'limits' && message.type === 'measure'))) return;
  active = message.suite;
  try {
    if (active === 'resources') await handleResources({ type: 'probe' });
    else await handleLimits({ type: 'measure' });
  } finally { active = undefined; }
};
