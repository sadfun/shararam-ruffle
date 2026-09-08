# Чем наш Ruffle отличается от апстрима

Клиент вшивает сборку форка <https://github.com/sadfun/ruffle>, ветка **`shararam/perf`**
(ревизия [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d); см.
`web/ruffle/BUILD-INFO.md`). База — апстрим `ruffle-rs/ruffle`
[`29de30555`](https://github.com/ruffle-rs/ruffle/commit/29de3055511aa8cd1239df850f853be1c1daa612)
от 2026-08-08. Поверх базы ровно семь коммитов; полный дифф:
<https://github.com/sadfun/ruffle/compare/29de30555...shararam/perf>.

| # | Коммит | Что | Тип |
|---|---|---|---|
| 1 | [`fee366f34`](https://github.com/sadfun/ruffle/commit/fee366f34) | AVM1 `NetConnection` по RTMP | функциональность |
| 2 | [`11d599c02`](https://github.com/sadfun/ruffle/commit/11d599c02) | AMF0 команд RTMP через апстримный `flash-lso` | функциональность |
| 3 | [`b298ed3d1`](https://github.com/sadfun/ruffle/commit/b298ed3d1) | убран дублирующий тест | — |
| 4 | [`bb27d1c08`](https://github.com/sadfun/ruffle/commit/bb27d1c08) | инлайн `BlendMode.LAYER`-групп | производительность |
| 5 | [`4174e3a3c`](https://github.com/sadfun/ruffle/commit/4174e3a3c) | offscreen-цель бленда размером с объект | производительность |
| 6 | [`1406709b8`](https://github.com/sadfun/ruffle/commit/1406709b8) | `MULTIPLY` на непрозрачном кадре через blend state | производительность |
| 7 | [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d) | кэш распарсенных SWF для повторного `loadMovie` | производительность |

Ничего из апстрима не удалено и не изменено «по-тихому»: каждое отличие — отдельный
коммит с описанием, все четыре оптимизации пиксельно эквивалентны апстримному выводу
(это проверяется image-тестами самого Ruffle, см. ниже).

---

## 1–3. RTMP `NetConnection` для AVM1

**Проблема.** Апстримный Ruffle не поддерживает RTMP: `NetConnection.connect("rtmp://…")`
завершается ошибкой, а Шарарам общается с FMS именно так (чат, комнаты, RPC).

**Что добавлено** ([`fee366f34`](https://github.com/sadfun/ruffle/commit/fee366f34), +3211 строк):

- `core/src/rtmp/` — sans-I/O реализация RTMP-протокола: рукопожатие C0/C1/C2
  (`handshake.rs`), чанкинг с переменным размером (`chunk.rs`), протокольные сообщения
  SetChunkSize / WindowAck / SetPeerBandwidth / UserControl (`message.rs`), AMF0-команды
  `connect`/`call` с транзакциями и `_result`/`_error` (`command.rs`), состояние сессии
  (`session.rs`). Модуль ничего не знает о сокетах и AVM — только байты ↔ сообщения.
- `core/src/net_connection/rtmp.rs`, `core/src/avm1/globals/netconnection.rs` — привязка к
  AVM1: `connect` для `rtmp://`, `call(method, responder, …)` → `onResult`/`onStatus` у
  респондера, входящие вызовы сервера → методы объекта `NetConnection`, статусы
  `NetConnection.Connect.*` → `onStatus`.
- `core/src/socket.rs`, `core/src/backend/navigator.rs` — транспорт: `Socket::connect_rtmp`
  открывает упорядоченный байтовый поток через бекенд навигатора. В браузере TCP нет,
  поэтому введён `SocketProxyMode::AllowFallback`: RTMP-цель, узнанная в рантайме,
  может уйти в **fallback-WebSocket-прокси** (`proxyUrl?host=…&port=…`), тогда как обычные
  `Socket`/`XMLSocket` по-прежнему требуют точного совпадения с конфигом (поведение
  апстрима не ослаблено). Клиент поднимает такой прокси (`/socket-proxy`) и гонит байты
  в FMS как есть; RTMP-фрейминг целиком остаётся внутри Ruffle.
- Новые опции web-конфига (`load-options.ts`): `socketProxy` с fallback-записью,
  `spoofUrl` (URL, который видит фильм как свой, при загрузке с зеркала), `pageUrl`,
  `playerVersion` кортежем `[major, minor, build, revision]`, платформа в
  `System.capabilities` (`SystemPlatform`) — всё это Шарарам читает при
  `PerformServerSelection`.

[`11d599c02`](https://github.com/sadfun/ruffle/commit/11d599c02) заменяет собственную
AMF0-сериализацию команд на апстримный crate `flash-lso` (тот же, что Ruffle использует
для `SharedObject`), [`b298ed3d1`](https://github.com/sadfun/ruffle/commit/b298ed3d1)
удаляет тест, ставший дубликатом.

**Почему корректно.** Wire-формат покрыт 18 юнит-тестами (`core/src/rtmp/*`,
`net_connection/rtmp.rs`): рукопожатие, разбор/сборка чанков с обоими размерами,
транзакции команд. Сквозная проверка — интеграционный тест клиента
`http_server::tests::browser_path_uses_original_swf_and_rtmp_ruffle` и продакшн с
11.08 (v0.1.x): реальный FMS Шарарама, чат и переходы между комнатами.

---

## 4. Инлайн `BlendMode.LAYER`-групп — [`bb27d1c08`](https://github.com/sadfun/ruffle/commit/bb27d1c08)

**Проблема.** Шарарам ставит `blendMode="layer"` на каждого аватара. В апстриме любой
`Command::Blend` рендерится в свежую offscreen-поверхность **размером с весь кадр** (со
своим MSAA) и композитится обратно полноэкранным квадом. В людной комнате это ~39
полноэкранных проходов за кадр (~4.6 ГБ трафика GPU на Retina): 9.2 fps, кадры 40–60 мс.

**Что изменено.** `render_base` (`core/src/display_object.rs`) перед созданием
`Command::Blend(Layer)` проверяет `CommandList::is_backdrop_independent()`
(`render/src/commands.rs`): дерево команд считается независимым от фона, если в нём нет
блендов кроме `Normal`/`Layer` (рекурсивно). Для такого дерева команды просто
дописываются в родительский список (`context.commands.append`), offscreen-проход не
создаётся.

**Почему корректно.** Ruffle (апстрим) уже сейчас применяет color transform Layer-группы
к её детям, а буфер группы композитит с единичной матрицей и без color transform.
Значит, изоляция группы — это ровно последовательность операций Porter–Duff «over»
детей в чистый буфер, а затем «over» буфера на фон. «Over» ассоциативен, поэтому
`(A over B) over Backdrop == A over (B over Backdrop)` — результат побитно тот же,
что и при рисовании детей прямо в фон. Равенство ломается только если кто-то внутри
группы читает свой локальный фон (Multiply/Add/Screen/Alpha/Erase/шейдерный бленд) —
такие деревья `is_backdrop_independent` отвергает, и они идут старым путём. Альфа-маски
изолируются внутри себя и на проверку не влияют.

Замечание: у апстрима поведение для полупрозрачных Layer-групп и так отличается от
Flash Player (Flash применяет alpha к сплющенной группе, Ruffle — к детям); мы это
не меняем, инлайн эквивалентен именно апстримному Ruffle.

**Предохранитель.** `ruffle_core::set_inline_layer_blends(bool)` → web-опция
`layerBlendInlining` (по умолчанию `true`) → в клиенте env сервера `SHARARAM_LAYER_INLINE=0`
подставляется в `index.html` (`src-tauri/src/http_server.rs`).

**Эффект.** Та же людная сцена: 9.2 → 28.7 fps (29.08).

---

## 5. Offscreen-цель бленда размером с объект — [`4174e3a3c`](https://github.com/sadfun/ruffle/commit/4174e3a3c)

**Проблема.** Бленды, которые *действительно* читают фон (в домике: стол с самоваром
`baba_yaga_table.swf` — 18 `multiply` на фигурах 6–16 px, плюс скамейка — 7), в апстриме
рендерились по той же схеме «весь кадр»: `CommandTarget::new(.., self.size, ..)`, копия
всего родительского буфера в `update_blend_buffer`, полноэкранный квад шейдера.
`Command::Blend` не нёс геометрии вообще — в отличие от фильтров, у которых
`render_offscreen(bounds)` уже был.

**Что изменено.**
- `render/src/commands.rs`: `Command::Blend(CommandList, RenderBlendMode, Option<Rectangle<Twips>>)`
  — трейт `CommandHandler::blend` получает device-bounds группы; ядро передаёт
  `render_bounds_with_transform(матрица, с фильтрами, view_matrix)` — тот же контракт
  границ, на который апстрим уже опирается для фильтров и `cacheAsBitmap`.
  `BitmapData.draw` с блендом передаёт `None` (весь буфер, как раньше); бекенды
  WebGL/Canvas параметр игнорируют.
- `render/wgpu/src/surface/commands.rs::blend_region`: bounds снимаются наружу до целых
  пикселей, добиваются до сетки 16 px (чтобы пул текстур видел мало разных размеров) и
  обрезаются целью; пустое пересечение с целью — группа пропускается целиком.
- `render/wgpu/src/surface/target.rs`: у `CommandTarget` появился `origin` (положение
  региона в глобальных пикселях); `update_blend_buffer` копирует из родителя только
  регион; дочерняя поверхность, копия фона и квад блендера — размером с регион.
  Шейдеры `render/wgpu/shaders/blend/*.wgsl` берут UV прямо из позиции квада.
  Альфа-маски и стенсил-маски учитывают `origin`.
- Шейдерные (PixelBender) бленды остаются полнокадровыми — их семантика может зависеть
  от координат.

**Почему корректно.** Всё, что рисует группа, лежит внутри её render bounds (это тот же
инвариант, который апстрим использует, чтобы обрезать фильтры). Вне региона группа не
рисует ничего, а шейдер бленда для пикселя фона без вклада `src` возвращает фон без
изменений (`src.a == 0 → discard`), то есть полнокадровый результат вне региона равен
фону. Внутри региона вычисления те же, только в локальных координатах. Проверено
юнит-тестом `blend_region_snaps_pads_and_clips` и всеми image-тестами блендов/масок/фильтров.

**Эффект.** Домик, 25 блендов: 7.6–8.1 → 17 fps, ожидание GPU (`fence_wait`) 144–155 →
53 мс (профили `…182304` → `…182940`); синтетика (стол в цикле): 8.8 → 37.6 fps.

---

## 6. `MULTIPLY` на непрозрачном кадре через blend state — [`1406709b8`](https://github.com/sadfun/ruffle/commit/1406709b8)

**Проблема.** Даже с регионом каждый complex-бленд — это копия фона + отдельный render
pass с шейдером, а на TBDR (Metal) любой разрыв прохода родителя — load/store всего
attachment’а 3322×2018 (~27 МБ), ~2 мс на бленд.

**Что изменено.** `render/wgpu/src/blend.rs`: новый `TrivialBlend::Multiply` —
аппаратный `wgpu::BlendState { color: src·Dst + dst·(1−src.a), alpha: OVER }`.
`WgpuCommandHandler` ведёт флаг `opaque`: он `true`, если цель прохода —
`FreshWithColor` с alpha ≥ 1 (корень кадра Шарарама: непрозрачный `backgroundColor`), и
гаснет, как только на эту цель попадает что-то, способное сделать alpha < 1: бленды
`Alpha`/`Erase`, шейдерный бленд, Stage3D. При `opaque` Multiply понижается из
`Complex` в `Trivial` и рисуется как обычный draw группы в текущем проходе (группа
по-прежнему изолируется в свою прозрачную текстуру и композитится одним квадом —
без разрыва прохода родителя).

**Почему корректно.** Апстримный `multiply.wgsl` для премультиплицированных `src`, `dst`
считает

    out.rgb = src.rgb·(1−dst.a) + dst.rgb·(1−src.a) + src.a·dst.a·(src.rgb/src.a)·(dst.rgb/dst.a)
    out.a   = src.a + dst.a·(1−src.a)

При `dst.a = 1` первый член обнуляется, третий сворачивается в `src.rgb·dst.rgb`, итого
`out.rgb = src.rgb·dst.rgb + dst.rgb·(1−src.a)` — в точности `src·Dst + dst·(1−src.a)`
blend state; `out.a` — стандартный OVER. Особый случай шейдера `src.a == 0 → discard`
даёт `dst`, и blend state даёт `dst·1 + 0 = dst`. Условие `dst.a = 1` гарантирует флаг
`opaque`: Normal/Add/Screen/Subtract и complex-шейдеры пишут alpha как OVER
(`src.a + dst.a·(1−src.a) = 1` при `dst.a = 1`), маски пишут с `ColorWrites::empty()`,
а всё остальное флаг сбрасывает. Отличие от шейдера — только округление float.

**Эффект.** Тот же домик: 17 → 32–41 fps, GPU 53 → 28–31 мс (профиль `…184710`, все 25
блендов по быстрому пути: счётчик `blend_multiply_direct` = `blend_complex` = 25);
синтетика — 58 fps (потолок rAF). Домик перестал отличаться от комнат без блендов.

---

## 7. Кэш распарсенных SWF для повторного `loadMovie` — [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d)

**Проблема.** Каждая часть тела аватара — отдельный SWF: `Avatar.LoadAvatar` →
`ClipSetLoader.Load` → `movieClipLoader.loadClip(url, body_holder_mc.<MRId>)`, один и
тот же URL на всех смешариков в комнате. Апстримный Ruffle на каждый `loadMovie`
распаковывал SWF заново (`SwfMovie::from_data`) и заново прогонял preload —
переопределял все персонажи (декодирование битмапов, шейпы, шрифты) в новую
`MovieLibrary`. В сессии 133 с (`…184710`): 394 загрузки при 198 уникальных URL, 79 %
времени preload (2.75 с из 3.5 с) — повторы; риг `fs/ek/4pydl5s0lc.swf` 12 × ~140 мс.

**Что изменено.**
- `core/src/library.rs`: `Library.movie_cache: HashMap<url, Arc<SwfMovie>>` и флаг
  `MovieLibrary.preloaded` — ставится, когда корневой клип фильма (`id == 0`) дошёл до
  конца потока тегов.
- `core/src/loader.rs::movie_loader_data`: для загрузки AVM1 по URL (не `loadBytes`, не
  AVM2 `Loader`, не `ImportAssets`, не корневой фильм), если для этого URL уже есть
  фильм с *готовой* библиотекой и совпадает сжатый размер, — используется тот же
  `Arc<SwfMovie>`. Библиотеки Ruffle и так ключуются по указателю `Arc` (`PtrWeakKeyHashMap`),
  поэтому общий `Arc` автоматически означает общую библиотеку персонажей.
- `core/src/display_object/movie_clip.rs::preload`: если библиотека фильма уже
  `preloaded`, все define-теги пропускаются и не считаются в лимит тика; обрабатываются
  только per-instance теги: `ShowFrame`, `FrameLabel`, `DefineSceneAndFrameLabelData`,
  `DoInitAction`, `ExportAssets`, `ImportAssets`, `SoundStreamHead`, `ScriptLimits`,
  `DoAbc`/`SymbolClass`, `End`. Повторная загрузка завершается за один тик.

**Почему корректно.**
- Ключ — полный URL (с query), а не содержимое: `_url` клипа остаётся точным
  (`ClipSetLoader` использует его в отчётах об ошибках), а URL ассетов Шарарама и так
  содержит контент-хэш и версию. Совпадение сжатого размера — защита от смены
  содержимого под тем же URL внутри сессии.
- Разделение персонажей между экземплярами — штатная семантика Ruffle: экземпляры
  одного `DefineSprite` уже делят `MovieClipShared`; `register_character` в апстриме
  игнорирует повторную регистрацию того же id.
- Всё, что в Flash относится к *экземпляру* загрузки, по-прежнему выполняется на каждую
  загрузку: `DoInitAction` (как и раньше — в preload каждого клипа), метки кадров, поток
  звука, импорт/экспорт.
- Загрузки, начавшиеся до того, как первая допрелоадила (burst при входе в комнату),
  идут по старому пути со своей библиотекой — библиотека никогда не делится между
  незавершёнными preload’ами.
- Сознательный компромисс: библиотеки закэшированных URL живут до конца сессии
  плеера (раньше освобождались, когда исчезал последний экземпляр). Для Шарарама это
  и есть цель (риг переиспользуется всю сессию); ограничение по объёму не вводили.

Проверено 142 тестами загрузчика Ruffle (фильтры `load`, `mcl_`, `movieclip_lockroot` —
последний грузит один `child.swf` девять раз в два захода, второй заход идёт через кэш).

**Эффект.** Следующая сессия (`…195406`): 773 загрузки / 381 URL, 369 попаданий в кэш
(94 % повторов), preload попадания ≈ 0 мс; у рига 52 из 59 загрузок из кэша.

---

## Как проверить самим

```sh
git clone -b shararam/perf https://github.com/sadfun/ruffle
cd ruffle
cargo test -p ruffle_render --lib                                  # is_backdrop_independent, append
cargo test -p ruffle_render_wgpu --lib blend_region                # регион бленда
for f in blend mask filter cache load mcl_ movieclip_lockroot; do  # 155 image + 142 loader тестов
  cargo test -p tests --features imgtests --release --test tests -- "$f"
done
```

Все перечисленные наборы зелёные на `971dd6c0d`. Два теста `visual/edittext_*` в этом
апстримном срезе падают и на нетронутом дереве — к нашим изменениям не относятся.

Сборка бандла, который вшит в клиент: `cd web && npm run build --workspace=ruffle-core
&& npm run build --workspace=ruffle-selfhosted` (release + wasm-opt; никаких
дополнительных cargo-фич). Профили, на которые ссылаются цифры, лежат в `profiles/`
рабочей копии Степана; методика и инструменты — в `PERFORMANCE.md`.

## Что есть в форке, но не в проде

- `shararam/render-opt` — те же семь коммитов плюс инструментирование профилировщика
  (cargo-фича `shararam_profiler`, `core/src/profiler*.rs`, `docs/SHARARAM-PROFILER.md`).
  Используется только профилировочной сборкой клиента (ветка `scout`).
- `shararam/layer-inline` — прежняя прод-ветка (коммиты 1–4), оставлена как история.
