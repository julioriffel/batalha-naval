const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');
const webpush = require('web-push');

let PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function getAvailablePort(preferredPort) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(preferredPort, '0.0.0.0', () => {
      s.once('close', () => resolve(preferredPort));
      s.close();
    });
    s.on('error', () => {
      resolve(getAvailablePort(preferredPort + 1));
    });
  });
}


// --- Detect Local Wi-Fi / LAN IP ---
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    // Skip virtual, docker, loopback, or bridge interfaces
    if (
      name.startsWith('br-') ||
      name.startsWith('docker') ||
      name.startsWith('veth') ||
      name.startsWith('tun') ||
      name.startsWith('tap')
    ) {
      continue;
    }
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push({ name, address: net.address });
      }
    }
  }

  // Prioritize Wi-Fi (wl...), then Ethernet (en..., eth...), then others
  const wifi = candidates.find(c => c.name.startsWith('wl'));
  if (wifi) return wifi.address;

  const eth = candidates.find(c => c.name.startsWith('en') || c.name.startsWith('eth'));
  if (eth) return eth.address;

  return candidates.length > 0 ? candidates[0].address : 'localhost';
}

const LOCAL_IP = getLocalIpAddress();

// --- MIME Types ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API: Server info
  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        localIp: LOCAL_IP,
        port: PORT,
        baseUrl: `http://${LOCAL_IP}:${PORT}`
      })
    );
  }

  // API: Ranking de vitórias dos comandantes
  if (pathname === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ leaderboard: getSortedLeaderboard() }));
  }

  // API: Dynamic QR Code generation
  if (pathname === '/api/qr') {
    const text = parsedUrl.searchParams.get('text') || `http://${LOCAL_IP}:${PORT}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(text, {
        width: 280,
        margin: 2,
        color: {
          dark: '#00f0ff',
          light: '#07101e'
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ qr: qrDataUrl }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Erro gerando QR Code' }));
    }
  }

  // --- API: PUSH NOTIFICATIONS & SISTEMA DE AMIGOS ---
  // Helper para respostas JSON
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // 0. Listar Salas Públicas em Aberto
  if (pathname === '/api/rooms/public') {
    return sendJson(200, { rooms: getPublicWaitingRooms() });
  }

  // 1. Chave pública VAPID para registro do Service Worker
  if (pathname === '/api/push/vapid-public-key') {
    return sendJson(200, { publicKey: vapidKeys.publicKey });
  }

  // 2. Registro e Sincronização do Perfil do Jogador
  if (pathname === '/api/player/sync' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const persistentId = (body.persistentId || '').trim();
    const name = (body.name || 'Comandante').trim().substring(0, 15);
    let code = (body.code || '').trim().toUpperCase();

    if (!persistentId) {
      return sendJson(400, { error: 'persistentId obrigatório' });
    }

    let player = Object.values(playersData).find(p => p.persistentId === persistentId);

    if (!player) {
      if (!code || playersData[code]) {
        code = generateCommanderCode();
      }
      player = {
        code,
        persistentId,
        name,
        friends: [],
        pushSubscription: null,
        lastSeen: new Date().toISOString()
      };
      playersData[code] = player;
    } else {
      player.name = name;
      player.lastSeen = new Date().toISOString();
      code = player.code;
    }

    savePlayers(playersData);
    return sendJson(200, {
      code: player.code,
      name: player.name,
      persistentId: player.persistentId,
      pushEnabled: !!player.pushSubscription
    });
  }

  // 3. Ativar Inscrição de Notificações Push
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const code = (body.code || '').trim().toUpperCase();
    const subscription = body.subscription;

    if (!code || !playersData[code] || !subscription) {
      return sendJson(400, { error: 'Inscrição ou código de comandante inválido' });
    }

    playersData[code].pushSubscription = subscription;
    playersData[code].lastSeen = new Date().toISOString();
    savePlayers(playersData);

    return sendJson(200, {
      success: true,
      message: 'Notificações push táticas ativadas com sucesso!'
    });
  }

  // 4. Listar Amigos do Comandante e Pedidos Recebidos
  if (pathname === '/api/friends/list') {
    const code = (parsedUrl.searchParams.get('code') || '').trim().toUpperCase();
    const player = playersData[code];

    if (!player) {
      return sendJson(200, { friends: [], incomingRequests: [] });
    }

    const friendsList = (player.friends || []).map(fCode => {
      const f = playersData[fCode];
      const isMutual = !!(f && f.friends && f.friends.includes(code));
      return {
        code: fCode,
        name: f ? f.name : fCode,
        isMutual,
        pushEnabled: !!(f && f.pushSubscription),
        lastSeen: f ? f.lastSeen : null
      };
    });

    // Pedidos de amizade recebidos (comandantes que adicionaram este jogador mas ainda não foram retribuídos)
    const incomingRequests = Object.values(playersData)
      .filter(p => p.code !== code && Array.isArray(p.friends) && p.friends.includes(code) && (!player.friends || !player.friends.includes(p.code)))
      .map(p => ({
        code: p.code,
        name: p.name,
        pushEnabled: !!p.pushSubscription,
        lastSeen: p.lastSeen || null
      }));

    return sendJson(200, { friends: friendsList, incomingRequests });
  }

  // 5. Adicionar Amigo por Código
  if (pathname === '/api/friends/add' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const myCode = (body.myCode || '').trim().toUpperCase();
    const targetCode = (body.targetCode || '').trim().toUpperCase();

    if (!myCode || !targetCode) {
      return sendJson(400, { error: 'Códigos inválidos' });
    }

    if (myCode === targetCode) {
      return sendJson(400, { error: 'Você não pode adicionar seu próprio código como amigo.' });
    }

    const myPlayer = playersData[myCode];
    if (!myPlayer) {
      return sendJson(404, { error: 'Seu perfil de comandante não foi encontrado. Recarregue a página.' });
    }

    const targetPlayer = playersData[targetCode];
    if (!targetPlayer) {
      return sendJson(404, { error: `Nenhum comandante encontrado com o código ${targetCode}.` });
    }

    if (!myPlayer.friends) myPlayer.friends = [];
    if (!myPlayer.friends.includes(targetCode)) {
      myPlayer.friends.push(targetCode);
      savePlayers(playersData);
    }

    const isMutual = !!(targetPlayer.friends && targetPlayer.friends.includes(myCode));

    // Notifica em tempo real se o comandante alvo estiver online no WebSocket
    wss.clients.forEach(cWs => {
      if (cWs.friendCode === targetCode || (targetPlayer.persistentId && cWs.persistentId === targetPlayer.persistentId)) {
        send(cWs, 'friend_added_notice', {
          fromCode: myCode,
          fromName: myPlayer.name,
          isMutual
        });
      }
    });

    // Envia Push Notification para o comandante alvo se possuir inscrição ativa
    if (targetPlayer.pushSubscription) {
      const origin = (body.origin || '').replace(/\/$/, '') || `http://${LOCAL_IP}:${PORT}`;
      const pushTitle = isMutual 
        ? `Amizade Naval Confirmada!` 
        : `Pedido de Amizade de ${myPlayer.name}`;
      const pushBody = isMutual 
        ? `O Comandante ${myPlayer.name} retribuiu sua amizade! Vocês agora podem se desafiar para a batalha.` 
        : `O Comandante ${myPlayer.name} (${myCode}) adicionou você como amigo! Toque para aceitar o pedido.`;

      const pushPayload = JSON.stringify({
        title: pushTitle,
        body: pushBody,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: {
          url: `${origin}/?amigo=${myCode}&aceitar=1`,
          fromCode: myCode,
          fromName: myPlayer.name,
          type: 'friend_request'
        }
      });

      webpush.sendNotification(targetPlayer.pushSubscription, pushPayload).catch(pushErr => {
        console.warn('[WebPush] Falha ao enviar notificação de amizade:', pushErr.statusCode, pushErr.message);
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          targetPlayer.pushSubscription = null;
          savePlayers(playersData);
        }
      });
    }

    return sendJson(200, {
      success: true,
      isMutual,
      friend: {
        code: targetPlayer.code,
        name: targetPlayer.name,
        isMutual,
        pushEnabled: !!targetPlayer.pushSubscription
      }
    });
  }

  // 5.1 Recusar Pedido de Amizade
  if (pathname === '/api/friends/decline' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const myCode = (body.myCode || '').trim().toUpperCase();
    const requesterCode = (body.requesterCode || '').trim().toUpperCase();

    const requester = playersData[requesterCode];
    if (requester && requester.friends) {
      requester.friends = requester.friends.filter(c => c !== myCode);
      savePlayers(playersData);
    }

    return sendJson(200, { success: true });
  }

  // 6. Remover Amigo
  if (pathname === '/api/friends/remove' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const myCode = (body.myCode || '').trim().toUpperCase();
    const targetCode = (body.targetCode || '').trim().toUpperCase();

    const myPlayer = playersData[myCode];
    if (myPlayer && myPlayer.friends) {
      myPlayer.friends = myPlayer.friends.filter(c => c !== targetCode);
      savePlayers(playersData);
    }

    return sendJson(200, { success: true });
  }

  // 7. Chamar Amigo para Partida via Push Notification
  // REQUISITO: "Somente amigos podem chamar para a partida via push"
  if (pathname === '/api/friends/challenge' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const myCode = (body.myCode || '').trim().toUpperCase();
    const targetCode = (body.targetCode || '').trim().toUpperCase();

    const myPlayer = playersData[myCode];
    const targetPlayer = playersData[targetCode];

    if (!myPlayer || !targetPlayer) {
      return sendJson(404, { error: 'Comandante não encontrado.' });
    }

    const isMutual = myPlayer.friends && myPlayer.friends.includes(targetCode) &&
                     targetPlayer.friends && targetPlayer.friends.includes(myCode);

    if (!isMutual) {
      return sendJson(403, {
        error: `Apenas amigos mútuos podem se desafiar via notificação push! Peça para o Comandante ${targetPlayer.name} adicionar o seu código (${myCode}) aos amigos dele.`
      });
    }

    if (!targetPlayer.pushSubscription) {
      return sendJson(400, {
        error: `O Comandante ${targetPlayer.name} é seu amigo, mas ainda não ativou as notificações push no celular ou navegador.`
      });
    }

    const roomCode = generateRoomCode();
    const origin = (body.origin || '').replace(/\/$/, '') || `http://${LOCAL_IP}:${PORT}`;
    const battleUrl = `${origin}/?sala=${roomCode}&desafio=1`;

    const pushPayload = JSON.stringify({
      title: `Desafio Naval de ${myPlayer.name}`,
      body: `${myPlayer.name} te chamou para combater na Batalha Naval! Toque para entrar na sala ${roomCode}.`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: {
        url: battleUrl,
        roomCode,
        challengerName: myPlayer.name
      }
    });

    try {
      await webpush.sendNotification(targetPlayer.pushSubscription, pushPayload);
      console.log(`[WebPush] Desafio enviado de ${myCode} para ${targetCode} na sala ${roomCode}`);
    } catch (pushErr) {
      console.error('[WebPush] Erro enviando push notification:', pushErr.statusCode, pushErr.message);
      if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
        targetPlayer.pushSubscription = null;
        savePlayers(playersData);
        return sendJson(400, {
          error: 'A inscrição de notificações do amigo expirou. Ele precisa reativar o push no app.'
        });
      }
    }

    return sendJson(200, {
      success: true,
      roomCode,
      message: `Desafio enviado com sucesso para ${targetPlayer.name}! Sala ${roomCode} pronta.`
    });
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check: ensure filePath is within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('403 Proibido');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA if not found
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (fErr, content) => {
        if (fErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    let contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (pathname === '/manifest.json' || ext === '.webmanifest') {
      contentType = 'application/manifest+json; charset=utf-8';
    }

    const isNoCacheFile = pathname === '/' || pathname === '/index.html' || pathname === '/sw.js' || pathname === '/manifest.json';
    const headers = {
      'Content-Type': contentType
    };

    if (isNoCacheFile) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, proxy-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=60, must-revalidate';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

// --- Game Rules & Ship Specs ---
const SHIP_SPECS = [
  { id: 'carrier', name: 'Porta-Aviões', size: 5, icon: '' },
  { id: 'battleship', name: 'Encouraçado', size: 4, icon: '' },
  { id: 'cruiser', name: 'Cruzador', size: 3, icon: '' },
  { id: 'submarine', name: 'Submarino', size: 3, icon: '' },
  { id: 'destroyer', name: 'Contratorpedeiro', size: 2, icon: '' }
];

// --- Leaderboard / Ranking de Jogadores ---
const LEADERBOARD_FILE = path.join(__dirname, 'data', 'leaderboard.json');

function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erro lendo leaderboard:', e);
  }
  return {};
}

