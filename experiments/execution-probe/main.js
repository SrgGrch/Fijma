figma.showUI(__html__, { width: 520, height: 520 });
let cancelled = false;
const send = (data) => figma.ui.postMessage(data);
const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));
const execution = { async yield() { await yieldControl(); if (cancelled) throw new Error('COOPERATIVE_STOP'); } };
figma.ui.onmessage = async (message) => {
  if (message === 'stop') { cancelled = true; send({ event: 'stop-requested' }); return; }
  cancelled = false;
  send({ event: 'start', probe: message, apiVersion: figma.apiVersion, editorType: figma.editorType, pageId: figma.currentPage.id });
  try {
    let code;
    if (message === 'read') code = 'await Promise.resolve(); return { page: figma.currentPage.name, value: 42 };';
    else if (message === 'throw') code = 'await Promise.resolve();\nthrow new Error("probe async error");';
    else if (message === 'cooperative') code = 'for (let i=0;i<500;i++) { await execution.yield(); } return "completed";';
    else if (message === 'blocking') code = 'const end=Date.now()+750; while(Date.now()<end) {} return "finite loop complete";';
    else if (message === 'write') code = 'const r=figma.createRectangle(); r.name="EXECUTION PROBE — undo me"; figma.currentPage.appendChild(r); throw new Error("probe after write");';
    else if (message === 'await') code = 'await new Promise(resolve => setTimeout(resolve, 5000)); return { page: figma.currentPage.name };';
    else throw new Error('Unknown probe');
    const fn = eval('(async function(figma, execution) {\n' + code + '\n})');
    const value = await fn(figma, execution);
    send({ event: 'return', value });
  } catch (error) { send({ event: 'error', message: String(error), stack: String(error && error.stack || '') }); }
  finally {
    if (message === 'write') {
      try { figma.commitUndo(); send({ event: 'commitUndo', result: 'returned' }); }
      catch (error) { send({ event: 'commitUndo', error: String(error) }); }
    }
    send({ event: 'finished', pageId: figma.currentPage.id });
  }
};
