# Adobe Scout — полный референс по UI и воркфлоу

Референс для воспроизведения профилировщика Adobe Scout (кодовое имя «Project Monocle», 2012–2017) в веб-приложении. Собрано из архивных статей Adobe Developer Connection (авторы: Thibault Imbert, Michael Smith, Andy Hall), release notes, реальных скриншотов Scout CC из репозитория hxScout, расшифрованных FLM-дампов и обсуждений сообщества. Для каждого блока указаны источники. Помечено, где данных нет или они неуверенные.

**Ключевые источники** (все проверены 30.08.2026):
- [GS] «Getting started with Adobe Scout» — https://web.archive.org/web/20130125083143/http://www.adobe.com/devnet/scout/articles/adobe-scout-getting-started.html (живое зеркало: https://airsdk.dev/docs/tools/development/scout/usage)
- [FP] «Understanding Flash Player with Adobe Scout» — https://web.archive.org/web/20130125083148/http://www.adobe.com/devnet/scout/articles/understanding-flashplayer-with-scout.html
- [DATA] «Understanding the data Adobe Scout gathers and uses» (Andy Hall) — https://web.archive.org/web/20130709043552/http://www.adobe.com/devnet/scout/articles/adobe-scout-data.html (авторская версия: https://aphall.com/2013/03/making-sense-of-scout/)
- [MEM] «Memory profiling with Adobe Scout» — https://web.archive.org/web/20130618231144/http://www.adobe.com/devnet/scout/articles/scout-memory-profiling.html
- [ACC] «Accurate profiling with Adobe Scout» — https://web.archive.org/web/20130210055057/http://www.adobe.com/devnet/scout/articles/accurate-profiling-with-scout.html
- [CUSTOM] «Custom telemetry with Adobe Scout» — https://web.archive.org/web/20130318113827/https://www.adobe.com/devnet/scout/articles/adobe-scout-custom-telemetry.html
- [RN] Release notes Scout 1.1.1 — https://web.archive.org/web/20140302155141/http://helpx.adobe.com/scout/release-note/release-notes-scout.html (яп. версия: https://web.archive.org/web/20191208035937/https://helpx.adobe.com/scout/release-note/release-notes-scout2.html)
- [SHOT] Скриншоты реального Adobe Scout CC (Windows) — https://github.com/slavikyad/hxScout/tree/master/flm_exploration (test_sum/scout_screenshot.png, test_perlin/scout_screenshot.png, test_wastealloc/scout_screenshot.png, test_stack/scout_screenshot_sampler.png)
- [FLM] Расшифрованные FLM-дампы — те же каталоги, capture.*.txt; парсеры: https://github.com/gpeacock/telemetry-tools (telemetry.py, amf3reader.py, flmserv.py, add-opt-in.py)
- [HX] hxScout (клон Scout для Haxe, Jeff Ward) — https://hxscout.com/guide.html
- [FAQ] Scout FAQ — https://airsdk.dev/docs/tools/development/scout/faqs
- [WIKI] https://en.wikipedia.org/wiki/Adobe_Scout
- [GH] Обсуждение судьбы Scout (AIR SDK / Harman) — https://github.com/airsdk/Adobe-Runtime-Support/discussions/2001 и трекер https://github.com/airsdk/Adobe-Scout/issues
- [FEN] Блог Andy Hall (инженер Scout) — https://fenomas.com/2013/05/new-features-in-adobe-scout-cc/
- [COMM] Обсуждение утечек памяти — https://community.adobe.com/t5/air-discussions/memory-leaks-tools/m-p/9791925

---

## 0. История и контекст

