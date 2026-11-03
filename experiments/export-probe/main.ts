figma.showUI(__html__, { width: 400, height: 260 });
figma.ui.onmessage = async (message) => {
  if (!message || message.type !== 'export') return;
  const selected = figma.currentPage.selection;
  if (selected.length !== 1) {
    figma.ui.postMessage({ type: 'error', message: 'Выделите один объект.' });
    return;
  }
  try {
    const png = await selected[0].exportAsync({ format: 'PNG' });
    const svg = await selected[0].exportAsync({ format: 'SVG_STRING' });
    figma.ui.postMessage({ type: 'export', png, svg });
  } catch {
    figma.ui.postMessage({ type: 'error', message: 'Не удалось экспортировать выделенный объект.' });
  }
};