function saveLeaderboard(data) {
  try {
    const dir = path.dirname(LEADERBOARD_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro salvando leaderboard:', e);
  }
}

let leaderboardData = loadLeaderboard();

function getSortedLeaderboard(limit = 25) {
  return Object.values(leaderboardData)
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      return b.matches - a.matches;
    })
    .slice(0, limit);
}

function recordMatchResult(winnerName, loserName, winnerShots, winnerHits, loserShots, loserHits) {
  const now = new Date().toISOString();

  // Atualiza Vencedor
  const wKey = (winnerName || 'Comandante').trim().toLowerCase();
  if (!leaderboardData[wKey]) {
    leaderboardData[wKey] = {
      name: (winnerName || 'Comandante').trim(),
      wins: 0,
      losses: 0,
      matches: 0,
      winRate: 0,
      accuracy: 0,
      totalShots: 0,
      totalHits: 0,
      lastPlayed: now
    };
  }
  const w = leaderboardData[wKey];
  w.name = (winnerName || 'Comandante').trim();
  w.wins += 1;
  w.matches += 1;
  w.totalShots += (winnerShots || 0);
  w.totalHits += (winnerHits || 0);
  w.winRate = Math.round((w.wins / w.matches) * 100);
  w.accuracy = w.totalShots > 0 ? Math.round((w.totalHits / w.totalShots) * 100) : 0;
  w.lastPlayed = now;

  // Atualiza Perdedor
  const lKey = (loserName || 'Inimigo').trim().toLowerCase();
  if (!leaderboardData[lKey]) {
    leaderboardData[lKey] = {
      name: (loserName || 'Inimigo').trim(),
      wins: 0,
      losses: 0,
      matches: 0,
      winRate: 0,
      accuracy: 0,
      totalShots: 0,
      totalHits: 0,
      lastPlayed: now
    };
  }
  const l = leaderboardData[lKey];
  l.name = (loserName || 'Inimigo').trim();
  l.losses += 1;
  l.matches += 1;
  l.totalShots += (loserShots || 0);
  l.totalHits += (loserHits || 0);
  l.winRate = Math.round((l.wins / l.matches) * 100);
  l.accuracy = l.totalShots > 0 ? Math.round((l.totalHits / l.totalShots) * 100) : 0;
  l.lastPlayed = now;

  saveLeaderboard(leaderboardData);
  return getSortedLeaderboard();
}

