import { createBridgeRuntime } from './bridge-runtime';
import { createPairingStorage } from './pairing-storage';

// Manual test candidate only: use after checking the document boundary in Desktop.
figma.showUI(__html__, { width: 400, height: 600, themeColors: true });
const runtime = createBridgeRuntime(undefined, true);
const pairing = createPairingStorage();
figma.ui.onmessage = message => { if (!pairing(message)) return runtime(message); };
