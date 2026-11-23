import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { errorSchema } from '../shared/contracts';

const commentId = z.string().min(1).max(128);
const statusSchema = z.enum(['unresolved', 'resolved']);
const commentsInput = z.strictObject({
  fileKey: z.string().regex(/^[a-zA-Z0-9]{1,128}$/).describe('Ключ файла или ветки из ссылки Figma.'),
  status: statusSchema.describe('unresolved — открытые ветки, resolved — закрытые.'),
  limit: z.number().int().min(1).max(50).optional().describe('Число веток на страницу. По умолчанию 20.'),
  afterThreadId: commentId.optional().describe('nextAfterThreadId из предыдущей страницы для того же файла и статуса.'),
  forceReload: z.boolean().optional().describe('Обновить комментарии через Figma REST API, пропустив кеш.'),
});

const authorSchema = z.object({ id: z.string(), handle: z.string() });
const anchorSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  node_id: z.string().optional(),
  node_offset: z.object({ x: z.number(), y: z.number() }).optional(),
  region_width: z.number().optional(),
  region_height: z.number().optional(),
  comment_pin_corner: z.string().optional(),
});
const timestamp = z.iso.datetime({ offset: true });
const apiResponseSchema = z.object({
  comments: z.array(z.object({
    id: commentId,
    parent_id: z.string().nullish(),
    user: authorSchema,
    message: z.string(),
    created_at: timestamp,
    resolved_at: timestamp.nullish(),
    client_meta: anchorSchema.nullish(),
  })),
});

const commentSchema = z.object({
  id: commentId,
  message: z.string(),
  author: authorSchema,
  createdAt: timestamp,
});
const threadSchema = commentSchema.extend({
  resolvedAt: timestamp.nullable(),
  anchor: anchorSchema.optional(),
  replies: z.array(commentSchema),
});
const commentsErrorSchema = z.object({ error: errorSchema });
const commentsOutput = z.union([
  z.object({
    fileKey: z.string(), status: statusSchema, threads: z.array(threadSchema),
    nextAfterThreadId: commentId.optional(),
  }),
  commentsErrorSchema,
]);

type Comment = z.infer<typeof commentSchema>;
type CommentsInput = z.infer<typeof commentsInput>;
type CommentsOutput = z.infer<typeof commentsOutput>;
type CommentsError = z.infer<typeof commentsErrorSchema>;
type FigmaComments = z.infer<typeof apiResponseSchema>['comments'];
type CommentsLoad = FigmaComments | CommentsError;

const accessToken = process.env.FIGMA_MCP_ACCESS_TOKEN?.trim();
const cacheTtlMs = 60_000;
const maxCachedFiles = 16;
const commentsCache = new Map<string, { comments: FigmaComments; expiresAt: number }>();
const pendingLoads = new Map<string, Promise<CommentsLoad>>();

function failure(code: z.infer<typeof errorSchema>['code'], message: string, recoveryAction: string): CommentsError {
  return { error: { code, message, recoveryAction } };
}

const chronological = (left: Comment, right: Comment) =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);

async function fetchComments(fileKey: string, token: string): Promise<CommentsLoad> {
  const apiFailure = () => failure('FIGMA_API_ERROR', 'Не удалось прочитать комментарии через Figma REST API.',
    'Проверьте доступность Figma API и повторите запрос позже.');
  try {
    const response = await fetch('https://api.figma.com/v1/files/' + fileKey + '/comments', {
      method: 'GET',
      headers: { 'X-Figma-Token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return failure('AUTH_FAILED',
        'Figma отклонила запрос комментариев.', 'Проверьте срок действия токена, право file_comments:read и доступ аккаунта к файлу.');
      if (response.status === 404) return failure('FIGMA_API_ERROR',
        'Figma не нашла указанный файл или ветку.', 'Проверьте fileKey и доступ аккаунта к файлу.');
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const recoveryAction = retryAfter && /^\d{1,10}$/.test(retryAfter)
          ? 'Повторите чтение через ' + Number(retryAfter) + ' сек.'
          : 'Дождитесь сброса лимита запросов Figma и повторите чтение.';
        return failure('FIGMA_API_ERROR', 'Figma ограничила частоту запросов.', recoveryAction);
      }
      return apiFailure();
    }
    return apiResponseSchema.parse(await response.json()).comments;
  } catch {
    return apiFailure();
  }
}