- Кодовое имя **Project Monocle**; публичные демо с 2012 г. (Lee Brimelow, Adobe MAX). Источник: http://blogs.adobe.com/digitalmedia/tag/project-monocle/, http://www.yeahbutisitflash.com/?p=3950
- **Scout 1.0** — запуск в составе Adobe Game Developer Tools; Википедия датирует релиз январём 2013, Grokipedia — 6 декабря 2012 (расхождение источников). [WIKI], https://grokipedia.com/page/adobe_scout
- **Scout CC 1.1** — 17 июня 2013: Memory Allocation Tracking (трекинг аллокаций), панель Memory Allocations, принудительный GC, поиск (Find bar). [FEN], [MEM], упоминание у Jackson Dunstan (https://www.jacksondunstan.com/articles/2260)
- **Scout CC 1.1.1** — Stage3D-движок обновлён до Flash Player 11.8 «Harrison», поддержка Rectangle Textures, исправление расчёта peak memory, ускорено закрытие сессий (close-all/close-others). [RN]
- Последняя версия — **1.1.3.354121** (8 мая 2017), далее продукт заморожен и снят с раздачи Adobe. [WIKI], [GH] (issue #8 «Scout is no longer available for download on macOS»)
- Написан на C++, x86-64, Windows/macOS; бесплатный для подписчиков Creative Cloud. [WIKI]
- В 2020-х исходники получила команда AIR SDK (Harman), репозиторий трекинга — airsdk/Adobe-Scout; пересобрали под Windows/macOS. [GH]
- Требования к контенту: Flash Player ≥ 11.4 / AIR ≥ 3.4 (телеметрия появилась именно там). [GS]
- Профилирует **release**-плеер и release-SWF на полной скорости — главное отличие от профайлера Flash Builder. [GS], [ACC]

---

## 1. Общая архитектура окна

Источник: [SHOT] (прямое наблюдение по скриншотам), [GS].

Тёмная тема (фон панелей ≈ #424142, фон графиков ≈ #292c29, текст ≈ #cecbce). Заголовок окна: `<путь к .flm или имя SWF> - Adobe Scout CC`. Меню: **File, Edit, View, Search, Window, Help**.

Компоновка (по умолчанию):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Menu: File Edit View Search Window Help                                │
├──────────┬─────────────────────────────────────────────────────────────┤
│          │ «  [Session Summary — узкая полоса мини-графиков]           │
│ Sidebar  ├───────────────────────────────┬─────────────────────────────┤
│          │ Frame Timeline                │ Summary | Session Info |    │
│ Settings │  [Frame Time|Memory|Events]   │ Trace Log   (табы)          │
│ for New  │  ruler 0:00…0:01…0:02         │                             │
│ Sessions │  Frame Time chart (red line)  │  Framerate 27.2 fps         │
│  +       │  Memory chart                 │  Target 60.0 fps ...        │
│ список   │  Events tracks (6 дорожек)    │                             │
│ сессий   ├───────────────────────────────┼─────────────────────────────┤
│          │ ActionScript | Memory         │ Top Activities | Activity   │
│          │ Allocations | DisplayList     │ Sequence   (табы)           │
│          │ Rendering | Stage3D Rendering │                             │
└──────────┴───────────────────────────────┴─────────────────────────────┘
```

- **Session Summary** — полоса сверху над Frame Timeline, во всю ширину; сворачивается кнопкой «‹»/««» слева. [SHOT], [GS]
- **Сайдбар слева**: секция «Settings for New Sessions» (шестерёнка) + информационная плашка о подключении рантайма + список открытых сессий внизу. Сворачивается кнопкой collapse. [GS], [SHOT]
- **Центр**: Frame Timeline (верх) и блок таб-панелей ActionScript / Memory Allocations / DisplayList Rendering / Stage3D Rendering (низ).
- **Справа**: сверху табы Summary / Session Info / Trace Log; снизу табы Top Activities / Activity Sequence.
- Все панели — **dockable-табы**: перетаскиваются за корешок в любое место; закрытая панель открывается заново из меню **Window**. Раскладка панелей называется **workspace**, workspaces можно сохранять и переключать через меню Window (в т.ч. Window > Sidebar). [GS], [FP]
- Каждая группа табов имеет справа кнопку-гамбургер меню панели (▼≡). Табы закрываются крестиком на корешке. [SHOT]
- **Stage3D Program Editor** — отдельная панель, открывается из меню Window. [GS]

### Сессии и live-запись
- Каждый запущенный SWF (и каждый ActionScript worker) = отдельная сессия; сессии появляются автоматически при запуске контента, пока Scout слушает порт. [GS], [FP]
- В списке сессий: имя SWF и его домен; у активной сессии — квадратная **красная кнопка Stop** (останавливает приём данных; сама деактивируется, когда контент закрыт) и **иконка-фильтр** (воронка): после клика новые сессии создаются только для SWF с тем же именем. Крестик слева закрывает сессию. [GS], [SHOT]
- Правый клик по сессии — контекстное меню: Close, Save, Close All, Close Others (по [RN]).
- Сессию можно сохранить как **.flm** файл и открыть позже/переслать коллеге; открытый FLM Scout «проигрывает заново в ускоренном режиме» (это тот же бинарный поток, что слал плеер). [GS], [ACC]
- Live-сессия выглядит идентично открытому FLM: графики растут вправо в реальном времени; выделение и анализ доступны прямо во время записи. Кнопка принудительного GC работает только в live-сессии. [MEM]
- Ограничение: сессия(и) свыше ~2 ГБ RAM «ломают» Scout. [GH]

---

## 2. Панели в деталях

### 2.1 Session Summary (полоса обзора сессии)
Источник: [GS], [SHOT].
- Уменьшенная копия Frame Timeline на всю длину сессии: «lets you see at a glance where the spikes in activity are, across the whole session».
- Клик по любому месту полосы — переход (прокрутка Frame Timeline) к этому времени.
- По умолчанию показан один мини-график Frame Time; **правый клик** открывает выбор дополнительных дорожек: **Frame Time, CPU Load, Memory, Events**. Особо полезно для поиска медленных утечек памяти на длинной сессии.
- На скриншотах: серый мини-график времени кадра с красной линией бюджета + синяя полоска событий/кадров под ним.

### 2.2 Frame Timeline
Источник: [GS], [FP], [SHOT].
- Главная панель. Сверху — кнопки-переключатели видимых графиков: **Frame Time**, **Memory**, **Events** (+ **CPU Usage**, если включён сбор; на скриншотах с capture без CPU кнопка отсутствует — набор кнопок зависит от собранных данных; точный порядок кнопок при всех включённых данных: не найдено, на скриншотах порядок «Frame Time | Memory | Events»).
- **Линейка времени** сверху: формат `0:00`, `0:01`, `0:02` (м:сс); на ней же — маркеры-скобки границ выделения (две «ручки-грипы») и белый playhead.
- **График Frame Time** (подпись «Frame Time» плавает в левом верхнем углу графика):
  - одна колонка = один кадр SWF;
  - **серые ступени/бары** — полное время кадра (active + inactive) [FP: «the total time … is indicated by the grey bars»];
  - **цветные бары** (у нижней кромки) — активное время, раскрашенное по категориям (см. §4 цвета);
  - **красная горизонтальная линия** — бюджет кадра: `1000 мс / fps` (30 fps → 33 мс; 60 fps → 16.7 мс, в Summary показывается как 17). Линия **меняет высоту по ходу сессии**, если SWF динамически менял framerate. Бар, пересекающий линию, = кадр вне бюджета;
  - при наведении — **тултип** с описанием сегмента;
  - нормальное состояние — серые бары «колышутся вокруг красной линии» (плеер всегда ждёт следующего тика); при fps, не делящем 60 (например 24), бары осциллируют вокруг линии — это норма.
- **График Memory**: стековые бары по категориям памяти (бирюзовая гамма), значение = снапшот на конец кадра. Классическая «пила» managed-памяти: рост → GC → резкий спад; Total memory при этом не падает. [MEM]
- **График CPU Usage**: процент CPU от ОС; может быть > 100 % на многоядерных машинах. [GS]
- **Дорожки Events** (появляются под Memory по кнопке Events): 6 горизонтальных треков, каждый с иконкой слева; интенсивность/высота синих штрихов = количество событий в кадре:
  1. **Mouse** (иконка курсора-стрелки) — были ли mouse-события;
  2. **Keyboard** (иконка клавиши «K») — keyboard-события;
  3. **Network** (иконка глобуса) — сетевой I/O;
  4. **Timer** (иконка секундомера) — использование класса Timer;
  5. **Rendering** (иконка ведёрка с краской) — был ли рендеринг;
  6. **Trace Events** (иконка «abc») — вызовы trace().
- Слева от каждого графика — **вертикальный слайдер** (вертикальный масштаб графика). Снизу — **горизонтальный скроллбар** навигации по сессии (упомянут в [RN] как «navigation scroll-bar in the Timeline panel»).
- Горизонтальный зум: явного описания зума колесом/жестами в документации **не найдено**; навигация описана через Session Summary (клик) и скроллбар. hxScout для аналога использует drag-выделение + отдельную полосу навигации.

### 2.3 Summary
Источник: [GS], [ACC], [MEM], [SHOT] — скриншот читается дословно.
- Шапка: слева крупно **framerate выделенного диапазона** («27.2 fps»), под ним «Target 60.0 fps»; справа — «Frames 1 – 5» (или «Frame 11» для одного кадра) и «Time 0:00 – 0:00.183». При превышении бюджета в тексте — «= 117 % of budget 83» (проценты могут быть огромными, например 1791 %; в [GS] упоминается формулировка «248 % over budget»).
- Внутри панели — **суб-табы «Frame Time | Memory»** (переключают, какой раздел показан; на широкой панели видны оба блока последовательно).
- **Раздел Frame Time** (все числа — мс, без явной подписи единиц в строках; в шапке «184 ms»):
  - `Total Frame Time  184 ms  [⚙]` — шестерёнка переключает **total за выделение / average на кадр**;
  - `Active  97  = 117 % of budget 83`;
  - строки категорий с цветным чипом слева, именем, числом и горизонтальным баром справа:
    - **ActionScript** (синий, раскрывается ▶ — при включённом Sampler внутри пакеты AS3-кода, время с пометкой «≈», т.к. сэмплировано [ACC]);
    - **DisplayList Rendering** (зелёный, раскрывается);
    - **Network and Video** (жёлтый);
    - **Other** (оранжевый, раскрывается — GC, обработка событий, парсинг SWF и пр.);
  - `▶ Inactive  86` — серым; раскрывается в: **Waiting for next frame**, **Waiting for GPU**, **Waiting for condition** [FP].
  - Числа в строках — **self time** активностей, сгруппированных по категориям. [DATA]
- **Раздел Memory** (единицы KB с разделителем тысяч):
  - `Current Total Memory  8,645 KB  [⚙]` — шестерёнка: **Current / Average / Peak** по выделению. Average — средневзвешенное по времени; Peak — максимум по каждой категории отдельно (сумма пиков может превышать пик общего) [MEM];
  - `Used Memory  8,050`;
  - категории (чип + имя + число + бар): **ActionScript Objects** (тёмно-бирюзовый), **Bitmap** (светло-бирюзовый, раскрывается ▶), **ByteArrays**, **SWF Files**, **Other** (полный состав — §6).
- **Раздел GPU Memory** — для Stage3D-контента: число draw calls на сцену и разбивка resource memory (обычно доминируют текстуры). Собирается всегда (в составе Basic Telemetry). [GS]
- **Механика фильтра-легенды**: клик по категории — остальные сереют, и **вся раскраска во всём Scout фильтруется** (Frame Timeline рисует только выбранную категорию, Activity Sequence/Top Activities серят чужие активности, ActionScript-панель фильтруется по пакету). Повторный клик снимает. Раскрытие категории добавляет в графики новые цвета подкатегорий («Figure 17. Expanding Bitmap memory…»). [GS]
- При ошибках данных панель показывает баннер: «We encountered an error while processing this session: Some of the data we present may not be correct.» [RN]

### 2.4 Top Activities
Источник: [GS], [DATA], [SHOT].
- Агрегат по **выделенному диапазону кадров**: одинаковые активности группируются **по имени**, вложенность и порядок игнорируются; показывается счётчик повторов за диапазон. [DATA]
- Шапка панели: слева иконка-фильтр (воронка), справа надпись «Active Time 97 ms». Над таблицей — жёлтая полоска-подсказка (закрывается ×): «Tip: clicking below on a single activity will filter the ActionScript panel.»
- Колонки (по скриншоту): **Function** | **Self Time (ms)** ▾ — притом в колонке Self Time два значения: мс и % (например «32   32 %»). (Да, первая колонка в реальном UI называется именно «Function», хотя содержит активности.) Сортировка по клику на заголовок, стрелка ▾.
- Текст строк окрашен цветом категории: синие «Event "enterFrame"», «Running AS2», «Initializing AS globals», «Running AS3 attached to frame»; оранжевые «AIR startup», «Runtime overhead», «Garbage collection», «Preparing ActionScript Bytecode»; зелёные «Creating Display Buffer»; жёлтые «Loading file». [SHOT]
- Клик по активности — **фильтрует ActionScript-панель** кодом, работавшим внутри этой активности (включая GC: видно, какие функции спровоцировали сборку). Также фильтрует Memory Allocations (deallocations конкретного GC). [GS], [MEM]
- Фильтр «**Hide small items**» (кнопка в тулбаре): по умолчанию скрыты активности с total time < 0.5 мс. [DATA], [GS]

### 2.5 Activity Sequence
Источник: [GS], [DATA], [CUSTOM], [SHOT].
- Показывает **один кадр** (при выделении диапазона — недоступна/пуста: «otherwise, there would be too much data to display»). Точный порядок и **вложенность** активностей (дерево с ▶/▼).
- Колонки: **Function** | **Total Time (ms)** ▾ (мс + %); есть скрытые колонки — **Self Time (ms)** и **Start Time** (start time выключена по умолчанию; правый клик по заголовкам колонок — выбор видимых). [DATA], [CUSTOM]
- Вложенность выводится из времени: B — ребёнок A, если началась позже и закончилась раньше. [DATA]
- Тот же фильтр «hide small items» (< 0.5 мс) и цветовая схема, что и в Summary; фильтрация категорий из Summary серит чужие строки.
- В последовательность вклиниваются **trace-строки** (оранжевые, «Trace: <текст>») и **кастомные метрики** (sendMetric — «Имя: значение»). [CUSTOM], [SHOT]
- Пример дерева со скриншота: `▼ Handling event "timer" 298 99 %` → `Event "timer" 298 99 %`; далее «Running AS3 attached to frame < 1 0 %», «Garbage collection < 1 0 %», «Runtime overhead < 1 0 %», «Handling LocalConnection traffic < 1 0 %». Значения меньше миллисекунды показываются как «< 1».
- Клик по активности — фильтр ActionScript-панели (как в Top Activities).

### 2.6 ActionScript (профилировка кода)
Источник: [GS], [ACC], [DATA], [SHOT].
- Работает от **ActionScript Sampler** (статистическое сэмплирование стека ~каждую 1 мс). Без включённого сэмплера панель показывает подсказку: «To use this panel: Enable the "ActionScript Sampler" setting.» [SHOT]
- Тулбар: слева дропдаун **Top-Down ▾ / Bottom-Up**, рядом кнопка **Expand All**; справа: «Sampled Time:  ActionScript 3  295 ms   Total  295 ms   Data Quality [☺/☹]». Красная грустная рожица = мало сэмплов, «select more frames»; зелёная/жёлтая счастливая = данных достаточно. [ACC], [SHOT]
- Колонки Top-Down: **Function** | **Self Time (ms)** (мс + %) | **Total Time (ms)** ▾ (мс + %).
- Колонки Bottom-Up: **Function** | **Self Time (ms)** | **Contribution (ms)** ▾ — раскрытие строки даёт обратный стек (кто вызывал) и вклад каждого вызова в self time родителя. [SHOT], [GS]
- Alt-клик по треугольнику — полное раскрытие поддерева. [GS]
- Имена функций с указанием пакета в скобках: `BitmapData.perlinNoise (flash.display)`, `Function.apply (http://adobe.com/AS3/2006/builtin)`, `Main.do_perlin`. [SHOT]
- Цветовая кодировка функций включается **раскрытием категории ActionScript в Summary**: тёмно-синий = нативные функции плеера, светло-синий = пользовательский AS3, бирюзово-зелёный = Stage3D API. [GS] (точные hex — не найдено)
- Данные агрегируются по выделенным кадрам; фильтруются кликами из Top Activities / Activity Sequence (только код внутри активности/обработчика) и фильтром пакета из Summary. [GS]
- Времена приблизительные (целые мс — гранулярность сэмплера); измеренные суммы могут расходиться с инструментированными (пример из [CUSTOM]: 80/40 мс в Top Activities против 71/35 мс здесь).
- При включённом Stage3D Recording панель показывает предупреждение о недостоверности таймингов. [ACC]

### 2.7 Memory Allocations (Scout 1.1+)
Источник: [MEM], [FEN].
- Требует настройку **Memory Allocation Tracking** (+ advanced telemetry; в браузере — debugger-версия плеера, для AIR не нужно).
- Виды (дропдаун): **Top-Down** (стеки аллокаций — где выделялись объекты; раскрытие показывает классы и количество), **Bottom-Up Objects** (суммарно по классам; раскрытие — кто аллоцировал), **Bottom-Up Functions** (функции по числу прямых аллокаций).
- Переключатель **Allocations / Deallocations** — вторая показывает освобождённые за выделенные кадры объекты (фильтруется кликом по конкретному «Garbage collection» в Activity Sequence/Top Activities — видно, что именно собрал конкретный GC).
- Фильтр **Hide Garbage-Collected Objects** (вкл. по умолчанию): показывать только объекты, живые на конец последнего выделенного кадра.
- Показываются только объекты, **аллоцированные в выделенных кадрах** (для полной картины живых объектов кадра N надо выделить кадры 1..N).
- Кнопка в левом верхнем углу панели — **принудительный полный GC** в live-сессии.
- Объекты окрашены по **категориям памяти** из Summary (не по категориям кода): например, крупные Bitmap DisplayObjects — бирюзовым; аллокации не только из AS (например «Preparing ActionScript Bytecode caused 20 allocations», «texture upload», «decompressing images»).
- Известные ограничения: статически инициализированные массивы AOT/iOS не видны; подклассы BitmapData красятся как ActionScript Objects; initial SWF и Main Screen Buffer иногда не показываются; сумма AS-объектов здесь меньше, чем в Summary (внутренние managed-аллокации плеера не трекаются).

### 2.8 Trace Log
Источник: [GS], [CUSTOM], [SHOT].
- Весь вывод `trace()` за выделенные кадры; светло-серое поле с моноширинным текстом.
- Тулбар: иконка-секундомер — **переключение таймстампов** on/off; иконка обновления. [SHOT] (вторая иконка — предположительно refresh/автопрокрутка, точно не найдено)
- Обновляется динамически при перетаскивании выделения в таймлайне («click in the timeline and drag left or right»). [CUSTOM]
- Выделив trace-строки, можно **сузить выделение кадров** до соответствующего диапазона. [airsdk.dev/usage]
- trace-вызовы отображаются также: в дорожке Trace Events таймлайна и в Activity Sequence (оранжевым, с длительностью, если > 0.5 мс: «Trace: set of 10x perlin_2 took 276 ms»). [SHOT]
- Критика: в live-сессии каждая новая строка прокручивала лог к началу — «basically useless» для realtime-мониторинга. [GH]

### 2.9 Session Info
Источник: [GS], [FLM] (поля соответствуют метаданным потока).
- Секции: **SWF** (имя/URL, размер, ширина/высота, частота кадров, версия SWF/VM, debug-флаг), **Flash runtime** (тип: Flash Player/AIR, версия плеера, версия AIR, debugger или нет), **ОС и железо** (ОС, архитектура, разрешение экрана, язык, число ядер CPU), **какие типы телеметрии собирались** в этой сессии.
- Точные подписи полей UI — не найдено (панель известна по описанию и по составу метрик .swf.*, .player.*, .platform.* в FLM).

### 2.10 DisplayList Rendering
Источник: [GS], [ACC], [FP].
- Требует настройку **DisplayList Rendering Details**; данные видны при выделении **одного кадра**.
- Слева — список **rendering passes** кадра с длительностями (пассов может быть больше одного на кадр — признак лишних updateAfterEvent(); пасс может пересекать границу кадров).
- Справа — **дерево операций** пасса с временами каждого шага (Calculating dirty regions → Rendering dirty region → Building edges from DisplayObject → Rasterizing edges → Applying filter: <имя> → Copying to screen; у записей — точки-индикаторы «регион был перерисован»).
- Центр — визуальная карта экрана, два режима:
  - **Heat Map** (по умолчанию): чем ярче область, тем дольше она рендерилась; клик по области подсвечивает её в дереве;
  - **Regions**: 4 категории, цветные, с **чекбоксами-переключателями наверху панели**:
    - **Regions (красный)** — dirty-прямоугольники (до трёх на пасс), требующие перерисовки;
    - **Updated Surfaces (синий)** — обновлённые в этом пассе внутренние поверхности (фильтры, blend modes, кэши, битмапы);
    - **Cached Surfaces (жёлтый)** — кэшированные поверхности, перерисованные в этом пассе (cacheAsBitmap);
    - **Display Objects (зелёный)** — отрендеренный векторный контент.
  - активности в дереве справа окрашены той же схемой; клик по области экрана выделяет соответствующую активность.
- Примечание: в [FP] «cached surfaces» в панели названы оранжевыми, в [GS] в Regions-режиме — жёлтыми; вероятно, речь о смежных оттенках (расхождение источников).

### 2.11 Stage3D Rendering
Источник: [GS], [ACC], [FAQ].
- Требует **Stage3D Recording** (запись всех вызовов Context3D с аргументами: буферы, текстуры, AGAL-программы). Внутри Scout встроена собственная копия Stage3D-движка — воспроизведение локальное, плеер не шлёт битмапы.
- Справа — список **всех Stage3D-команд выбранного кадра** в компактном формате (аргументы в порядке передачи; правый клик → **Show Argument Names**).
- Клик по draw call (`Context3D.drawTriangles`) — слева отображается **состояние back buffer сразу после этого вызова**. **Space** — следующий draw call, **Backspace** — предыдущий (покадровое «строительство» сцены).
- При render-to-texture автоматически показывается текущий **render target** вместо back buffer.
- **Wireframe mode** (кнопка в тулбаре панели) — только рёбра треугольников, видно «за» объекты.
- Модифицированные (через Program Editor) draw calls подсвечиваются **фиолетовым**.
- Режим записи **Immediate / Delayed** (дропдаун в настройках): Delayed не грузит данные в память Scout, пока не нажата кнопка **start recording** в самой панели (иначе гигабайты за минуты).
- GPU-времени Scout не показывает (не умеет мерить GPU) — только «Waiting for GPU» на CPU-стороне. [FAQ]

### 2.12 Stage3D Program Editor
Источник: [GS].
- Отдельная панель (Window menu). Для выбранного draw call показывает **AGAL-код vertex и fragment программ**.
- Редактирование кода + кнопка **Upload** — Scout перерисовывает сцену с изменённой программой; кнопка **Reset** — откат. Изменённые вызовы в списке команд становятся фиолетовыми.

### 2.13 Сайдбар: Settings for New Sessions
Источник: [SHOT] (дословные подписи), [GS], [ACC].
Чекбоксы с описаниями и оценкой оверхеда (нельзя менять для уже идущей сессии):
1. **Basic Telemetry** (чекбокс неактивен — всегда включена) — «Provides a high-level breakdown of time and memory using lightweight instrumentation of the entire Flash Runtime. Overhead: negligible»
2. **CPU Usage** — «Provides a graph of average CPU usage for each frame. Overhead: low»
3. **ActionScript Sampler** — «Provides an estimate of time spent across functions by sampling the call stack every 1 ms. Overhead: low»
4. **Memory Allocation Tracking** — «Provides a detailed breakdown of ActionScript memory usage, by recording memory allocations. Overhead: high»
5. **DisplayList Rendering Details** — «Provides a visual map of DisplayObjects rendered, including caching behavior. Overhead: medium»
6. **Stage3D Recording** — «Provides detailed 3D analysis, including command-by-command replay, by recording all Stage3D activity. Overhead: high. Recording: [immediate ▾]»

Ниже — плашка статуса: «The Flash Runtime on this computer is not connected to Scout.» со ссылкой **Preferences** (оранжевая). Всё, кроме Basic Telemetry, требует advanced telemetry в SWF.

### 2.14 Find bar (поиск, Scout 1.1+)
Источник: airsdk.dev/usage, [FEN].
- Ищет по мере набора во **всех открытых панелях**: имена AS-функций, активности, trace-строки, имена display objects, Stage3D-команды.
- Кнопки `<` `>` — предыдущий/следующий результат в текущем выделении; `<<` `>>` — поиск **за пределами выделения**, с переходом на кадр, содержащий совпадение.
- Текущий результат выделяется крупным шрифтом; нужные панели авто-открываются и прокручиваются.

---

## 3. Модель выделения (ключевая механика)

Источник: [GS], [MEM], [CUSTOM], [SHOT].

1. **Выделение диапазона**: click-drag по любому графику Frame Timeline. Границы показываются скобками-ручками на линейке; выделенные кадры подсвечены (выбранный кадр — более светлый/яркий бар, вокруг playhead — белые вертикальные линии через все графики). Клик = выделение одного кадра.
2. **Все панели подчинены выделению**:
   - Summary — средние/суммарные значения и fps по диапазону («Frames 1 – 5», «Time 0:00 – 0:00.183»);
   - Top Activities — агрегат по диапазону;
   - Activity Sequence — только при **одном** выделенном кадре;
   - ActionScript — сэмплы из диапазона (чем шире, тем точнее, следить за рожицей Data Quality);
   - Memory Allocations — аллокации, случившиеся в диапазоне;
   - Trace Log — trace() из диапазона, обновляется на лету при перетаскивании;
   - DisplayList Rendering и Stage3D Rendering — один кадр.
3. **Навигация**: клик по Session Summary — прыжок в место сессии; горизонтальный скроллбар внизу таймлайна; вертикальные слайдеры — масштаб графиков по Y.
4. **Каскадные фильтры поверх выделения**: категория в Summary → серит всё чужое во всех панелях; активность в Top Activities/Activity Sequence → фильтрует ActionScript и Memory Allocations; trace-строки → сужают выделение.
5. Горячие клавиши таймлайна (стрелки для сдвига выделения и т.п.) — **не найдено** в документации; подтверждены только Space/Backspace (Stage3D), Alt-click (разворот дерева).

---

## 4. Категории времени кадра и цвета

Источник: [GS] (названия), [SHOT] (пиксельные значения; скриншоты сняты в Windows-VM, возможно лёгкое цветовое квантование — значения считать приближением ±1-2 тона).

| Категория | Цвет | HEX (по скриншоту) | Состав [FP] |
|---|---|---|---|
| ActionScript | синий | **#1096d6** | выполнение AS3-кода и время внутри AS API |
| DisplayList Rendering | зелёный | **#84aa63** | операции с display list: dirty regions, растеризация, копирование на экран (без Stage3D) |
| Network and Video | жёлтый | **#deb66b** | загрузка по сети, стриминг и декодирование видео |
| Other | оранжевый | **#de795a** | всё остальное: GC, обработка событий, парсинг SWF… |
| Inactive | серый (текст #8a8a8a-п., бары фона) | — | Waiting for next frame / Waiting for GPU / Waiting for condition |

Прочие цвета UI (по скриншотам):
- красная линия бюджета: **#de0c08**;
- выделенный кадр-бар: **#219ede**, playhead: **#ffffff**;
- память ActionScript Objects: **#108a94**, Bitmap: **#4aa6ad** (остальные подкатегории — соседние бирюзово-зелёные тона, точно не найдено);
- ByteArrays / SWF Files чипы — зеленоватые (#84b?; точно не найдено);
- фон графиков: **#292c29**, чередование строк/фон панелей: **#393c39 / #424142**, hover-строка #4a494a, светлый текст **#cecbce**, оранжевый акцент ссылок/подсказок (#e8a33d-п.);
- поле Trace Log — светло-серое (#c8c8c8-п.), текст тёмный моноширинный;
- кастомные span-метрики — «ярко-зелёный» во всех панелях [CUSTOM] (hex не найден);
- ActionScript-панель: нативные функции — тёмно-синий, пользовательский AS — светло-синий, Stage3D — бирюзовый [GS] (hex не найдено; на скриншотах без включённой раскраски все строки #1096d6);
- DisplayList Regions: Regions красный, Updated Surfaces синий, Cached Surfaces жёлтый, Display Objects зелёный [GS];
- модифицированные draw calls: фиолетовый [GS].

---

## 5. Модель данных телеметрии

### 5.1 Транспорт и формат
Источник: [ACC], [FAQ], [FLM], [GS].
- Плеер при загрузке каждого SWF пытается открыть **TCP-соединение на порт 7934** (меняется в Preferences > «Listen For New Session On Port» + в .telemetry.cfg). Не удалось — телеметрия отключается без оверхеда.
- Данные — поток **AMF3-объектов** (сжатый бинарный формат); **.flm-файл = сырой записанный поток** (сохранение сессии пишет именно то, что прислал плеер; открытие = быстрое «проигрывание»). Скауту можно «скормить» flm даже через `nc localhost 7934 < capture.flm` [HX/flm_exploration].
- Конфиг на стороне плеера — файл **`.telemetry.cfg`** в домашней директории (macOS `~/.telemetry.cfg`, Windows `%HOMEDRIVE%%HOMEPATH%\.telemetry.cfg`; для Chrome/Pepper — специальные пути внутри профиля Chrome [FAQ]). Scout сам переписывает его при изменении настроек. Ключи [GS], [HX]:
  ```
  TelemetryAddress = 192.168.1.20:7934
  SamplerEnabled = true|false
  CPUCapture = true|false
  ScriptObjectAllocationTraces = true|false   # Memory Allocation Tracking
  DisplayObjectCapture = true|false
  Stage3DCapture = true|false
  ```
- На мобильных (AIR) конфигурацию передаёт **Scout Companion app** (iOS/Android/Kindle) по Wi-Fi, без .telemetry.cfg; либо telemetry.cfg кладётся в пакет приложения. [GS], [RN]
- Аварийные FLM: macOS `/var/folders/…/Adobe Performance Data`, Windows `%TEMP%\Adobe Performance Data`; логи Scout: `~/Library/Preferences/Adobe/Scout/1.0/logs` / `%APPDATA%\Adobe\Scout\1.0\logs`. [GS]

### 5.2 Активности (основная единица)
Источник: [DATA].
- **Activity** = блок времени с именем; у каждой — имя, время конца и **длительность (span)** (плеер шлёт end+duration, а не start+end). Некоторые несут доп. параметры (value).
- Вложенность **выводится из таймингов**; активности обязаны закрываться в обратном порядке открытия, иначе Scout выдаёт ошибку/не показывает данные.
- **Total time** = конец − начало; **Self time** = total − сумма total непосредственных детей.
- Плеер репортит только активности длительностью **> 5 микросекунд** [ACC]; Scout показывает **elapsed time, а не CPU time** [FP].
- Кадры делимитируются служебными метриками `.enter` / `.exit` (тик кадра), `.swf.frame` — маркер кадра SWF. [FLM]

### 5.3 Имена метрик в потоке (из реальных FLM-дампов [FLM])
Метаданные сессии: `.tlm.version` («3,2»), `.tlm.meta`, `.tlm.date`, `.player.version`, `.player.airversion`, `.player.type` («Air»/«Flash»?), `.player.debugger`, `.player.global.date`, `.player.instance`, `.player.scriptplayerversion`, `.platform.capabilities` (строка вида `&M=Adobe Windows&R=2560x1440&OS=Windows XP 64&ARCH=x86&L=en…`), `.platform.cpucount`.

Категории/настройки: `.tlm.category.disable` / `.tlm.category.start` (значения: «3D», «sampler», «displayobjects», «alloctraces», «allalloctraces», «customMetrics»), `.tlm.detailedMetrics.start`, `.tlm.commandtime`, `.tlm.doplay`, `.tlm.active` / `.tlm.inactive`.

SWF: `.swf.name`, `.swf.size`, `.swf.rate` (частота кадров), `.swf.width`, `.swf.height`, `.swf.vm`, `.swf.playerversion`, `.swf.debug`, `.swf.start`, `.swf.parse` (span), `.swf.frame`, `.swf.globalobject`.

Кадры/плеер: `.enter`, `.exit` (span), `.player.enterframe`, `.player.timer`, `.player.view.resize` (value: прямоугольник), `.player.abcdecode` (→ «Preparing ActionScript Bytecode»), `.starttimer`.

ActionScript: `.as.doactions`, `.as.actions`, `.as.event` (value: имя события — «status», «complete»…), `.as.runentrypoint`; в старом протоколе также `.prof.enter.name/.prof.enter.time/.prof.exit.time` (пары для span) [telemetry-tools].

GC: `.gc.Reap`, `.gc.Mark`, `.gc.Sweep`, `.gc.CollectionWork` (span+delta).

Рендер: `.rend.screen`, `.rend.update`, `.rend.paintbits`, `.rend.calc`, `.rend.display.create`, `.rend.display.mode`.

Сеть: `.network.loadmovie` (value: URL SWF), `.network.loadfile`, `.network.loader.receive`, `.network.loader.close`, `.network.swf.received`, `.network.localconnection.idle`.

Память (значения в KB, периодические снапшоты): `.mem.total`, `.mem.used`, `.mem.managed`, `.mem.managed.used`, `.mem.bitmap`, `.mem.bitmap.display`, `.mem.bitmap.data`, `.mem.bytearray`, `.mem.script`, `.mem.telemetry.overhead`.

Сэмплер: `.sampler.sample` (value: `{time, numticks, ticktimes[], callstack[<id>…]}`), `.sampler.methodNameMap` (таблица id→имя метода), `.sampler.starttime, .sampler.averageInterval, .sampler.medianInterval, .sampler.maxInterval`.

Прочее: `.trace` (value: текст), `.capabilities`.

Пользовательские метрики: любые имена **без ведущей точки** (имена с «.» зарезервированы за плеером); рекомендована reverse-DNS нотация («com.example.MyMetric»). [CUSTOM]

Категоризация по префиксу (упрощённая логика telemetry-tools): `as→ActionScript, rend→Rendering, network→Network, mem→Memory, tlm→Telemetry, прочее→Player`. Точная таблица соответствия «имя активности → категория Summary» в Scout зашита внутри и **не опубликована** — восстанавливается по цветам строк в панелях. [DATA]

### 5.4 Basic vs Advanced telemetry
Источник: [GS], [ACC], [MEM].
- **Basic** (всегда): внутренние активности плеера (Frame Timeline, Summary, Top Activities, Activity Sequence), сводка CPU/GPU-памяти, события, trace.
- **Advanced** (opt-in в SWF): ActionScript Sampler (стеки), DisplayList Rendering Details, Stage3D Recording, Memory Allocation Tracking, поддержка workers. Причина opt-in — чтобы чужие не профилировали ваш продакшн-SWF.
- Включение advanced: Flash Builder 4.7 → «Enable Detailed Telemetry» (компиляторный флаг `-advanced-telemetry`); для готовых SWF — скрипт `add-opt-in.py` (пишет тег EnableTelemetry в SWF, опционально с паролем; пароль ASCII-only, вводится в Scout). [GS], [FLM/README], [RN]
- Сторонние утилиты для включения: TelemetryEASY (https://inflagrantedelicto.memoryspiral.com/2012/12/telemetryeasy-advanced-telemetry-utility-for-adobe-scout/), SWF Scout Enabler (http://renaun.com/blog/2012/12/enable-advanced-telemetry-on-flex-or-old-swfs-with-swf-scount-enabler/), настройка FlashDevelop (http://danikgames.com/blog/how-to-get-advanced-telemetry-profiling-with-adobe-scout-and-flashdevelop/).

### 5.5 Полный перечень «известных» активностей UI (для словаря отображения)
Источник: [FP] — дословно.
- События: `Handling event "<name>"` (keyDown, keyPress, keyUp; mouseDown, rightMouseDown, mouseMove, mouseUp, mouseWheel; touch, gesture; resize, mouseLeave, foreground, background, fullScreen, fullScreenInteractiveAccepted, visible), `Event "<name>"` (пользовательский обработчик), `Handling event "timer"`, `Timer started: <interval>`, `Handling event "enterFrame"`, `Handling event "frameLabel"`, `Handling event "exitFrame"`, `Handling event "render"`, `Handling uncaught error`, `AS2 event "enterFrame"`, `Handling event "onLoadInit"`.
- AVM: `Garbage collection`, `Trace: <output>`, `Exception: <class>`, `AVM Bridge callback`, `ExternalInterface callback`, `Running AS2`, `Running Worker code`, `Waiting for Condition`, `MessageChannel.receive`, `MessageChannel.send`, `Mutex.lock`, `Mutex.trylock`.
- Тикер кадра: `Running SWF tags for frame`, `Running frame actions`, `Running AS3 attached to frame`.
- Рендер: `Calculating dirty regions`, `Rendering dirty region`, `Building edges from DisplayObject`, `Rasterizing edges`, `Applying filter: <name>`, `Copying to screen`, `Rendering from cached surface`, `Updating cached surface`, `Updating text layout`, `Rendering text`, `Rendering FTE text`, `Creating BitmapData`, `Decompressing images`, `BitmapData.copyPixels`, `BitmapData.draw`, `Creating Display Buffer`, `Resizing Display Buffer`, `Triggering UpdateAfterEvent`.
- Загрузка: `Loading SWF: <url>`, `Loading file: <url>`, `Receiving Loader data`, `Receiving SWF data`, `Receiving image data`, `Decoding SWF file`, `Closing Loader`, `Preparing ActionScript bytecode`, `Initializing AS globals`.
- Сеть: `LocalConnection callback`, `Handling LocalConnection traffic`, `Sending URL requests`, `URL request timestamp`, `URL request: <url>`, `URL request ID: <id>`, `Responder callback`, `Processing network buffers`, `Receiving NetStream audio/video`, `Decoding media from network`, `Receiving NetStream metadata`, `Receiving NetStream commands`, `Closing network connection`, `Receiving NetStream shared objects`.
- Звук/видео: `Dispatching Sound Complete`, `Initializing StageVideo`.
- Разное: `AIR startup`, `Button hit testing`, `Runtime overhead`.
- Inactive: `Waiting for next frame`, `Waiting for GPU`, `Waiting for condition`.

---

## 6. Память: счётчики Summary

Источник: [MEM] — дословно.

- **Total Memory** — вся память, полученная плеером от ОС (блоками); **Used Memory** — реально занятая из этих блоков. Total обычно чуть меньше показаний Activity Monitor/Task Manager (ресурсы, выделенные самой ОС, не видны).
- Total = память **всех** player instances процесса; чужие инстансы попадают в Other → Other Players.
- Топ-категории Used Memory:
  1. **ActionScript Objects** — managed-память (объекты AS + внутренние объекты плеера, ~10 МБ служебных). Единственная managed-категория; классическая «пила» с GC.
  2. **Bitmap** — графические ресурсы (unmanaged), подкатегории (скрываются, если пустые):
     - **Images** — сжатые загруженные изображения (JPG, GIF, PNG, ATF; [Embed]-ресурсы идут в SWF Files);
     - **Bitmap DisplayObjects** — распакованные изображения + мипмапы;
     - **BitmapData** — данные BitmapData-объектов (и подклассов);
     - **Bitmap Filter Buffers** — результаты фильтров/эффектов;
     - **CacheAsBitmap Buffers** — кэши cacheAsBitmap / cacheAsBitmapMatrix;
     - **Main Screen Buffer** — буфер, копируемый на экран;
     - **Other Bitmap Memory** — прочий рендер (текст и т.п.; сюда же звуки, скачанные через URLRequest).
  3. **ByteArrays** — память ByteArray (unmanaged); подкатегория **DomainMemory** при FlasCC.
  4. **SWF Files** — загруженные SWF, включая главный (unmanaged).
  5. **Other** — остальное; подкатегории:
     - **Network Buffers** — сетевые буферы приёма/отправки;
     - **Telemetry Overhead** — память самого профилировщика;
     - **Other Players** — другие player instances (и workers);
     - **Uncategorized** — не трекаемое (буферы звука/видео, XML, Stage3D/OpenGL/DirectX, JIT-код, мелкие структуры).
- **GPU Memory** (отдельная секция, для Stage3D): число draw calls, разбивка resource memory (текстуры и пр.).
- Режимы отображения (шестерёнка): **Current** (конец последнего кадра выделения, по умолчанию) / **Average** (средневзвешенное по времени) / **Peak** (максимум по каждой категории).
- Единицы: **KB** с разделителем тысяч (например «8,645 KB»).

---

## 7. Специальные возможности (сводно)

- **Stage3D Recording + replay** — покадровый повтор draw call-ов внутри Scout, back buffer после каждого вызова, wireframe, render targets, режим Delayed. (§2.11)
- **Stage3D Program Editor** — живое редактирование AGAL с Upload/Reset. (§2.12)
- **Heat Map / Regions** для DisplayList. (§2.10)
- **ActionScript Sampler** — стек каждые ~1 мс, Top-Down/Bottom-Up, Data Quality-индикатор. (§2.6)
- **Memory Allocation Tracking** (1.1+) — стеки аллокаций, Bottom-Up по классам и функциям, deallocations, Force GC. (§2.7)
- **ActionScript Workers** (beta, Preferences > Beta Features > «Start Sessions For ActionScript Workers») — отдельная сессия на каждый worker; активности Waiting for Condition / MessageChannel.* / Mutex.*. [FP]
- **Custom telemetry API** (`flash.profiler.Telemetry`): `sendMetric(name, value)` — точечная метка в Activity Sequence («Имя: значение»); `spanMarker` + `sendSpanMetric(name, marker[, value])` — собственная активность (видна в Activity Sequence, Top Activities, ActionScript-стеках и в Summary при раскрытии ActionScript, ярко-зелёным); span-метрики обязаны корректно вкладываться; `registerCommandHandler`/`unregisterCommandHandler` — на v1.0 не делали ничего (задел на команды Scout→контент); `Telemetry.connected` — признак подключения. Оверхед метрик мал, но большое их число искажает тайминги. [CUSTOM], https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/flash/profiler/Telemetry.html
- **Find bar** (1.1+) — сквозной поиск по панелям и по кадрам. (§2.14)
- **GPU-панели не было**: GPU-время не измерялось вовсе; только GPU Memory в Summary и «Waiting for GPU». [FAQ], [GS]

---

## 8. Воркфлоу разработчика (по документации)

### 8.1 Главные принципы [ACC]
- Сначала **лёгкие данные** (Basic + Sampler + CPU) → находим *что* тормозит; лишь потом включаем тяжёлые (DisplayList Details / Stage3D Recording / Allocation Tracking) → выясняем *почему*. Совмещать нельзя: «You can't get detailed rendering data and accurate time measurements simultaneously».
- Профилировать: release-плеер, release-SWF, целевое железо/браузер, без других приложений/вкладок, без VM/эмуляторов; на мобильных следить за пропускной способностью Wi-Fi.

### 8.2 «Почему просел кадр» [GS], [FP]
1. В Session Summary найти спайк, кликнуть → Frame Timeline.
2. Выделить плохие кадры; смотреть какие цвета «пробивают» красную линию.
3. Summary: какая категория доминирует → клик по ней (фильтр всех панелей).
4. Если ActionScript: Top Activities → самая дорогая активность (например Event "enterFrame" 54 % / 2,279 ms) → клик → ActionScript-панель покажет только код этого обработчика → Bottom-Up → самые тяжёлые self-time функции. Убедиться, что рожица счастливая (иначе расширить выделение).
5. Если один конкретный кадр: Activity Sequence — точный порядок и вложенность (например GC посреди обработчика).
6. Если DisplayList Rendering: перезапустить с DisplayList Rendering Details → выделить кадр → Heat Map (что дорого) → Regions (что перерисовывается/кэшируется; «не кэшируйте то, что меняется каждый кадр»).
7. Если Stage3D: сперва по Summary→ActionScript доля Stage3D API; затем Stage3D Recording → шагать по draw calls, искать лишние вызовы/смены состояния.
8. «Waiting for GPU» велик → GPU перегружен: меньше треугольников, проще AGAL, меньше текстуры; диагноз подтверждается отключением аппаратного ускорения (время ожидания исчезнет). GPU не быстрее 60 fps — при достигнутых 60 fps ожидание нормально.

### 8.3 «Куда ушла память» [MEM], renaun.com «Find Loitering Objects…»
1. Memory-график в Frame Timeline/Session Summary: монотонный рост без спадов после GC = утечка.
2. Summary → Memory: какая категория растёт (раскрыть Bitmap при необходимости; переключить Current/Average/Peak).
3. Включить Memory Allocation Tracking (перезапуск сессии) → выделить кадры 1..N → Memory Allocations: Top-Down (где аллоцировали) / Bottom-Up Objects (какие классы).
4. Нажать **Force GC** → всё, что осталось при Hide Garbage-Collected Objects — реальные живые объекты (loitering).
5. «Пила» + частые GC → object pooling для короткоживущих объектов; фильтр по Garbage collection в Top Activities покажет функции-виновники аллокаций.

### 8.4 «Почему дёргается рендер» [FP], [GS]
- Ровно-плохой fps = систематический перегруз; редкие пики = ситуативные (GC, декомпрессия картинок, парсинг SWF — ищутся по Activity Sequence пикового кадра).
- Больше одного rendering pass на кадр → лишние updateAfterEvent().
- Много «Updating cached surface» → неверное использование cacheAsBitmap (кэш инвалидируется каждый кадр).
- Серые бары выше красной линии при низких цветных барах → CPU занят чужими процессами.

### 8.5 Что Adobe называла главными достоинствами
- Видимость **внутренностей плеера**, а не только своего кода (в отличие от профайлера Flash Builder, где «all the internal operations of Flash Player were hidden»). [GS]
- Профилирование **release-контента на полной скорости**, без debugger-плеера, «precisely the same SWF and webpage that your users will be running». [GS]
- **Удалённое профилирование** мобильных устройств (AIR) и чужих машин по Wi-Fi/TCP. [GS]
- Комбинация **инструментирования** (микросекундная точность активностей) и **сэмплирования** (дешёвый профиль кода) с перекрёстной фильтрацией. [ACC]
- Оффлайн-обмен сессиями (.flm). [GS]

---

## 9. Критика и ограничения (что говорили пользователи)

- **~2 ГБ лимит**: Scout перестаёт работать, когда сессии съедают ~2 ГБ RAM — длинные сессии невозможны. [GH issue #1]
- **Memory-профилирование слабее Flash Builder**: нет снапшотов памяти с диффом, нет loitering-object view, нет графа ссылок на объект, нет allocation stack traces уровня FB; «I find Scout to be not very useful for memory leak detection… not been able to find one single step-by-step tutorial»; «shows only the total memory allocation, which doesn't help much». [GH], [COMM]
- **Trace Log в live** прокручивается к началу при каждой новой строке — «basically useless» для реального времени. [GH issue #2]
- **Гранулярность в целые миллисекунды** (сэмплер и отображение) — суб-миллисекундные измерения невозможны (Jackson Dunstan сделал Timely именно из-за этого: https://www.jacksondunstan.com/articles/2348).
- **Нет GPU-таймингов** — только косвенное «Waiting for GPU». [FAQ]
- **Нет счётчика вызовов методов** в ActionScript-панели (сэмплер не знает число вызовов — только время на вершине стека). [DATA], [GH issue #10 «Add method call count»]
- Активности с total < 5 мкс вообще не репортятся; активности < 0.5 мс скрыты по умолчанию. [ACC], [DATA]
- Advanced-настройки нельзя менять по ходу сессии; тяжёлые настройки искажают тайминги. [ACC]
- Разное: нет Linux-версии [GH issue #6]; сломанные Help-ссылки; некорректная память при воркерах с ByteArray [GH issue #4]; Chrome/PPAPI слал битые данные памяти [RN]; UI мог терять подписи при рассинхроне language/locale [RN]; standalone-плеер Windows требовал перезапуска между сессиями [RN].
- Русские обзоры: специализированной статьи на Хабре **не найдено** (поиск 2026 г.; хаб flash_platform содержит лишь упоминания). Русскоязычный материал: flashnotes.ru «Профилирование с Adobe Scout в Intellij Idea» (сайт мёртв, http://flashnotes.ru/profilirovanie-s-adobe-scout-v-intellij-idea.html).

---

## 10. Не найдено / неуверенно (честный список)

- Точные hex-цвета: подкатегорий памяти кроме двух верхних, «ярко-зелёного» кастомных метрик, трёх оттенков ActionScript-панели, категорий Regions-режима (есть только словесные названия цветов).
- Точный вид панелей DisplayList Rendering, Stage3D Rendering, Session Info, Memory Allocations (скриншоты в статьях недоступны в читаемом виде; описания — только текстовые, но подробные).
- Механика горизонтального зума таймлайна и клавиатурные шорткаты навигации по кадрам.
- Формат Find bar (где расположен: предположительно тулбар/меню Search).
- Полная таблица соответствия «имя метрики потока → отображаемое имя активности → категория» (восстановлена частично: `.player.abcdecode`→«Preparing ActionScript ByteCode», `.network.loadmovie`→«Loading SWF: …», `.as.event`→«Event "…"», `.gc.*`→«Garbage collection» и т.д.).
- Порядок кнопок графиков при включённом CPU Usage.
- Расхождение дат релиза 1.0 (дек. 2012 vs янв. 2013) и цвета Cached Surfaces (жёлтый vs оранжевый) — источники противоречат.
- Видео Adobe MAX/GDC-докладов и транскрипты YouTube-демо — не извлекались (текстовых транскриптов в открытом доступе не нашлось; ориентир: Lee Brimelow, Denver Flash UG, демо Monocle с ~37-й минуты).

---

## Приложение А. Скриншоты-первоисточники

Локальные копии (скачаны из hxScout репозитория, годятся как пиксельный референс):
- `test_sum/scout_screenshot.png` — общий вид с Summary (категории, память, Top Activities);
- `test_perlin/scout_screenshot.png` — ActionScript-панель Top-Down + Trace Log + сайдбар настроек;
- `test_wastealloc/scout_screenshot.png` — «пила» памяти, оранжево-синие бары кадров, playhead;
- `test_stack/scout_screenshot_sampler.png` — один кадр: Summary (1791 % of budget 17) + Activity Sequence с trace-строками и деревом «Handling event "timer"».

URL-префикс: `https://raw.githubusercontent.com/slavikyad/hxScout/master/flm_exploration/`
