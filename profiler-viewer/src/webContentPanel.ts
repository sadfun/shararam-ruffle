// WebContent — нативные стеки главного потока WebKit-процесса страницы,
// снятые хостом через /usr/bin/sample (флаг --sample-webcontent). Это ответ
// на «Блокировка потока (замёрз вне JS)»: что именно делал WebKit — коммит
// слоёв, IPC в GPU-процесс, GC JSC — пока страница ничего не видела.
// Сэмплы идут чанками по ~5 с; интервал 1 мс, так что счёт ≈ миллисекунды.

import { query, toNumber } from "./db";
import { ProfileModel } from "./model";
import { ScoutState } from "./state";
import { scoutMs } from "./summaryPanel";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class WebContentPanel {
  private hasData: boolean | null = null;

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private state: ScoutState
  ) {}

  async render() {
    const container = this.container;
    if (this.hasData === null) {
      this.hasData = this.model.kinds.some(
        kind => kind.cat === "native" && kind.name === "wc_stacks"
      );
    }
    container.textContent = "";
    if (!this.hasData) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "Нативные стеки WebContent не записаны. Запустите профилировочную " +
            "сборку с флагом --sample-webcontent — хост будет снимать стеки " +
            "главного потока WebKit-процесса чанками по ~5 с (диагностический " +
            "режим: сэмплирование приостанавливает потоки цели на каждый тик)."
        )
      );
      return;
    }

    const frameCount = this.model.frameTimesMs.length;
    const selection = this.state.selection ?? { a: 0, b: frameCount - 1 };
    const aUs = Math.round(
      this.model.t0Us +
        (this.model.frameTimesMs[selection.a] - this.model.frameDtMs[selection.a]) * 1000
    );
    const bUs = Math.round(this.model.t0Us + this.model.frameTimesMs[selection.b] * 1000);

    let chunks = 0;
    let coveredUs = 0;
    let totalSamples = 0;
    const byChain = new Map<string, number>();
    try {
      const { rows } = await query(
        `SELECT ts_us, dur_us, args FROM events
         WHERE cat = 'native' AND name = 'wc_stacks'
           AND ts_us < ${bUs} AND ts_us + dur_us > ${aUs}
         ORDER BY ts_us`
      );
      for (const row of rows) {
        let args: { total?: number; stacks?: [number, string][] };
        try {
          args = JSON.parse(String(row["args"]));
        } catch {
          continue;
        }
        chunks++;
        coveredUs += Math.min(toNumber(row["dur_us"]), bUs - aUs);
        totalSamples += args.total ?? 0;
        for (const [count, chain] of args.stacks ?? []) {
          byChain.set(chain, (byChain.get(chain) ?? 0) + count);
        }
      }
    } catch {
      /* ignore */
    }

    const toolbar = el("div", "panel-toolbar");
    toolbar.appendChild(
      el("span", "dim", this.state.selection ? `кадры ${selection.a} – ${selection.b}` : "вся сессия")
    );
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(
      el(
        "span",
        "dim",
        `${chunks} чанков sample · покрыто ~${scoutMs(coveredUs / 1000)} мс из ${scoutMs((bUs - aUs) / 1000)}`
      )
    );
    container.appendChild(toolbar);

    if (!chunks) {
      container.appendChild(
        el("div", "details-empty", "В выделении нет чанков sample — выберите диапазон пошире.")
      );
      return;
    }

    const top = [...byChain.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20);
    const table = el("table", "grid") as HTMLTableElement;
    const head = table.createTHead().insertRow();
    head.appendChild(el("th", "", "Стек главного потока (лист первым)"));
    head.appendChild(el("th", "num", "сэмплов (~мс)"));
    head.appendChild(el("th", "num", "%"));
    const body = table.createTBody();
    for (const [chain, count] of top) {
      const tr = body.insertRow();
      const name = tr.insertCell();
      name.className = "wc-chain";
      name.textContent = chain;
      const samples = tr.insertCell();
      samples.className = "num";
      samples.textContent = count.toLocaleString("ru");
      const pct = tr.insertCell();
      pct.className = "num";
      pct.textContent = totalSamples > 0 ? `${Math.round((count / totalSamples) * 100)} %` : "";
    }
    container.appendChild(table);

    container.appendChild(
      el(
        "div",
        "dim panel-note",
        "Стеки главного потока процесса com.apple.WebKit.WebContent, интервал " +
          "сэмплирования 1 мс (счёт ≈ миллисекунды). mach_msg на вершине — поток " +
          "ждал (обычно ответа GPU-процесса или следующего событийного цикла); " +
          "всё остальное — во что упиралась работа. Хвосты стеков усечены до 8 " +
          "кадров; показан топ-20 цепочек выделения."
      )
    );
  }
}
