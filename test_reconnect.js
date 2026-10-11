const { WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;

async function testReconnection() {
  console.log(`🧪 Testando cenários de reconexão na porta ${PORT}...`);

  // --- CENÁRIO 1: HOST AGUARDANDO NA SALA DE ESPERA RECARREGA A PÁGINA ---
  console.log('\n--- Teste 1: Host aguardando recarrega a página ---');
  let ws1 = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(r => ws1.on('open', r));

  const hostPersistentId = 'usr_test_host_' + Date.now();
  let hostRoomCode = '';

  const hostCreatedPromise = new Promise(resolve => {
    ws1.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'room_created') {
        hostRoomCode = d.roomCode;
        resolve(d);
      }
    });
  });

  ws1.send(JSON.stringify({
    type: 'create_room',
    playerName: 'Comandante Host',
    persistentId: hostPersistentId,
    friendCode: 'CMD-HOST',
    isPublic: true
  }));

  const createdData = await hostCreatedPromise;
  console.log(`✅ Sala criada pelo host: #${hostRoomCode}`);

  // Simula queda de conexão / F5 (recarregar página)
  console.log('🔄 Simulando recarregamento da página (fechando WebSocket do host)...');
  ws1.close();
  await new Promise(r => setTimeout(r, 500));

  // Host abre nova aba/conexão com a URL ?sala=hostRoomCode
  const ws1Reloaded = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(r => ws1Reloaded.on('open', r));

  const hostReconnectPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout reconectando host')), 3000);
    ws1Reloaded.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'room_created' && d.isReconnected) {
        clearTimeout(timeout);
        resolve(d);
      }
    });
  });

  ws1Reloaded.send(JSON.stringify({
    type: 'reconnect_room',
    roomCode: hostRoomCode,
    persistentId: hostPersistentId,
    friendCode: 'CMD-HOST'
  }));

  const reconnectedData = await hostReconnectPromise;
  console.log(`✅ Host reconectado com sucesso na sala #${reconnectedData.roomCode} (isReconnected: ${reconnectedData.isReconnected})!`);

  // --- CENÁRIO 2: ENTRADA DO JOGADOR 2 E RECONEXÃO NA FASE DE POSICIONAMENTO ---
  console.log('\n--- Teste 2: Reconexão na fase de posicionamento ---');
  let ws2 = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(r => ws2.on('open', r));
  const p2PersistentId = 'usr_test_p2_' + Date.now();

  const placementPromise = Promise.all([
    new Promise(res => ws1Reloaded.on('message', m => {
      if (JSON.parse(m.toString()).type === 'start_placement') res();
    })),
    new Promise(res => ws2.on('message', m => {
      if (JSON.parse(m.toString()).type === 'start_placement') res();
    }))
  ]);

  ws2.send(JSON.stringify({
    type: 'join_room',
    roomCode: hostRoomCode,
    playerName: 'Comandante P2',
    persistentId: p2PersistentId,
    friendCode: 'CMD-P2'
  }));

  await placementPromise;
  console.log('✅ Ambos entraram na fase de posicionamento.');

  // P2 submete frota
  const testFleet = [
    { id: 'carrier', name: 'Porta-Aviões', size: 5, coords: [{row: 0, col: 0},{row: 0, col: 1},{row: 0, col: 2},{row: 0, col: 3},{row: 0, col: 4}] },
    { id: 'battleship', name: 'Encouraçado', size: 4, coords: [{row: 1, col: 0},{row: 1, col: 1},{row: 1, col: 2},{row: 1, col: 3}] },
    { id: 'cruiser', name: 'Cruzador', size: 3, coords: [{row: 2, col: 0},{row: 2, col: 1},{row: 2, col: 2}] },
    { id: 'submarine', name: 'Submarino', size: 3, coords: [{row: 3, col: 0},{row: 3, col: 1},{row: 3, col: 2}] },
    { id: 'destroyer', name: 'Contratorpedeiro', size: 2, coords: [{row: 4, col: 0},{row: 4, col: 1}] }
  ];
  ws2.send(JSON.stringify({ type: 'submit_fleet', ships: testFleet }));

  // P2 perde conexão / recarrega a página
  console.log('🔄 P2 recarrega a página durante a fase de posicionamento...');
  ws2.close();
  await new Promise(r => setTimeout(r, 400));

  const ws2Reloaded = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(r => ws2Reloaded.on('open', r));

  const p2ReconnectPlacementPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout reconectando P2 em placement')), 3000);
    ws2Reloaded.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'reconnect_placement') {
        clearTimeout(timeout);
        resolve(d);
      }
    });
  });

  ws2Reloaded.send(JSON.stringify({
    type: 'reconnect_room',
    roomCode: hostRoomCode,
    persistentId: p2PersistentId,
    friendCode: 'CMD-P2'
  }));

  const p2PlacementData = await p2ReconnectPlacementPromise;
  if (!p2PlacementData.ready || p2PlacementData.ships.length !== 5) {
    throw new Error('Estado da frota pronta de P2 não foi mantido na reconexão!');
  }
  console.log('✅ P2 reconectado em placement preservando a frota submetida!');

  // Host submete frota para iniciar a batalha
  const battleStartedPromise = Promise.all([
    new Promise(res => ws1Reloaded.on('message', m => {
      if (JSON.parse(m.toString()).type === 'battle_started') res(JSON.parse(m.toString()));
    })),
    new Promise(res => ws2Reloaded.on('message', m => {
      if (JSON.parse(m.toString()).type === 'battle_started') res(JSON.parse(m.toString()));
    }))
  ]);

  ws1Reloaded.send(JSON.stringify({ type: 'submit_fleet', ships: testFleet }));
  const [battleP1, battleP2] = await battleStartedPromise;
  console.log('✅ Batalha iniciada após submissão de frotas!');

  // --- CENÁRIO 3: RECONEXÃO EM PLENA BATALHA NAVAL ---
  console.log('\n--- Teste 3: Reconexão em pleno combate naval ---');
  // Atira um tiro
  const shooter = battleP1.isYourTurn ? ws1Reloaded : ws2Reloaded;
  const victim = battleP1.isYourTurn ? ws2Reloaded : ws1Reloaded;

  const shotPromise = new Promise(resolve => {
    shooter.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'shot_result') resolve(d);
    });
  });
  // Tiro em (0, 0) - acerto garantido no carrier
  shooter.send(JSON.stringify({ type: 'fire', row: 0, col: 0 }));
  await shotPromise;
  console.log('✅ Primeiro disparo efetuado com acerto!');

  // Agora shooter perde conexão / recarrega
  console.log('🔄 Atirador perde conexão em meio à batalha naval e recarrega...');
  const isShooterP1 = (shooter === ws1Reloaded);
  const reconnectingPersistentId = isShooterP1 ? hostPersistentId : p2PersistentId;
  const opponentSocket = isShooterP1 ? ws2Reloaded : ws1Reloaded;

  const opponentNotifiedDisconnect = new Promise(resolve => {
    opponentSocket.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'opponent_disconnected') resolve(d);
    });
  });

  shooter.close();
  const oppDisconnectMsg = await opponentNotifiedDisconnect;
  console.log('✅ Adversário foi notificado da desconexão temporária:', oppDisconnectMsg.message);

  // Atirador reconecta
  const shooterNewWs = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise(r => shooterNewWs.on('open', r));

  const opponentNotifiedReconnect = new Promise(resolve => {
    opponentSocket.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'opponent_reconnected') resolve(d);
    });
  });

  const shooterBattleReconnected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout reconectando batalha')), 3000);
    shooterNewWs.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'battle_reconnected') {
        clearTimeout(timeout);
        resolve(d);
      }
    });
  });

  shooterNewWs.send(JSON.stringify({
    type: 'reconnect_room',
    roomCode: hostRoomCode,
    persistentId: reconnectingPersistentId
  }));

  const [battleReconnectedData, oppReconnectNotice] = await Promise.all([
    shooterBattleReconnected,
    opponentNotifiedReconnect
  ]);

  if (!battleReconnectedData.myFleet || battleReconnectedData.myFleet.length !== 5) {
    throw new Error('Frota do jogador reconectado não veio completa');
  }
  console.log('✅ Batalha reconectada com sucesso! Turno atual:', battleReconnectedData.isYourTurn ? 'Seu' : 'Oponente');
  console.log('✅ Adversário recebeu aviso de reconexão:', oppReconnectNotice.message);

  shooterNewWs.close();
  opponentSocket.close();

  console.log('\n🎉 TODOS OS TESTES DE RECONEXÃO PASSARAM COM SUCESSO!\n');
  process.exit(0);
}

testReconnection().catch(err => {
  console.error('❌ Falha no teste de reconexão:', err);
  process.exit(1);
});
