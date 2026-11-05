# Контракты Fijma

Источник схем — `contracts.ts`, `operation-result.ts`, `context.ts` и `tree-result.ts`. Объекты строгие: неизвестные поля и команды отклоняются. Проверка схемы не заменяет проверку живого документа, прав, доступности API, шрифтов, совместимости типов и связей непосредственно перед записью.

Входная JSON Schema `figma_apply_batch` публикуется с общими `$defs` и локальными `$ref`; клиент должен поддерживать такие ссылки. Проверка входа сохраняет исходные Zod refinements, включая уникальность stepId и предусловия существующих объектов. В локальном SDK-замере каталог занимает 175 288 байт вместо 6 719 128; это объём JSON, не измерение оплачиваемых токенов модели.

## Инструменты

Все инструменты документа принимают `scope: {sessionId, connectionGeneration}`. `figma_get_context` не требует scope. Ошибка инструмента: `{error:{code,message,failedStep?,details?,recoveryAction}}`; `details` не должен содержать секреты.

| Инструмент | Остальные параметры | Успешный ответ |
| --- | --- | --- |
| figma_get_context | нет | state, sessionId, connectionGeneration, documentLabel, pages, currentPageId, selection, writeEnabled, capabilities, limits |
| figma_get_tree | rootId, depth, limit, cursor? | nodes, truncated, nextCursor? |
| figma_find_nodes | rootId или document:true, name?, types?, limit, cursor? | nodes с pageId, truncated, nextCursor? |
| figma_get_nodes | nodeIds, fields | nodes: проекции или ошибки отдельных nodeId |
| figma_get_local_resources | kind, ids?, fields, limit, cursor? | resources, truncated, nextCursor? |
| figma_navigate | pageId?, nodeIds, select, reveal | currentPageId, selection |
| figma_apply_batch | operationId, steps | результат операции |
| figma_get_operation | operationId | известный результат или состояние unknown |
| figma_cancel_operation | operationId | известное состояние; отмена не обещает откат |
| figma_export_node | nodeId, format PNG/SVG, scale? | sessionId, nodeId, bytes, format, mimeType и PNG image block либо uri с expiresAt; PNG также содержит width и height |

Примеры: `figma_get_tree({scope:{sessionId:"s",connectionGeneration:1},rootId:"0:1",depth:2,limit:100})`; `figma_find_nodes({scope:{sessionId:"s",connectionGeneration:1},document:true,name:"Button",limit:50})`; `figma_get_nodes({scope:{sessionId:"s",connectionGeneration:1},nodeIds:["1:1"],fields:["name","characters"]})`.

Проекция узла имеет `nodeId`, `type`, `properties`, списки имён `mixed` и `unavailable`. `fields` принимает только имена полей `properties`, без вложенных путей. `properties` допускает name, x, y, width, height, rotation, visible, locked, appearance и typography поля ниже, characters, textSegments, parentId, children, layout, constraints, layoutSizingHorizontal, layoutSizingVertical, fillStyleId, strokeStyleId, textStyleId, effectStyleId, boundVariables и explicitVariableModes. Неполученное поле отсутствует; mixed и unavailable различимы. `textSegments` содержит диапазоны start/end в UTF-16, characters и доступные поля форматирования, fills, textStyleId и boundVariables; фактические размеры могут быть нулевыми.

Ресурс имеет `kind`, `id`, `properties`, `mixed`, `unavailable`. Допустимые поля проекции:

- components: name, description, key, remote, parentId;
- styles: name, description, key, remote, type, value, boundVariables;
- collections: name, modes (`modeId`, `name`), defaultModeId, variableIds, remote;
- variables: name, description, collectionId, type, valuesByMode, hiddenFromPublishing, remote. Значение режима — строка, boolean, finite number, цвет, `{type:"VARIABLE_ALIAS",id}` или составной цвет с alias для color и/или opacity.

Проекции узлов и components также предоставляют `mainComponent` и `componentSet` как `{id,key,remote}` или null, `componentProperties` и `componentPropertyDefinitions` как словари по полному имени свойства, `variantProperties` как словарь строк или null. У свойств доступны type, value или defaultValue, preferredValues и boundVariables; у определений также variantOptions, description и slotSettings. Эти же поля можно задавать в `expected` и `expected.related`, чтобы проверять состояние компонента и его связей перед записью.

