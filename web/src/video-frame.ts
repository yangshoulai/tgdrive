/** 视频封面质量检查；阈值与 tgdrive/thumbnails.py 的 video_frame_usable 一致。
 * 接受有细节的暗场和常见黑边，跳过黑白占比过高、淡入淡出及近乎纯色的画面。 */
export function videoFramePixelsUsable(pixels: ArrayLike<number>): boolean {
  if (!pixels.length) return false;
  let black = 0, white = 0, sum = 0, squares = 0;
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index];
    if (value <= 24) black++;
    if (value >= 232) white++;
    sum += value; squares += value * value;
  }
  if (black >= pixels.length * 0.7 || white >= pixels.length * 0.7) return false;
  const mean = sum / pixels.length;
  return squares / pixels.length - mean * mean >= 12 ** 2;
}
