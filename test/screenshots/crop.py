"""Downscale raw workbench captures for the README (full window, so the popup visibly floats)."""
import glob, os
from PIL import Image

for f in sorted(glob.glob(os.path.join(os.path.dirname(__file__), '../../media/screenshots/*.png'))):
    im = Image.open(f).convert('RGB')
    if im.size[0] <= 1600:
        continue  # already processed
    im = im.resize((1600, round(1600 * im.size[1] / im.size[0])), Image.LANCZOS)
    im.save(f, optimize=True)
    print(os.path.basename(f), im.size)
