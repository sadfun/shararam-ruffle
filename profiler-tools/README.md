# Инструменты замера без логина

Скрипты, которыми мерились рендер-оптимизации на одном SWF без входа в игру.
Сценарий: debug desktop-сборка профилировочного клиента (rust-embed без
`debug-embed` читает `web/` и `web-profiler/` с диска), `inject.js` дописывается
в конец `web/app.js` (не коммитить: `git checkout -- web/app.js`), SWF отдаётся
байтами по WebSocket, профиль пишется в `profiles/` cwd процесса, SIGTERM его
финализирует.

- `ws_serve.py <file.swf>` — отдаёт байты SWF на `ws://127.0.0.1:8792` (CSP клиента разрешает `ws://127.0.0.1:*`).
- `inject.js` — хук в `web/app.js`: берёт байты из сокета, `player.load({data, scale:'noScale', backgroundExecutionMode:'mainThread'})`, публикует `window.__shararamRuffle={getPlayer}`.
- `measure.py <profile.duckdb> <skip_s>` — fps / `fence_wait` / стойлы / счётчики блендов по профилю, пропуская первые `skip_s` секунд.
- `swfinfo.py <file.swf>` — парсер тегов: PlaceObject2/3 (бленды, фильтры, cacheAsBitmap), bounds DefineShape, дерево DefineSprite; умеет вырезать DoAction для зацикливания клипа.

Индекс контент-хэшей ассетов Шарарама (`content_index.tsv`, 11 МБ) не хранится:
строится проходом по `~/Developer/ShararamClient/swf` (sha256 файлов) и
сопоставляется с кэшем клиента `~/Library/Caches/shararam-ruffle/assets/<sha256("fs/xx/hash.swf?query")>`.
