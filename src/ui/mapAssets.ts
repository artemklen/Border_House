const images = new Map<string, HTMLImageElement>();
const tints = new Map<string, HTMLCanvasElement>();

export function loadIcon(file: string): HTMLImageElement {
  let image = images.get(file);
  if (!image) {
    image = new Image();
    image.src = `/icons/${file}.svg`;
    images.set(file, image);
  }
  return image;
}

export function iconReady(file: string): HTMLImageElement | null {
  const image = loadIcon(file);
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/** Значок с currentColor, перекрашенный в цвет токена. Печати рисуются как есть. */
export function tintedIcon(file: string, color: string, size: number): HTMLCanvasElement | null {
  const image = iconReady(file);
  if (!image || !color) return null;
  const key = `${file}|${color}|${size}`;
  const cached = tints.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, size, size);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  tints.set(key, canvas);
  return canvas;
}
