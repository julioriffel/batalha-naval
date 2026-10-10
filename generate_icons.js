const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const iconsDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// 1. Criar ícone SVG em alta resolução
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#0d1b2a"/>
      <stop offset="70%" stop-color="#07101e"/>
      <stop offset="100%" stop-color="#030710"/>
    </radialGradient>
    <radialGradient id="radarGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(0, 240, 255, 0.25)"/>
      <stop offset="60%" stop-color="rgba(0, 240, 255, 0.08)"/>
      <stop offset="100%" stop-color="rgba(0, 240, 255, 0)"/>
    </radialGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background Shield -->
  <rect width="512" height="512" rx="100" fill="url(#bg)"/>
  <rect width="496" height="496" x="8" y="8" rx="92" fill="none" stroke="#00f0ff" stroke-width="4" stroke-opacity="0.3"/>

  <!-- Radar circles -->
  <circle cx="256" cy="256" r="200" fill="url(#radarGlow)" stroke="#00f0ff" stroke-width="3" stroke-opacity="0.5"/>
  <circle cx="256" cy="256" r="140" fill="none" stroke="#00f0ff" stroke-width="2" stroke-opacity="0.4" stroke-dasharray="8 6"/>
  <circle cx="256" cy="256" r="80" fill="none" stroke="#00f0ff" stroke-width="2" stroke-opacity="0.5"/>
  <circle cx="256" cy="256" r="20" fill="#00f0ff" fill-opacity="0.4"/>

  <!-- Crosshairs -->
  <line x1="256" y1="36" x2="256" y2="476" stroke="#00f0ff" stroke-width="2" stroke-opacity="0.4"/>
  <line x1="36" y1="256" x2="476" y2="256" stroke="#00f0ff" stroke-width="2" stroke-opacity="0.4"/>

  <!-- Tactical Anchor / Warship Icon -->
  <g filter="url(#glow)" transform="translate(156, 136)">
    <!-- Anchor Crown & Stock -->
    <circle cx="100" cy="40" r="22" fill="none" stroke="#00f0ff" stroke-width="14"/>
    <line x1="100" y1="62" x2="100" y2="190" stroke="#00f0ff" stroke-width="18" stroke-linecap="round"/>
    <line x1="50" y1="85" x2="150" y2="85" stroke="#00f0ff" stroke-width="16" stroke-linecap="round"/>
    <!-- Anchor Flukes -->
    <path d="M 30,140 C 30,210 170,210 170,140" fill="none" stroke="#00f0ff" stroke-width="18" stroke-linecap="round"/>
    <!-- Triangular Palms -->
    <polygon points="15,145 30,120 45,145" fill="#00ffaa"/>
    <polygon points="155,145 170,120 185,145" fill="#00ffaa"/>
  </g>

  <!-- Blip Targets -->
  <circle cx="340" cy="180" r="8" fill="#ff2a55" filter="url(#glow)"/>
  <circle cx="170" cy="330" r="6" fill="#ff9900" filter="url(#glow)"/>
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent, 'utf8');

// Função pura em Node.js para criar um arquivo PNG sem dependências externas
function createPng(width, height, drawFn) {
  // RGBA buffer (width * height * 4)
  const buffer = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b, a] = drawFn(x, y, width, height);
      buffer[idx] = r;
      buffer[idx + 1] = g;
      buffer[idx + 2] = b;
      buffer[idx + 3] = a;
    }
  }

  // PNG requires scanlines with a filter byte (0) before each line
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // Filter type None
    buffer.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
      }
    }
    return (crc ^ -1) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const toCrc = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(toCrc), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  // PNG Header
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdr, idat, iend]);
}

// Função de desenho tático para gerar ícone PNG
function drawTacticalIcon(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxR = w / 2;

  // Background escuro arredondado
  if (Math.abs(dx) > w * 0.46 || Math.abs(dy) > h * 0.46) {
    return [0, 0, 0, 0]; // Transparent outer corners
  }

  // Gradiente radial de fundo
  const normDist = dist / maxR;
  let r = 7;
  let g = 16;
  let b = 30;

  if (normDist < 1.0) {
    r = Math.floor(13 * (1 - normDist * 0.7));
    g = Math.floor(27 * (1 - normDist * 0.7));
    b = Math.floor(45 * (1 - normDist * 0.7));
  }

  // Círculos de radar ciano
  const r1 = w * 0.4;
  const r2 = w * 0.28;
  const r3 = w * 0.16;

  if (Math.abs(dist - r1) < 2 || Math.abs(dist - r2) < 2 || Math.abs(dist - r3) < 2) {
    return [0, 240, 255, 255];
  }

  // Cruz de mira
  if ((Math.abs(x - cx) < 1.5 || Math.abs(y - cy) < 1.5) && dist < r1) {
    return [0, 240, 255, 200];
  }

  // Símbolo de âncora/navio central
  if (Math.abs(x - cx) < w * 0.04 && y > cy - h * 0.2 && y < cy + h * 0.18) {
    return [0, 255, 170, 255]; // Haste verde neon
  }
  if (Math.abs(y - (cy - h * 0.08)) < h * 0.03 && Math.abs(x - cx) < w * 0.16) {
    return [0, 240, 255, 255]; // Barra transversal
  }
  // Arco inferior da âncora
  const arcDist = Math.sqrt(dx * dx + (dy - h * 0.06) * (dy - h * 0.06));
  if (Math.abs(arcDist - w * 0.18) < 4 && y > cy) {
    return [0, 255, 170, 255];
  }

  // Ponto vermelho (alvo no radar)
  const targetDist = Math.sqrt((x - (cx + w * 0.18)) ** 2 + (y - (cy - h * 0.18)) ** 2);
  if (targetDist < 6) {
    return [255, 42, 85, 255];
  }

  return [r, g, b, 255];
}

const png192 = createPng(192, 192, drawTacticalIcon);
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), png192);

const png512 = createPng(512, 512, drawTacticalIcon);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), png512);

console.log('✅ Ícones SVG, PNG-192 e PNG-512 gerados com sucesso em public/icons/!');
