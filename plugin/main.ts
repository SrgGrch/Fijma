import { createBridgeRuntime } from './bridge-runtime';

figma.showUI(__html__, { width: 450, height: 430 });
figma.ui.onmessage = createBridgeRuntime();