// --- Push Notifications (Web Push & VAPID) ---
const VAPID_FILE = path.join(__dirname, 'data', 'vapid.json');

function getOrCreateVapidKeys() {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erro lendo vapid.json:', e);
  }
  const keys = webpush.generateVAPIDKeys();
  const dir = path.dirname(VAPID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), 'utf8');
  return keys;
}

const vapidKeys = getOrCreateVapidKeys();
webpush.setVapidDetails(
  'mailto:contato@bolsadedados.com.br',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// --- Players & Friends Store ---
const PLAYERS_FILE = path.join(__dirname, 'data', 'players.json');

function loadPlayers() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erro lendo players.json:', e);
  }
  return {};
}

function savePlayers(data) {
  try {
    const dir = path.dirname(PLAYERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro salvando players.json:', e);
  }
}

let playersData = loadPlayers();

function generateCommanderCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const code = `CMD-${rand}`;
  return playersData[code] ? generateCommanderCode() : code;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// --- Rooms & Game State ---
const rooms = new Map(); // roomCode -> room object

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function getPublicWaitingRooms() {
  const list = [];
  const toDelete = [];

  for (const [code, room] of rooms.entries()) {
    // 1. Elimina salas corrompidas ou sem lista de jogadores
    if (!room || !Array.isArray(room.players) || room.players.length === 0) {
      toDelete.push(code);
      continue;
    }

    // 2. Filtra estritamente jogadores com conexão WebSocket ativa e aberta
    const activePlayers = room.players.filter(p => p && p.ws && p.ws.readyState === WebSocket.OPEN);

    // Se não há nenhum jogador conectado na sala, purga do servidor
    if (activePlayers.length === 0) {
      toDelete.push(code);
      continue;
    }

    // 3. REGRA ESTRITA: Somente salas públicas em espera com exatamente 1 integrante ativo (menos de 2)
    if (room.isPublic && room.state === 'waiting' && activePlayers.length === 1) {
      const host = activePlayers[0];
      list.push({
        roomCode: code,
        hostName: host.name,
        hostFriendCode: host.friendCode || null,
        hostPersistentId: host.persistentId || null,
        playerCount: 1,
        maxPlayers: 2,
        createdAt: typeof room.createdAt === 'number' ? room.createdAt : (room.createdAt ? new Date(room.createdAt).getTime() : Date.now())
      });
    }
  }

  for (const code of toDelete) {
    rooms.delete(code);
  }

  return list;
}

function createEmptyGrid() {
  return Array.from({ length: 10 }, () => Array(10).fill(null));
}

function validateFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== SHIP_SPECS.length) {
    return { valid: false, error: 'A frota deve conter exatamente 5 navios.' };
  }

  const occupied = new Set();
  const specsMap = new Map(SHIP_SPECS.map(s => [s.id, s]));

  for (const ship of ships) {
    const spec = specsMap.get(ship.id);
    if (!spec) {
      return { valid: false, error: `Navio inválido: ${ship.id}` };
    }
    if (!Array.isArray(ship.coords) || ship.coords.length !== spec.size) {
      return { valid: false, error: `Tamanho incorreto para ${spec.name}` };
    }

    // Verify row/col bounds and line alignment
    const coords = ship.coords;
    const sameRow = coords.every(c => c.row === coords[0].row);
    const sameCol = coords.every(c => c.col === coords[0].col);

    if (!sameRow && !sameCol) {
      return { valid: false, error: `${spec.name} deve estar alinhado em linha reta.` };
    }

    // Verify contiguous cells
    if (sameRow) {
      const cols = coords.map(c => c.col).sort((a, b) => a - b);
      for (let i = 0; i < cols.length - 1; i++) {
        if (cols[i + 1] !== cols[i] + 1) {
          return { valid: false, error: `Células do ${spec.name} devem ser contínuas.` };
        }
      }
    } else {
      const rows = coords.map(c => c.row).sort((a, b) => a - b);
      for (let i = 0; i < rows.length - 1; i++) {
        if (rows[i + 1] !== rows[i] + 1) {
          return { valid: false, error: `Células do ${spec.name} devem ser contínuas.` };
        }
      }
    }

    for (const c of coords) {
      if (c.row < 0 || c.row > 9 || c.col < 0 || c.col > 9) {
        return { valid: false, error: `Coordenadas fora dos limites do radar.` };
      }
      const key = `${c.row},${c.col}`;
      if (occupied.has(key)) {
        return { valid: false, error: `Navios não podem se sobrepor.` };
      }
      occupied.add(key);
    }
  }

  return { valid: true };
}

// --- BOT / IA TÁTICA ---
function generateBotFleet() {
  const ships = [];
  const occupied = new Set();

  for (const spec of SHIP_SPECS) {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 250) {
      attempts++;
      const isHorizontal = Math.random() < 0.5;
      const maxRow = isHorizontal ? 10 : 10 - spec.size;
      const maxCol = isHorizontal ? 10 - spec.size : 10;
      const startRow = Math.floor(Math.random() * maxRow);
      const startCol = Math.floor(Math.random() * maxCol);

      const coords = [];
      let collides = false;
      for (let i = 0; i < spec.size; i++) {
        const r = isHorizontal ? startRow : startRow + i;
        const c = isHorizontal ? startCol + i : startCol;
        if (occupied.has(`${r},${c}`)) {
          collides = true;
          break;
        }
        coords.push({ row: r, col: c });
      }

      if (!collides) {
        coords.forEach(c => occupied.add(`${c.row},${c.col}`));
        ships.push({
          id: spec.id,
          name: spec.name,
          size: spec.size,
          coords,
          hits: 0,
          sunk: false
        });
        placed = true;
      }
    }
  }

  return ships;
}

