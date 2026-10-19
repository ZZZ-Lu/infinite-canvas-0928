import { NANO_LOD_THRESHOLD } from './cardLodAppearance';
export type LodFrame = { scale: number; tx: number; ty: number };
// A queued callback from a previous camera/LOD cannot retire the current DOM.
export function canRetireDomForNano(frame: LodFrame, camera: LodFrame) {
  return frame.scale < NANO_LOD_THRESHOLD && camera.scale < NANO_LOD_THRESHOLD &&
    frame.scale === camera.scale && frame.tx === camera.tx && frame.ty === camera.ty;
}
