import { McpServer } from '@modelcontextprotocol/server';
import { toolInputs, toolErrorSchema } from '../shared/contracts';
import { contextSchema, disconnectedContext } from '../shared/context';
import { treeOutputSchema } from '../shared/tree-result';

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

export function createServer(getContext: () => Promise<unknown> = async () => disconnectedContext, getTree?: (args: unknown) => Promise<unknown>) {
  const server = new McpServer({ name: 'figma-mcp-bridge', version: '0.1.0' });
  for (const [name, inputSchema] of Object.entries(toolInputs)) {
    server.registerTool(name, {
      description: descriptions[name as keyof typeof descriptions], inputSchema,
      outputSchema: name === 'figma_get_context' ? contextSchema : name === 'figma_get_tree' ? treeOutputSchema : toolErrorSchema,
    }, async args => {
      let output;
      try { output = name === 'figma_get_context' ? contextSchema.parse(await getContext()) : name === 'figma_get_tree' && getTree ? treeOutputSchema.parse(await getTree(args)) : {
        error: { code: 'NOT_CONNECTED', message: 'Плагин Figma не подключён.', recoveryAction: 'Подключите плагин и получите новый контекст.' },
      }; } catch (error) {
        const code = error instanceof Error && ['NOT_CONNECTED', 'SESSION_EXPIRED', 'CAPABILITY_UNAVAILABLE', 'RESOURCE_LIMIT'].includes(error.message) ? error.message : 'FIGMA_API_ERROR';
        output = { error: { code, message: 'Запрос документа недоступен.', recoveryAction: 'Переподключите плагин и повторите чтение контекста.' } };
      }
      return { structuredContent: output, content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        ...('error' in output ? { isError: true } : {}) };
    });
  }
  return server;
}