Например, `{resources:[{kind:"variables",id:"v",properties:{valuesByMode:{dark:{type:"VARIABLE_ALIAS",id:"other"}}},mixed:[],unavailable:[]}],truncated:false}`. Запрошенные fields ограничены полями соответствующего kind и задают проекцию, а не путь присваивания.

Пагинация ресурсов проецирует только выдаваемую страницу. Для стилей, коллекций и переменных каждое продолжение сканирует запрошенные поля каталога и сравнивает компактный некриптографический fingerprint; полный JSON каталога в cursor не хранится. Изменение запрошенного значения инвалидирует cursor, изменение незапрошенного поля само по себе — нет. Компоненты по известным ids читаются напрямую с проверкой типа и локальности; поиск без ids выдаёт несколько компонентов за вызов с сохранением не вместившихся строк для продолжения. Размер страницы ограничен limit и байтовым бюджетом, а обход — maxNodes; даже пустой ответ с nextCursor требует продолжения.

Read-схемы отделены от write: они сохраняют нулевые размеры, nullable imageHash, массивы и вложенные коллекции привязок, вариации шрифта, свойства image/gradient и shadow/blur. Поддерживаются SOLID, GRADIENT и IMAGE; для иных paint/effect либо не представимого в JSON значения всё запрошенное поле помечается unavailable, без частичной подмены. Эти read-значения не расширяют разрешённые значения записи.

## Пакет

`operationId` — UUIDv7; один ID и неизменный payload используются для выяснения результата, но не для повторного исполнения после потери журнала. `steps` — непустой упорядоченный массив с уникальными stepId. Узел задаётся `{nodeId:"1:1"}` либо `{stepId:"frame",output:"nodeId"}`; ресурсы — ID либо ссылка с output `styleId`, `collectionId`, `modeId`, `variableId`. Ссылка должна указывать на предыдущий шаг с соответствующим результатом.

Пример: `[{stepId:"frame",op:"createNode",type:"FRAME",parent:{nodeId:"0:1"},properties:{name:"Screen",width:320}},{stepId:"text",op:"createText",parent:{stepId:"frame",output:"nodeId"},characters:"Hello",font:{family:"Inter",style:"Regular"},typography:{fontSize:16}}]`.

Поддерживаемые op:

- Структура: createPage, renamePage, clonePage, movePage, deletePage, createNode, updateNode, cloneNode, deleteNode, moveNode, groupNodes, ungroupNode.
- Компоновка: setGeometry, setConstraints, setAutoLayout, setLayoutSizing.
- Текст: createText, setText, replaceTextRange, formatTextRange.
- Графика: setAppearance, importImage, importSvg, booleanNodes.
- Компоненты: createComponent, componentFromNode, combineVariants, setComponentProperties, createInstance, setInstanceProperties, swapVariant, detachInstance.
- Стили: createStyle, updateStyle, applyStyle, unbindStyle, deleteStyle.
- Переменные: createCollection, updateCollection, deleteCollection, createMode, renameMode, deleteMode, createVariable, updateVariable, deleteVariable, setVariableValue, setVariableAlias, bindVariable, unbindVariable, setNodeMode.

Создание узла использует FRAME, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, TEXT; updateNode дополнительно допускает COMPONENT и INSTANCE и задаёт type для проверки patch. COMPONENT/INSTANCE создаются отдельными операциями. Общие свойства: name, x, y, width, height, rotation, visible, locked. Appearance: fills, strokes, effects, opacity, strokeWeight; cornerRadius доступен FRAME, RECTANGLE, ELLIPSE, POLYGON, STAR, COMPONENT и INSTANCE, а четыре отдельных угловых радиуса — FRAME, RECTANGLE, COMPONENT и INSTANCE. Для FRAME доступен layout; для POLYGON/STAR — pointCount; для TEXT — characters и typography. Typography: fontName, fontSize, lineHeight, letterSpacing, textAlignHorizontal, textAlignVertical, textCase, textDecoration, textAutoResize. Layout: layoutMode, layoutWrap, paddingTop/Right/Bottom/Left, itemSpacing, counterAxisSpacing, primaryAxisAlignItems, counterAxisAlignItems. Числа конечны; размеры положительны. Цвет и непрозрачность ограничены диапазоном 0–1. `replaceTextRange` требует явного insertionFormatting, диапазон — [start,end) в UTF-16. Проверки доступности свойств, корректных сочетаний и границ строки зависят от живого узла.

