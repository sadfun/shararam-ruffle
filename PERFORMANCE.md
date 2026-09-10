# Производительность: что сделано, где лежит, как мерилось

Сводка работ августа–сентября 2026 над скоростью Шарарама в Ruffle. Всё,
что попало в прод, живёт в форке Ruffle <https://github.com/sadfun/ruffle>
(ветка `shararam/perf`) и вшивается в клиент бандлом `web/ruffle/`
(см. `web/ruffle/BUILD-INFO.md`, там же — как пересобрать).

## Что в проде (релиз v0.3.0)

Подробный технический отчёт по каждому изменению — механика, доказательство
корректности, ссылки на коммиты — в [RUFFLE-FORK.md](RUFFLE-FORK.md).


Подробный отчёт по каждому отличию форка от апстрима — механика, аргумент
корректности, ссылки на коммиты — в [RUFFLE-FORK.md](RUFFLE-FORK.md).


| Оптимизация | Коммит форка | Файлы | Эффект (измерено) |
|---|---|---|---|
| Инлайн `BlendMode.LAYER`: группа без зависимости от фона рисуется прямо в кадр, а не через полноэкранную offscreen-поверхность (пиксельно эквивалентно по ассоциативности «over») | `bb27d1c08` | `render/src/commands.rs` (`is_backdrop_independent`), `core/src/display_object.rs` (`render_base`) | людная локация 9.2 → 28.7 fps. Выключатель: конфиг `layerBlendInlining` ← env сервера `SHARARAM_LAYER_INLINE=0` |
| Бленд-группы рендерятся в offscreen-цель размером с bounds группы, а не с весь кадр; `Command::Blend` теперь несёт device-bounds | `4174e3a3c` | `core/src/display_object.rs`, `render/wgpu/src/surface.rs`, `surface/commands.rs` (`blend_region`), `surface/target.rs` (origin цели), `render/wgpu/shaders/blend/*.wgsl` | домик со столом-самоваром (25 multiply-блендов): 7.6 → 17 fps, ожидание GPU 144 → 53 мс |
| `MULTIPLY` на непрозрачном кадре — через GPU blend state (`Dst, OneMinusSrcAlpha`), без снимка бэкдропа и разрыва render pass; точно равен шейдеру при dst.a = 1 | `1406709b8` | `render/wgpu/src/blend.rs` (`TrivialBlend::Multiply`), `surface/commands.rs` (флаг `opaque`, гаснет на Alpha/Erase/Shader/Stage3D) | тот же домик: 17 → 32–41 fps, GPU 28–31 мс — как в комнатах без блендов |
| Кэш распарсенных SWF: повторный AVM1 `loadMovie` того же URL берёт готовый `Arc<SwfMovie>` и его библиотеку персонажей; preload повтора обрабатывает только теги кадров/меток/init-actions | `971dd6c0d` | `core/src/library.rs` (`movie_cache`, `MovieLibrary::preloaded`), `core/src/loader.rs` (`movie_loader_data`), `core/src/display_object/movie_clip.rs` (`preload`) | в сессии 133 с: 394 загрузки / 198 URL, 79% времени preload были повторами (риг аватара 12 × 140 мс); после — 94% повторов из кэша, ~0 мс каждый |
| Библиотека загруженного фильма (персонажи, меши рендера, битмапы, шрифты, распакованные байты SWF) освобождается, когда её не играет ни один корневой клип; в апстриме — никогда | `be239a95c` | `core/src/library.rs` (`use_movie`, `prune_unused_movies`), `core/src/display_object/movie_clip.rs` (`library_use`), `core/src/player.rs` | куча gc-arena после сборки мусора росла на 250 МБ за 5 минут и не возвращалась ни на одном выходе из локации |
| Wasm-память растёт кусками по 64 МиБ вместо 64 КиБ dlmalloc: на Windows/Chromium каждый `memory.grow` коммитит память через `VirtualAlloc` за 1–10 мс | `876466068` | `web/src/alloc.rs`, `web/src/lib.rs` | фризы 0.8–5.5 с при выходе из людной локации на Windows; в профиле новой сборки секундных фризов нет, максимум 511 мс |
| Хит-тест мыши не обходит весь display list (кэш bounds поддерева, включая hit-области кнопок), а диспатч AVM1-событий не ищет `onXxx` по цепочке прототипов у каждого клипа (кэш наличия обработчика) | `7826b1412` | `core/src/display_object.rs` (`pick_bounds`), `core/src/avm1/handlers.rs`, `core/src/display_object/movie_clip.rs`, `core/src/player.rs` | синтетика 4900 объектов: pick 705 → 1.2 мкс, событие мыши 1200 → 75 мкс; у тестировщицы −15 мс из 38-миллисекундного тика |

Корректность: весь набор SWF-тестов Ruffle на `shararam/perf` — 4166 зелёных, 4 падения
те же, что и на нетронутом апстримном срезе; хит-тест дополнительно прогнан с фичей
`ruffle_core/pick_bounds_verify`, которая пересчитывает кэшированные bounds при каждом
обращении. Запуск — `cargo test -p tests --release --test tests`, image-тесты —
`--features imgtests`.

