# Профилирование Шарарам Ruffle

Профилировочная сборка клиента записывает всю сессию в один файл DuckDB:
играете как обычно, закрываете окно — рядом появляется
`profiles/shararam-profile-<дата>.duckdb`. Файл открывается вьюером
(`profiler-viewer/`), где видно FPS-график и все события по категориям на
одном таймлайне, либо напрямую через SQL (`duckdb file.duckdb`).

Всё профилирование живёт в ветке `profiler` и включается **одним cargo-флагом**
`--features profiler`; обычные сборки не содержат ни одной из этих строк кода
(все хуки компилируются в пустоту), поэтому производительность профилировочной
сборки соответствует обычной — она отличается только записью событий
(микросекунды на событие).

## Что записывается

| Источник | Что |
|---|---|
| **Ruffle** (форк, feature `shararam_profiler`) | фазы каждого кадра (`tick` / `run_frame` / AVM1-скрипты / `run_actions` / таймеры / GC), рендер (командные списки, cacheAsBitmap, **тесселяция шейпов** с id и SWF, загрузка текстур, декодирование битмапов, оффскрин-рендеры, GPU-readback), загрузка SWF (start → fetch → parse → прелоад по чанкам → onLoadInit) с URL и байтами, **все RTMP RPC** (connect / call / result / error / server-invoke, аргументы AMF → читаемый JSON, транзакции, размеры), сокеты, layout текста, ExternalInterface, gotos, mouse pick |
| **Страница** (`web/profiler.js`) | каждый кадр rAF (график FPS), long tasks, resource timing (все HTTP-загрузки с размерами и таймингами), видимость вкладки, память JS/wasm, маркеры игры (`OnLoad`, `OnUserEnterLocation`, …) |
| **Локальный сервер** | прокси-запросы к shararam.ru (метод, путь, статус, байты, время до заголовков и полной передачи), base.swf (кэш-хит), RTMP-туннель (connect/close, байты в секунду) |

Все таймстампы приводятся к микросекундам эпохи, так что три источника лежат
на одной оси времени.

## Сборка

Профилировочному exe нужен Ruffle, собранный с инструментами. Готовый бандл
уже лежит в `web-profiler/ruffle/` (см. `web-profiler/BUILD-INFO.md`, ветка
форка `shararam/profiler`). Дальше:

```powershell
# Windows
make profiler        # -> dist\Shararam-Ruffle-Profiler.exe
```

```sh
# macOS/Linux (дев-запуск без бандла)
cargo run --manifest-path src-tauri/Cargo.toml --release \
  --no-default-features --features desktop,profiler
# или серверный режим (браузер): ... --features profiler -- --serve
```

Опции: `--profile-dir <папка>` (или `SHARARAM_PROFILE_DIR`) — куда писать
профили; по умолчанию `./profiles`. В окне профилировочной сборки сверху
виден бейдж с путём к файлу.

Полезные URL-флаги страницы: `?autoserver=1` — пропустить диалог выбора
сервера (авто-подключение; удобно для автоматических прогонов). В
профилировочной сборке игра продолжает работать и в скрытой/свёрнутой
вкладке (Ruffle тикает из Worker-а), чтобы запись не останавливалась.

Файл дописывается каждые ~5 секунд, так что даже убитый процесс оставляет
читаемый профиль; при обычном закрытии окна он финализируется полностью.

## Просмотр

```sh
cd profiler-viewer
npm install
npm run dev          # http://localhost:5178
```

Откройте `.duckdb` кнопкой или перетащите в окно (или `?load=<url>`).
Сверху — FPS (провалы >50мс подсвечены красным, серым — периоды без кадров,
фиолетовым — память wasm), ниже — таймлайн по категориям: колесо — зум,
перетаскивание — прокрутка, клик — детали события. Вкладки внизу:

- **RTMP** — все вызовы/ответы с методом, tid, латентностью и аргументами;
- **Загрузки** — водопад всех загрузок (SWF, HTTP, прокси);
- **Медленное** — события дольше 8 мс, по убыванию;
- **SQL** — произвольные запросы к файлу прямо во вьюере.

Тот же файл можно копать в DuckDB CLI:

```sql
-- на что ушло время
SELECT cat, name, count(*), round(sum(dur_us)/1000) AS ms
FROM events GROUP BY 1,2 ORDER BY ms DESC LIMIT 20;

-- FPS по секундам (view создаётся при финализации)
SELECT * FROM fps_1s;

-- RPC с латентностью ответа
SELECT * FROM rtmp_calls ORDER BY latency_ms DESC LIMIT 20;
```

Схема: `events(seq, ts_us, dur_us, source, cat, name, args)` — `args` это
JSON; `frames(ts_us, dt_ms)` — кадры страницы; `samples(ts_us, name, value)` —
память и трафик туннеля; `meta(key, value)`.

## Как это устроено / как выключить

- Форк Ruffle, ветка `shararam/profiler`: feature `shararam_profiler`
  (`core/src/profiler.rs` + хуки; при выключенном feature — пустые inline
  no-op). Буфер событий отдаётся странице как JSON через
  `window.__ruffleProfiler.drain()`.
- Этот репозиторий, ветка `profiler`: feature `profiler`
  (`src-tauri/src/profiler.rs` — писатель DuckDB в отдельном потоке;
  `web/profiler.js` — сборщик на странице; роуты `/api/profiler/*`).
- Удалить всё целиком = не мержить ветки; выключить в сборке = собрать без
  `--features profiler` (это и есть обычный `make exe`).
