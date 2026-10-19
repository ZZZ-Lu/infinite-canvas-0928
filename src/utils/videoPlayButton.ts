import React from "react";

export const PLAY_BUTTON_SVG_PATH = "M8 6.5v11c0 .8.9 1.3 1.6.9l8.5-5.5a1 1 0 0 0 0-1.8L9.6 5.6c-.7-.4-1.6.1-1.6.9z";

let playIconPath2D: Path2D | null = null;
export function getPlayIconPath2D(): Path2D {
  if (typeof window !== "undefined" && !playIconPath2D) {
    playIconPath2D = new Path2D(PLAY_BUTTON_SVG_PATH);
  }
  return playIconPath2D || new Path2D(PLAY_BUTTON_SVG_PATH);
}

/**
 * Standard sizing math for video card play buttons (100% Scale Reference Standard):
 * - narrowerSide = Math.min(width, height)
 * - playButtonDiameter = narrowerSide / 2
 * - playButtonIconSize = playButtonDiameter * 0.76
 */
export function calculateVideoPlayButtonDimensions(width: number, height: number) {
  const narrowerSide = Math.min(width, height);
  const playButtonDiameter = narrowerSide / 2;
  const playButtonIconSize = playButtonDiameter * 0.76;
  return {
    narrowerSide,
    playButtonDiameter,
    playButtonIconSize,
  };
}
