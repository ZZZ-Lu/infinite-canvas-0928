type ResizeRequest = { id: number; file: Blob; maxDim: number; quality: number };

self.onmessage = async ({ data }: MessageEvent<ResizeRequest>) => {
  const { id, file, maxDim, quality } = data;
  let bitmap: ImageBitmap | undefined;
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('Offscreen image processing is unavailable');
    }

    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Offscreen 2D context is unavailable');

    context.drawImage(bitmap, 0, 0, width, height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const output = await canvas.convertToBlob({ type, quality });
    self.postMessage({ id, blob: output });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    bitmap?.close();
  }
};
