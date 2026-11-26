/** Pure detection heuristics (no DOM access), kept separate so they can be unit-tested. */

export interface ViewportGeometry {
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  /** Page zoom relative to when monitoring started (devicePixelRatio / baseline). */
  zoom: number;
}

/**
 * In full screen the viewport should cover the screen. DevTools docked inside
 * the window shrinks one side only (width when docked left/right, height when
 * docked at the bottom). If both sides shrink by the same proportion, the page
 * is zoomed or the display is scaled, which is not a violation.
 */
export function dockedDevtoolsSuspected(g: ViewportGeometry): { suspected: boolean; widthGap: number; heightGap: number } {
  const width = g.innerWidth * g.zoom;
  const height = g.innerHeight * g.zoom;
  const widthGap = Math.round(g.screenWidth - width);
  const heightGap = Math.round(g.screenHeight - height);
  if (g.screenWidth <= 0 || g.screenHeight <= 0) return { suspected: false, widthGap, heightGap };
  const widthRatio = width / g.screenWidth;
  const heightRatio = height / g.screenHeight;
  const uniform = Math.abs(widthRatio - heightRatio) < 0.04;
  const suspected = !uniform && (widthGap > 160 || heightGap > 160);
  return { suspected, widthGap, heightGap };
}
