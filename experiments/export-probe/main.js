(() => {
  // experiments/export-probe/main.ts
  figma.showUI(__html__, { width: 400, height: 260 });
  figma.ui.onmessage = async (message) => {
    if (!message || message.type !== "export") return;
    const selected = figma.currentPage.selection;
    if (selected.length !== 1) {
      figma.ui.postMessage({ type: "error", message: "\u0412\u044B\u0434\u0435\u043B\u0438\u0442\u0435 \u043E\u0434\u0438\u043D \u043E\u0431\u044A\u0435\u043A\u0442." });
      return;
    }
    try {
      const png = await selected[0].exportAsync({ format: "PNG" });
      const svg = await selected[0].exportAsync({ format: "SVG_STRING" });
      figma.ui.postMessage({ type: "export", png, svg });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u044D\u043A\u0441\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u044B\u0439 \u043E\u0431\u044A\u0435\u043A\u0442." });
    }
  };
})();