`insertionFormatting` принимает либо `{inherit:"BEFORE"|"AFTER", format?: rangePatch}`, либо `{format: fullRangeStyle}` без наследования поддерживаемых символьных свойств. `rangePatch` допускает fontName, fontSize, lineHeight, letterSpacing, textCase, textDecoration и fills; `fullRangeStyle` требует все семь полей. `formatTextRange.format` использует тот же rangePatch. Например, `{inherit:"BEFORE",format:{fontSize:18}}` явно наследует оформление предыдущего символа и меняет размер; полный стиль может задать `{fontName:{family:"Inter",style:"Regular"},fontSize:18,lineHeight:{unit:"AUTO"},letterSpacing:{unit:"PIXELS",value:0},textCase:"ORIGINAL",textDecoration:"NONE",fills:[]}`. Выравнивание и textAutoResize относятся к узлу и недопустимы в rangePatch.

`bindVariable` и `unbindVariable` принимают только поля Plugin API: height, width, characters, itemSpacing, paddingLeft, paddingRight, paddingTop, paddingBottom, visible, cornerRadius, topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius, minWidth, maxWidth, minHeight, maxHeight, counterAxisSpacing, strokeWeight, strokeTopWeight, strokeRightWeight, strokeBottomWeight, strokeLeftWeight, opacity, gridRowGap, gridColumnGap, fontFamily, fontSize, fontStyle, fontWeight, letterSpacing, lineHeight, paragraphSpacing, paragraphIndent. Доступность конкретного поля и совместимость переменной проверяются на живом объекте. Определение свойства компонента BOOLEAN требует boolean defaultValue; TEXT, INSTANCE_SWAP и VARIANT требуют строку. Если тип проекции переменной указан, значения режимов соответствуют этому типу либо являются alias.

Изменение существующего объекта требует непустой `expected`. Поддерживаются имя, родитель, порядок children, геометрия, appearance, typography, текст, style IDs, boundVariables, explicitVariableModes, description, hiddenFromPublishing, type, paints, layoutGrids, modes, valuesByMode и variableIds. Для нескольких объектов `related` отображает каждый существующий ID в непустую проекцию тех же конечных полей. Например: `expected:{parentId:"p",related:{p:{children:["a","b"]},b:{name:"Other"}}}`. Проверяются только переданные свойства; это не блокировка документа. Для созданного предыдущим шагом объекта допустима ссылка без expected. Удаление связей — только явные unbindStyle, unbindVariable или detachInstance; остальные операции не должны неявно их снимать.

Для проверки диапазонов `expected.textSegments` принимает полученную при чтении проекцию сегментов, включая textStyleId, fillStyleId и boundVariables. `setText` полностью заменяет содержимое, используя оформление первого символа; смешанные связи и диапазонные overrides отклоняются, поскольку заменить их одной строкой без потери невозможно. Очистка связанного текста также отклоняется. Замена диапазона сохраняет незатронутый текст и сдвигает его оформление вместе с ним.

## Результат и состояния

`operationResultSchema`: operationId, sessionId, connectionGeneration, status, steps, affectedNodeIds, affectedResourceIds, warnings, error?. Статусы: queued, running, succeeded, failed, partially_applied, cancelled, unknown. Результат шага: stepId, status (`succeeded`, `failed`, `skipped`), outputs (необязательные nodeId/styleId/collectionId/modeId/variableId), appliedChanges `{nodeIds,resourceIds,details?}`, error?. Даже упавший шаг может перечислять известные изменения. ACK подтверждает доставку, а не успех.

`figma_get_nodes` и `expected` поддерживают `gridStyleId` и `layoutGrids`, включая фактически прочитанные сетки GRID, ROWS и COLUMNS. Запись grid style сохраняет ограничения схемы соответствующей операции.

В `expected` для fills, strokes, effects и paints принимаются поддерживаемые значения проекций чтения, включая метаданные и bindings Figma; доступные поля записи при этом не расширяются. Нулевые размеры и `parentId: null` также можно использовать в предусловиях.

Пример: `{operationId:"019a4a10-0000-7000-8000-000000000001",sessionId:"s",connectionGeneration:1,status:"partially_applied",steps:[{stepId:"one",status:"failed",outputs:{},appliedChanges:{nodeIds:["1:1"],resourceIds:[]},error:{code:"FIGMA_API_ERROR",message:"failed",recoveryAction:"Read changes"}}],affectedNodeIds:["1:1"],affectedResourceIds:[],warnings:[]}`.

