# Наши изменения в Ruffle: механика, корректность, коммиты

Клиент вшивает сборку форка <https://github.com/sadfun/ruffle>, ветка **`shararam/perf`**,
ревизия [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d) (см.
`web/ruffle/BUILD-INFO.md`). Относительно Ruffle, который шёл в v0.1.x
(`shararam/rtmp-netconnection`, [`b298ed3d1`](https://github.com/sadfun/ruffle/commit/b298ed3d1)
— апстрим + RTMP), добавлены ровно четыре коммита, все — про производительность:

| # | Коммит | Что | Эффект |
|---|---|---|---|
| 1 | [`bb27d1c08`](https://github.com/sadfun/ruffle/commit/bb27d1c08) | `BlendMode.LAYER`-группы без зависимости от фона рисуются inline | людная комната 9.2 → 28.7 fps |
| 2 | [`4174e3a3c`](https://github.com/sadfun/ruffle/commit/4174e3a3c) | offscreen-цель бленда — размером с объект, не с кадр | домик 7.6 → 17 fps |
| 3 | [`1406709b8`](https://github.com/sadfun/ruffle/commit/1406709b8) | `MULTIPLY` на непрозрачном кадре — аппаратным blend state | домик 17 → 32–41 fps |
| 4 | [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d) | повторный `loadMovie` того же URL переиспользует распарсенный SWF | 94 % повторов ≈ 0 мс |

Полный дифф: <https://github.com/sadfun/ruffle/compare/b298ed3d1...shararam/perf>
(26 файлов, +535/−72). Все четыре изменения дают тот же вывод, что и
апстрим — это проверяется image-тестами самого Ruffle (см. «Как проверить»).

---

## 1. Инлайн `BlendMode.LAYER`-групп — [`bb27d1c08`](https://github.com/sadfun/ruffle/commit/bb27d1c08)

### Как это работает в апстриме

`render_base` (`core/src/display_object.rs`) для объекта с `blendMode != normal`
собирает команды детей в отдельный `CommandList` и кладёт в родительский список
`Command::Blend(sub_commands, mode)`. wgpu-бекенд (`render/wgpu/src/surface/commands.rs::chunk_blends`)
на каждый `Blend` создаёт `Surface` **размером с всю цель** (со своим MSAA), рендерит в
неё детей на прозрачный фон, затем композитит текстуру на родителя одним квадом на весь
кадр. Шарарам ставит `blendMode="layer"` каждому аватару: в людной комнате это ~39
полнокадровых offscreen-проходов за кадр (~4.6 ГБ трафика GPU на 3322×2018) — игра
упирается в fill rate: 9.2 fps, кадры 40–60 мс.

### Что изменено

- `render/src/commands.rs`: `CommandList::is_backdrop_independent()` — рекурсивная
  проверка «в дереве нет блендов кроме `Normal`/`Layer`»; всё остальное (`Draw*`, маски,
  `RenderAlphaMask`) считается независимым от фона.
- `render/src/commands.rs`: `CommandList::append(other)` — перенос команд с учётом
  `maskers_in_progress` (вложенные маскеры по-прежнему подавляются, как при обычной
  записи через `CommandHandler`).
- `core/src/display_object.rs::render_base`: если группа `Layer` и
  `sub_commands.is_backdrop_independent()`, вместо `commands.blend(...)` делается
  `commands.append(sub_commands)`. Все прочие бленды идут старым путём.
- Предохранитель: `ruffle_core::set_inline_layer_blends(bool)` (глобальный `AtomicBool`),
  выведен в web-опцию `layerBlendInlining` (по умолчанию `true`); клиент подставляет
  её из env сервера `SHARARAM_LAYER_INLINE=0` (`src-tauri/src/http_server.rs`).

### Почему вывод не меняется

Два факта об апстриме, на которые опирается доказательство:

1. Color transform Layer-группы Ruffle уже применяет **к детям** (через
   `transform_stack`), а не к готовому буферу.
2. Буфер группы композитится на родителя с единичной матрицей, без color transform,
   обычным `Normal`-блендом (Porter–Duff «over», премультиплицированные цвета).

Тогда изолированный рендер группы — это `((… (∅ over C₁) over C₂) …) over Backdrop`, где
`Cᵢ` — дети в уже трансформированных цветах, а inline — `(… (Backdrop over C₁) over C₂ …)`.
«Over» ассоциативен, поэтому оба выражения равны попиксельно. Равенство нарушает только
операция, читающая **локальный** фон группы (Multiply/Add/Screen/Alpha/Erase/шейдерный
бленд внутри дерева) — такие деревья `is_backdrop_independent` отвергает. Альфа-маски
(`RenderAlphaMask`) изолируют своё содержимое сами и на проверку не влияют.

Оговорка: для полупрозрачных Layer-групп апстримный Ruffle и так отличается от Flash
Player (Flash применяет alpha к сплющенной группе, Ruffle — к каждому ребёнку). Мы этого
не трогаем: инлайн эквивалентен именно апстримному Ruffle, не Flash.

### Проверка и эффект

Юнит-тесты `backdrop_independence_follows_nested_blends`,
`append_respects_nested_masker_suppression` (`render/src/commands.rs`); image-тесты
`blend`/`mask`. Измерение 29.08: та же людная локация 9.2 → 28.7 fps, вывод попиксельно
тот же. На сайте с 29.08 (клиент [`6cec9bc`](https://github.com/sadfun/shararam-ruffle/commit/6cec9bc)).

---

## 2. Offscreen-цель бленда размером с объект — [`4174e3a3c`](https://github.com/sadfun/ruffle/commit/4174e3a3c)

### Как это работает в апстриме

Для блендов, которые действительно читают фон, схема та же — «весь кадр»: дочерняя
`Surface` размером с цель, `update_blend_buffer` копирует **весь** родительский буфер
(`copy_texture_to_texture` полной текстуры), шейдер бленда бежит полноэкранным квадом.
`Command::Blend` не несёт никакой геометрии — в отличие от фильтров, у которых
`render_offscreen(bounds)` в апстриме уже ограничен границами объекта. В домике стол с
самоваром (`baba_yaga_table.swf`: 18 `multiply` на фигурах 6–16 px) и скамейка (7) дают
25 таких полнокадровых копий за кадр.

### Что изменено

- `render/src/commands.rs`: `Command::Blend(CommandList, RenderBlendMode, Option<Rectangle<Twips>>)`;
  трейт `CommandHandler::blend(commands, mode, bounds)`. Ядро
  (`core/src/display_object.rs::render_base`) передаёт
  `render_bounds_with_transform(&transform_stack.matrix, true, &stage.view_matrix())` —
  границы объекта в device-пикселях с учётом фильтров, тот же контракт, который апстрим
  использует для фильтров и `cacheAsBitmap`. `BitmapData.draw` с блендом
  (`core/src/bitmap/operations.rs`) передаёт `None` = весь буфер, как раньше. Бекенды
  WebGL/Canvas параметр игнорируют.
- `render/wgpu/src/surface/commands.rs::blend_region(bounds, whole)`: границы снимаются
  наружу до целых пикселей (`floor`/`ceil`), добиваются до сетки 16 px (чтобы пул текстур
  видел мало разных размеров) и обрезаются целью. Пустое пересечение → группа
  **пропускается целиком**; невалидные bounds → весь кадр (поведение апстрима).
- `render/wgpu/src/surface/target.rs`: у `CommandTarget` появился `origin` (положение
  региона в пикселях цели); `update_blend_buffer(.., region)` копирует из родителя только
  регион в pooled-буфер размером с регион; дочерняя `Surface`, копия фона и квад
  блендера — размером с регион. `add_to_current` вычитает `origin` из `tx/ty` матриц,
  так что команды детей рисуются в локальных координатах региона.
- `render/wgpu/shaders/blend/*.wgsl` (9 шейдеров): UV берётся прямо из позиции квада
  (квад покрывает ровно регион обеих текстур), а не выводится из NDC.
- Альфа-маски (`render_alpha_mask`) и стенсил-маски учитывают `origin`. Шейдерные
  (PixelBender) бленды остаются полнокадровыми.

### Почему вывод не меняется

Инвариант апстрима: всё, что рисует объект, лежит в его `render_bounds` (иначе бы
резались фильтры и `cacheAsBitmap`). Вне региона группа не рисует ничего, а шейдер
любого complex-бленда для пикселя без вклада `src` (`src.a == 0`) делает `discard` —
фон остаётся как есть. Значит, полнокадровый результат вне региона тождественно равен
фону, и его можно не вычислять. Внутри региона выполняются те же операции над теми же
пикселями, только со сдвигом координат на `origin`. Регион, полностью вне цели,
эквивалентен группе, которая ничего не нарисовала.

### Проверка и эффект

Юнит-тест `blend_region_snaps_pads_and_clips` (`render/wgpu/src/surface/commands.rs`);
image-тесты `blend` (32), `mask` (27), `filter` (62), `cache` (34) — без изменений
эталонов. Домик, 25 блендов, 3322×2018: 7.6–8.1 → 17 fps, ожидание GPU (`fence_wait`)
144–155 → 53 мс (профили `20260908-182304` → `20260908-182940`); синтетика (стол в
цикле в WKWebView): 8.8 → 37.6 fps, стойлов GPU 68 → 0.

---

## 3. `MULTIPLY` на непрозрачном кадре через blend state — [`1406709b8`](https://github.com/sadfun/ruffle/commit/1406709b8)

### Как это работает в апстриме

Бленды делятся на `Trivial` (выражаются аппаратным `wgpu::BlendState`: Normal, Add,
Subtract, Screen, …) и `Complex` (нужен снимок фона + шейдер: Multiply, Overlay, Darken,
Alpha, Erase, …). `Multiply` — complex. Каждый complex-бленд = копия фона + отдельный
render pass, а на TBDR (Metal/WKWebView) любой разрыв прохода родителя — это load + store
всего attachment’а (3322×2018×4 ≈ 27 МБ), ~2 мс на бленд; 25 блендов стола съедали
остаток кадра даже после п. 2.

### Что изменено

- `render/wgpu/src/blend.rs`: вариант `TrivialBlend::Multiply` с
  `BlendState { color: src·Dst + dst·(1−src.a) (Add), alpha: OVER }`.
  `BlendType::from(Multiply)` по-прежнему `Complex` — понижение делается в обработчике.
- `render/wgpu/src/surface/commands.rs`: у `WgpuCommandHandler` флаг `opaque` —
  инвариант «каждый пиксель текущей цели имеет alpha = 1». Инициализация:
  `RenderTargetMode::FreshWithColor(c)` с `c.a ≥ 1` (корень кадра: клиент задаёт
  непрозрачный `backgroundColor`, wmode непрозрачный); дочерние поверхности блендов —
  прозрачные, у них `opaque = false`. Флаг гаснет, как только на цель попадает что-то,
  способное сделать alpha < 1: complex-бленды `Alpha`/`Erase`, шейдерный бленд,
  `render_stage3d`. При `opaque` `Complex(Multiply)` заменяется на `Trivial(Multiply)`:
  группа по-прежнему изолируется в свою прозрачную текстуру (семантика группы
  сохранена), но композитится одним draw внутри **текущего** прохода — без копии фона и
  без разрыва прохода.

### Почему вывод не меняется

Апстримный `multiply.wgsl` для премультиплицированных `src` (группа) и `dst` (фон):

    out.rgb = src.rgb·(1−dst.a) + dst.rgb·(1−src.a) + src.a·dst.a·(src.rgb/src.a)·(dst.rgb/dst.a)
    out.a   = src.a + dst.a·(1−src.a)
    src.a == 0 → discard (фон не трогается)

При `dst.a = 1`: первый член обнуляется, третий сворачивается в `src.rgb·dst.rgb`, итого
`out.rgb = src.rgb·dst.rgb + dst.rgb·(1−src.a)` — буквально `src·Dst + dst·(1−src.a)`
из blend state; `out.a = src.a + (1−src.a) = 1` — OVER. Случай `src.a = 0`: шейдер
оставляет `dst`, blend state даёт `dst·1 + 0 = dst`. Различие — только порядок операций
над float (шейдер делит и умножает на `src.a`, blend state — нет).

Условие `dst.a = 1` гарантируется флагом: `Normal/Add/Subtract/Screen` и все complex-
шейдеры пишут alpha как OVER (`1` при `dst.a = 1`), маски пишут с
`ColorWrites::empty()`, `Multiply` сам — OVER; всё, что не удовлетворяет этому (`Alpha`,
`Erase`, шейдерные бленды, Stage3D), сбрасывает флаг, и дальше Multiply идёт шейдером.
Ядро дублирует ту же логику счётчиком `blend_multiply_direct` в профилировщике, чтобы
в любом профиле было видно, сколько блендов пошло быстрым путём.

### Проверка и эффект

Image-тесты `blend`/`mask`/`filter`/`cache` (155) — эталоны не менялись. Домик:
17 → 32–41 fps, GPU 53 → 28–31 мс (профиль `20260908-184710`, `blend_multiply_direct` =
`blend_complex` = 25 в каждом кадре — все бленды стола по быстрому пути); оставшиеся
~29 мс `fence_wait` — латентность презентации WKWebView, одинаковая с комнатами без
блендов. Синтетика: 58 fps (потолок rAF).

---

## 4. Кэш распарсенных SWF для повторного `loadMovie` — [`971dd6c0d`](https://github.com/sadfun/ruffle/commit/971dd6c0d)

### Как это работает в апстриме

`MovieLoader::movie_loader_data` (`core/src/loader.rs`) на каждый ответ сети делает
`SwfMovie::from_data` (распаковка zlib/LZMA + заголовок) → новый `Arc<SwfMovie>` →
`MovieClip::replace_with_movie` → чанковый `preload` по тикам, который проходит **все**
теги: `DefineShape*`, `DefineBits*` (декодирование), `DefineFont*`, `DefineSprite`
(рекурсивный preload) регистрируются в `MovieLibrary`. Библиотеки в `Library` ключуются
по указателю `Arc<SwfMovie>` (`PtrWeakKeyHashMap`), поэтому каждый новый `Arc` = новая
пустая библиотека, и вся работа повторяется. В Шарараме каждая часть тела — свой SWF
(`Avatar.LoadAvatar` → `ClipSetLoader.Load` → `movieClipLoader.loadClip(url,
body_holder_mc.<MRId>)`), URL один на всех смешариков в комнате. Сессия 133 с
(`20260908-184710`): 394 загрузки при 198 уникальных URL; preload 3.5 с, из них
2.75 с (79 %) — повторы; риг `fs/ek/4pydl5s0lc.swf` — 12 × ~140 мс, каждый раз стойлом
главного потока.

### Что изменено

- `core/src/library.rs`: `Library.movie_cache: HashMap<String, Arc<SwfMovie>>` (ключ —
  полный URL с query) с `cache_movie(url, movie)` и `preloaded_movie(url)`; у
  `MovieLibrary` флаг `preloaded` (`set_preloaded()`), означающий «все персонажи этого
  фильма зарегистрированы».
- `core/src/display_object/movie_clip.rs::preload`: когда корневой клип фильма
  (`shared.id == 0`) доходит до конца потока (`is_finished`), библиотека помечается
  `preloaded`. Если библиотека фильма уже `preloaded`, `tag_callback` пропускает все
  define-теги (и не считает их байты в лимит тика) и обрабатывает только per-instance
  теги: `ShowFrame`, `FrameLabel`, `DefineSceneAndFrameLabelData`, `DoInitAction`,
  `ExportAssets`, `ImportAssets`/`2`, `SoundStreamHead`/`2`, `ScriptLimits`,
  `DoAbc`/`SymbolClass`, `End`. Повторная загрузка допрелоадивается за один тик.
- `core/src/loader.rs::movie_loader_data`: для AVM1-загрузки по URL (`vm_data` = Avm1,
  не `loadBytes`) — если `preloaded_movie(url)` есть и его `compressed_len()` равен
  размеру пришедших байт, берётся этот `Arc`; иначе создаётся новый и сохраняется в
  кэш как «последняя загрузка этого URL». Общий `Arc` ⇒ общая `MovieLibrary` ⇒ общие
  декодированные битмапы, зарегистрированные шейпы, шрифты.
  Не участвуют: AVM2 `Loader`, `loadBytes`, `ImportAssets`, корневой фильм.

### Почему вывод не меняется

- **Разделение персонажей — штатная семантика Ruffle.** Экземпляры одного `DefineSprite`
  уже делят `MovieClipShared` и один набор персонажей; `register_character` в апстриме
  игнорирует повторную регистрацию существующего id (`Entry::Occupied → false`). Мы
  лишь не тратим время на разбор того, что будет проигнорировано.
- **Per-instance состояние остаётся per-instance.** `MovieClipShared` у каждой загрузки
  свой: метки кадров, границы кадров, `SoundStreamHead`, прогресс preload.
  `DoInitAction` выполняется в preload каждого клипа, как и раньше (класс-инициализация
  на каждую загрузку — поведение апстрима не изменено).
- **`_url` точен.** Ключ — URL, а не контент-хэш: `MovieClip._url` у повторной загрузки
  совпадает с запрошенным (клиент Шарарама читает `_url` в отчётах об ошибках
  `ClipSetLoader`). URL ассетов Шарарама и так содержит контент-хэш и версию; сравнение
  сжатого размера — защита от подмены содержимого под тем же URL внутри сессии.
- **Никакого разделения незавершённого.** Кэш отдаёт фильм только с `preloaded`
  библиотекой. Загрузки, стартовавшие раньше (burst при входе в комнату: N аватаров ⇒ N
  `loadClip` одного рига за пару тиков), идут по старому пути со своей библиотекой —
  частично заполненная библиотека никогда не видна второму экземпляру.
- **Компромисс по памяти.** Фильмы в кэше и их библиотеки живут до конца сессии плеера
  (раньше — до исчезновения последнего экземпляра). Для Шарарама это и есть цель;
  лимит по объёму не вводили (при необходимости — LRU по `compressed_len`).

### Проверка и эффект

142 теста загрузчика Ruffle (фильтры `load`, `mcl_`, `movieclip_lockroot`;
последний грузит один `child.swf` девять раз в два захода — второй заход идёт через
кэш) без изменений эталонов. Следующая сессия (`20260908-195406`): 773 загрузки /
381 URL, 369 попаданий в кэш (94 % повторов), preload на попадании ≈ 0 мс (событие
`load/movie_cache_hit` в профиле); у рига 52 из 59 загрузок из кэша.

---

## Как проверить

```sh
git clone -b shararam/perf https://github.com/sadfun/ruffle && cd ruffle
cargo test -p ruffle_render --lib                                  # п.1: backdrop independence, append
cargo test -p ruffle_render_wgpu --lib blend_region                # п.2: регион бленда
for f in blend mask filter cache load mcl_ movieclip_lockroot; do  # 155 image + 142 loader тестов
  cargo test -p tests --features imgtests --release --test tests -- "$f"
done
```

Всё зелёное на `971dd6c0d`. Два теста `visual/edittext_*` в этом апстримном срезе
падают и на нетронутом дереве — к нашим изменениям не относятся.

Бандл клиента: `cd web && npm run build --workspace=ruffle-core && npm run build
--workspace=ruffle-selfhosted` (release + wasm-opt, без дополнительных cargo-фич).
Профили с цифрами — `profiles/shararam-profile-<дата>.duckdb` в рабочей копии Степана;
методика и инструменты — `PERFORMANCE.md`.

Ветка `shararam/render-opt` — те же четыре коммита плюс инструментирование
профилировщика (cargo-фича `shararam_profiler`); в прод не идёт, используется
профилировочной сборкой клиента (ветка `scout`).
