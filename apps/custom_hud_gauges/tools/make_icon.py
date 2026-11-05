# 140x140 tile icon: a speedometer-style arc with a needle, transparent padding.
import sys, math
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 4
N = 140 * S
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
col = (235, 238, 242, 255)
cx, cy, r = N // 2, int(N * 0.58), int(N * 0.36)
d.arc([cx - r, cy - r, cx + r, cy + r], 150, 390, fill=col, width=7 * S)
a = math.radians(-35)
d.line([cx, cy, cx + int(r * 0.85 * math.cos(a)), cy + int(r * 0.85 * math.sin(a))], fill=col, width=6 * S)
d.ellipse([cx - 7 * S, cy - 7 * S, cx + 7 * S, cy + 7 * S], fill=col)
img.resize((140, 140), Image.LANCZOS).save(out)
print("wrote", out)
