// Teste automatizado do fluxo de 2 jogadores via WebSocket
const { WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;

async function runTest() {
  console.log(`🧪 Iniciando teste automatizado da Batalha Naval na porta ${PORT}...`);

  // 1. Testar HTTP API
  const info = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/api/info`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  console.log('✅ /api/info OK:', info);

  // 1.1 Testar HTTP Leaderboard API
  const leaderboardApi = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/api/leaderboard`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  if (!Array.isArray(leaderboardApi.leaderboard)) {
    throw new Error('API /api/leaderboard não retornou array válido');
  }
  console.log(`✅ /api/leaderboard OK (${leaderboardApi.leaderboard.length} registros)`);

  function postJson(path, body) {
    return new Promise((resolve, reject) => {
      const dataStr = JSON.stringify(body);
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr)
        }
      }, res => {
        let resData = '';
        res.on('data', c => resData += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode, body: resData });
          }
        });
      });
      req.on('error', reject);
      req.write(dataStr);
      req.end();
    });
  }

  // 1.2 Testar chave pública VAPID
  const vapidKeyRes = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/api/push/vapid-public-key`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  if (!vapidKeyRes.publicKey) throw new Error('VAPID public key não retornada');
  console.log('✅ /api/push/vapid-public-key OK');

  // 1.3 Testar registro de jogadores (Comandante A e Comandante B)
  const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const syncA = await postJson('/api/player/sync', { persistentId: 'uuid-teste-a-' + uniqueSuffix, name: 'Comandante Alfa' });
  const syncB = await postJson('/api/player/sync', { persistentId: 'uuid-teste-b-' + uniqueSuffix, name: 'Comandante Bravo' });
  const codeA = syncA.body.code;
  const codeB = syncB.body.code;
  if (!codeA || !codeB || !codeA.startsWith('CMD-') || !codeB.startsWith('CMD-')) {
    throw new Error('Códigos de comandante inválidos gerados pelo sync');
  }
  console.log(`✅ Registro de jogadores OK: Alfa (${codeA}) e Bravo (${codeB})`);

  // 1.4 Testar adição de amigo unidirecional (Alfa adiciona Bravo)
  const add1 = await postJson('/api/friends/add', { myCode: codeA, targetCode: codeB });
  if (add1.body.isMutual !== false) throw new Error('Amizade não deveria ser mútua ainda');
  console.log('✅ Alfa adicionou Bravo aos amigos (status: pendente retribuição)');

  // 1.5 Testar regra de segurança: Somente amigos mútuos podem chamar para partida via push!
  const chalFail = await postJson('/api/friends/challenge', { myCode: codeA, targetCode: codeB });
  if (chalFail.status !== 403) throw new Error(`Deveria retornar 403 para não-mútuo, retornou ${chalFail.status}`);
  console.log('✅ Bloqueio de push para não-amigos validado com sucesso (403)');

  // 1.6 Bravo adiciona Alfa de volta -> torna-se amizade mútua!
  const add2 = await postJson('/api/friends/add', { myCode: codeB, targetCode: codeA });
  if (add2.body.isMutual !== true) throw new Error('Amizade deveria ser mútua agora');
  console.log('✅ Bravo retribuiu amizade (status: amigos mútuos)');

  // 1.7 Bravo tenta ser chamado sem ter push ativado
  const chalNoPush = await postJson('/api/friends/challenge', { myCode: codeA, targetCode: codeB });
  if (chalNoPush.status !== 400) throw new Error('Deveria avisar que push não está ativo');
  console.log('✅ Validação de push ausente verificada com sucesso (400)');

  // 2. Conectar Jogador 1 (Host)
  const ws1 = new WebSocket(`ws://localhost:${PORT}`);
  let roomCode = '';

  await new Promise(resolve => ws1.on('open', resolve));
  console.log('✅ Jogador 1 conectado via WebSocket');

  const p1Created = new Promise(resolve => {
    ws1.on('message', msg => {
      const data = JSON.parse(msg.toString());
      if (data.type === 'room_created') {
        roomCode = data.roomCode;
        console.log(`✅ Sala criada com código: ${roomCode}`);
        resolve(data);
      }
    });
  });

  ws1.send(JSON.stringify({ type: 'create_room', playerName: 'Comandante Alfa' }));
  await p1Created;

  // 3. Conectar Jogador 2
  const ws2 = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(resolve => ws2.on('open', resolve));
  console.log('✅ Jogador 2 conectado via WebSocket');

  const placementStarted = Promise.all([
    new Promise(res => ws1.on('message', m => { if (JSON.parse(m.toString()).type === 'start_placement') res(); })),
    new Promise(res => ws2.on('message', m => { if (JSON.parse(m.toString()).type === 'start_placement') res(); }))
  ]);

  ws2.send(JSON.stringify({ type: 'join_room', roomCode, playerName: 'Comandante Bravo' }));
  await placementStarted;
  console.log('✅ Ambos os jogadores entraram na fase de posicionamento');

  // 4. Posicionar frotas válidas para ambos os jogadores
  const fleetP1 = [
    { id: 'carrier', coords: [{row: 0, col: 0}, {row: 0, col: 1}, {row: 0, col: 2}, {row: 0, col: 3}, {row: 0, col: 4}] },
    { id: 'battleship', coords: [{row: 2, col: 0}, {row: 2, col: 1}, {row: 2, col: 2}, {row: 2, col: 3}] },
    { id: 'cruiser', coords: [{row: 4, col: 0}, {row: 4, col: 1}, {row: 4, col: 2}] },
    { id: 'submarine', coords: [{row: 6, col: 0}, {row: 6, col: 1}, {row: 6, col: 2}] },
    { id: 'destroyer', coords: [{row: 8, col: 0}, {row: 8, col: 1}] }
  ];

  const fleetP2 = [
    { id: 'carrier', coords: [{row: 1, col: 0}, {row: 1, col: 1}, {row: 1, col: 2}, {row: 1, col: 3}, {row: 1, col: 4}] },
    { id: 'battleship', coords: [{row: 3, col: 0}, {row: 3, col: 1}, {row: 3, col: 2}, {row: 3, col: 3}] },
    { id: 'cruiser', coords: [{row: 5, col: 0}, {row: 5, col: 1}, {row: 5, col: 2}] },
    { id: 'submarine', coords: [{row: 7, col: 0}, {row: 7, col: 1}, {row: 7, col: 2}] },
    { id: 'destroyer', coords: [{row: 9, col: 0}, {row: 9, col: 1}] }
  ];

  let battleDataP1 = null;
  let battleDataP2 = null;

  const battleStarted = Promise.all([
    new Promise(res => ws1.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'battle_started') { battleDataP1 = d; res(); }
    })),
    new Promise(res => ws2.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'battle_started') { battleDataP2 = d; res(); }
    }))
  ]);

  ws1.send(JSON.stringify({ type: 'submit_fleet', ships: fleetP1 }));
  ws2.send(JSON.stringify({ type: 'submit_fleet', ships: fleetP2 }));

  await battleStarted;
  console.log('✅ Batalha iniciada com sucesso!');
  console.log(`   Turno inicial: ${battleDataP1.isYourTurn ? 'Jogador 1' : 'Jogador 2'}`);

  if (!battleDataP1.sessionScore || typeof battleDataP1.sessionScore.myWins === 'undefined') {
    throw new Error('sessionScore não foi enviado em battle_started');
  }
  console.log('✅ Placar de duelo (sessionScore) recebido:', battleDataP1.sessionScore);

  // 5. Testar um disparo
  const shooterWs = battleDataP1.isYourTurn ? ws1 : ws2;
  const victimWs = battleDataP1.isYourTurn ? ws2 : ws1;

  const shotResolved = Promise.all([
    new Promise(res => shooterWs.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'shot_result') {
        console.log(`✅ Resultado do tiro (atirador):`, d.isHit ? '💥 ACERTOU' : '🌊 ÁGUA');
        res();
      }
    })),
    new Promise(res => victimWs.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'shot_result') {
        console.log(`✅ Notificação do tiro (vítima):`, d.isHit ? '💥 SOFREU IMPACTO' : '🌊 ERRO DO INIMIGO');
        res();
      }
    }))
  ]);

  // Se jogador 1 for o atirador, atira na posição (1, 0) que tem o carrier do P2!
  // Se jogador 2 for o atirador, atira na posição (0, 0) que tem o carrier do P1!
  const targetRow = battleDataP1.isYourTurn ? 1 : 0;
  const targetCol = 0;

  shooterWs.send(JSON.stringify({ type: 'fire', row: targetRow, col: targetCol }));
  await shotResolved;

  // 6. Testar solicitação de ranking via WebSocket
  const wsLeaderboardReceived = new Promise((resolve, reject) => {
    ws1.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'leaderboard_data') {
        if (Array.isArray(d.leaderboard)) {
          console.log(`✅ leaderboard_data via WebSocket OK (${d.leaderboard.length} registros)`);
          resolve();
        } else {
          reject(new Error('leaderboard_data não contém array'));
        }
      }
    });
  });
  ws1.send(JSON.stringify({ type: 'get_leaderboard' }));
  await wsLeaderboardReceived;

  ws1.close();
  ws2.close();

  console.log('🎉 TODOS OS TESTES PASSARAM COM SUCESSO!\n');
  process.exit(0);
}

runTest().catch(err => {
  console.error('❌ Falha nos testes:', err);
  process.exit(1);
});
