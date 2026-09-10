# Profiler-instrumented Ruffle build

Served at `/ruffle/` **only** by profiling builds of the client
(`--features profiler`); regular builds embed `web/ruffle/` instead and
never include this directory.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/render-opt` (on top of `shararam/rtmp-netconnection`)
- revision: `deb3ce384` (кэш bounds для хит-теста мыши и наличия
  AVM1-обработчиков: `mouse_pick` больше не обходит весь display list, а
  диспатч `onEnterFrame`/`onMouseMove`/… не ищет метод по цепочке прототипов
  у каждого клипа — в людной комнате pick 705 → 3 мкс, событие мыши
  1200 → 75 мкс на синтетике из 4900 объектов; на тестовом наборе SWF
  Ruffle 4165 зелёных, 5 падений те же, что и без изменения; на верхних
  коммитах: `e0d829d21` — рост памяти wasm кусками по 64 МиБ вместо 64 КиБ
  dlmalloc (на Windows/Chromium каждый `memory.grow` стоит 1–10 мс в ядре,
  и тик, которому нужно 30 МБ свежей кучи, замирал на секунды);
  `4a67bd03e` — библиотека загруженного фильма освобождается, когда её
  не играет ни один корневой клип (апстрим держит персонажей, меши, битмапы,
  шрифты и байты SWF каждого `loadMovie` до конца сессии, отчего куча после
  сборки мусора только росла); `24e5f275d` — кэш распарсенных SWF: повторный
  AVM1 loadMovie того же URL делит фильм и библиотеку; MULTIPLY на
  непрозрачном кадре через blend state; бленд-группы в offscreen-цели размером
  с объект; плюс сэмплер стека AVM1 с позиционными метками анонимных функций,
  счётчики аллокаций, карта экрана, span `Array.sort` — см.
  `docs/SHARARAM-PROFILER.md`)
- build: `cd web && npm run build:shararam-profiler`
  (release profile + wasm-opt, identical to a regular build except for the
  `shararam_profiler` cargo feature)
- what the feature adds: a low-overhead event recorder
  (`core/src/profiler.rs` in the fork) exposed to the page as
  `window.__ruffleProfiler`; see `docs/SHARARAM-PROFILER.md` in the fork.

To refresh after changing the fork:

```sh
cd ../ruffle-shararam-profiler/web
npm run build:shararam-profiler
cp packages/selfhosted/dist/ruffle.js \
   packages/selfhosted/dist/core.ruffle.*.js \
   packages/selfhosted/dist/*.wasm \
   ../../shararam-ruffle/web-profiler/ruffle/
```
(remove the previously committed `core.ruffle.*.js` / `*.wasm` pair when
the hash changes)
