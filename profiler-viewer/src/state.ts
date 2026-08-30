// Scout's interaction model: one frame-range selection drives every panel,
// and a category picked in the Summary greys everything else out.

export interface Selection {
  /** inclusive frame indexes, a <= b */
  a: number;
  b: number;
}

type Listener = () => void;

export class ScoutState {
  selection: Selection | null = null;
  /** category index from CATEGORIES, or null = no filter */
  categoryFilter: number | null = null;
  targetFps = 60;
  /** hover position in profile ms (playhead), or null */
  hoverMs: number | null = null;

  private selectionListeners: Listener[] = [];
  private filterListeners: Listener[] = [];
  private hoverListeners: Listener[] = [];

  onSelection(listener: Listener) {
    this.selectionListeners.push(listener);
  }
  onFilter(listener: Listener) {
    this.filterListeners.push(listener);
  }
  onHover(listener: Listener) {
    this.hoverListeners.push(listener);
  }

  budgetMs(): number {
    return 1000 / this.targetFps;
  }

  setSelection(selection: Selection | null) {
    this.selection = selection;
    for (const listener of this.selectionListeners) listener();
  }

  setCategoryFilter(category: number | null) {
    this.categoryFilter = category;
    for (const listener of this.filterListeners) listener();
  }

  setTargetFps(fps: number) {
    this.targetFps = Math.min(Math.max(fps, 1), 240);
    for (const listener of this.filterListeners) listener();
  }

  setHover(ms: number | null) {
    this.hoverMs = ms;
    for (const listener of this.hoverListeners) listener();
  }
}
