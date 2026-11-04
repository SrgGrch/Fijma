# Figma MCP Bridge

[English](README.md) | Русский

Локальный MCP-мост для чтения и редактирования открытого Design-файла в Figma Desktop. MCP-клиент получает структурированные инструменты для узлов, страниц, локальных стилей и переменных, пакетных изменений и экспорта PNG/SVG. Мост не выполняет произвольный код из запроса.

## Что нужно

- Node.js 20+ и npm.
- Figma Desktop и доступ к **Plugins → Development**.
- MCP-клиент с поддержкой локального stdio-сервера.

Проект пока устанавливается из исходников: опубликованного npm-пакета нет.

## Как установить

```powershell
git clone https://github.com/SrgGrch/Fijma.git
cd Fijma
npm ci
npm run build
```

Откройте Design-файл в Figma Desktop. Выберите **Plugins → Development → Import plugin from manifest** и укажите абсолютный путь к `dist/plugin/manifest.json`. Запустите **Figma MCP Bridge**.

Затем подключите MCP-сервер к своему клиенту. В примерах ниже замените `C:\path\to\Fijma` на абсолютный путь к клонированному проекту. Для JSON обратные слеши удвоены. Node.js должен быть доступен в `PATH` клиента; при необходимости укажите абсолютный путь к `node.exe`.

### Codex CLI / Codex Desktop

Добавьте в `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.figma_local]
command = "node"
args = ['C:\path\to\Fijma\dist\server\index.js']
```

CLI и Desktop читают эту конфигурацию. В CLI можно также выполнить `codex mcp add figma_local -- node C:\path\to\Fijma\dist\server\index.js`. [Документация Codex MCP](https://developers.openai.com/codex/mcp/).

### Claude Code

Выполните в каталоге проекта:

```powershell
claude mcp add --transport stdio --scope local figma-local -- node C:\path\to\Fijma\dist\server\index.js
```

`local` привязывает настройку к текущему проекту. Для всех проектов используйте `--scope user`. [Документация Claude Code MCP](https://code.claude.com/docs/en/mcp).

### Cursor

Создайте `.cursor/mcp.json` в проекте или `%USERPROFILE%\.cursor\mcp.json` для всех проектов:

```json
{
  "mcpServers": {
    "figma-local": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\Fijma\\dist\\server\\index.js"]
    }
  }
}
```

[Документация Cursor MCP](https://cursor.com/docs/mcp).

### Gemini CLI

Выполните:

```powershell
gemini mcp add figma-local node C:\path\to\Fijma\dist\server\index.js
```

Или добавьте такой же объект `mcpServers` с `command` и `args` в `%USERPROFILE%\.gemini\settings.json`. [Документация Gemini CLI MCP](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).

### Сопряжение и первый запрос

Перезапустите или обновите MCP-подключение клиента. Адаптер автоматически поднимет общий локальный мост. Он выводит путь к `pairing-secret.txt` в stderr. Если клиент не показывает stderr, запустите из корня проекта `node scripts/manual-client.mjs`: он покажет путь и позволит отправлять MCP-запросы по одной JSON-строке.

Откройте файл ключа локально, вставьте его в панель плагина и нажмите **«Подключиться и запомнить»**. Не отправляйте ключ в чат. Вызовите `figma_get_context`: статус должен быть `ready`, а имя документа должно совпасть с нужным файлом. Для записи включите переключатель в панели плагина; при новом соединении запись снова выключена. Остальные инструменты используют `scope` (`sessionId` и `connectionGeneration`) из текущего контекста. Подробнее: [запуск и сопряжение](docs/launch.md).

## Как собрать локально

```powershell
npm ci
npm run build
npm test
```

`npm run build` создаёт `dist/server/index.js` и файлы плагина в `dist/plugin/`. `npm test` запускает автоматические проверки, в том числе обмен через MCP SDK и loopback WebSocket с имитацией Figma. После обновления сборки закройте окно плагина, остановите старый общий процесс командой `npm run stop`, затем запустите плагин и MCP-подключение заново.

## Принцип работы

```text
MCP-клиент ── stdio ── адаптер ── локальный общий мост ── WebSocket ── UI плагина ── Figma Plugin API
```

Каждый клиент запускает свой stdio-адаптер; общий мост слушает только `127.0.0.1:55263` и обслуживает одно сопряжённое соединение с плагином. Первый клиент, вызвавший инструмент, владеет документом до отключения; остальные получают `SESSION_BUSY`. Секрет сопряжения хранится локально, а плагин запоминает его в `figma.clientStorage`.

Чтение доступно после сопряжения. Запись разрешается в UI плагина для закреплённого документа и выполняется последовательными пакетами с предусловиями и проверкой результата. Stop отменяет следующие шаги и очередь; уже применённые изменения не откатываются. При переключении окна Figma плагин продолжает работать с тем файлом, где был запущен. Для другого файла отключите прежний плагин и подключите новый. Экспорт PNG/SVG проходит через ограниченные по размеру сообщения и временные MCP-ресурсы.

Запросы документа и экспорты передаются вашему MCP-клиенту и выбранному им поставщику модели. Начинайте запись с копии документа. Ограничения операций и размеров: [контракты](shared/contracts.md), [профиль лимитов](docs/limits.md), [исполнение пакетов](shared/execution.md). Исходники находятся в `plugin/`, `server/` и `shared/`; проверки — в `tests/`.

## Лицензия

[MIT](LICENSE).
