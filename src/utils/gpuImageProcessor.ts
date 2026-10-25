/**
 * WebGL GPU-accelerated Image Processor.
 * Leverages GPU hardware texture Mipmapping (LINEAR_MIPMAP_LINEAR),
 * createImageBitmap off-thread decoding, and WebGL Shaders for
 * near-instant GPU-bound image downsampling and resizing.
 */

let cachedCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let cachedGL: WebGLRenderingContext | WebGL2RenderingContext | null = null;
let cachedProgram: WebGLProgram | null = null;
let positionBuffer: WebGLBuffer | null = null;
let texCoordBuffer: WebGLBuffer | null = null;

function initWebGL(): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
} | null {
  if (cachedGL && cachedProgram && cachedCanvas) {
    return { canvas: cachedCanvas, gl: cachedGL, program: cachedProgram };
  }

  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');

    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!gl) return null;

    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
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
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }

    gl.useProgram(program);

    // Position quad
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]), gl.STATIC_DRAW);

    // Texture coords quad
    texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      1, 1,
    ]), gl.STATIC_DRAW);

    cachedCanvas = canvas;
    cachedGL = gl;
    cachedProgram = program;

    return { canvas, gl, program };
  } catch (err) {
    console.warn('[GPUImageProcessor] WebGL initialization fallback:', err);
    return null;
  }
}

/**
 * Process image with WebGL GPU hardware acceleration.
 * Decodes image via GPU ImageBitmap, generates hardware Mipmaps,
 * and renders with trilinear filtering in microseconds.
 */
export async function gpuResizeImage(
  imageSource: Blob | File | string | ImageBitmap | HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png' = 'image/jpeg',
  quality: number = 0.85
): Promise<Blob | null> {
  const webgl = initWebGL();
  if (!webgl) return null; // Fallback to CPU

  const { canvas, gl, program } = webgl;
  let bitmap: ImageBitmap | null = null;

  try {
    if (imageSource instanceof ImageBitmap) {
      bitmap = imageSource;
    } else if (imageSource instanceof Blob) {
      bitmap = await createImageBitmap(imageSource);
    } else if (typeof imageSource === 'string' && imageSource.trim()) {
      let blob: Blob;
      if (imageSource.startsWith('data:')) {
        const res = await fetch(imageSource);
        blob = await res.blob();
        bitmap = await createImageBitmap(blob);
      } else {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        if (!imageSource.startsWith('blob:')) img.crossOrigin = 'anonymous';
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = imageSource;
        });
        bitmap = await createImageBitmap(img);
      }
    } else if (imageSource instanceof HTMLImageElement) {
      bitmap = await createImageBitmap(imageSource);
    }

    if (!bitmap) return null;

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    gl.viewport(0, 0, targetWidth, targetHeight);

    gl.useProgram(program);

    // Bind positions
    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Bind texture coords
    const aTex = gl.getAttribLocation(program, 'a_texCoord');
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

    // Create GPU Texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Upload ImageBitmap to GPU VRAM
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    // Enable GPU Mipmapping & Hardware Trilinear Filtering
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    // GPU Draw Call
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Cleanup GPU Texture
    gl.deleteTexture(texture);

    // Convert OffscreenCanvas/Canvas to Blob
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
      const blob = await canvas.convertToBlob({ type: mimeType, quality });
      return blob;
    } else if (canvas instanceof HTMLCanvasElement) {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), mimeType, quality);
      });
      return blob;
    }
  } catch (err) {
    console.warn('[GPUImageProcessor] GPU draw call failed, fallback to CPU:', err);
  } finally {
    if (bitmap && !(imageSource instanceof ImageBitmap)) {
      bitmap.close();
    }
  }

  return null;
}
