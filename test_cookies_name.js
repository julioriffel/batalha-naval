const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const TEST_PORT = 3099;

async function run() {
  console.log(`🚀 Iniciando teste de cookies e nomes aleatórios na porta ${TEST_PORT}...`);

  // Start server on TEST_PORT
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'pipe'
  });

  serverProcess.stderr.on('data', data => {
    console.error(`[Server Error] ${data}`);
  });

  // Wait for server to boot
  await new Promise((resolve) => setTimeout(resolve, 1500));

  function request(options) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        ...options
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  try {
    // 1. Test first visit (no cookie provided)
    console.log('🧪 Teste 1: Primeira visita sem cookie...');
    const res1 = await request({ path: '/', method: 'GET' });
    assert.strictEqual(res1.statusCode, 200);
    const setCookie1 = res1.headers['set-cookie'];
    assert.ok(setCookie1, 'Header Set-Cookie deve ser retornado na primeira visita');
    const cookieHeaderStr = Array.isArray(setCookie1) ? setCookie1.join(';') : setCookie1;
    assert.ok(cookieHeaderStr.includes('naval_player_name='), 'Cookie naval_player_name deve estar presente');
    assert.ok(cookieHeaderStr.includes('Path=/'), 'Cookie deve ter Path=/');
    assert.ok(cookieHeaderStr.includes('SameSite=Lax'), 'Cookie deve ter SameSite=Lax');

    const matchName = cookieHeaderStr.match(/naval_player_name=([^;]+)/);
    assert.ok(matchName, 'Nome do jogador deve ser extraível');
    const assignedName = decodeURIComponent(matchName[1]);
    console.log(`   👉 Nome aleatório gerado pelo servidor: "${assignedName}" (tamanho: ${assignedName.length})`);
    assert.ok(assignedName.length > 0 && assignedName.length <= 15, 'Nome deve ter entre 1 e 15 caracteres');
    assert.notStrictEqual(assignedName, 'Comandante', 'Nome não deve ser o padrão genérico "Comandante"');

    // 2. Test visit with existing valid cookie
    console.log('🧪 Teste 2: Visita com cookie existente ("Alm. Kraken")...');
    const customCookie = 'naval_player_name=' + encodeURIComponent('Alm. Kraken');
    const res2 = await request({
      path: '/',
      method: 'GET',
      headers: { 'Cookie': customCookie }
    });
    assert.strictEqual(res2.statusCode, 200);
    // Should NOT set a new cookie, preserving the user's cookie
    const setCookie2 = res2.headers['set-cookie'];
    assert.ok(!setCookie2, 'Não deve sobrescrever cookie válido existente');
    console.log('   👉 Cookie existente preservado com sucesso!');

    // 3. Test visit with legacy generic default ("Comandante")
    console.log('🧪 Teste 3: Visita com cookie genérico legado ("Comandante")...');
    const legacyCookie = 'naval_player_name=' + encodeURIComponent('Comandante');
    const res3 = await request({
      path: '/',
      method: 'GET',
      headers: { 'Cookie': legacyCookie }
    });
    assert.strictEqual(res3.statusCode, 200);
    const setCookie3 = res3.headers['set-cookie'];
    assert.ok(setCookie3, 'Deve reatribuir cookie quando o valor for o genérico "Comandante"');
    const cookieStr3 = Array.isArray(setCookie3) ? setCookie3.join(';') : setCookie3;
    const matchName3 = cookieStr3.match(/naval_player_name=([^;]+)/);
    const newAssignedName = decodeURIComponent(matchName3[1]);
    console.log(`   👉 Novo nome aleatório gerado em substituição ao legado: "${newAssignedName}"`);
    assert.notStrictEqual(newAssignedName, 'Comandante');
    assert.ok(newAssignedName.length <= 15);

    // 4. Test API sync when client sends persistentId with cookie
    console.log('🧪 Teste 4: API /api/player/sync lendo nome do cookie quando body.name não for informado...');
    const syncReqData = JSON.stringify({ persistentId: 'usr_test_cookie_' + Date.now() });
    const res4 = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/player/sync',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(syncReqData),
          'Cookie': 'naval_player_name=' + encodeURIComponent('Cap. Fênix')
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(syncReqData);
      req.end();
    });

    assert.strictEqual(res4.name, 'Cap. Fênix', 'Servidor deve adotar nome do cookie na sincronização');
    console.log(`   👉 Perfil sincronizado com o nome do cookie: "${res4.name}"`);

    console.log('\n🎉 TODOS OS TESTES DE COOKIES E NOMES PASSARAM COM SUCESSO!\n');
  } finally {
    serverProcess.kill('SIGTERM');
  }
}

run().catch(err => {
  console.error('❌ Falha nos testes de cookie:', err);
  process.exit(1);
});