function loadComments(fileKey: string, token: string, forceReload: boolean): Promise<CommentsLoad> {
  const cached = commentsCache.get(fileKey);
  if (!forceReload && cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.comments);

  const pending = pendingLoads.get(fileKey);
  if (pending) return pending;

  const load = fetchComments(fileKey, token).then(result => {
    if (Array.isArray(result)) {
      commentsCache.delete(fileKey);
      const oldestKey = commentsCache.keys().next().value;
      if (commentsCache.size >= maxCachedFiles && oldestKey !== undefined) commentsCache.delete(oldestKey);
      commentsCache.set(fileKey, { comments: result, expiresAt: Date.now() + cacheTtlMs });
    } else if (result.error.code === 'AUTH_FAILED') {
      commentsCache.delete(fileKey);
    }
    return result;
  }).finally(() => pendingLoads.delete(fileKey));
  pendingLoads.set(fileKey, load);
  return load;
}

async function getComments(
  { fileKey, status, limit = 20, afterThreadId, forceReload = false }: CommentsInput,
  signal: AbortSignal,
): Promise<CommentsOutput> {
  if (!accessToken) return failure('CAPABILITY_UNAVAILABLE', 'Для чтения комментариев нужен токен Figma.',
    'Задайте FIGMA_MCP_ACCESS_TOKEN с правом file_comments:read и перезапустите общий мост.');

  const cancelled = () => failure('CANCELLED', 'Чтение комментариев отменено.', 'При необходимости повторите запрос.');
  if (signal.aborted) return cancelled();
  // This load can serve other MCP requests even if this caller cancels.
  const comments = await loadComments(fileKey, accessToken, forceReload);
  if (signal.aborted) return cancelled();
  if (!Array.isArray(comments)) return comments;

  const threads = new Map<string, z.infer<typeof threadSchema>>();
  const replies: { parentId: string; comment: Comment }[] = [];
  for (const { id, user, message, created_at, resolved_at, parent_id, client_meta } of comments) {
    const comment = { id, message, author: user, createdAt: created_at };
    if (parent_id) {
      replies.push({ parentId: parent_id, comment });
      continue;
    }
    const resolvedAt = resolved_at ?? null;
    if ((status === 'resolved') === (resolvedAt !== null)) {
      threads.set(id, { ...comment, resolvedAt, ...(client_meta ? { anchor: client_meta } : {}), replies: [] });
    }
  }

  const ordered = [...threads.values()].sort((left, right) => chronological(right, left));
  const previous = afterThreadId === undefined ? -1 : ordered.findIndex(thread => thread.id === afterThreadId);
  if (afterThreadId !== undefined && previous === -1) return failure('INVALID_CURSOR',
    'Ветка предыдущей страницы отсутствует в текущей выборке.', 'Повторите чтение без afterThreadId.');
  const start = previous + 1;
  const page = ordered.slice(start, start + limit);
  const selected = new Map(page.map(thread => [thread.id, thread]));
  for (const { parentId, comment } of replies) selected.get(parentId)?.replies.push(comment);
  for (const thread of page) thread.replies.sort(chronological);

  return {
    fileKey, status, threads: page,
    ...(start + page.length < ordered.length ? { nextAfterThreadId: page[page.length - 1].id } : {}),
  };
}

export function registerComments(server: McpServer) {
  server.registerTool('figma_get_comments', {
    description: 'Чтение открытых или закрытых веток комментариев Figma вместе с ответами. Работает по ключу файла без подключения плагина. Кеш действует 60 секунд. Для обновления используйте forceReload.',
    inputSchema: commentsInput,
    outputSchema: commentsOutput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    const output = await getComments(args, ctx.mcpReq.signal);
    return {
      structuredContent: output,
      content: [{ type: 'text', text: JSON.stringify(output) }],
      ...('error' in output ? { isError: true } : {}),
    };
  });
}
