import { McpServer, ResourceTemplate, ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toolInputs } from '../shared/contracts';
import { contextSchema, disconnectedContext } from '../shared/context';
import { treeOutputSchema, searchOutputSchema } from '../shared/tree-result';
import { nodesOutputSchema, resourcesOutputSchema, navigateOutputSchema, operationOutputSchema, exportOutputSchema, inlinePngTransferSchema } from '../shared/operation-result';
import { executionOutputSchema, anyOperationOutputSchema } from '../shared/execution-contracts';
import { registerApiCatalog } from './api-catalog';
import { CompilationError } from './execution-compiler';

const outputSchemas = {
  figma_get_context: contextSchema, figma_get_tree: treeOutputSchema, figma_find_nodes: searchOutputSchema,
  figma_get_nodes: nodesOutputSchema, figma_get_local_resources: resourcesOutputSchema, figma_navigate: navigateOutputSchema,
  figma_apply_batch: operationOutputSchema, figma_get_operation: anyOperationOutputSchema, figma_cancel_operation: anyOperationOutputSchema,
  figma_export_node: exportOutputSchema,
  figma_execute: executionOutputSchema,
} satisfies Record<keyof typeof toolInputs, z.ZodType>;

const descriptions: Record<keyof typeof toolInputs, string> = {
  figma_get_context: 'Состояние моста и закреплённого файла плагина, который может работать в фоне. Не требует сессии.',
  figma_get_tree: 'Ограниченное дерево узлов текущей сессии.',
  figma_find_nodes: 'Поиск узлов в явно заданной области текущего документа.',
  figma_get_nodes: 'Чтение запрошенных свойств по nodeId.',
  figma_get_local_resources: 'Чтение локальных компонентов, стилей и переменных.',
  figma_navigate: 'Явный переход к узлам и изменение выделения.',
  figma_apply_batch: 'Пакет структурированных изменений с предусловиями и ссылками на предыдущие шаги.',
  figma_get_operation: 'Чтение известного состояния операции без повторного исполнения.',
  figma_cancel_operation: 'Запрос остановки операции без отката применённых изменений.',
  figma_export_node: 'Экспорт выбранного узла в PNG или SVG.',
  figma_execute: 'Выполнение доверенного JavaScript или TypeScript с полным доступом к API Figma. Отмена кооперативна; await всей работы обязателен.',
};

