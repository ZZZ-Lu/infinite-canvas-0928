/**
 * GPU-Accelerated WebGL & Offscreen Image Processing Pipeline.
 * 
 * Provides hardware-accelerated bilinear/trilinear resampling for large 2K/4K/8K images
 * using WebGL offscreen canvas contexts to avoid main thread CPU bottlenecks.
 * 
 * Strict Data-DOM Decoupling: Zero React state, zero DOM element attachment.
 */

let sharedOffscreenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let sharedGlContext: WebGLRenderingContext | WebGL2RenderingContext | null = null;

function getSharedCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; gl: WebGLRenderingContext | WebGL2RenderingContext | null } {
  if (typeof OffscreenCanvas !== 'undefined') {
    if (!sharedOffscreenCanvas || !(sharedOffscreenCanvas instanceof OffscreenCanvas)) {
      sharedOffscreenCanvas = new OffscreenCanvas(width, height);
    } else {
      sharedOffscreenCanvas.width = width;
      sharedOffscreenCanvas.height = height;
    }
  } else if (typeof document !== 'undefined') {
    if (!sharedOffscreenCanvas) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      sharedOffscreenCanvas = c;
    } else {
      sharedOffscreenCanvas.width = width;
      sharedOffscreenCanvas.height = height;
    }
  } else {
    throw new Error('Canvas context not available in environment');
  }

  if (!sharedGlContext || sharedGlContext.isContextLost()) {
    sharedGlContext = (sharedOffscreenCanvas.getContext('webgl2') as WebGL2RenderingContext | null) ||
      (sharedOffscreenCanvas.getContext('webgl') as WebGLRenderingContext | null) ||
      ((sharedOffscreenCanvas as any).getContext('experimental-webgl') as WebGLRenderingContext | null);
  }

  return { canvas: sharedOffscreenCanvas, gl: sharedGlContext };
}

/**
 * Perform GPU-accelerated texture resampling of an image source to target dimensions.
 */
