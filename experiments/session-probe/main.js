(() => {
  // experiments/session-probe/main.ts
  var session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  figma.showUI(__html__, { width: 430, height: 400 });
  figma.ui.onmessage = (message) => {
    if (message && message.type === "probe" && Number.isSafeInteger(message.sequence)) {
      figma.ui.postMessage({ type: "probe-result", sequence: message.sequence, session, fileKeyAvailable: Boolean(figma.fileKey) });
    } else if (message && message.type === "test-write" && typeof message.session === "string") {
      if (message.session !== session) {
        figma.ui.postMessage({ type: "write-result", status: "SESSION_EXPIRED" });
        return;
      }
      try {
        const marker = figma.createRectangle();
        marker.name = "MCP session test marker";
        marker.resize(80, 80);
        figma.ui.postMessage({ type: "write-result", status: "CREATED" });
      } catch (e) {
        figma.ui.postMessage({ type: "write-result", status: "ERROR" });
      }
    }
  };
})();