function isUnshot(r, c, player) {
  if (r < 0 || r > 9 || c < 0 || c > 9) return false;
  const key = `${r},${c}`;
  return !player.hitsReceived.has(key) && !player.missesReceived.has(key);
}

function chooseBotTarget(difficulty, humanPlayer) {
  const allUnshot = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (isUnshot(r, c, humanPlayer)) {
        allUnshot.push({ row: r, col: c });
      }
    }
  }
  if (allUnshot.length === 0) return null;

  // Localizar acertos em navios ainda NÃO afundados (Target Mode)
  const activeHits = [];
  for (const ship of humanPlayer.ships) {
    if (!ship.sunk) {
      for (const c of ship.coords) {
        if (humanPlayer.hitsReceived.has(`${c.row},${c.col}`)) {
          activeHits.push({ row: c.row, col: c.col, shipId: ship.id });
        }
      }
    }
  }

  // MODO FÁCIL (Recruta)
  if (difficulty === 'easy') {
    if (activeHits.length > 0 && Math.random() < 0.25) {
      const h = activeHits[Math.floor(Math.random() * activeHits.length)];
      const neighbors = [
        { row: h.row - 1, col: h.col },
        { row: h.row + 1, col: h.col },
        { row: h.row, col: h.col - 1 },
        { row: h.row, col: h.col + 1 }
      ].filter(n => isUnshot(n.row, n.col, humanPlayer));

      if (neighbors.length > 0) {
        return neighbors[Math.floor(Math.random() * neighbors.length)];
      }
    }
    return allUnshot[Math.floor(Math.random() * allUnshot.length)];
  }

  // TARGET MODE (Médio e Difícil): Quando há acertos ativos não afundados
  if (activeHits.length > 0) {
    if (activeHits.length === 1) {
      const h = activeHits[0];
      const neighbors = [
        { row: h.row - 1, col: h.col },
        { row: h.row + 1, col: h.col },
        { row: h.row, col: h.col - 1 },
        { row: h.row, col: h.col + 1 }
      ].filter(n => isUnshot(n.row, n.col, humanPlayer));

      if (neighbors.length > 0) {
        return neighbors[Math.floor(Math.random() * neighbors.length)];
      }
    } else {
      // 2 ou mais acertos: verificar se estão alinhados
      const sameRow = activeHits.every(h => h.row === activeHits[0].row);
      const sameCol = activeHits.every(h => h.col === activeHits[0].col);

      if (sameRow) {
        const row = activeHits[0].row;
        const cols = activeHits.map(h => h.col).sort((a, b) => a - b);
        const minCol = cols[0];
        const maxCol = cols[cols.length - 1];
        const lineCandidates = [
          { row, col: minCol - 1 },
          { row, col: maxCol + 1 }
        ].filter(n => isUnshot(n.row, n.col, humanPlayer));

        if (lineCandidates.length > 0) {
          return lineCandidates[Math.floor(Math.random() * lineCandidates.length)];
        }
      } else if (sameCol) {
        const col = activeHits[0].col;
        const rows = activeHits.map(h => h.row).sort((a, b) => a - b);
        const minRow = rows[0];
        const maxRow = rows[rows.length - 1];
        const lineCandidates = [
          { row: minRow - 1, col },
          { row: maxRow + 1, col }
        ].filter(n => isUnshot(n.row, n.col, humanPlayer));

        if (lineCandidates.length > 0) {
          return lineCandidates[Math.floor(Math.random() * lineCandidates.length)];
        }
      }

      // Se alinhamento estiver bloqueado, tenta vizinhos de qualquer acerto ativo
      const allNeighbors = [];
      for (const h of activeHits) {
        const nList = [
          { row: h.row - 1, col: h.col },
          { row: h.row + 1, col: h.col },
          { row: h.row, col: h.col - 1 },
          { row: h.row, col: h.col + 1 }
        ].filter(n => isUnshot(n.row, n.col, humanPlayer));
        allNeighbors.push(...nList);
      }
      if (allNeighbors.length > 0) {
        return allNeighbors[Math.floor(Math.random() * allNeighbors.length)];
      }
    }
  }

  // HUNT MODE: Nenhum acerto ativo
  // MODO MÉDIO (Capitão): Varredura por paridade tipo xadrez
  if (difficulty === 'medium') {
    const parityCells = allUnshot.filter(c => (c.row + c.col) % 2 === 0);
    if (parityCells.length > 0) {
      return parityCells[Math.floor(Math.random() * parityCells.length)];
    }
    return allUnshot[Math.floor(Math.random() * allUnshot.length)];
  }

  // MODO DIFÍCIL (Almirante Cyber): Densidade de Probabilidade
  const unsunkSizes = humanPlayer.ships.filter(s => !s.sunk).map(s => s.size);
  const minSize = unsunkSizes.length > 0 ? Math.min(...unsunkSizes) : 2;

  const cellScores = new Map();
  for (const cell of allUnshot) {
    cellScores.set(`${cell.row},${cell.col}`, 0);
  }

  for (const size of unsunkSizes) {
    // Horizontal
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c <= 10 - size; c++) {
        let fits = true;
        for (let i = 0; i < size; i++) {
          const key = `${r},${c + i}`;
          if (humanPlayer.missesReceived.has(key)) {
            fits = false;
            break;
          }
        }
        if (fits) {
          for (let i = 0; i < size; i++) {
            const key = `${r},${c + i}`;
            if (cellScores.has(key)) {
              cellScores.set(key, cellScores.get(key) + 1);
            }
          }
        }
      }
    }
    // Vertical
    for (let r = 0; r <= 10 - size; r++) {
      for (let c = 0; c < 10; c++) {
        let fits = true;
        for (let i = 0; i < size; i++) {
          const key = `${r + i},${c}`;
          if (humanPlayer.missesReceived.has(key)) {
            fits = false;
            break;
          }
        }
        if (fits) {
          for (let i = 0; i < size; i++) {
            const key = `${r + i},${c}`;
            if (cellScores.has(key)) {
              cellScores.set(key, cellScores.get(key) + 1);
            }
          }
        }
      }
    }
  }

  let maxScore = -1;
  for (const s of cellScores.values()) {
    if (s > maxScore) maxScore = s;
  }

  let topCells = allUnshot.filter(c => (cellScores.get(`${c.row},${c.col}`) || 0) === maxScore);
  const parityTop = topCells.filter(c => (c.row + c.col) % minSize === 0);
  if (parityTop.length > 0) topCells = parityTop;

  return topCells[Math.floor(Math.random() * topCells.length)] || allUnshot[0];
}

