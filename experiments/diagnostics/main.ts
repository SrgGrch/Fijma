import { handleResources } from '../resources-probe/probe';
import { handleLimits } from '../limits-probe/probe';
import { createBridgeRuntime } from '../../plugin/bridge-runtime';
import { createMarkerProbe } from './marker';

figma.showUI(__html__, { width: 600, height: 640 });
const bridge = createBridgeRuntime(createMarkerProbe(figma));
let active: string | undefined;
let bridgeConnected = false;
figma.ui.onmessage = async message => {
  if (message?.type === 'yield' && active === 'limits' && Number.isSafeInteger(message.id) &&
    Object.keys(message).length === 2) {
    await handleLimits(message);
    return;
  }
  if (message && typeof message === 'object' && ['hello-request', 'welcome', 'disconnected', 'getContext', 'command', 'yield'].includes(message.type)) {
    if (active && message.type !== 'disconnected') { figma.ui.postMessage({ type: 'error', code: 'RESOURCE_LIMIT' }); return; }
    if (message.type === 'hello-request') bridgeConnected = true;
    if (message.type === 'disconnected') bridgeConnected = false;
    await bridge(message);
    return;
  }
  if (!message || typeof message !== 'object' || Object.keys(message).some(key => !['suite', 'type'].includes(key))) return;
  if (message.suite === 'limits' && message.type === 'stop' && active === 'limits') {
    await handleLimits({ type: 'stop' });
    return;
  }
  if (active || bridgeConnected) return;
  if (!((message.suite === 'resources' && message.type === 'probe') || (message.suite === 'limits' && message.type === 'measure'))) return;
  active = message.suite;
  try {
    if (active === 'resources') await handleResources({ type: 'probe' });
    else await handleLimits({ type: 'measure' });
  } finally { active = undefined; }
};
