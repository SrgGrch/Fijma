import { createBridgeRuntime } from './bridge-runtime';

// Manual test candidate only: use after checking the document boundary in Desktop.
figma.showUI(__html__, { width: 450, height: 430 });
figma.ui.onmessage = createBridgeRuntime(undefined, true);
