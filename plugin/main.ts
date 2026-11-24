import { createBridgeRuntime } from './bridge-runtime';
import { createPairingStorage } from './pairing-storage';

const fullSize = { width: 400, height: 600 };
const compactSize = { width: 320, height: 48 };
figma.showUI(__html__, { ...fullSize, themeColors: true });
const runtime = createBridgeRuntime();
const pairing = createPairingStorage();
figma.ui.onmessage = message => {
  if (message?.type === 'ui-compact' && typeof message.compact === 'boolean') {
    const { width, height } = message.compact ? compactSize : fullSize;
    figma.ui.resize(width, height);
    return;
  }
  if (!pairing(message)) return runtime(message);
};
