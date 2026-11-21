export interface Size {
  width: number;
  height: number;
}

/**
 * Where a frame image sits in a box: scaled to fit whole, centred. Drawing, input mapping and the
 * element outline all go through this, so a click lands where the picture shows the page even
 * when the frame's size or aspect differs from the canvas (another device pixel ratio, a resize
 * not yet answered by the host).
 */
export function frameRect(box: Size, image: Size) {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** Draws `image` fitted into the canvas, whose backing store follows its CSS size × DPR. */
export function paintFrame(canvas: HTMLCanvasElement, image: ImageBitmap) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.clearRect(0, 0, width, height);
  const fit = frameRect({ width, height }, image);
  if (fit) context.drawImage(image, fit.left, fit.top, fit.width, fit.height);
}
