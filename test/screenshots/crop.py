"""Crop raw workbench captures to explorer + popup + editor and downscale for the README."""
import glob, os, sys
from PIL import Image

for f in sorted(glob.glob(os.path.join(os.path.dirname(__file__), '../../media/screenshots/*.png'))):
    im = Image.open(f).convert('RGB')
    if im.size[0] <= 1600:
        continue  # already processed
    k = im.size[0] / 1400
    im = im.crop((0, 0, int(1160 * k), int(660 * k)))
    im = im.resize((1600, round(1600 * im.size[1] / im.size[0])), Image.LANCZOS)
    im.save(f, optimize=True)
    print(os.path.basename(f), im.size)
