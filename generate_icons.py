import os
import subprocess
from PIL import Image

ICONS_DIR = os.path.join(os.path.dirname(__file__), 'public', 'icons')
os.makedirs(ICONS_DIR, exist_ok=True)

# 1. Ensure icon.svg exists
svg_path = os.path.join(ICONS_DIR, 'icon.svg')

# 2. Render SVG at 512x512 with headless Chrome for crisp rasterization
html_temp = f"""<!DOCTYPE html>
<html>
<head>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{ width: 512px; height: 512px; overflow: hidden; background: transparent; }}
  img {{ width: 512px; height: 512px; display: block; }}
</style>
</head>
<body>
<img src="file://{os.path.abspath(svg_path)}">
</body>
</html>"""

temp_html_path = '/tmp/render_icon.html'
temp_png_path = '/tmp/render_icon_512.png'

with open(temp_html_path, 'w') as f:
    f.write(html_temp)

subprocess.run([
    'google-chrome',
    '--headless=new',
    f'--screenshot={temp_png_path}',
    '--window-size=512,512',
    '--default-background-color=00000000',
    f'file://{temp_html_path}'
], check=True)

base_img = Image.open(temp_png_path).convert('RGBA')

# 3. Standard 'any' icons (full bleed / rounded corners, crisp)
icon_512 = base_img
icon_192 = base_img.resize((192, 192), Image.Resampling.LANCZOS)

icon_512.save(os.path.join(ICONS_DIR, 'icon-512.png'), 'PNG', optimize=True)
icon_192.save(os.path.join(ICONS_DIR, 'icon-192.png'), 'PNG', optimize=True)

# 4. Maskable icons (Opaque background #040811, 100% solid, artwork in 80% safe zone)
maskable_bg_512 = Image.new('RGBA', (512, 512), (4, 8, 17, 255))
safe_size = 410  # 80% of 512 is ~409.6
scaled_artwork = base_img.resize((safe_size, safe_size), Image.Resampling.LANCZOS)
offset = (512 - safe_size) // 2
maskable_bg_512.paste(scaled_artwork, (offset, offset), scaled_artwork)

maskable_512 = maskable_bg_512.convert('RGB')
maskable_192 = maskable_512.resize((192, 192), Image.Resampling.LANCZOS)

maskable_512.save(os.path.join(ICONS_DIR, 'icon-maskable-512.png'), 'PNG', optimize=True)
maskable_192.save(os.path.join(ICONS_DIR, 'icon-maskable-192.png'), 'PNG', optimize=True)

print("✅ Todos os ícones (PNG-192, PNG-512, Maskable-192, Maskable-512) gerados com sucesso!")
