# Разработка и устройство скрипта

Для обычной установки используйте [ссылку в README](../README.md#установка). Этот документ — для редактирования исходников и выпуска новых версий.

## Локальное подключение

Tampermonkey в Chrome и браузерах на Chromium умеет читать исходники с диска. [Официальная инструкция](https://www.tampermonkey.net/faq.php?q=Q402).

1. Скачайте или клонируйте репозиторий в постоянную папку. Для запуска нужны оба файла из `src`.
2. Откройте `chrome://extensions` или `edge://extensions` → **Tampermonkey → «Подробнее»**. Разрешите пользовательские скрипты и включите **«Разрешить доступ к URL файлов»**. Если чтение блокируется настройками доступа к сайтам, проверьте [справку Tampermonkey](https://www.tampermonkey.net/faq.php?q=Q204).
3. В Tampermonkey создайте новый скрипт и замените шаблон заголовком ниже. Исправьте оба пути.
4. Сохраните его и перезагрузите редактор Тильды. На время разработки включайте только локальную копию.

```js
// ==UserScript==
// @name         Tilda — Monaco HTML + публикация (разработка)
// @namespace    local.tilda.monaco.dev
// @version      1.0.0
// @description  Локальная разработка Tilda Monaco. JS и CSS читаются с диска.
// @match        https://tilda.ru/page/*
// @match        https://tilda.cc/page/*
// @run-at       document-end
// @noframes
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_getResourceText
// @downloadURL  none
// @resource     tmlStyles file:///FULL/PATH/TO/tilda-monaco/src/tilda-monaco.css
// @require      file:///FULL/PATH/TO/tilda-monaco/src/tilda-monaco.user.js
// ==/UserScript==
```

Отдельные имя и namespace позволяют держать публичную и рабочую копии в Tampermonkey. `@downloadURL none` отключает автоматические обновления локального подключения. Уже настроенное подключение из прежней инструкции тоже продолжит работать: метаданные файла из `@require` не заменяют заголовок установленного скрипта.

**Windows**, папка `C:\Users\YOUR_NAME\Documents\tilda-monaco`:

```js
// @resource     tmlStyles file:///C:/Users/YOUR_NAME/Documents/tilda-monaco/src/tilda-monaco.css
// @require      file:///C:/Users/YOUR_NAME/Documents/tilda-monaco/src/tilda-monaco.user.js
```

**macOS**, папка `/Users/YOUR_NAME/Documents/tilda-monaco`:

```js
// @resource     tmlStyles file:///Users/YOUR_NAME/Documents/tilda-monaco/src/tilda-monaco.css
// @require      file:///Users/YOUR_NAME/Documents/tilda-monaco/src/tilda-monaco.user.js
```

Укажите фактический путь и имя папки пользователя. В URL нужны прямые слеши `/`, начало `file:///`, пробелы записываются как `%20`. Не используйте `~`, переменные окружения или кавычки вокруг адреса. Имя ресурса `tmlStyles` оставьте без изменений.

Адрес можно получить через **«Открыть файл»** (`Ctrl+O` / `Cmd+O`) в браузере: откройте `tilda-monaco.css` и скопируйте адресную строку. Для второй строки замените имя файла на `tilda-monaco.user.js`.

Редактируйте файлы в `src`, сохраняйте и перезагружайте Тильду. Сборка для локальной проверки не нужна. Номер версии в установленном заголовке разработки на подхват изменений не влияет. Если меняются `@grant`, `@match` или другие разрешения, обновите их и в установленном заголовке.

Если файлы не читаются, проверьте доступ к `file://`, полный путь, распаковку ZIP и расширения файлов: это должны быть `.js` и `.css`, а не `.js.txt` и `.css.txt`. При переносе папки исправьте оба пути. Изменения GitHub сами на локальный диск не скачиваются.

## Выпуск версии для пользователей

Установочная ссылка и адрес автообновления ведут на `dist/tilda-monaco.user.js` в ветке `main`. Этот файл хранится в Git вместе с исходниками.

1. Внесите изменения в `src` и проверьте их через локальное подключение в Тильде.
2. Увеличьте `@version` в `src/tilda-monaco.user.js`, например с `1.1.11` до `1.1.12`. Это нужно для каждого публичного обновления, в том числе только CSS. Без увеличения версии Tampermonkey не обнаружит новый релиз.
3. Соберите установочный файл и выполните проверки:

```sh
node scripts/build-userscript.mjs
node --check src/tilda-monaco.user.js
node --check dist/tilda-monaco.user.js
node --test tests/*.test.cjs
node scripts/build-userscript.mjs --check
```

4. Закоммитьте исходники, обновлённый `dist` и остальные файлы изменения. Отправьте коммит в `main` на GitHub.
5. Проверьте ссылку установки из README. Для немедленной проверки обновления используйте отдельную установленную публичную копию и штатную команду Tampermonkey проверки обновлений; затем перезагрузите Тильду.

Нужен Node.js; установка npm-зависимостей не требуется. Сборка встраивает CSS в JS без минификации и добавляет `@updateURL` / `@downloadURL`. Код и стили устанавливаются одной версией. Файл `dist` генерируется полностью — редактируйте исходники, затем пересобирайте его. Режим `--check` ничего не записывает и сообщает об устаревшей сборке.

GitHub Release или тег для этой схемы не обязательны. Обновления приходят после очередной проверки Tampermonkey; для установки без подтверждения у пользователя должна быть включена «Автоматическая установка». Открытый редактор продолжает работать до перезагрузки. Настройка «Внешние ресурсы» не управляет обновлением нашего скрипта: проверяются `@version` и адреса из заголовка. [Документация автообновления](https://www.tampermonkey.net/documentation.php?locale=en&q=update_url), [правила версии](https://www.tampermonkey.net/documentation.php?locale=en&q=version).

После изменений CSS-минификатора дополнительно выполните `node --test tests/minify-css.integration.mjs`: эта проверка загружает библиотеку из CDN.

Тесты используют заглушки Тильды, Monaco и Worker, не обращаются к сети и не публикуют реальные страницы. Изменения интерфейса дополнительно проверяются в открытом редакторе Тильды.

## Файлы и устройство

- `src/tilda-monaco.user.js` — логика редактора, синхронизация со штатным Ace, темы, минификация, публикация и кнопки блоков.
- `src/tilda-monaco.css` — оформление панели, кнопок, iframe и окна выбора темы.
- `dist/tilda-monaco.user.js` — готовый установочный файл со встроенным CSS и адресами автообновления.
- `scripts/build-userscript.mjs` — сборка установочного файла без npm-зависимостей.
- `tests/distribution.test.cjs` — запуск собранного файла без API локальных ресурсов и проверка встроенных стилей.
- `tests/project-publish.test.cjs` — проверки сохранения и публикации через функции Тильды.
- `tests/minify.test.cjs` — проверки отмены, ошибок, таймаута и изменений во время минификации.
- `tests/minify-css.integration.mjs` — проверка реального CSS-парсера, включая вложенность и экранирование внутри HTML; требует доступа к CDN.

Monaco работает в отдельном iframe, чтобы его сочетания клавиш не перехватывались редактором страницы. CSS добавляется один раз на документ: в публичной версии он встроен в userscript, а при локальной разработке читается через `GM_getResourceText`. Встроенные CSS и JavaScript получают языковые подсказки через отдельные модели; сохранение продолжает идти через форму Тильды.

`unsafeWindow` и `@sandbox raw` нужны для взаимодействия с функциями страницы, `GM_getResourceText` — для CSS только в локальном режиме, `GM_openInTab` — для открытия вкладки после асинхронной публикации, `GM_registerMenuCommand` — для команд в меню расширения. [Режим выполнения](https://www.tampermonkey.net/documentation.php?q=sandbox), [разрешения API](https://www.tampermonkey.net/documentation.php?q=grant).

## Зависимости

| Библиотека | Версия в исходнике |
| --- | --- |
| Monaco Editor | Последняя стабильная при первом открытии редактора |
| Prettier и плагины | 3.9.6 |
| HTML Minifier Terser | 7.2.0 |
| CSSTree, минификация CSS | 3.2.1 |
| Monaco Themes | 0.4.8 |
| VS Code CSS Language Service | 6.3.10 |
| process, браузерный модуль | 0.11.10 |

При обновлении Prettier его standalone-модуль и все плагины нужно переводить на одну версию одновременно. Браузерная сборка HTML-минификатора содержит свои зависимости; CSS обрабатывается отдельно через CSSTree.
