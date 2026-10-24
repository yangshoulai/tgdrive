"""手动视频候选图的取帧顺序与画面检查；不改变上传、预览和自动补图的规则。"""

import math


SAMPLE_SIZE = 64
DEFAULT_COUNT = 3
MAX_COUNT = 9


def frame_positions(duration: float | None, count: int = DEFAULT_COUNT) -> list[float]:
    """先密集检查前几秒，片头较长时逐步向后；短视频补入按时长分布的位置。"""
    positions = {1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180, 300, 600}
    if count > DEFAULT_COUNT:
        step = min(1, duration / (count * 2)) if duration is not None and math.isfinite(duration) and duration > 0 else 1
        positions.update(index * step for index in range(1, count * 2 + 1))
    if duration is not None and math.isfinite(duration) and duration > 0:
        end = max(0, duration - min(.05, duration / 10))
        positions.update(duration * part for part in (.1, .2, .35, .5, .65, .8, .9, .98))
        positions = {value for value in positions if .03 <= value <= end}
    # 避免相邻的固定位置与时长比例位置只差几毫秒，重复启动解码器。
    result = []
    for position in sorted(positions):
        if not result or position - result[-1] >= .05:
            result.append(round(position, 3))
    return result


def frame_usable(pixels: bytes) -> bool:
    """排除明显的黑白屏、灰底文字与缺少画面细节的片头；最终画面由用户选择。"""
    if len(pixels) != SAMPLE_SIZE ** 2:
        return False
    count = len(pixels)
    mean = sum(pixels) / count
    if sum(value * value for value in pixels) / count - mean * mean < 12 ** 2:
        return False
    if sum(value <= 24 for value in pixels) >= count * .75 or sum(value >= 232 for value in pixels) >= count * .75:
        return False
    histogram = [0] * 256
    for value in pixels:
        histogram[value] += 1
    # 缩小时文字边缘的抗锯齿会把两种颜色扩散成多段亮度，不能只检查很窄的直方图峰。
    for width in (17, 33, 49):
        bands = [sum(histogram[start:start + width]) for start in range(257 - width)]
        dominant = max(range(len(bands)), key=bands.__getitem__)
        if bands[dominant] >= count * .65:
            return False
        other = max((value for index, value in enumerate(bands) if abs(index - dominant) >= width), default=0)
        if bands[dominant] + other >= count * .9:
            return False
    detailed = []
    for top in range(0, SAMPLE_SIZE, 16):
        for left in range(0, SAMPLE_SIZE, 16):
            tile = [pixels[y * SAMPLE_SIZE + x] for y in range(top, top + 16) for x in range(left, left + 16)]
            average = sum(tile) / len(tile)
            detailed.append(sum(value * value for value in tile) / len(tile) - average * average >= 8 ** 2)
    return sum(detailed) >= 5 and any(detailed[index] for index in (5, 6, 9, 10))


def same_frame(left: bytes, right: bytes) -> bool:
    return len(left) == len(right) == SAMPLE_SIZE ** 2 and sum(abs(a - b) for a, b in zip(left, right)) / len(left) < 4
