// Shared zoomable time viewport for the FPS chart and the timeline.

export class Viewport {
  /** visible window in profile ms */
  v0 = 0;
  v1 = 1000;
  totalMs = 1000;
  private listeners: (() => void)[] = [];

  reset(totalMs: number) {
    this.totalMs = totalMs;
    this.v0 = 0;
    this.v1 = totalMs;
    this.emit();
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  span(): number {
    return this.v1 - this.v0;
  }

  xOf(ms: number, width: number): number {
    return ((ms - this.v0) / this.span()) * width;
  }

  msOf(x: number, width: number): number {
    return this.v0 + (x / width) * this.span();
  }

  zoomAround(ms: number, factor: number) {
    const minSpan = 1; // 1ms
    let span = this.span() * factor;
    span = Math.min(Math.max(span, minSpan), this.totalMs * 1.05);
    const ratio = (ms - this.v0) / this.span();
    this.v0 = ms - span * ratio;
    this.v1 = this.v0 + span;
    this.clamp();
    this.emit();
  }

  panByMs(deltaMs: number) {
    this.v0 += deltaMs;
    this.v1 += deltaMs;
    this.clamp();
    this.emit();
  }

  setRange(v0: number, v1: number) {
    this.v0 = v0;
    this.v1 = Math.max(v1, v0 + 1);
    this.clamp();
    this.emit();
  }

  private clamp() {
    const span = this.span();
    if (this.v0 < -this.totalMs * 0.05) {
      this.v0 = -this.totalMs * 0.05;
      this.v1 = this.v0 + span;
    }
    if (this.v1 > this.totalMs * 1.05) {
      this.v1 = this.totalMs * 1.05;
      this.v0 = this.v1 - span;
    }
  }
}

/** Sensible tick step for a time axis, in ms. */
export function tickStepMs(spanMs: number, targetTicks: number): number {
  const raw = spanMs / targetTicks;
  const steps = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000,
    300000, 600000
  ];
  for (const step of steps) if (step >= raw) return step;
  return 600000;
}

/** Attaches wheel-zoom and drag-pan to a canvas, in CSS pixel space. */
export function attachNavigation(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  leftGutter: number,
  onClickAt?: (x: number, y: number) => void
) {
  let dragging = false;
  let moved = false;
  let lastX = 0;

  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const width = rect.width - leftGutter;
    const x = event.clientX - rect.left - leftGutter;
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      const ms = viewport.msOf(Math.max(x, 0), width);
      viewport.zoomAround(ms, Math.pow(1.0018, event.deltaY));
    } else {
      viewport.panByMs((event.deltaX / width) * viewport.span());
    }
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    dragging = true;
    moved = false;
    lastX = event.clientX;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width - leftGutter;
    const deltaX = event.clientX - lastX;
    if (Math.abs(deltaX) > 2) moved = true;
    lastX = event.clientX;
    viewport.panByMs((-deltaX / width) * viewport.span());
  });
  canvas.addEventListener("pointerup", event => {
    dragging = false;
    if (!moved && onClickAt) {
      const rect = canvas.getBoundingClientRect();
      onClickAt(event.clientX - rect.left, event.clientY - rect.top);
    }
  });
}

/** Sizes a canvas to its CSS box with devicePixelRatio, returns 2D context. */
export function prepareCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(rect.width, 10);
  const height = Math.max(rect.height, 10);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

/** First index in sorted array with value >= target. */
export function lowerBound(array: Float64Array, target: number): number {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (array[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
