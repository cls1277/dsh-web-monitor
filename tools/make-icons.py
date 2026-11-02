"""生成扩展图标（16/32/48/128）。

用 512px 画布绘制后 LANCZOS 下采样，保证小尺寸下依然清晰。
运行：python tools/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"


def rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build_master() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # 背景：竖直渐变（深蓝 → 亮蓝），先画渐变再裁剪成圆角
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gradient)
    top = (37, 99, 235)    # #2563eb
    bottom = (29, 78, 216) # #1d4ed8
    for y in range(SIZE):
        ratio = y / (SIZE - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3)) + (255,)
        gdraw.line([(0, y), (SIZE, y)], fill=color)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=104, fill=255)
    image.paste(gradient, (0, 0), mask)

    # 显示器外框
    rounded_rect(draw, (104, 150, 408, 344), radius=26, outline=(255, 255, 255, 255), width=26)
    # 屏幕里的「内容行」
    rounded_rect(draw, (150, 202, 322, 218), radius=8, fill=(255, 255, 255, 235))
    rounded_rect(draw, (150, 246, 366, 262), radius=8, fill=(255, 255, 255, 190))
    rounded_rect(draw, (150, 290, 292, 306), radius=8, fill=(255, 255, 255, 150))
    # 支架
    draw.rectangle((238, 344, 274, 392), fill=(255, 255, 255, 255))
    rounded_rect(draw, (176, 392, 336, 416), radius=12, fill=(255, 255, 255, 255))

    # 右上角「有变化」绿点
    draw.ellipse((366, 58, 470, 162), fill=(34, 197, 94, 255))
    draw.ellipse((404, 96, 432, 124), fill=(255, 255, 255, 255))

    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = build_master()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(OUT_DIR / f"icon{size}.png")
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
