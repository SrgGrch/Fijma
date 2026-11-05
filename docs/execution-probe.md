# Executor Desktop probe protocol

Status: **read and throw observed in Desktop**. See the [recorded results](../openspec/changes/universal-executor/verification.md#desktop-probe-2026-11-05). Import `experiments/execution-probe/manifest.json` in Figma Desktop and use a new test file. Record Desktop version, OS, plugin manifest revision, date and the complete UI transcript, without document or secret data.

1. Run Async JSON read: record its return and whether the file remains unchanged. Run Async throw and preserve its stack/source locations.
2. Run Yield loop then Stop; record whether Stop is observed and when. Run Finite blocking loop and attempt Stop while it runs; note UI responsiveness. The loop is finite, but if Figma becomes unresponsive manually close the disposable plugin or Figma and reopen the test file. A timeout is not interruption.
3. Run Write, throw, commitUndo; inspect the rectangle and use Undo manually. Record whether the write persisted, whether commitUndo returned, and what Undo actually did. Do not assume rollback or atomicity.
4. Start Await 5 seconds, switch to a second disposable file/tab, then inspect the transcript and both files. Separately close the plugin or disconnect the bridge during an await in the bridge acceptance fixture. Record whether execution finishes, any late writes, and which file remains bound. This standalone probe has no bridge, so it cannot establish disconnect behavior.
5. Save dated evidence separately, including unexpected behavior and recovery. Do not mark tasks complete or advertise support until real outcomes have been reviewed against the design. If dynamic evaluation fails, revisit the implementation design before claiming readiness.

The probe uses the same AsyncFunction constructor as the executor. Cooperative waits round-trip through the UI iframe, so it does not depend on browser timers in plugin main. A standalone successful probe still does not replace the full bridge acceptance matrix.
