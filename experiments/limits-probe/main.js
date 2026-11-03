(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // shared/read-tree.ts
  async function readTree(root, limits2, options = {}) {
    var _a, _b, _c;
    for (const [key, value] of Object.entries(limits2)) {
      if (!Number.isSafeInteger(value) || value < (key === "maxDepth" ? 0 : 1)) throw new Error("INVALID_ARGUMENT");
    }
    if (limits2.maxResponseBytes < 2) throw new Error("INVALID_ARGUMENT");
    const nodes = [];
    const frames = [{ children: [root], index: 0, depth: 0 }];
    let bytes = 2;
    let truncated = false;
    let cancelled = false;
    while (frames.length) {
      if ((_a = options.stopped) == null ? void 0 : _a.call(options)) {
        cancelled = true;
        break;
      }
      const frame = frames[frames.length - 1];
      if (frame.index >= frame.children.length) {
        frames.pop();
        continue;
      }
      const node = frame.children[frame.index++];
      const row = { nodeId: node.id, name: node.name, type: node.type, depth: frame.depth };
      const rowBytes = encodeURI(JSON.stringify(row)).replace(/%[A-F\d]{2}/g, "x").length;
      const nextBytes = bytes + rowBytes + (nodes.length ? 1 : 0);
      if (nodes.length >= limits2.maxNodes || nextBytes > limits2.maxResponseBytes) {
        truncated = true;
        break;
      }
      nodes.push(row);
      bytes = nextBytes;
      if ((_b = node.children) == null ? void 0 : _b.length) {
        if (frame.depth < limits2.maxDepth) frames.push({ children: node.children, index: 0, depth: frame.depth + 1 });
        else truncated = true;
      }
      if (nodes.length % limits2.chunkSize === 0) {
        await ((_c = options.yieldControl) != null ? _c : (() => new Promise((resolve) => setTimeout(resolve, 0))))();
      }
    }
    return { nodes, bytes, truncated: truncated || cancelled, cancelled };
  }

  // experiments/limits-probe/probe.ts
  var running = false;
  var stoppedAt;
  var yieldId = 0;
  var pendingYield;
  var yieldToUI = () => new Promise((resolve) => {
    pendingYield = { id: ++yieldId, resolve };
    figma.ui.postMessage({ type: "yield", id: yieldId });
  });
  var limits = { maxDepth: 8, maxNodes: 1e3, maxResponseBytes: 262144, chunkSize: 50 };
  var handleLimits = async (message) => {
    if ((message == null ? void 0 : message.type) === "yield") {
      if (pendingYield && message.id === pendingYield.id) {
        const { resolve } = pendingYield;
        pendingYield = void 0;
        resolve();
      }
      return;
    }
    if ((message == null ? void 0 : message.type) === "stop") {
      if (running) stoppedAt = Date.now();
      return;
    }
    if ((message == null ? void 0 : message.type) !== "measure" || running) return;
    running = true;
    stoppedAt = void 0;
    let fixture;
    const report = { provisionalLimits: limits, scheduler: "ui-message" };
    const progress = (action) => figma.ui.postMessage({ type: "progress", action });
    try {
      progress("\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0444\u0438\u043A\u0441\u0442\u0443\u0440\u044B (5000 \u043F\u0440\u044F\u043C\u043E\u0443\u0433\u043E\u043B\u044C\u043D\u0438\u043A\u043E\u0432)");
      await figma.currentPage.loadAsync();
      fixture = figma.createFrame();
      fixture.name = "MCP limits probe";
      fixture.resize(1e3, 1e3);
      const start = Date.now();
      for (let index = 0; index < 5e3; index++) {
        if (stoppedAt !== void 0) break;
        const rect = figma.createRectangle();
        fixture.appendChild(rect);
        rect.resize(8, 8);
        rect.x = index % 100 * 10;
        rect.y = Math.floor(index / 100) * 10;
        if (index % 50 === 49) await yieldToUI();
      }
      report.fixture = { count: fixture.children.length, createMs: Date.now() - start };
      if (stoppedAt === void 0) {
        progress("\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u043D\u043E\u0435 \u0447\u0442\u0435\u043D\u0438\u0435");
        const readStart = Date.now();
        let yieldMs = 0, yields = 0;
        const result = await readTree(fixture, limits, {
          stopped: () => stoppedAt !== void 0,
          yieldControl: async () => {
            const start2 = Date.now();
            await yieldToUI();
            yieldMs += Date.now() - start2;
            yields++;
          }
        });
        const ms = Date.now() - readStart;
        report.read = { count: result.nodes.length, bytes: result.bytes, truncated: result.truncated, cancelled: result.cancelled, ms, yieldMs, yields, workMs: ms - yieldMs };
      }
      if (stoppedAt === void 0) {
        progress("\u0413\u0440\u0430\u043D\u0438\u0446\u044B depth/node/byte \u043D\u0430 \u0442\u043E\u0439 \u0436\u0435 \u0444\u0438\u043A\u0441\u0442\u0443\u0440\u0435");
        const node = await readTree(fixture, __spreadProps(__spreadValues({}, limits), { maxNodes: 1 }));
        const depth = await readTree(fixture, __spreadProps(__spreadValues({}, limits), { maxDepth: 0 }));
        const exactBytes = await readTree(fixture, __spreadProps(__spreadValues({}, limits), { maxResponseBytes: node.bytes }));
        const belowBytes = await readTree(fixture, __spreadProps(__spreadValues({}, limits), { maxResponseBytes: node.bytes - 1 }));
        report.boundaries = {
          nodeLimit: node.nodes.length === 1 && node.truncated,
          depthLimit: depth.nodes.length === 1 && depth.truncated,
          exactByteLimit: exactBytes.nodes.length === 1 && exactBytes.bytes === node.bytes && exactBytes.truncated,
          belowByteLimit: belowBytes.nodes.length === 0 && belowBytes.truncated
        };
      }
      if (stoppedAt === void 0) {
        progress("PNG 1000 \xD7 1000 (\u044D\u043A\u0441\u043F\u043E\u0440\u0442 API \u043D\u0435 \u043F\u0440\u0435\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F)");
        const exportStart = Date.now();
        const png = await fixture.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
        report.export = { bytes: png.length, pixels: 1e6, ms: Date.now() - exportStart };
      }
    } catch (error) {
      report.error = String(error);
    } finally {
      if (stoppedAt !== void 0) report.stop = { mainObservedAt: stoppedAt, stopToCleanupMs: Date.now() - stoppedAt };
      try {
        fixture == null ? void 0 : fixture.remove();
        report.cleanup = "removed";
      } catch (error) {
        report.cleanupError = String(error);
      }
      figma.ui.postMessage({ type: "report", report });
      running = false;
    }
  };

  // experiments/limits-probe/main.ts
  figma.showUI(__html__, { width: 540, height: 580 });
  figma.ui.onmessage = handleLimits;
})();
