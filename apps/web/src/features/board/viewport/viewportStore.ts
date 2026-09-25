import type { Size, Viewport } from "./viewport";

export type ViewportChangeSource = "user" | "follow";

/** Tiny external store for the viewport so pan/zoom never re-renders the whole board tree. */
export class ViewportStore {
  private viewport: Viewport = { x: 0, y: 0, scale: 1 };
  private size: Size = { width: 0, height: 0 };
  /** Who made the last viewport change: follow mode must not cancel itself. */
  private source: ViewportChangeSource = "user";
  private readonly listeners = new Set<() => void>();

  get = (): Viewport => this.viewport;
  getSize = (): Size => this.size;
  getSource = (): ViewportChangeSource => this.source;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(viewport: Viewport, source: ViewportChangeSource = "user"): void {
    if (
      viewport.x === this.viewport.x &&
      viewport.y === this.viewport.y &&
      viewport.scale === this.viewport.scale
    ) {
      return;
    }
    this.viewport = viewport;
    this.source = source;
    this.emit();
  }

  setSize(size: Size): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.size = size;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
