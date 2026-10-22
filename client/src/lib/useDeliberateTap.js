import { useRef } from 'react';

// Set by the chart whenever a finger or mouse is panning/zooming it, so a drag that ends
// on top of a Buy/Sell button is not mistaken for a tap.
let lastGestureAt = 0;
export const markGesture = () => {
  lastGestureAt = Date.now();
};

const MOVE_SLOP_PX = 10;
const GESTURE_COOLDOWN_MS = 400;

/**
 * Props for a button that should only fire on a deliberate tap: not when the finger slid
 * more than a few pixels, and not right after a chart gesture.
 */
export function useDeliberateTap(onTap) {
  const start = useRef(null);
  return {
    onPointerDown: (e) => {
      start.current = { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_SLOP_PX) s.moved = true;
    },
    onClick: (e) => {
      const moved = start.current?.moved;
      start.current = null;
      if (moved || Date.now() - lastGestureAt < GESTURE_COOLDOWN_MS) {
        e.preventDefault();
        return;
      }
      onTap(e);
    },
  };
}