function scheduleBotTurn(room, delay = 1000) {
  if (!room || !room.isBotMatch || room.state !== 'battle') return;
  if (room.botTimeout) clearTimeout(room.botTimeout);
  room.botTimeout = setTimeout(() => {
    executeBotTurn(room);
  }, delay);
}

function executeBotTurn(room) {
  if (!room || room.state !== 'battle' || !room.isBotMatch) return;
  const botIndex = room.players.findIndex(p => p.isBot);
  if (botIndex === -1 || room.currentTurnIndex !== botIndex) return;

  const bot = room.players[botIndex];
  const human = room.players[1 - botIndex];
  if (!human || !human.ws) return;

  const target = chooseBotTarget(room.botDifficulty, human);
  if (!target) return;

  const { row, col } = target;
  const shotKey = `${row},${col}`;
  bot.shotsFired++;

  let hitShip = null;
  for (const ship of human.ships) {
    const match = ship.coords.find(c => c.row === row && c.col === col);
    if (match) {
      hitShip = ship;
      break;
    }
  }

  let isHit = false;
  let sunkShipData = null;
  let isGameOver = false;

  if (hitShip) {
    isHit = true;
    bot.hitsLanded++;
    human.hitsReceived.add(shotKey);
    hitShip.hits++;

    if (hitShip.hits >= hitShip.size) {
      hitShip.sunk = true;
      sunkShipData = {
        id: hitShip.id,
        name: hitShip.name,
        size: hitShip.size,
        coords: hitShip.coords
      };
    }

    const allSunk = human.ships.every(s => s.sunk);
    if (allSunk) {
      isGameOver = true;
      room.state = 'gameover';
      room.winnerIndex = botIndex;
    }
  } else {
    human.missesReceived.add(shotKey);
  }

  let nextTurnIndex = botIndex;
  if (!isHit && !isGameOver) {
    nextTurnIndex = 1 - botIndex;
    room.currentTurnIndex = nextTurnIndex;
  }

  const nextTurnPlayer = room.players[nextTurnIndex];

  send(human.ws, 'shot_result', {
    target: { row, col },
    isHit,
    sunkShip: sunkShipData,
    isYourTurn: !isGameOver && nextTurnIndex !== botIndex,
    activePlayerName: nextTurnPlayer.name,
    role: 'defender'
  });

  if (isGameOver) {
    if (!room.scores) {
      room.scores = { [bot.id]: 0, [human.id]: 0 };
    }
    room.scores[bot.id] = (room.scores[bot.id] || 0) + 1;

    const currentLeaderboard = getSortedLeaderboard();

    send(human.ws, 'game_over', {
      isWinner: false,
      winnerName: bot.name,
      shotsFired: human.shotsFired,
      hitsLanded: human.hitsLanded,
      accuracy: human.shotsFired > 0 ? Math.round((human.hitsLanded / human.shotsFired) * 100) : 0,
      opponentFleet: bot.ships,
      opponentFriendCode: null,
      sessionScore: {
        myWins: room.scores[human.id] || 0,
        opponentWins: room.scores[bot.id] || 0,
        opponentName: bot.name
      },
      leaderboard: currentLeaderboard
    });
    return;
  }

  // Se o bot acertou e a partida continua: Tiro extra!
  if (isHit && !isGameOver) {
    scheduleBotTurn(room, 1200);
  }
}

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcastToRoom(room, type, data = {}) {
  room.players.forEach(p => {
    if (p && p.ws) {
      send(p.ws, type, data);
    }
  });
}

