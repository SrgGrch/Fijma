import { handleResources } from './probe';
figma.showUI(__html__, { width: 540, height: 560 });
figma.ui.onmessage = handleResources;
