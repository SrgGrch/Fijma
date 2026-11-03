# Контракты Figma MCP Bridge

Источник схем — `contracts.ts`, `operation-result.ts`, `context.ts` и `tree-result.ts`. Объекты строгие: неизвестные поля и команды отклоняются. Проверка схемы не заменяет проверку живого документа, прав, доступности API, шрифтов, совместимости типов и связей непосредственно перед записью.

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
| figma_export_node | nodeId, format PNG/SVG, scale? | sessionId, nodeId, bytes, format, mimeType и PNG data либо uri с expiresAt; PNG также содержит width и height |

Примеры: `figma_get_tree({scope:{sessionId:"s",connectionGeneration:1},rootId:"0:1",depth:2,limit:100})`; `figma_find_nodes({scope:{sessionId:"s",connectionGeneration:1},document:true,name:"Button",limit:50})`; `figma_get_nodes({scope:{sessionId:"s",connectionGeneration:1},nodeIds:["1:1"],fields:["name","characters"]})`.

Проекция узла имеет `nodeId`, `type`, `properties`, списки имён `mixed` и `unavailable`. `fields` принимает только имена полей `properties`, без вложенных путей. `properties` допускает name, x, y, width, height, rotation, visible, locked, appearance и typography поля ниже, characters, textSegments, parentId, children, layout, fillStyleId, strokeStyleId, textStyleId, effectStyleId, boundVariables и explicitVariableModes. Неполученное поле отсутствует; mixed и unavailable различимы. `textSegments` содержит диапазоны start/end в UTF-16, characters и доступные поля форматирования, fills, textStyleId и boundVariables; фактические размеры могут быть нулевыми.

Ресурс имеет `kind`, `id`, `properties`, `mixed`, `unavailable`. Допустимые поля проекции:

- components: name, description, key, remote, parentId;
- styles: name, description, key, remote, type, value, boundVariables;
- collections: name, modes (`modeId`, `name`), defaultModeId, variableIds, remote;
- variables: name, description, collectionId, type, valuesByMode, hiddenFromPublishing, remote. Значение режима — строка, boolean, finite number, цвет, `{type:"VARIABLE_ALIAS",id}` или составной цвет с alias для color и/или opacity.

Проекции узлов и components также предоставляют `mainComponent` и `componentSet` как `{id,key,remote}` или null, `componentProperties` и `componentPropertyDefinitions` как словари по полному имени свойства, `variantProperties` как словарь строк или null. У свойств доступны type, value или defaultValue, preferredValues и boundVariables; у определений также variantOptions, description и slotSettings. Эти же поля можно задавать в `expected` и `expected.related`, чтобы проверять состояние компонента и его связей перед записью.

Например, `{resources:[{kind:"variables",id:"v",properties:{valuesByMode:{dark:{type:"VARIABLE_ALIAS",id:"other"}}},mixed:[],unavailable:[]}],truncated:false}`. Запрошенные fields ограничены полями соответствующего kind и задают проекцию, а не путь присваивания.

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

Создание и update узла используют перечисленные типы FRAME, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, TEXT; updateNode задаёт type для проверки patch. COMPONENT/INSTANCE создаются отдельными операциями. Общие свойства: name, x, y, width, height, rotation, visible, locked. Appearance: fills, strokes, effects, opacity, strokeWeight; cornerRadius доступен FRAME, RECTANGLE, ELLIPSE, POLYGON, STAR, а четыре отдельных угловых радиуса — FRAME и RECTANGLE. Для FRAME доступен layout; для POLYGON/STAR — pointCount; для TEXT — characters и typography. Typography: fontName, fontSize, lineHeight, letterSpacing, textAlignHorizontal, textAlignVertical, textCase, textDecoration, textAutoResize. Layout: layoutMode, layoutWrap, paddingTop/Right/Bottom/Left, itemSpacing, counterAxisSpacing, primaryAxisAlignItems, counterAxisAlignItems. Числа конечны; размеры положительны. Цвет и непрозрачность ограничены диапазоном 0–1. `replaceTextRange` требует явного insertionFormatting, диапазон — [start,end) в UTF-16. Проверки доступности свойств, корректных сочетаний и границ строки зависят от живого узла.

