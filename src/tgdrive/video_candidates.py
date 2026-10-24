"""手动视频候选图的取帧顺序与画面检查；不改变上传、预览和自动补图的规则。"""

import math


SAMPLE_SIZE = 64
DEFAULT_COUNT = 3
MAX_COUNT = 9


def frame_positions(duration: float | None, count: int = DEFAULT_COUNT) -> list[float]:
    """优先覆盖全片的不同段落，主采样点之后再补取附近位置，避免候选集中在片头。"""
    if duration is not None and math.isfinite(duration) and duration > 0:
        end = max(0, duration - min(.05, duration / 10))
        anchors = [.5] if count == 1 else [.1 + .8 * index / (count - 1) for index in range(count)]
        offset = min(.04, .8 / max(1, count - 1) / 3)
        positions = [min(end, duration * (anchor + shift)) for shift in (0, offset, -offset) for anchor in anchors]
        separation = min(.05, duration / (count * 16))
    else:
        # 无时长信息时逐步拉开间隔，解码到结尾后停止；不再一秒一张凑满数量。
        positions = [5, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200]
        separation = .05
    # 保留主采样点优先级，不能按时间重新排序，否则又会优先凑满前段画面。
    result = []
    for position in positions:
        position = round(position, 3)
        if position > 0 and all(abs(position - old) >= separation for old in result):
            result.append(position)
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
