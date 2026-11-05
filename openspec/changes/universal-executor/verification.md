# Проверки реализации — 2026-11-05

Ветка `codex/universal-executor-plan`, worktree `G:\Projects\AI\Figma-plugin-mcp-executor-plan`. Реализацию выполняли основной агент и три Terra-high субагента. Коммиты этапов отправлены в origin; основной checkout не изменялся. Тесты начали после полного цикла реализации согласно указанию пользователя.

## Выполнено

- `npm test`: полный прогон завершился exit 0. Включает сборки production/candidate/diagnostics, прежние контракты, IPC, owner handover, ресурсы/экспорт, batch-операции и восстановление, семь новых тестовых файлов исполнителя/каталога и расширенный сквозной candidate bridge.
- `node tests/trusted-execution.mjs`: дополнительный прогон окончательной версии exit 0; timeout → unknown → поздний succeeded, отсутствие повторной записи, старое generation, кооперативная отмена и отмена очереди, смена scope до запуска.
- `node --check experiments/execution-probe/main.js`: exit 0. Только синтаксис, не Desktop-совместимость.
- Изолированная `npm ci --omit=dev --os=win32 --cpu=x64` и импорт/TypeScript transform через esbuild: exit 0. Компилятор доступен без devDependencies.
- `openspec validate universal-executor --strict`: valid; `git diff --check`: ошибок пробелов нет.

У окружения npm задан os=linux. Первоначальная установка без явной платформы дала неверный native binary esbuild. В этом worktree зависимости переустановлены с os=win32/cpu=x64; глобальная конфигурация не менялась. Первый тестовый прогон также выявил отсутствующую fixture для нового инструмента и старое ожидание INVALID_ARGUMENT вместо SESSION_EXPIRED; исправлено, после чего полный прогон прошёл. Генерация каталога переведена на линейный подсчёт размера JSON.

## Что подтверждено автоматически

| Контракт | Доказательство |
| --- | --- |
| Public input / compiled wire, protocol v2, budgets | execution-contracts, contracts, protocol, message-limits |
| Queue, dedup, cancel, timeout, scope | trusted-execution, trusted-bridge-runtime, прежние batch/recovery tests |
| MCP→compiler→UI→plugin runtime→result | расширенный candidate-bridge: TS, await, запись, повтор, статус, ошибка после записи, JSON resource |
| Owner disconnect и поздняя работа | execution-ownership-process: настоящий daemon и два SDK-клиента, симулированный плагин |
| JSON chunks, TTL, scope, MIME, errors | execution-server и прежние export tests |
| Каталог типов целиком и лимиты страниц | api-catalog: точный текст закреплённых деклараций, URI allowlist, size |
| Типографика/карточки | execution-examples исполняет реальные файлы examples на fixtures |

## Не подтверждено

Figma Desktop не запускался для новой сборки. Не подтверждены реальный AsyncFunction, особенности объектов Plugin API, Undo, отзывчивость при синхронном коде и смена вкладки/сессии с настоящим документом. Подготовлен отдельный `experiments/execution-probe/manifest.json` и инструкция `docs/execution-probe.md`; рабочий плагин пользователя не заменён, production bridge не перезапускался.

Пункты 1.1, 1.2, 3.2, 6.2, 6.3 остаются открытыми из-за Desktop-критериев. Реализация 3.2 и документация 6.3 готовы, но их критерии включают фактическую приёмку. Исторические MVP-отчёты и успешные VM-тесты не заменяют эти доказательства.
