const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const serverModule = require('./server.js');
const {
  purgeOldLeaderboardData,
  recordMatchResult,
  getSortedLeaderboard,
  RANKING_RETENTION_DAYS,
  RANKING_RETENTION_MS,
  LEADERBOARD_FILE,
  getLeaderboardData,
  setLeaderboardData
} = serverModule;

const TEST_PORT = 3198;

async function runTests() {
  console.log('🧪 Iniciando testes de retenção de 7 dias e expurgo diário do ranking...');

  // Backup do leaderboard atual
  let originalLeaderboardContent = null;
  if (fs.existsSync(LEADERBOARD_FILE)) {
    originalLeaderboardContent = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
  }

  try {
    // -------------------------------------------------------------
    // TESTE 1: Configuração de Constantes
    // -------------------------------------------------------------
    console.log('👉 Teste 1: Validação das constantes de retenção...');
    assert.strictEqual(RANKING_RETENTION_DAYS, 7, 'Retenção deve ser de 7 dias');
    assert.strictEqual(RANKING_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, 'Milissegundos devem corresponder a 7 dias');

    // -------------------------------------------------------------
    // TESTE 2: Registro e Expurgo de Partidas com Datas Diferentes
    // -------------------------------------------------------------
    console.log('👉 Teste 2: Registro e expurgo com datas relativas...');
    setLeaderboardData({});

    const now = Date.now();
    const dateToday = new Date(now).toISOString();
    const date3DaysAgo = new Date(now - (3 * 24 * 60 * 60 * 1000)).toISOString();
    const date6DaysAgo = new Date(now - (6 * 24 * 60 * 60 * 1000)).toISOString();
    const date8DaysAgo = new Date(now - (8 * 24 * 60 * 60 * 1000)).toISOString(); // Fora da janela de 7 dias
    const date12DaysAgo = new Date(now - (12 * 24 * 60 * 60 * 1000)).toISOString(); // Fora da janela de 7 dias

    // Registrar partida de 8 dias atrás (Jogador Antigo vs Jogador Misto)
    recordMatchResult('Jogador Antigo', 'Jogador Misto', 10, 8, 10, 5, date8DaysAgo);

    // Registrar partida de 3 dias atrás (Jogador Misto vs Jogador Recente)
    recordMatchResult('Jogador Misto', 'Jogador Recente', 15, 12, 14, 7, date3DaysAgo);

    // Registrar partida de hoje (Jogador Recente vs Jogador Hoje)
    recordMatchResult('Jogador Recente', 'Jogador Hoje', 20, 18, 18, 10, dateToday);

    // Executar expurgo baseado no momento 'now'
    const purgeResult = purgeOldLeaderboardData(now);
    console.log('   Resultado do expurgo:', purgeResult);

    const ranking = getSortedLeaderboard();
    const data = getLeaderboardData();

    // 1. 'Jogador Antigo' só tinha a partida de 8 dias atrás -> deve ter sido expurgado
    assert.strictEqual(data['jogador antigo'], undefined, 'Jogador Antigo (>7 dias) deve ser expurgado do banco');

    // 2. 'Jogador Misto' tinha uma derrota há 8 dias e uma vitória há 3 dias -> só a vitória deve restar
    const misto = data['jogador misto'];
    assert.ok(misto, 'Jogador Misto deve permanecer no banco');
    assert.strictEqual(misto.wins, 1, 'Jogador Misto deve ter 1 vitória nos últimos 7 dias');
    assert.strictEqual(misto.losses, 0, 'Derrota de 8 dias atrás do Jogador Misto deve ter sido expurgada');
    assert.strictEqual(misto.matches, 1, 'Total de partidas deve ser 1');
    assert.strictEqual(misto.winRate, 100, 'Taxa de vitória deve ser 100%');

    // 3. 'Jogador Recente' tem 1 derrota há 3 dias e 1 vitória hoje -> 2 partidas
    const recente = data['jogador recente'];
    assert.ok(recente, 'Jogador Recente deve existir');
    assert.strictEqual(recente.wins, 1, 'Jogador Recente deve ter 1 vitória');
    assert.strictEqual(recente.losses, 1, 'Jogador Recente deve ter 1 derrota');
    assert.strictEqual(recente.matches, 2, 'Jogador Recente deve ter 2 partidas nos últimos 7 dias');

    // 4. 'Jogador Hoje' tem 1 derrota hoje
    const hoje = data['jogador hoje'];
    assert.ok(hoje, 'Jogador Hoje deve existir');
    assert.strictEqual(hoje.wins, 0);
    assert.strictEqual(hoje.losses, 1);
    assert.strictEqual(hoje.matches, 1);

    // 5. Ranking ordenado deve conter apenas os 3 comandantes ativos
    assert.strictEqual(ranking.length, 3, 'Ranking deve ter 3 jogadores');
    assert.ok(!ranking.some(p => p.name === 'Jogador Antigo'), 'Ranking não pode conter Jogador Antigo');

    // -------------------------------------------------------------
    // TESTE 3: Verificação de persistência em arquivo
    // -------------------------------------------------------------
    console.log('👉 Teste 3: Verificação do arquivo leaderboard.json...');
    assert.ok(fs.existsSync(LEADERBOARD_FILE), 'Arquivo leaderboard.json deve existir');
    const diskContent = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    assert.strictEqual(diskContent['jogador antigo'], undefined, 'Jogador Antigo não deve estar no JSON');
    assert.ok(diskContent['jogador misto'], 'Jogador Misto deve estar salvo no JSON');

    // -------------------------------------------------------------
    // TESTE 4: Teste de Servidor HTTP & WebSocket
    // -------------------------------------------------------------
    console.log(`👉 Teste 4: Inicializando servidor HTTP na porta ${TEST_PORT}...`);
    const serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'pipe'
    });

    serverProcess.stderr.on('data', d => console.error(`[Server stderr] ${d}`));

    // Aguardar boot do servidor
    await new Promise(r => setTimeout(r, 1200));

    // Testar GET /api/leaderboard
    const httpRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/api/leaderboard`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      }).on('error', reject);
    });

    assert.strictEqual(httpRes.status, 200, 'HTTP status deve ser 200');
    assert.strictEqual(httpRes.data.periodDays, 7, 'periodDays retornado na API deve ser 7');
    assert.ok(Array.isArray(httpRes.data.leaderboard), 'leaderboard retornado deve ser array');
    console.log(`   ✅ /api/leaderboard retornou ${httpRes.data.leaderboard.length} registros com periodDays=7.`);

    // Testar WebSocket get_leaderboard
    console.log('👉 Teste 5: Consulta de ranking via WebSocket...');
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise(r => ws.on('open', r));

    const wsLeaderboardPromise = new Promise((resolve, reject) => {
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'leaderboard_data') {
            resolve(msg);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    ws.send(JSON.stringify({ type: 'get_leaderboard' }));
    const wsMsg = await wsLeaderboardPromise;
    assert.strictEqual(wsMsg.type, 'leaderboard_data');
    assert.strictEqual(wsMsg.periodDays, 7, 'periodDays via WebSocket deve ser 7');
    assert.ok(Array.isArray(wsMsg.leaderboard), 'leaderboard via WebSocket deve ser array');
    console.log(`   ✅ WebSocket leaderboard_data recebido com ${wsMsg.leaderboard.length} registros e periodDays=7.`);

    ws.close();
    serverProcess.kill('SIGTERM');

    console.log('\n🎉 TODOS OS TESTES DE RETENÇÃO DE 7 DIAS E EXPURGO DIÁRIO PASSARAM COM SUCESSO!\n');
  } finally {
    // Restaurar arquivo original se havia antes do teste
    if (originalLeaderboardContent !== null) {
      fs.writeFileSync(LEADERBOARD_FILE, originalLeaderboardContent, 'utf8');
      console.log('🔄 Banco leaderboard.json restaurado com dados originais.');
    }
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ Falha nos testes de retenção:', err);
  process.exit(1);
});