export async function gpuResizeImage(
  imageSource: HTMLImageElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  targetWidth: number,
  targetHeight: number,
  quality: number = 0.85
): Promise<Blob> {
  const tw = Math.max(1, Math.round(targetWidth));
  const th = Math.max(1, Math.round(targetHeight));

  try {
    const { canvas, gl } = getSharedCanvas(tw, th);

    if (gl) {
      // Setup simple texture passthrough WebGL program
      const vsSource = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
          v_texCoord = a_texCoord;
        }
      `;
      const fsSource = `
        precision mediump float;
        uniform sampler2D u_image;
        varying vec2 v_texCoord;
        void main() {
          gl_FragColor = texture2D(u_image, v_texCoord);
        }
      `;

      const createShader = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      };

      const vs = createShader(gl.VERTEX_SHADER, vsSource);
      const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
      if (vs && fs) {
        const program = gl.createProgram();
        if (program) {
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.linkProgram(program);

          if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
            gl.useProgram(program);

            // Set up quad
            const positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
              -1, -1, 0, 1,
               1, -1, 1, 1,
              -1,  1, 0, 0,
              -1,  1, 0, 0,
               1, -1, 1, 1,
               1,  1, 1, 0,
            ]), gl.STATIC_DRAW);

            const positionLoc = gl.getAttribLocation(program, 'a_position');
            const texCoordLoc = gl.getAttribLocation(program, 'a_texCoord');

            gl.enableVertexAttribArray(positionLoc);
            gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);

            gl.enableVertexAttribArray(texCoordLoc);
            gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8);

            // Upload texture
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageSource);

            gl.viewport(0, 0, tw, th);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // Clean up shader resources
            gl.deleteTexture(texture);
            gl.deleteBuffer(positionBuffer);
            gl.deleteProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);

            // Export blob
            if ('convertToBlob' in canvas && typeof (canvas as any).convertToBlob === 'function') {
              try {
                return await (canvas as any).convertToBlob({ type: 'image/webp', quality });
              } catch {
                return await (canvas as any).convertToBlob({ type: 'image/jpeg', quality });
              }
            } else if ('toBlob' in canvas && typeof (canvas as HTMLCanvasElement).toBlob === 'function') {
              return new Promise<Blob>((res, rej) => {
                (canvas as HTMLCanvasElement).toBlob((b) => b ? res(b) : rej(new Error('Canvas toBlob failed')), 'image/webp', quality);
              });
            }
          }
        }
      }
    }
  } catch (glErr) {
    console.warn('[gpuImageProcessor] WebGL acceleration fallback to 2D canvas:', glErr);
  }

  // 2D Canvas Fallback
  const fallbackCanvas = typeof document !== 'undefined'
    ? document.createElement('canvas')
    : new OffscreenCanvas(tw, th);
  fallbackCanvas.width = tw;
  fallbackCanvas.height = th;
  const ctx = fallbackCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

  if (!ctx) {
    throw new Error('Canvas 2D context unavailable for image compression');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imageSource, 0, 0, tw, th);

  if ('convertToBlob' in fallbackCanvas && typeof (fallbackCanvas as any).convertToBlob === 'function') {
    try {
      return await (fallbackCanvas as any).convertToBlob({ type: 'image/webp', quality });
    } catch {
      return await (fallbackCanvas as any).convertToBlob({ type: 'image/jpeg', quality });
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    (fallbackCanvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('2D Canvas fallback toBlob failed'));
    }, 'image/jpeg', quality);
  });
}

/**
 * Resample and compress an input image Blob or File to a maximum dimension (default: 1200px).
 */
export async function compressAndResizeImage(
  fileOrBlob: Blob | File,
  maxEdge: number = 1200,
  quality: number = 0.85
): Promise<Blob> {
  if (!fileOrBlob || fileOrBlob.size === 0) {
    throw new Error('Invalid image file/blob provided for compression');
  }

  // Use createImageBitmap if available for high-performance off-main-thread decoding
  if (typeof createImageBitmap !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(fileOrBlob);
      const srcW = bitmap.width;
      const srcH = bitmap.height;

      if (srcW <= maxEdge && srcH <= maxEdge && fileOrBlob.size < 300 * 1024) {
        bitmap.close();
        return fileOrBlob;
      }

      let tw = srcW;
      let th = srcH;
      if (srcW > srcH) {
        if (srcW > maxEdge) {
          tw = maxEdge;
          th = Math.max(1, Math.round(maxEdge * (srcH / srcW)));
        }
      } else {
        if (srcH > maxEdge) {
          th = maxEdge;
          tw = Math.max(1, Math.round(maxEdge * (srcW / srcH)));
        }
      }

      const resizedBlob = await gpuResizeImage(bitmap, tw, th, quality);
      bitmap.close();
      return resizedBlob;
    } catch (bitmapErr) {
      console.warn('[gpuImageProcessor] createImageBitmap failed, fallback to Image element:', bitmapErr);
    }
  }

  // Fallback HTMLImageElement loading
  return new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.referrerPolicy = 'no-referrer';

    img.onload = async () => {
      try {
        const srcW = img.naturalWidth || maxEdge;
        const srcH = img.naturalHeight || maxEdge;

        let tw = srcW;
        let th = srcH;
        if (srcW > srcH) {
          if (srcW > maxEdge) {
            tw = maxEdge;
            th = Math.max(1, Math.round(maxEdge * (srcH / srcW)));
          }
        } else {
          if (srcH > maxEdge) {
            th = maxEdge;
            tw = Math.max(1, Math.round(maxEdge * (srcW / srcH)));
          }
        }

        const resBlob = await gpuResizeImage(img, tw, th, quality);
        URL.revokeObjectURL(url);
        resolve(resBlob);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decoding failed for GPU compression'));
    };

    img.src = url;
  });
}
