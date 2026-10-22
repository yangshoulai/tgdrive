/** 视频封面质量检查；阈值与 tgdrive/thumbnails.py 的 video_frame_usable 一致。
 * 接受有细节的暗场和常见黑边，跳过黑白占比过高、淡入淡出及近乎纯色的画面。 */
export const VIDEO_SAMPLE_SIZE = 32;
export const VIDEO_FRAME_TIMES = [0, 1, 3, 10, 30, 60, 120] as const;

export function videoFramePixelsUsable(pixels: ArrayLike<number>): boolean {
  if (pixels.length !== VIDEO_SAMPLE_SIZE ** 2) return false;
  let black = 0, white = 0, sum = 0, squares = 0;
  const histogram = new Uint16Array(256);
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index];
    if (value <= 24) black++;
    if (value >= 232) white++;
    sum += value; squares += value * value;
    histogram[value]++;
  }
  if (black >= pixels.length * 0.7 || white >= pixels.length * 0.7) return false;
  const mean = sum / pixels.length;
  if (squares / pixels.length - mean * mean < 12 ** 2) return false;
  // 大面积单色叠加小标志也会有很高的全局方差；85% 像素集中在相近的 25 级亮度仍视为空白。
  let band = 0;
  for (let value = 0; value < 25; value++) band += histogram[value];
  if (band >= pixels.length * .85) return false;
  for (let value = 25; value < 256; value++) {
    band += histogram[value] - histogram[value - 25];
    if (band >= pixels.length * .85) return false;
  }
  // 至少 8% 像素有明显邻域变化，覆盖 4 个分区并包含中部，避免平滑渐变、黑边和角落标志充数。
  const tiles = new Uint16Array(16), tileSize = VIDEO_SAMPLE_SIZE / 4;
  for (let index = 0; index < pixels.length; index++) {
    const x = index % VIDEO_SAMPLE_SIZE, y = Math.floor(index / VIDEO_SAMPLE_SIZE), value = pixels[index];
    const horizontal = x > 0 && Math.abs(value - pixels[index - 1]) >= 12;
    const vertical = y > 0 && Math.abs(value - pixels[index - VIDEO_SAMPLE_SIZE]) >= 12;
    if (horizontal || vertical) {
      tiles[Math.floor(y / tileSize) * 4 + Math.floor(x / tileSize)]++;
    }
  }
  return tiles.reduce((total, value) => total + value, 0) >= pixels.length * .08
    && tiles.filter(value => value >= 4).length >= 4 && [5, 6, 9, 10].some(index => tiles[index] >= 4);
}
