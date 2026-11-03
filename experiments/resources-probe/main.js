(() => {
  // experiments/resources-probe/probe.ts
  var running = false;
  var handleResources = async (message) => {
    if (!message || message.type !== "probe" || running) return;
    running = true;
    const results = [];
    const owned = [];
    const keep = (resource) => {
      owned.push(resource);
      return resource;
    };
    const check = async (action, run) => {
      figma.ui.postMessage({ type: "progress", action });
      try {
        results.push({ action, ok: true, detail: await run() });
      } catch (error) {
        results.push({ action, ok: false, detail: String(error) });
      }
    };
    try {
      await check("component/instance", () => {
        const component = keep(figma.createComponent());
        component.name = "MCP capability probe";
        const instance = keep(component.createInstance());
        return { componentId: component.id, instanceId: instance.id, type: instance.type };
      });
      for (const kind of ["Paint", "Text", "Effect", "Grid"]) {
        await check(`style/${kind}`, async () => {
          const style = keep(figma[`create${kind}Style`]());
          style.name = "MCP capability probe";
          const styles = await figma[`getLocal${kind}StylesAsync`]();
          if (!styles.some((item) => item.id === style.id)) throw new Error("Created style missing from local read");
          return { id: style.id, type: style.type };
        });
      }
      await check("variables", async () => {
        const collection = keep(figma.variables.createVariableCollection("MCP capability probe"));
        const modeId = collection.defaultModeId;
        const value = keep(figma.variables.createVariable("width", collection, "FLOAT"));
        value.setValueForMode(modeId, 120);
        const alias = keep(figma.variables.createVariable("alias", collection, "FLOAT"));
        await check("alias", () => {
          alias.setValueForMode(modeId, figma.variables.createVariableAlias(value));
          return { variableId: alias.id, valuesByMode: alias.valuesByMode };
        });
        await check("binding", () => {
          var _a, _b;
          const rect = keep(figma.createRectangle());
          rect.setBoundVariable("width", value);
          const bound = (_a = rect.boundVariables) == null ? void 0 : _a.width;
          if ((bound == null ? void 0 : bound.id) !== value.id) throw new Error("Binding readback mismatch");
          rect.setBoundVariable("width", null);
          if ((_b = rect.boundVariables) == null ? void 0 : _b.width) throw new Error("Unbind readback mismatch");
          return { bound, unbound: true };
        });
        await check("mode/add", () => {
          const second = collection.addMode("Probe second mode");
          value.setValueForMode(second, 240);
          return { modes: collection.modes, valuesByMode: value.valuesByMode };
        });
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const variables = await figma.variables.getLocalVariablesAsync();
        if (!collections.some((item) => item.id === collection.id) || !variables.some((item) => item.id === value.id)) {
          throw new Error("Created variables missing from local read");
        }
        return { collectionId: collection.id, modes: collection.modes, valuesByMode: value.valuesByMode };
      });
    } finally {
      for (const resource of owned.reverse()) await check("cleanup", () => {
        resource.remove();
        return "removed";
      });
      figma.ui.postMessage({ type: "report", results });
      running = false;
    }
  };

  // experiments/resources-probe/main.ts
  figma.showUI(__html__, { width: 540, height: 560 });
  figma.ui.onmessage = handleResources;
})();