Коды ошибок: NOT_CONNECTED, AUTH_FAILED, SESSION_BUSY, QUEUE_TIMEOUT, RECOVERY_REQUIRED, OPERATION_NOT_OWNED, PROTOCOL_MISMATCH, SESSION_EXPIRED, DOCUMENT_MISMATCH, INVALID_ARGUMENT, INVALID_CURSOR, NODE_NOT_FOUND, CAPABILITY_UNAVAILABLE, FONT_UNAVAILABLE, CONFLICT, OPERATION_ID_CONFLICT, OPERATION_EXPIRED, RESOURCE_LIMIT, RESOURCE_EXPIRED, WRITE_DISABLED, FIGMA_API_ERROR, OUTCOME_UNKNOWN. При CONFLICT нужно перечитать объект, при OUTCOME_UNKNOWN — выяснить статус и перечитать документ без слепого повтора.

Если имена недоступных шрифтов удалось определить, FONT_UNAVAILABLE содержит `details.fonts` — массив `{family,style}`. Когда Figma сообщает о недостающем шрифте без определяемого имени, ошибка может прийти без списка. Исходный текст исключения API не передаётся.

Если редактор сообщает об ограничении числа режимов переменных, CAPABILITY_UNAVAILABLE содержит `details.reason: "VARIABLE_MODE_LIMIT"` и предлагает использовать существующий режим или проверить ограничения редактора. Произвольный текст ошибки Figma не передаётся.

Схемы описывают целевой контракт, а не доступность всех функций. Сейчас подключены context, tree и find; обработчики остальных инструментов и проверка предусловий в Figma ещё реализуются. Запись отключена до проверки границы документа в задаче 1.2. Фактические возможности сообщает context. Каталог публикует схемы результатов всех инструментов; проекции чтения и их обработчики уточняются в задаче 4.3.

При `moveNode` индекс считается после исключения перемещаемого узла из списка детей; его локальная матрица сохраняется и потому координаты трактуются относительно нового родителя. Для `movePage` индекс задаёт итоговую позицию страницы. `groupNodes` принимает узлы с одной страницей с указанным родителем; Figma сохраняет их абсолютное положение. `ungroupNode` использует нативную семантику Figma и может изменить выделение, если группа выделена. Автокомпоновка может изменить фактическую геометрию: перечитайте узлы после операции. Перед записью отклоняются циклы, неподходящие родители и изменения внутри instance; операция не выполняет detach. Ограничения циклов компонентов проверяет Figma. Результат включает известные изменённые узлы, родителей и предков, созданную группу или удалённую группу и её детей; Figma может автоматически удалить опустевшие группы.

## Доверенное выполнение (protocol v2)

`figma_execute` принимает scope, UUIDv7 operationId, language (`javascript`/`typescript`), code (тело async-функции) и необязательные JSON args. Сервер добавляет compiledCode только во внутреннее сообщение; публичная схема его отклоняет. `readOnly` не поддерживается. Для execute требуется отдельное разрешение UI; batch writeEnabled не разрешает скрипты.

Результат имеет kind=execute, effects=none только до запуска, иначе unknown, ограниченные logs/logsTruncated, value либо resource. Статус succeeded не подтверждает отсутствие побочных эффектов. get_operation/cancel принимают оба вида; форма batch-результата сохраняется. При таймауте нельзя повторно запускать исходник с новым ID без проверки документа. API-каталог и ограничения среды публикуются отдельно от tools/list.

### Несколько MCP-клиентов

Команды документа сериализуются общей FIFO-очередью; владения на время соединения нет. Лимиты ожидания и размера очереди — `operationTimeout` и `maxQueuedOperations`. `QUEUE_TIMEOUT` означает отсутствие отправки в Figma; `RESOURCE_LIMIT` — переполнение. Отключение удаляет ожидающие команды клиента, не отменяя автоматически уже отправленные и не разрывая подключение плагина. Статус/отмена доступны только отправителю (`OPERATION_NOT_OWNED` для чужих или неизвестных operationId), включая ожидающие команды. Экспортные ресурсы доступны только создавшему их клиенту.

`OUTCOME_UNKNOWN` не освобождает доступ для новых команд, пока выполнение не подтверждено: они получают `RECOVERY_REQUIRED`. Поздний терминальный ответ или терминальный статус снимает барьер. Если связь оборвалась с незавершённой записью, новая сессия plugin main обязательна. Клиент должен сам получить контекст перед записью. Между отдельными командами нет транзакционной изоляции: batch использует прежние предусловия, execute должен самостоятельно учитывать изменения документа.
