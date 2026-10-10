const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

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
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// --- Game Rules & Ship Specs ---
const SHIP_SPECS = [
  { id: 'carrier', name: 'Porta-Aviões', size: 5, icon: '🚢' },
  { id: 'battleship', name: 'Encouraçado', size: 4, icon: '⚔️' },
  { id: 'cruiser', name: 'Cruzador', size: 3, icon: '🛡️' },
  { id: 'submarine', name: 'Submarino', size: 3, icon: '🌊' },
  { id: 'destroyer', name: 'Contratorpedeiro', size: 2, icon: '⚡' }
];

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

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentPlayerId = null;
  let currentRoomCode = null;

  ws.on('message', async message => {
    try {
      const payload = JSON.parse(message.toString());
      const { type } = payload;

      // 1. CRIAR SALA
      if (type === 'create_room') {
        const roomCode = generateRoomCode();
        const playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        const playerName = (payload.playerName || 'Comandante 1').trim().substring(0, 15);

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
          state: 'waiting', // waiting -> placement -> battle -> gameover
          players: [
            {
              id: playerId,
              name: playerName,
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
          joinUrl,
          qrDataUrl,
          localIp: LOCAL_IP,
          port: PORT
        });
        return;
      }

      // 2. ENTRAR EM SALA
      if (type === 'join_room') {
        const roomCode = (payload.roomCode || '').toUpperCase().trim();
        const playerName = (payload.playerName || 'Comandante 2').trim().substring(0, 15);
        const room = rooms.get(roomCode);

        if (!room) {
          return send(ws, 'error', { message: 'Sala não encontrada. Verifique o código.' });
        }
        if (room.players.length >= 2) {
          return send(ws, 'error', { message: 'Esta sala já está cheia com 2 jogadores.' });
        }

        const playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        const newPlayer = {
          id: playerId,
          name: playerName,
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
        room.state = 'placement';
        currentPlayerId = playerId;
        currentRoomCode = roomCode;

        // Notify both players to begin fleet placement
        send(ws, 'room_joined', {
          roomCode,
          playerId,
          playerName,
          opponentName: room.players[0].name
        });

        send(room.players[0].ws, 'opponent_joined', {
          opponentName: playerName
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
            send(p.ws, 'battle_started', {
              isYourTurn: isTurn,
              activePlayerName: startingPlayer.name,
              activePlayerId: startingPlayer.id
            });
          });
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
          send(shooter.ws, 'game_over', {
            isWinner: true,
            winnerName: shooter.name,
            shotsFired: shooter.shotsFired,
            hitsLanded: shooter.hitsLanded,
            accuracy: Math.round((shooter.hitsLanded / shooter.shotsFired) * 100),
            opponentFleet: defender.ships
          });

          send(defender.ws, 'game_over', {
            isWinner: false,
            winnerName: shooter.name,
            shotsFired: defender.shotsFired,
            hitsLanded: defender.hitsLanded,
            accuracy: defender.shotsFired > 0 ? Math.round((defender.hitsLanded / defender.shotsFired) * 100) : 0,
            opponentFleet: shooter.ships
          });
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

    } catch (err) {
      console.error('Erro processando mensagem WebSocket:', err);
      send(ws, 'error', { message: 'Comando inválido recebido pelo radar.' });
    }
  });

  ws.on('close', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    // Remover jogador ou notificar adversário
    const remaining = room.players.filter(p => p.id !== currentPlayerId);
    if (remaining.length === 0) {
      rooms.delete(currentRoomCode);
      console.log(`[Sala ${currentRoomCode}] Encerrada (todos desconectados).`);
    } else {
      room.players = remaining;
      room.state = 'waiting';
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