Плюс на стороне клиента/сервера (уже в `main` до v0.2.0): дисковый кэш `/fs/`-ассетов
(`4eb75e1`, `dfeae7a`), предсжатая статика для Caddy (`8e2d188`), кэширование сервера (`2b36643`).

## Почему именно это

- Шарарам ставит `blendMode="layer"` на каждого аватара, а стол с самоваром в домике
  (`baba_yaga_table.swf`, 18 multiply на фигурах 6–16 px) и скамейка (7) заставляли
  wgpu-бекенд Ruffle делать 25 полнокадровых копий бэкдропа за кадр. На TBDR (Metal)
  каждый разрыв render pass на 3322×2018 — load+store всего кадра (~27 МБ).
- Каждая часть тела аватара — отдельный SWF (`Avatar.LoadAvatar` → `ClipSetLoader.Load`
  → `movieClipLoader.loadClip(url, body_holder_mc.<MRId>)`), один URL на всех смешариков
  в комнате; Ruffle же на каждый `loadMovie` распаковывал и переопределял все персонажи.

## Инструменты (ветка `scout`, worktree `~/Developer/shararam-ruffle-scout`)

- **Профилировочная сборка клиента**: `cargo build --manifest-path src-tauri/Cargo.toml
  --release --no-default-features --features desktop,profiler` — вшивает `web-profiler/`
  (бандл форка с фичей `shararam_profiler`, ветка `shararam/render-opt` = `shararam/perf`
  + инструментирование; `web-profiler/BUILD-INFO.md`). Сессия пишется в
  `profiles/shararam-profile-<дата>.duckdb` (таблицы `events`, `frames`, `fps_1s`,
  `loads`, `samples`, `rtmp`, `slow_events`).
- **Вьюер** (реплика Adobe Scout): `profiler-viewer/` — `npm run dev`, порт 5178,
  перетащить `.duckdb`. Панель «Рендер кадра» показывает `blend_complex` /
  «Multiply без снимка бэкдропа»; список загрузок — «из кэша распарсенных».
- **Инструментирование в форке**: `core/src/profiler.rs`, `core/src/profiler/render.rs`,
  `web/src/profiler.rs`, описание `docs/SHARARAM-PROFILER.md` (форк).
- **Замер без логина** (один SWF в debug desktop-сборке): `profiler-tools/` — `ws_serve.py`,
  `inject.js`, `measure.py`, `swfinfo.py` (см. README там).
- **Исходники клиента Шарарама** (переданы разработчиками 08.09): `~/Developer/ShararamClient`
  — `class/` (13 930 файлов AS2), `swf/` (8.2 ГБ ассетов). Деанонимизация ассетов из
  профиля: ключ кэша клиента `sha256("fs/xx/hash.swf?query")`, сопоставление по
  контент-хэшам файлов из `swf/`.

## Что найдено, но не сделано

- `kernel/LayersController`: z-сортировка объектов комнаты + `swapDepths` каждые 50 мс
  (`Base.Config.DistributeLayersInterval`, **перезаписывается сервером** через
  `GetUserData` → `config`). Это горячая таймерная цепочка профиля; лечится на стороне
  сервера Шарарама, без правок SWF. `utilites/CheatDetector` карает только ускорение
  таймеров — замедлять безопасно.
- Оставшиеся шейдерные бленды (overlay/darken и т. п.) всё ещё рвут render pass —
  следующий шаг: рисовать квад бленда внутри следующего Draw-чанка.
- Снятие фильтров с SWF на лету (ветка `swf-patch`) — невыгодно, выключено.
- Стойлы главного потока в людных комнатах были на две трети хит-тестом мыши и
  диспатчем событий — это закрыто в v0.3.0 (п.7 отчёта). Осталась AS2-сторона:
  аллокации `$.Fn/FnA` (`arguments.concat` на каждый вызов делегата) и квадратичный
  `Dispose` при выходе из локации.
- `Array.sort` в Ruffle — квиксорт с левым пивотом «как во Flash», то есть O(n²) на уже
  отсортированном массиве. `LayersController` сортирует свой список каждые 50 мс, и он
  каждый раз уже отсортирован: при 56 объектах это 1540 вызовов AS2-компаратора вместо
  ~330, 3–4 мс на сортировку. Лечится средним пивотом в `core/src/avm1/globals/array.rs`
  (порядок равных элементов перестанет совпадать с Flash) или интервалом на стороне
  сервера Шарарама.

## Как выпускать

1. Форк: коммиты в `shararam/perf`, тесты выше, `cd web && npm run build --workspace=ruffle-core
   && npm run build --workspace=ruffle-selfhosted`.
2. Клиент: скопировать `packages/selfhosted/dist/{ruffle.js, core.ruffle.*.js, *.wasm}` в
   `web/ruffle/` (старую пару `core.ruffle.*.js`/`*.wasm` удалить), обновить
   `web/ruffle/BUILD-INFO.md`, поднять версию в `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`.
3. `git push` в `main` → workflow **Deploy public server** выкатывает shararam.sadfun.dev.
4. `gh release create vX.Y.Z` → workflow **Release builds** собирает Windows/macOS/Linux
   и прикладывает к релизу.