export function createServer(getContext: () => Promise<unknown> = async () => disconnectedContext, getTree?: (args: unknown) => Promise<unknown>, findNodes?: (args: unknown) => Promise<unknown>,
  getNodes?: (args: unknown) => Promise<unknown>, getLocalResources?: (args: unknown) => Promise<unknown>, navigate?: (args: unknown) => Promise<unknown>,
  exportNode?: (args: unknown) => Promise<unknown>, readResource?: (uri: string) => { uri: string; mimeType: string; data: Buffer },
  applyBatch?: (args: unknown) => Promise<unknown>, getOperation?: (args: unknown) => Promise<unknown>, cancelOperation?: (args: unknown) => Promise<unknown>, beforeRequest?: () => void,
  pairingPath = join(homedir(), '.figma-mcp-bridge', 'pairing-secret.txt'), execute?: (args: unknown) => Promise<unknown>) {
  const copyCommand = `Get-Content -Raw -LiteralPath '${pairingPath.replaceAll("'", "''")}' | Set-Clipboard`;
  const server = new McpServer({ name: 'Fijma', version: '0.1.0' }, {
    instructions: [
      'На вопросы о текущем файле Figma сначала вызывай figma_get_context; не угадывай открытый файл.',
      'Мост закреплён за файлом, где запущен плагин, и работает в фоне. Контекст показывает подключённый файл, не обязательно активную вкладку Figma. Переключение окон или файлов не меняет адресата команд; для другого файла нужно явно отключить прежний плагин и подключить новый.',
      'Если figma_get_context вернул state=disconnected или инструмент вернул NOT_CONNECTED, сразу сообщи: «Fijma сейчас отключена от Figma», и в том же ответе дай шаги подключения, без дополнительного вопроса пользователю.',
      `Предложи пользователю выполнить в PowerShell команду копирования ключа: ${copyCommand}`,
      'Затем: открой нужный Design-файл в Figma Desktop, запусти development-плагин Fijma, вставь ключ и нажми «Подключиться и запомнить». После подключения повторно вызови figma_get_context и отвечай по свежему контексту.',
      'Сам не читай ключ, не копируй его автоматически и не проси прислать его в чат. Не раскрывай содержимое pairing-secret.txt в MCP-ответах или сообщениях; показывай только команду для локального копирования.',
      'SESSION_BUSY не требует закрытия другого MCP-клиента. Команды клиентов выполняются по FIFO. QUEUE_TIMEOUT означает, что команда не была отправлена в Figma. RECOVERY_REQUIRED означает незавершённую операцию: проверь её статус; если завершение не подтверждено, закрой и заново запусти плагин. Закрывать подключения других клиентов не нужно.',
      'figma_execute доступен только после отдельного разрешения доверенного кода в UI (executeEnabled). Код — тело async-функции: return JSON; доступны figma, args, console и execution.yield()/execution.checkCancelled().',
      'Доверенный код имеет полный доступ к документу, read-only не обеспечивается, Stop кооперативен и не гарантирует прерывания. Ожидайте всю работу через await; не оставляйте listeners, callbacks или detached promises и не заменяйте figma.ui.onmessage и не вызывайте closePlugin.',
      'OUTCOME_UNKNOWN означает, что выполнение может продолжаться: проверяйте figma_get_operation и документ, не запускайте повторно новую операцию. Справочник закреплённого Figma API: figma-api://index; декларации не гарантируют поддержку в конкретной среде.',
    ].join('\n'),
  });
  registerApiCatalog(server);
  if (readResource) server.registerResource('figma-export', new ResourceTemplate('figma-resource://export/{token}', { list: undefined }),
    { description: 'Экспорт текущей сессии; истекает не позднее указанного срока.' }, async uri => {
      try { beforeRequest?.(); }
      catch { throw new ProtocolError(-32000, 'SESSION_BUSY: запрос временно недоступен.'); }
      try {
        const resource = readResource(uri.href);
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, blob: resource.data.toString('base64') }] };
      } catch { throw new ProtocolError(-32602, 'RESOURCE_EXPIRED: повторите экспорт.'); }
    });
  if (readResource) server.registerResource('figma-execution', new ResourceTemplate('figma-resource://execution/{token}', { list: undefined }),
    { description: 'JSON результат выполнения для текущей сессии.' }, async uri => {
      try { beforeRequest?.(); } catch { throw new ProtocolError(-32000, 'SESSION_BUSY'); }
      try {
        const resource = readResource(uri.href);
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.data.toString('utf8') }] };
      } catch { throw new ProtocolError(-32602, 'RESOURCE_EXPIRED'); }
    });
  for (const [name, inputSchema] of Object.entries(toolInputs)) {
    const publishedInput = name === 'figma_apply_batch' ? {
      '~standard': { ...inputSchema['~standard'], jsonSchema: { ...inputSchema['~standard'].jsonSchema,
        input: () => z.toJSONSchema(inputSchema, { io: 'input', reused: 'ref' }) } },
    } : inputSchema;
    server.registerTool(name, {
      description: descriptions[name as keyof typeof descriptions], inputSchema: publishedInput,
      outputSchema: outputSchemas[name as keyof typeof outputSchemas],
    }, async args => {
      let output, imageData: string | undefined;
      try {
        beforeRequest?.();
        if (name === 'figma_get_context') output = contextSchema.parse(await getContext());
        else if (name === 'figma_get_tree' && getTree) output = treeOutputSchema.parse(await getTree(args));
        else if (name === 'figma_find_nodes' && findNodes) output = searchOutputSchema.parse(await findNodes(args));
        else if (name === 'figma_get_nodes' && getNodes) output = nodesOutputSchema.parse(await getNodes(args));
        else if (name === 'figma_get_local_resources' && getLocalResources) output = resourcesOutputSchema.parse(await getLocalResources(args));
        else if (name === 'figma_navigate' && navigate) output = navigateOutputSchema.parse(await navigate(args));
        else if (name === 'figma_export_node' && exportNode) {
          const result = await exportNode(args);
          if (result && typeof result === 'object' && 'data' in result) {
            const { data, ...metadata } = inlinePngTransferSchema.parse(result);
            imageData = data;
            output = exportOutputSchema.parse(metadata);
          } else output = exportOutputSchema.parse(result);
        }
        else if (name === 'figma_apply_batch' && applyBatch) output = operationOutputSchema.parse(await applyBatch(args));
        else if (name === 'figma_execute' && execute) output = executionOutputSchema.parse(await execute(args));
        else if (name === 'figma_get_operation' && getOperation) output = anyOperationOutputSchema.parse(await getOperation(args));
        else if (name === 'figma_cancel_operation' && cancelOperation) output = anyOperationOutputSchema.parse(await cancelOperation(args));
        else {
          const context = contextSchema.parse(await getContext());
          output = { error: { code: context.state === 'ready' ? 'CAPABILITY_UNAVAILABLE' : 'NOT_CONNECTED',
            message: context.state === 'ready' ? 'Обработчик инструмента ещё не подключён.' : 'Плагин Figma не подключён.',
            recoveryAction: 'Проверьте capabilities текущего контекста.' } };
        }
      } catch (error) {
        const code = error instanceof Error && ['INVALID_ARGUMENT', 'QUEUE_TIMEOUT', 'RECOVERY_REQUIRED', 'OPERATION_NOT_OWNED', 'CANCELLED', 'SESSION_BUSY', 'NOT_CONNECTED', 'SESSION_EXPIRED', 'CAPABILITY_UNAVAILABLE', 'RESOURCE_LIMIT', 'WRITE_DISABLED', 'EXECUTION_DISABLED', 'COMPILATION_FAILED', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'OUTCOME_UNKNOWN'].includes(error.message) ? error.message : 'FIGMA_API_ERROR';
        output = { error: { code, ...(error instanceof CompilationError ? { phase: error.phase, ...(error.line ? { line: error.line } : {}), ...(error.column ? { column: error.column } : {}) } : {}), message: code === 'RESOURCE_LIMIT' ? 'Превышен лимит запроса или ресурса.' : 'Запрос документа недоступен.',
          recoveryAction: code === 'RECOVERY_REQUIRED' ? 'Проверьте статус своей операции. Если завершение не подтверждено, закройте и заново запустите плагин; перечитайте контекст и документ.' : code === 'QUEUE_TIMEOUT' ? 'Команда не отправлена в Figma; повторите после освобождения очереди.' : code === 'OPERATION_NOT_OWNED' ? 'Используйте operationId операции этого MCP-подключения.' : code === 'CANCELLED' ? 'Ожидающая команда отменена до отправки.' : code === 'OUTCOME_UNKNOWN' ? 'Проверьте состояние операции по operationId; не запускайте её повторно.' : code === 'COMPILATION_FAILED' ? 'Исправьте синтаксис и удалите imports.' : code === 'SESSION_BUSY' ? 'Дождитесь освобождения моста и повторите запрос.' : code === 'RESOURCE_LIMIT' ? 'Уменьшите объём запроса, пакета или экспорта и повторите.' : 'Переподключите плагин и повторите чтение контекста.' } };
      }
      const content: any[] = [{ type: 'text', text: JSON.stringify(output) }];
      if (name === 'figma_export_node' && !('error' in output)) {
        if (imageData) content.push({ type: 'image', mimeType: 'image/png', data: imageData });
        else if ('uri' in output) content.push({ type: 'resource_link', uri: output.uri, name: 'Figma export', mimeType: output.mimeType });
      }
      if ('resource' in output && output.resource && typeof output.resource === 'object' && 'uri' in output.resource) content.push({ type: 'resource_link', uri: output.resource.uri, name: 'Execution result', mimeType: 'application/json' });
      return { structuredContent: output, content,
        ...('error' in output ? { isError: true } : {}) };
    });
  }
  return server;
}