function broadcastPublicRooms() {
  const publicRooms = getPublicWaitingRooms();
  wss.clients.forEach(client => {
    if (client && client.readyState === WebSocket.OPEN) {
      send(client, 'public_rooms_updated', { rooms: publicRooms });
    }
  });
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.friendCode = null;
  ws.on('pong', () => { ws.isAlive = true; });

  // Envia lista atualizada de salas abertas imediatamente ao conectar
  send(ws, 'public_rooms_updated', {
    rooms: getPublicWaitingRooms()
  });

  let currentPlayerId = null;
  let currentRoomCode = null;

  ws.on('message', async message => {
    try {
      const payload = JSON.parse(message.toString());
      const { type } = payload;

      // 0. CONSULTAR RANKING
      if (type === 'get_leaderboard') {
        return send(ws, 'leaderboard_data', {
          leaderboard: getSortedLeaderboard()
        });
      }

      // 0.1 CONSULTAR SALAS PÚBLICAS EM ABERTO
      if (type === 'get_public_rooms') {
        return send(ws, 'public_rooms_updated', {
          rooms: getPublicWaitingRooms()
        });
      }

      // 0.2 REGISTRAR USUÁRIO NO WEBSOCKET (SINCRONIZAÇÃO EM TEMPO REAL)
      if (type === 'register_user') {
        const friendCode = (payload.friendCode || '').trim().toUpperCase() || null;
        const persistentId = (payload.persistentId || '').trim() || null;
        if (friendCode) ws.friendCode = friendCode;
        if (persistentId) ws.persistentId = persistentId;
        return;
      }

      // 1. CRIAR SALA
      if (type === 'create_room') {
        const roomCode = (payload.roomCode && !rooms.has(payload.roomCode)) ? payload.roomCode : generateRoomCode();
        const playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        const playerName = (payload.playerName || 'Comandante 1').trim().substring(0, 15);
        const friendCode = (payload.friendCode || '').trim().toUpperCase() || null;
        const persistentId = (payload.persistentId || '').trim() || null;
        const isPublic = payload.isPublic !== false; // Padrão pública a menos que venha false
        ws.friendCode = friendCode;

        // Se este jogador já estava em uma sala aguardando solo, limpa para evitar duplicatas no radar
        if (persistentId || friendCode) {
          for (const [code, r] of rooms.entries()) {
            if (r.state === 'waiting' && Array.isArray(r.players) && r.players.length === 1) {
              const host = r.players[0];
              if ((persistentId && host.persistentId === persistentId) || (friendCode && host.friendCode === friendCode)) {
                rooms.delete(code);
                if (r.isPublic) broadcastPublicRooms();
              }
            }
          }
        }

        // Se o cliente enviar seu origin (ex: https://batalha.bolsadedados.com.br), usa ele; caso contrário, IP local
        const origin = (payload.origin || '').replace(/\/$/, '') || `http://${LOCAL_IP}:${PORT}`;
        const joinUrl = `${origin}/?sala=${roomCode}`;
        let qrDataUrl = '';
        try {
          qrDataUrl = await QRCode.toDataURL(joinUrl, {
            width: 280,
            margin: 2,
            color: { dark: '#00f0ff', light: '#07101e' }
          });
        } catch (e) {
          console.error('Erro gerando QR:', e);
        }

        const room = {
          code: roomCode,
          isPublic,
          createdAt: Date.now(),
          state: 'waiting', // waiting -> placement -> battle -> gameover
          scores: { [playerId]: 0 },
          players: [
            {
              id: playerId,
              name: playerName,
              friendCode,
              persistentId,
              ws,
              ready: false,
              ships: [],
              hitsReceived: new Set(),
              missesReceived: new Set(),
              shotsFired: 0,
              hitsLanded: 0,
              rematch: false
            }
          ],
          currentTurnIndex: 0,
          winnerIndex: null
        };

        rooms.set(roomCode, room);
        currentPlayerId = playerId;
        currentRoomCode = roomCode;

        send(ws, 'room_created', {
          roomCode,
          playerId,
          playerName,
          friendCode,
          persistentId,
          isPublic,
          joinUrl,
          qrDataUrl,
          localIp: LOCAL_IP,
          port: PORT
        });

        if (isPublic) {
          broadcastPublicRooms();
        }
        return;
      }

      // 1.1 CRIAR PARTIDA CONTRA BOT (IA)
      if (type === 'create_bot_game') {
        const roomCode = generateRoomCode();
        const playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        const playerName = (payload.playerName || 'Comandante').trim().substring(0, 15) || 'Comandante';
        const friendCode = (payload.friendCode || '').trim().toUpperCase() || null;
        const persistentId = (payload.persistentId || '').trim() || null;
        const difficulty = ['easy', 'medium', 'hard'].includes(payload.difficulty) ? payload.difficulty : 'medium';

        let botName = 'BOT Capitão IA';
        if (difficulty === 'easy') botName = 'BOT Recruta IA';
        else if (difficulty === 'hard') botName = 'BOT Almirante Cyber';

        ws.friendCode = friendCode;

        // Se este jogador já estava em uma sala aguardando solo, limpa
        if (persistentId || friendCode) {
          for (const [code, r] of rooms.entries()) {
            if (r.state === 'waiting' && Array.isArray(r.players) && r.players.length === 1) {
              const host = r.players[0];
              if ((persistentId && host.persistentId === persistentId) || (friendCode && host.friendCode === friendCode)) {
                rooms.delete(code);
                if (r.isPublic) broadcastPublicRooms();
              }
            }
          }
        }

        const botId = 'bot_' + Math.random().toString(36).substring(2, 8);
        const botShips = generateBotFleet();

        const room = {
          code: roomCode,
          isPublic: false,
          isBotMatch: true,
          botDifficulty: difficulty,
          createdAt: Date.now(),
          state: 'placement',
          scores: { [playerId]: 0, [botId]: 0 },
          players: [
            {
              id: playerId,
              name: playerName,
              friendCode,
              persistentId,
              ws,
              ready: false,
              ships: [],
              hitsReceived: new Set(),
              missesReceived: new Set(),
              shotsFired: 0,
              hitsLanded: 0,
              rematch: false
            },
            {
              id: botId,
              name: botName,
              friendCode: null,
              persistentId: null,
              isBot: true,
              ws: null,
              ready: true,
              ships: botShips,
              hitsReceived: new Set(),
              missesReceived: new Set(),
              shotsFired: 0,
              hitsLanded: 0,
              rematch: false
            }
          ],
          currentTurnIndex: 0,
          winnerIndex: null,
          botTimeout: null
        };

        rooms.set(roomCode, room);
        currentPlayerId = playerId;
        currentRoomCode = roomCode;

        send(ws, 'room_created', {
          roomCode,
          playerId,
          playerName,
          friendCode,
          persistentId,
          isPublic: false,
          isBot: true,
          botDifficulty: difficulty,
          opponentName: botName
        });

        send(ws, 'room_joined', {
          roomCode,
          playerId,
          playerName,
          opponentName: botName,
          opponentFriendCode: null,
          isBot: true
        });

        send(ws, 'start_placement', {
          shipSpecs: SHIP_SPECS,
          opponentName: botName,
          isBot: true
        });

        return;
      }

      // 2. ENTRAR EM SALA
      if (type === 'join_room') {
        const roomCode = (payload.roomCode || '').toUpperCase().trim();
        const playerName = (payload.playerName || 'Comandante 2').trim().substring(0, 15);
        const friendCode = (payload.friendCode || '').trim().toUpperCase() || null;
        const persistentId = (payload.persistentId || '').trim() || null;
        ws.friendCode = friendCode;
        const room = rooms.get(roomCode);

        if (!room) {
          return send(ws, 'error', { message: 'Sala não encontrada. Verifique o código.' });
        }
        if (room.players.length >= 2) {
          return send(ws, 'error', { message: 'Esta sala já está cheia com 2 jogadores.' });
        }

        // Validação: Impedir a entrada duas vezes do mesmo usuário na mesma sala
        const isAlreadyInRoom = room.players.some(p => {
          if (p.ws === ws) return true;
          if (currentPlayerId && p.id === currentPlayerId) return true;
          if (persistentId && p.persistentId && p.persistentId === persistentId) return true;
          if (friendCode && p.friendCode && p.friendCode === friendCode) return true;
          return false;
        });

        if (isAlreadyInRoom) {
          return send(ws, 'error', {
            message: 'Você já está nesta sala! Não é permitido entrar duas vezes na mesma partida.'
          });
        }

        const playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        const newPlayer = {
          id: playerId,
          name: playerName,
          friendCode,
          persistentId,
          ws,
          ready: false,
          ships: [],
          hitsReceived: new Set(),
          missesReceived: new Set(),
          shotsFired: 0,
          hitsLanded: 0,
          rematch: false
        };

        room.players.push(newPlayer);
        if (!room.scores) room.scores = {};
        room.scores[playerId] = 0;
        room.state = 'placement';
        currentPlayerId = playerId;
        currentRoomCode = roomCode;

        if (room.isPublic) {
          broadcastPublicRooms();
        }

        // Notify both players to begin fleet placement
        send(ws, 'room_joined', {
          roomCode,
          playerId,
          playerName,
          opponentName: room.players[0].name,
          opponentFriendCode: room.players[0].friendCode
        });

        send(room.players[0].ws, 'opponent_joined', {
          opponentName: playerName,
          opponentFriendCode: friendCode
        });

        broadcastToRoom(room, 'start_placement', {
          shipSpecs: SHIP_SPECS
        });
        return;
      }

      // 3. CONFIRMAR FROTA (PLACEMENT PRONTO)
      if (type === 'submit_fleet') {
        const room = rooms.get(currentRoomCode);
        if (!room || room.state !== 'placement') return;

        const player = room.players.find(p => p.id === currentPlayerId);
        if (!player) return;

        const validation = validateFleet(payload.ships);
        if (!validation.valid) {
          return send(ws, 'error', { message: validation.error });
        }

        player.ships = payload.ships.map(s => {
          const spec = SHIP_SPECS.find(spec => spec.id === s.id);
          return {
            id: s.id,
            name: spec.name,
            size: spec.size,
            coords: s.coords,
            hits: 0,
            sunk: false
          };
        });
        player.ready = true;

        send(ws, 'fleet_confirmed');

        const opponent = room.players.find(p => p.id !== currentPlayerId);
        if (opponent && opponent.ws) {
          send(opponent.ws, 'opponent_ready');
        }

        // Se ambos estiverem prontos, inicia a batalha!
        if (room.players.length === 2 && room.players.every(p => p.ready)) {
          room.state = 'battle';
          // Sorteia quem começa
          room.currentTurnIndex = Math.random() < 0.5 ? 0 : 1;
          const startingPlayer = room.players[room.currentTurnIndex];

          room.players.forEach((p, idx) => {
            const isTurn = idx === room.currentTurnIndex;
            const opp = room.players[1 - idx];
            if (p && p.ws) {
              send(p.ws, 'battle_started', {
                isYourTurn: isTurn,
                activePlayerName: startingPlayer.name,
                activePlayerId: startingPlayer.id,
                opponentFriendCode: opp ? opp.friendCode : null,
                sessionScore: {
                  myWins: room.scores ? (room.scores[p.id] || 0) : 0,
                  opponentWins: room.scores ? (room.scores[opp.id] || 0) : 0,
                  opponentName: opp ? opp.name : 'Inimigo'
                }
              });
            }
          });

          // Se for partida contra bot e a vez inicial for do bot:
          if (room.isBotMatch && startingPlayer.isBot) {
            scheduleBotTurn(room, 1200);
          }
        }
        return;
      }

      // 4. DISPARAR TIRO (RADAR DE ATAQUE)
      if (type === 'fire') {
        const room = rooms.get(currentRoomCode);
        if (!room || room.state !== 'battle') return;

        const shooterIndex = room.currentTurnIndex;
        const shooter = room.players[shooterIndex];
        const defenderIndex = 1 - shooterIndex;
        const defender = room.players[defenderIndex];

        if (shooter.id !== currentPlayerId) {
          return send(ws, 'error', { message: 'Aguarde a sua vez de atacar!' });
        }

        const row = Number(payload.row);
        const col = Number(payload.col);

        if (isNaN(row) || isNaN(col) || row < 0 || row > 9 || col < 0 || col > 9) {
          return send(ws, 'error', { message: 'Coordenadas de disparo inválidas.' });
        }

        const shotKey = `${row},${col}`;
        if (defender.hitsReceived.has(shotKey) || defender.missesReceived.has(shotKey)) {
          return send(ws, 'error', { message: 'Esta coordenada já foi bombardeada!' });
        }

        shooter.shotsFired++;

        // Checar se acertou algum navio do defensor
        let hitShip = null;
        for (const ship of defender.ships) {
          const match = ship.coords.find(c => c.row === row && c.col === col);
          if (match) {
            hitShip = ship;
            break;
          }
        }

        let isHit = false;
        let sunkShipData = null;
        let isGameOver = false;

        if (hitShip) {
          isHit = true;
          shooter.hitsLanded++;
          defender.hitsReceived.add(shotKey);
          hitShip.hits++;

          if (hitShip.hits >= hitShip.size) {
            hitShip.sunk = true;
            sunkShipData = {
              id: hitShip.id,
              name: hitShip.name,
              size: hitShip.size,
              coords: hitShip.coords
            };
          }

          // Checar se todos os navios do defensor afundaram
          const allSunk = defender.ships.every(s => s.sunk);
          if (allSunk) {
            isGameOver = true;
            room.state = 'gameover';
            room.winnerIndex = shooterIndex;
          }
        } else {
          defender.missesReceived.add(shotKey);
        }

        // Regra de turno: Acertou joga de novo! Errou passa a vez.
        let nextTurnIndex = shooterIndex;
        if (!isHit && !isGameOver) {
          nextTurnIndex = defenderIndex;
          room.currentTurnIndex = nextTurnIndex;
        }

        const nextTurnPlayer = room.players[nextTurnIndex];

        // Notificar Atirador
        send(shooter.ws, 'shot_result', {
          target: { row, col },
          isHit,
          sunkShip: sunkShipData,
          isYourTurn: !isGameOver && nextTurnIndex === shooterIndex,
          activePlayerName: nextTurnPlayer.name,
          role: 'attacker'
        });

        // Notificar Defensor
        send(defender.ws, 'shot_result', {
          target: { row, col },
          isHit,
          sunkShip: sunkShipData,
          isYourTurn: !isGameOver && nextTurnIndex === defenderIndex,
          activePlayerName: nextTurnPlayer.name,
          role: 'defender'
        });

        // Se o jogo acabou, envia tela de vitória/derrota com dados finais e revelação da frota inimiga
        if (isGameOver) {
          if (!room.scores) {
            room.scores = { [shooter.id]: 0, [defender.id]: 0 };
          }
          room.scores[shooter.id] = (room.scores[shooter.id] || 0) + 1;

          // Atualiza ranking persistente no servidor (somente multiplayer humano)
          if (!room.isBotMatch) {
            recordMatchResult(
              shooter.name,
              defender.name,
              shooter.shotsFired,
              shooter.hitsLanded,
              defender.shotsFired,
              defender.hitsLanded
            );
          }

          const currentLeaderboard = getSortedLeaderboard();

          send(shooter.ws, 'game_over', {
            isWinner: true,
            winnerName: shooter.name,
            shotsFired: shooter.shotsFired,
            hitsLanded: shooter.hitsLanded,
            accuracy: Math.round((shooter.hitsLanded / shooter.shotsFired) * 100),
            opponentFleet: defender.ships,
            opponentFriendCode: defender.friendCode,
            sessionScore: {
              myWins: room.scores[shooter.id],
              opponentWins: room.scores[defender.id] || 0,
              opponentName: defender.name
            },
            leaderboard: currentLeaderboard
          });

          send(defender.ws, 'game_over', {
            isWinner: false,
            winnerName: shooter.name,
            shotsFired: defender.shotsFired,
            hitsLanded: defender.hitsLanded,
            accuracy: defender.shotsFired > 0 ? Math.round((defender.hitsLanded / defender.shotsFired) * 100) : 0,
            opponentFleet: shooter.ships,
            opponentFriendCode: shooter.friendCode,
            sessionScore: {
              myWins: room.scores[defender.id] || 0,
              opponentWins: room.scores[shooter.id],
              opponentName: shooter.name
            },
            leaderboard: currentLeaderboard
          });
          return;
        }

        // Se for jogo com bot e o próximo turno for do bot:
        if (room.isBotMatch && nextTurnIndex === defenderIndex && defender.isBot) {
          scheduleBotTurn(room, 1000);
        }
        return;
      }

      // 5. PEDIDO DE REVANCHE
      if (type === 'request_rematch') {
        const room = rooms.get(currentRoomCode);
        if (!room || room.state !== 'gameover') return;

        const player = room.players.find(p => p.id === currentPlayerId);
        if (!player) return;

        player.rematch = true;

        if (room.isBotMatch) {
          const bot = room.players.find(p => p.isBot);
          if (bot) {
            bot.rematch = true;
            room.state = 'placement';
            bot.ships = generateBotFleet();
            bot.ready = true;
            bot.hitsReceived.clear();
            bot.missesReceived.clear();
            bot.shotsFired = 0;
            bot.hitsLanded = 0;
            bot.rematch = false;

            player.ready = false;
            player.ships = [];
            player.hitsReceived.clear();
            player.missesReceived.clear();
            player.shotsFired = 0;
            player.hitsLanded = 0;
            player.rematch = false;

            send(ws, 'rematch_accepted');
            send(ws, 'start_placement', {
              shipSpecs: SHIP_SPECS,
              opponentName: bot.name,
              isBot: true
            });
            return;
          }
        }

        const opponent = room.players.find(p => p.id !== currentPlayerId);

        if (opponent && opponent.rematch) {
          // Ambos aceitaram a revanche! Reinicia o jogo
          room.state = 'placement';
          room.players.forEach(p => {
            p.ready = false;
            p.ships = [];
            p.hitsReceived.clear();
            p.missesReceived.clear();
            p.shotsFired = 0;
            p.hitsLanded = 0;
            p.rematch = false;
          });

          broadcastToRoom(room, 'rematch_accepted');
          broadcastToRoom(room, 'start_placement', {
            shipSpecs: SHIP_SPECS
          });
        } else {
          // Avisa o adversário que este jogador pediu revanche
          if (opponent && opponent.ws) {
            send(opponent.ws, 'opponent_wants_rematch', {
              message: `${player.name} solicitou uma revanche!`
            });
          }
          send(ws, 'rematch_pending');
        }
        return;
      }

      // 6. ABANDONAR / RENDER-SE DA BATALHA
      if (type === 'surrender') {
        const room = rooms.get(currentRoomCode);
        if (!room || room.state !== 'battle') return;

        if (room.botTimeout) clearTimeout(room.botTimeout);

        const forfeiter = room.players.find(p => p.id === currentPlayerId);
        const winner = room.players.find(p => p.id !== currentPlayerId);
        if (!forfeiter || !winner) return;

        room.state = 'gameover';
        if (!room.scores) {
          room.scores = { [winner.id]: 0, [forfeiter.id]: 0 };
        }
        room.scores[winner.id] = (room.scores[winner.id] || 0) + 1;

        if (!room.isBotMatch) {
          recordMatchResult(
            winner.name,
            forfeiter.name,
            winner.shotsFired,
            winner.hitsLanded,
            forfeiter.shotsFired,
            forfeiter.hitsLanded
          );
        }

        const currentLeaderboard = getSortedLeaderboard();

        // Notificar o vencedor da desistência (se for conexão real)
        if (winner.ws) {
          send(winner.ws, 'game_over', {
            isWinner: true,
            winnerName: winner.name,
            forfeit: true,
            message: `${forfeiter.name} abandonou a batalha!`,
            shotsFired: winner.shotsFired,
            hitsLanded: winner.hitsLanded,
            accuracy: winner.shotsFired > 0 ? Math.round((winner.hitsLanded / winner.shotsFired) * 100) : 0,
            opponentFleet: forfeiter.ships,
            opponentFriendCode: forfeiter.friendCode,
            sessionScore: {
              myWins: room.scores[winner.id],
              opponentWins: room.scores[forfeiter.id] || 0,
              opponentName: forfeiter.name
            },
            leaderboard: currentLeaderboard
          });
        }

        send(ws, 'surrender_acknowledged', {
          message: 'Você abandonou a batalha.'
        });
        return;
      }

      // 7. SAIR DA SALA VOLUNTARIAMENTE (PLACEMENT OU WAITING)
      if (type === 'leave_room') {
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        if (room.botTimeout) clearTimeout(room.botTimeout);

        const wasPublic = room.isPublic;
        const remaining = room.players.filter(p => p.id !== currentPlayerId);
        if (remaining.length === 0) {
          rooms.delete(currentRoomCode);
          if (wasPublic) broadcastPublicRooms();
        } else {
          room.players = remaining;
          room.state = 'waiting';
          if (wasPublic) broadcastPublicRooms();
          const opponent = remaining[0];
          if (opponent && opponent.ws) {
            send(opponent.ws, 'opponent_left', {
              message: 'O comandante adversário saiu da sala.'
            });
          }
        }
        currentRoomCode = null;
        send(ws, 'left_room_success');
        return;
      }

    } catch (err) {
      console.error('Erro processando mensagem WebSocket:', err);
      send(ws, 'error', { message: 'Comando inválido recebido pelo radar.' });
    }
  });

  ws.on('close', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    if (room.botTimeout) clearTimeout(room.botTimeout);

    if (room.isBotMatch) {
      rooms.delete(currentRoomCode);
      return;
    }

    const wasPublic = room.isPublic;
    // Remover jogador ou notificar adversário
    const remaining = room.players.filter(p => p.id !== currentPlayerId);
    if (remaining.length === 0) {
      rooms.delete(currentRoomCode);
      if (wasPublic) broadcastPublicRooms();
      console.log(`[Sala ${currentRoomCode}] Encerrada (todos desconectados).`);
    } else {
      room.players = remaining;
      room.state = 'waiting';
      if (wasPublic) broadcastPublicRooms();
      const opponent = remaining[0];
      if (opponent && opponent.ws) {
        send(opponent.ws, 'opponent_disconnected', {
          message: 'O comandante adversário se desconectou da batalha naval.'
        });
      }
    }
  });
});

// Ping interval to keep connections alive on mobile
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// --- Start Server ---
async function start() {
  const chosenPort = await getAvailablePort(PORT);
  PORT = chosenPort;

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`⚓ BATALHA NAVAL HIGH-TECH - SERVIDOR INICIADO!`);
    console.log(`======================================================`);
    console.log(`💻 Acesso local (neste computador):`);
    console.log(`   👉 http://localhost:${PORT}`);
    console.log(`\n📱 Acesso no CELULAR (mesma rede Wi-Fi / Intranet):`);
    console.log(`   👉 http://${LOCAL_IP}:${PORT}`);
    console.log(`======================================================\n`);
  });
}

start();


