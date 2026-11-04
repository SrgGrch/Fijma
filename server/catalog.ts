import { McpServer, ResourceTemplate, ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolInputs } from '../shared/contracts';
import { contextSchema, disconnectedContext } from '../shared/context';
import { treeOutputSchema, searchOutputSchema } from '../shared/tree-result';
import { nodesOutputSchema, resourcesOutputSchema, navigateOutputSchema, operationOutputSchema, exportOutputSchema, inlinePngTransferSchema } from '../shared/operation-result';

const outputSchemas = {
  figma_get_context: contextSchema, figma_get_tree: treeOutputSchema, figma_find_nodes: searchOutputSchema,
  figma_get_nodes: nodesOutputSchema, figma_get_local_resources: resourcesOutputSchema, figma_navigate: navigateOutputSchema,
  figma_apply_batch: operationOutputSchema, figma_get_operation: operationOutputSchema, figma_cancel_operation: operationOutputSchema,
  figma_export_node: exportOutputSchema,
} satisfies Record<keyof typeof toolInputs, z.ZodType>;

const descriptions: Record<keyof typeof toolInputs, string> = {
  figma_get_context: 'Состояние моста и доступного документа. Не требует сессии.',
  figma_get_tree: 'Ограниченное дерево узлов текущей сессии.',
  figma_find_nodes: 'Поиск узлов в явно заданной области текущего документа.',
  figma_get_nodes: 'Чтение запрошенных свойств по nodeId.',
  figma_get_local_resources: 'Чтение локальных компонентов, стилей и переменных.',
  figma_navigate: 'Явный переход к узлам и изменение выделения.',
  figma_apply_batch: 'Пакет структурированных изменений с предусловиями и ссылками на предыдущие шаги.',
  figma_get_operation: 'Чтение известного состояния операции без повторного исполнения.',
  figma_cancel_operation: 'Запрос остановки операции без отката применённых изменений.',
  figma_export_node: 'Экспорт выбранного узла в PNG или SVG.',
};

export function createServer(getContext: () => Promise<unknown> = async () => disconnectedContext, getTree?: (args: unknown) => Promise<unknown>, findNodes?: (args: unknown) => Promise<unknown>,
  getNodes?: (args: unknown) => Promise<unknown>, getLocalResources?: (args: unknown) => Promise<unknown>, navigate?: (args: unknown) => Promise<unknown>,
  exportNode?: (args: unknown) => Promise<unknown>, readResource?: (uri: string) => { uri: string; mimeType: string; data: Buffer },
  applyBatch?: (args: unknown) => Promise<unknown>, getOperation?: (args: unknown) => Promise<unknown>, cancelOperation?: (args: unknown) => Promise<unknown>) {
  const server = new McpServer({ name: 'figma-mcp-bridge', version: '0.1.0' });
  if (readResource) server.registerResource('figma-export', new ResourceTemplate('figma-resource://export/{token}', { list: undefined }),
    { description: 'Экспорт текущей сессии; истекает не позднее указанного срока.' }, async uri => {
      try {
        const resource = readResource(uri.href);
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, blob: resource.data.toString('base64') }] };
      } catch { throw new ProtocolError(-32602, 'RESOURCE_EXPIRED: повторите экспорт.'); }
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
        else if (name === 'figma_get_operation' && getOperation) output = operationOutputSchema.parse(await getOperation(args));
        else if (name === 'figma_cancel_operation' && cancelOperation) output = operationOutputSchema.parse(await cancelOperation(args));
        else {
          const context = contextSchema.parse(await getContext());
          output = { error: { code: context.state === 'ready' ? 'CAPABILITY_UNAVAILABLE' : 'NOT_CONNECTED',
            message: context.state === 'ready' ? 'Обработчик инструмента ещё не подключён.' : 'Плагин Figma не подключён.',
            recoveryAction: 'Проверьте capabilities текущего контекста.' } };
        }
      } catch (error) {
        const code = error instanceof Error && ['NOT_CONNECTED', 'SESSION_EXPIRED', 'CAPABILITY_UNAVAILABLE', 'RESOURCE_LIMIT', 'WRITE_DISABLED', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'OUTCOME_UNKNOWN'].includes(error.message) ? error.message : 'FIGMA_API_ERROR';
        output = { error: { code, message: code === 'RESOURCE_LIMIT' ? 'Превышен лимит запроса или ресурса.' : 'Запрос документа недоступен.',
          recoveryAction: code === 'RESOURCE_LIMIT' ? 'Уменьшите объём запроса, пакета или экспорта и повторите.' : 'Переподключите плагин и повторите чтение контекста.' } };
      }
      const content: any[] = [{ type: 'text', text: JSON.stringify(output) }];
      if (name === 'figma_export_node' && !('error' in output)) {
        if (imageData) content.push({ type: 'image', mimeType: 'image/png', data: imageData });
        else if ('uri' in output) content.push({ type: 'resource_link', uri: output.uri, name: 'Figma export', mimeType: output.mimeType });
      }
      return { structuredContent: output, content,
        ...('error' in output ? { isError: true } : {}) };
    });
  }
  return server;
}