`bindVariable` и `unbindVariable` принимают только поля Plugin API: height, width, characters, itemSpacing, paddingLeft, paddingRight, paddingTop, paddingBottom, visible, cornerRadius, topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius, minWidth, maxWidth, minHeight, maxHeight, counterAxisSpacing, strokeWeight, strokeTopWeight, strokeRightWeight, strokeBottomWeight, strokeLeftWeight, opacity, gridRowGap, gridColumnGap, fontFamily, fontSize, fontStyle, fontWeight, letterSpacing, lineHeight, paragraphSpacing, paragraphIndent. Доступность конкретного поля и совместимость переменной проверяются на живом объекте. Определение свойства компонента BOOLEAN требует boolean defaultValue; TEXT, INSTANCE_SWAP и VARIANT требуют строку. Если тип проекции переменной указан, значения режимов соответствуют этому типу либо являются alias.

Изменение существующего объекта требует непустой `expected`. Поддерживаются имя, родитель, порядок children, геометрия, appearance, typography, текст, style IDs, boundVariables, explicitVariableModes, description, hiddenFromPublishing, type, paints, layoutGrids, modes, valuesByMode и variableIds. Для нескольких объектов `related` отображает каждый существующий ID в непустую проекцию тех же конечных полей. Например: `expected:{parentId:"p",related:{p:{children:["a","b"]},b:{name:"Other"}}}`. Проверяются только переданные свойства; это не блокировка документа. Для созданного предыдущим шагом объекта допустима ссылка без expected. Удаление связей — только явные unbindStyle, unbindVariable или detachInstance; остальные операции не должны неявно их снимать.

## Результат и состояния

`operationResultSchema`: operationId, sessionId, connectionGeneration, status, steps, affectedNodeIds, affectedResourceIds, warnings, error?. Статусы: queued, running, succeeded, failed, partially_applied, cancelled, unknown. Результат шага: stepId, status (`succeeded`, `failed`, `skipped`), outputs (необязательные nodeId/styleId/collectionId/modeId/variableId), appliedChanges `{nodeIds,resourceIds,details?}`, error?. Даже упавший шаг может перечислять известные изменения. ACK подтверждает доставку, а не успех.

Пример: `{operationId:"019a4a10-0000-7000-8000-000000000001",sessionId:"s",connectionGeneration:1,status:"partially_applied",steps:[{stepId:"one",status:"failed",outputs:{},appliedChanges:{nodeIds:["1:1"],resourceIds:[]},error:{code:"FIGMA_API_ERROR",message:"failed",recoveryAction:"Read changes"}}],affectedNodeIds:["1:1"],affectedResourceIds:[],warnings:[]}`.

Коды ошибок: NOT_CONNECTED, AUTH_FAILED, SESSION_BUSY, PROTOCOL_MISMATCH, SESSION_EXPIRED, DOCUMENT_MISMATCH, INVALID_ARGUMENT, INVALID_CURSOR, NODE_NOT_FOUND, CAPABILITY_UNAVAILABLE, FONT_UNAVAILABLE, CONFLICT, OPERATION_ID_CONFLICT, OPERATION_EXPIRED, RESOURCE_LIMIT, RESOURCE_EXPIRED, WRITE_DISABLED, FIGMA_API_ERROR, OUTCOME_UNKNOWN. При CONFLICT нужно перечитать объект, при OUTCOME_UNKNOWN — выяснить статус и перечитать документ без слепого повтора.

Схемы описывают целевой контракт, а не доступность всех функций. Сейчас подключены context, tree и find; обработчики остальных инструментов и проверка предусловий в Figma ещё реализуются. Запись отключена до проверки границы документа в задаче 1.2. Фактические возможности сообщает context. Каталог публикует схемы результатов всех инструментов; проекции чтения и их обработчики уточняются в задаче 4.3.
