
import sys, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
text = open(sys.argv[1], encoding="utf-8").read().splitlines()
font = ImageFont.truetype(sys.argv[3], 30, layout_engine=ImageFont.Layout.RAQM)
W, H = 1654, 1100
img = Image.new("L", (W, H), 245); d = ImageDraw.Draw(img)
y = 80
for line in text:
    d.text((W - 90, y), line, font=font, fill=20, anchor="ra", direction="rtl", language="ar"); y += 62
rng = random.Random(1)
px = img.load()
for _ in range(25000):
    x, yy = rng.randrange(W), rng.randrange(H); px[x, yy] = rng.choice([90, 160, 200])
img = img.rotate(1.3, resample=Image.BICUBIC, fillcolor=235).filter(ImageFilter.GaussianBlur(0.8))
img.save(sys.argv[2], quality=55)
