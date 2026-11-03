figma.showUI(__html__, { width: 420, height: 300 });
figma.ui.onmessage = (message) => {
  if (!message || !['batch-a', 'batch-b', 'partial'].includes(message.type)) return;
  const marker = figma.createRectangle();
  marker.name = message.type === 'batch-a' ? 'Undo test A' : message.type === 'batch-b' ? 'Undo test B' : 'Undo test partial';
  marker.resize(80, 80);
  marker.x = message.type === 'batch-a' ? 0 : message.type === 'batch-b' ? 100 : 200;
  figma.commitUndo();
  figma.ui.postMessage({ type: 'result', name: marker.name, partial: message.type === 'partial' });
};
