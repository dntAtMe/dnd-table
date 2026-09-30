import type { CameraRect } from '@dnd/protocol';

/** screen = map * k + (x, y) */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export const MAX_ZOOM = 8;

/** Camera that fits a map rectangle inside a viewport of w×h pixels, centred. */
export function fitRect(rect: CameraRect, w: number, h: number, padding = 0): Camera {
  const k = Math.min((w - padding * 2) / rect.w, (h - padding * 2) / rect.h);
  return { k, x: w / 2 - (rect.x + rect.w / 2) * k, y: h / 2 - (rect.y + rect.h / 2) * k };
}

/** The part of the map visible in a w×h viewport. */
export function visibleRect(cam: Camera, w: number, h: number): CameraRect {
  return { x: -cam.x / cam.k, y: -cam.y / cam.k, w: w / cam.k, h: h / cam.k };
}

export function screenToMap(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k };
}

/** Zooms by `factor` keeping the map point under (sx, sy) fixed. */
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number, minK: number): Camera {
  const k = Math.min(MAX_ZOOM, Math.max(minK, cam.k * factor));
  const f = k / cam.k;
  return { k, x: sx - (sx - cam.x) * f, y: sy - (sy - cam.y) * f };
}
