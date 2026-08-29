// Floating screen-recording preview: shows the stored JPEG frame nearest
// to the time the user is scrubbing, so "what was on screen when the fps
// dropped" is one glance away. Frames are fetched lazily from the
// `snapshots` table and cached as object URLs.

import { query } from "./db";
import { ProfileModel, formatClock } from "./model";
import { lowerBound } from "./view";

const CACHE_LIMIT = 80;

export class SnapshotPreview {
  private cache = new Map<number, string>(); // ts_us → object URL, LRU order
  private shownTsUs = 0;
  private wantTsUs = 0;
  private wantMs = 0;
  private busy = false;

  constructor(
    private panel: HTMLElement,
    private img: HTMLImageElement,
    private caption: HTMLElement,
    private model: ProfileModel
  ) {
    panel.hidden = !this.enabled;
  }

  get enabled(): boolean {
    return this.model.snapTimesMs.length > 0;
  }

  /** Shows the recorded frame nearest to `ms` on the profile timeline. */
  showAt(ms: number) {
    if (!this.enabled) return;
    const times = this.model.snapTimesMs;
    let index = lowerBound(times, ms);
    if (index >= times.length) index = times.length - 1;
    if (index > 0 && Math.abs(times[index - 1] - ms) < Math.abs(times[index] - ms)) index--;
    this.wantTsUs = this.model.snapTsUs[index];
    this.wantMs = times[index];
    void this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.wantTsUs !== this.shownTsUs) {
        const tsUs = this.wantTsUs;
        const ms = this.wantMs;
        let url = this.cache.get(tsUs);
        if (url) {
          // refresh LRU position
          this.cache.delete(tsUs);
          this.cache.set(tsUs, url);
        } else {
          const { rows } = await query(
            `SELECT bytes, mime FROM snapshots WHERE ts_us = ${Math.round(tsUs)} LIMIT 1`
          );
          if (!rows.length) {
            this.shownTsUs = tsUs; // nothing there; stop retrying
            continue;
          }
          const raw = rows[0]["bytes"];
          const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as number[]);
          // copy into a plain ArrayBuffer: arrow may hand out a view into a
          // larger (or shared) buffer, which Blob's typing rejects
          const copy = new Uint8Array(bytes.length);
          copy.set(bytes);
          url = URL.createObjectURL(
            new Blob([copy.buffer], { type: String(rows[0]["mime"] ?? "image/jpeg") })
          );
          this.cache.set(tsUs, url);
          if (this.cache.size > CACHE_LIMIT) {
            const oldest = this.cache.entries().next().value!;
            this.cache.delete(oldest[0]);
            URL.revokeObjectURL(oldest[1]);
          }
        }
        this.img.src = url;
        this.caption.textContent = `запись · ${formatClock(ms)}`;
        this.shownTsUs = tsUs;
      }
    } catch (error) {
      console.warn("snapshot preview", error);
    } finally {
      this.busy = false;
    }
  }
}
