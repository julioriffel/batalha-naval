/**
 * Batalha Naval High-Tech - Frontend Game Controller
 * Lógica de cliente, WebSockets, renderização tática e UX mobile.
 */

(function () {
  'use strict';

  // --- Game State ---
  const state = {
    ws: null,
    roomCode: null,
    playerId: null,
    playerName: 'Comandante',
    opponentName: 'Inimigo',
    isHost: false,
    shipSpecs: [
      { id: 'carrier', name: 'Porta-Aviões', size: 5, icon: '🚢' },
      { id: 'battleship', name: 'Encouraçado', size: 4, icon: '⚔️' },
      { id: 'cruiser', name: 'Cruzador', size: 3, icon: '🛡️' },
      { id: 'submarine', name: 'Submarino', size: 3, icon: '🌊' },
      { id: 'destroyer', name: 'Contratorpedeiro', size: 2, icon: '⚡' }
    ],
    placement: {
      ships: [], // { id, name, size, coords: [{row, col}] }
      selectedShipId: 'carrier',
      orientation: 'H' // 'H' | 'V'
    },
    battle: {
      isMyTurn: false,
      activeTab: 'attack', // 'attack' | 'defense'
      attackGrid: Array.from({ length: 10 }, () => Array(10).fill(null)), // null | 'miss' | 'hit' | 'sunk'
      defenseGrid: Array.from({ length: 10 }, () => Array(10).fill(null)),
      enemySunkCount: 0,
      mySunkCount: 0
    }
  };

  // --- DOM Elements ---
  const screens = {
    lobby: document.getElementById('screen-lobby'),
    waitingHost: document.getElementById('screen-waiting-host'),
    placement: document.getElementById('screen-placement'),
    battle: document.getElementById('screen-battle')
  };

  const hudTurnBanner = document.getElementById('hud-turn-banner');
  const btnMute = document.getElementById('btn-mute');
  const modalGameOver = document.getElementById('modal-game-over');
  const toastContainer = document.getElementById('toast-container');

  // --- Toast Notification ---
  function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Switch Screens ---
  function showScreen(screenName) {
    Object.values(screens).forEach(s => s && s.classList.remove('active'));
    if (screens[screenName]) {
      screens[screenName].classList.add('active');
    }
  }

  // --- Sound & Audio Control ---
  function updateMuteButton() {
    const muted = window.tacticalAudio.isMuted();
    btnMute.innerHTML = muted ? '🔇 Mudo' : '🔊 Som';
  }

  btnMute.addEventListener('click', () => {
    const isMuted = window.tacticalAudio.toggleMute();
    updateMuteButton();
    if (!isMuted) {
      window.tacticalAudio.turnAlertSound();
      const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
      if (isIos) {
        showToast('🔔 No iPhone: desative a chave lateral de silencioso para ouvir os alarmes!', 4000);
      }
    }
  });
  updateMuteButton();

  // --- WebSocket Setup ---
  function initWebSocket() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        state.ws = ws;
        resolve(ws);
      };

      ws.onerror = (err) => {
        console.error('Erro de conexão WebSocket:', err);
        showToast('Erro conectando ao radar naval.');
        reject(err);
      };

      ws.onclose = () => {
        showToast('Desconectado do servidor naval.');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerMessage(data);
        } catch (e) {
          console.error('Erro decodificando mensagem:', e);
        }
      };
    });
  }

  function sendWS(type, payload = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  // --- Message Dispatcher ---
  function handleServerMessage(msg) {
    console.log('[Radar Naval In]', msg);

    switch (msg.type) {
      case 'room_created':
        state.roomCode = msg.roomCode;
        state.playerId = msg.playerId;
        state.isHost = true;
        document.getElementById('display-room-code').textContent = msg.roomCode;
        document.getElementById('qr-img').src = msg.qrDataUrl;
        document.getElementById('network-ip-display').textContent = msg.joinUrl;
        showScreen('waitingHost');
        window.tacticalAudio.sonarPing();
        break;

      case 'room_joined':
        state.roomCode = msg.roomCode;
        state.playerId = msg.playerId;
        state.isHost = false;
        state.opponentName = msg.opponentName;
        showToast(`Entrou na sala do Comandante ${msg.opponentName}!`);
        break;

      case 'opponent_joined':
        state.opponentName = msg.opponentName;
        showToast(`Comandante ${msg.opponentName} conectado ao radar!`);
        break;

      case 'start_placement':
        if (msg.shipSpecs) state.shipSpecs = msg.shipSpecs;
        initPlacementPhase();
        showScreen('placement');
        window.tacticalAudio.sonarPing();
        break;

      case 'fleet_confirmed':
        document.getElementById('btn-confirm-fleet').disabled = true;
        document.getElementById('btn-confirm-fleet').textContent = '✅ Frota Posicionada!';
        document.getElementById('placement-status-text').textContent = 'Aguardando o adversário terminar o posicionamento...';
        break;

      case 'opponent_ready':
        showToast(`Oponente terminou de posicionar a frota!`);
        break;

      case 'battle_started':
        initBattlePhase(msg.isYourTurn, msg.activePlayerName);
        showScreen('battle');
        window.tacticalAudio.sonarPing();
        if (/iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase())) {
          showToast('🔔 Dica iPhone: mantenha a chave lateral fora do modo silencioso', 3500);
        }
        break;

      case 'shot_result':
        handleShotResult(msg);
        break;

      case 'game_over':
        handleGameOver(msg);
        break;

      case 'opponent_wants_rematch':
        showToast(msg.message || 'Oponente pediu revanche!');
        break;

      case 'rematch_pending':
        const btnRematch = document.getElementById('btn-rematch');
        if (btnRematch) {
          btnRematch.disabled = true;
          btnRematch.textContent = '⏳ Aguardando adversário...';
        }
        break;

      case 'rematch_accepted':
        modalGameOver.classList.remove('active');
        showToast('Revanche iniciada! Reposicione sua frota.');
        break;

      case 'opponent_disconnected':
        showToast(msg.message, 5000);
        hudTurnBanner.textContent = '⚠️ ADVERSÁRIO DESCONECTOU';
        hudTurnBanner.className = 'turn-banner alert-danger';
        break;

      case 'error':
        showToast(`⚠️ ${msg.message}`);
        break;
    }
  }

  // --- LOBBY INTERACTIONS ---
  const inputPlayerName = document.getElementById('input-player-name');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const inputRoomCode = document.getElementById('input-room-code');

  btnCreateRoom.addEventListener('click', async () => {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    state.playerName = inputPlayerName.value.trim() || 'Comandante 1';
    await initWebSocket();
    sendWS('create_room', { playerName: state.playerName, origin: window.location.origin });
  });

  btnJoinRoom.addEventListener('click', async () => {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    const code = inputRoomCode.value.trim().toUpperCase();
    if (!code) {
      showToast('Digite o código da sala!');
      return;
    }
    state.playerName = inputPlayerName.value.trim() || 'Comandante 2';
    await initWebSocket();
    sendWS('join_room', { roomCode: code, playerName: state.playerName });
  });

  // Share / Copy Link Button
  const btnCopyLink = document.getElementById('btn-copy-link');
  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', () => {
      const url = document.getElementById('network-ip-display').textContent;
      navigator.clipboard.writeText(url).then(() => {
        showToast('📋 Link de acesso copiado!');
      }).catch(() => {
        showToast('Copie o endereço mostrado na tela.');
      });
    });
  }

  // --- URL Param Auto-Fill (?sala=XYZ) ---
  const urlParams = new URLSearchParams(window.location.search);
  const paramSala = urlParams.get('sala');
  if (paramSala) {
    inputRoomCode.value = paramSala.toUpperCase();
    inputRoomCode.focus();
    showToast(`Código ${paramSala.toUpperCase()} carregado! Digite seu nome e entre.`);
  }

  // --- SHIP PLACEMENT LOGIC ---
  const fleetSelector = document.getElementById('fleet-selector');
  const placementGridEl = document.getElementById('placement-grid');
  const btnRotate = document.getElementById('btn-rotate-ship');
  const btnRandomPlacement = document.getElementById('btn-random-fleet');
  const btnClearPlacement = document.getElementById('btn-clear-fleet');
  const btnConfirmFleet = document.getElementById('btn-confirm-fleet');

  function initPlacementPhase() {
    state.placement.ships = [];
    state.placement.selectedShipId = state.shipSpecs[0].id;
    state.placement.orientation = 'H';

    btnConfirmFleet.disabled = true;
    btnConfirmFleet.textContent = '⚓ Confirmar Frota (0/5)';
    document.getElementById('placement-status-text').textContent = 'Toque nas coordenadas para posicionar cada embarcação.';

    renderPlacementFleetChips();
    renderGrid(placementGridEl, false, onPlacementCellClick, onPlacementCellHover);
  }

  function renderPlacementFleetChips() {
    fleetSelector.innerHTML = '';
    state.shipSpecs.forEach(spec => {
      const chip = document.createElement('div');
      chip.className = 'ship-chip';
      const isPlaced = state.placement.ships.some(s => s.id === spec.id);
      const isSelected = state.placement.selectedShipId === spec.id;

      if (isPlaced) chip.classList.add('placed');
      if (isSelected) chip.classList.add('selected');

      chip.innerHTML = `${spec.icon} <strong>${spec.name}</strong> (${spec.size})`;
      chip.addEventListener('click', () => {
        window.tacticalAudio.click();
        state.placement.selectedShipId = spec.id;
        renderPlacementFleetChips();
      });

      fleetSelector.appendChild(chip);
    });
  }

  btnRotate.addEventListener('click', () => {
    window.tacticalAudio.click();
    state.placement.orientation = state.placement.orientation === 'H' ? 'V' : 'H';
    btnRotate.innerHTML = `🔄 Girar (${state.placement.orientation === 'H' ? 'Horizontal' : 'Vertical'})`;
  });

  btnClearPlacement.addEventListener('click', () => {
    window.tacticalAudio.click();
    state.placement.ships = [];
    renderPlacementFleetChips();
    updatePlacementGridDisplay();
    btnConfirmFleet.disabled = true;
    btnConfirmFleet.textContent = '⚓ Confirmar Frota (0/5)';
  });

  btnRandomPlacement.addEventListener('click', () => {
    window.tacticalAudio.sonarPing();
    window.tacticalHaptics.fire();
    generateRandomFleet();
    renderPlacementFleetChips();
    updatePlacementGridDisplay();
    checkAllShipsPlaced();
  });

  btnConfirmFleet.addEventListener('click', () => {
    if (state.placement.ships.length !== 5) return;
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    sendWS('submit_fleet', { ships: state.placement.ships });
  });

  function getShipCoordinates(startRow, startCol, size, orientation) {
    const coords = [];
    for (let i = 0; i < size; i++) {
      const r = orientation === 'H' ? startRow : startRow + i;
      const c = orientation === 'H' ? startCol + i : startCol;
      coords.push({ row: r, col: c });
    }
    return coords;
  }

  function isValidPlacement(coords, excludeShipId = null) {
    for (const c of coords) {
      if (c.row < 0 || c.row > 9 || c.col < 0 || c.col > 9) return false;
    }
    for (const ship of state.placement.ships) {
      if (ship.id === excludeShipId) continue;
      for (const sc of ship.coords) {
        if (coords.some(c => c.row === sc.row && c.col === sc.col)) {
          return false;
        }
      }
    }
    return true;
  }

  function onPlacementCellClick(row, col) {
    const currentSpec = state.shipSpecs.find(s => s.id === state.placement.selectedShipId);
    if (!currentSpec) return;

    const coords = getShipCoordinates(row, col, currentSpec.size, state.placement.orientation);
    if (!isValidPlacement(coords, currentSpec.id)) {
      window.tacticalHaptics.miss();
      showToast('Posição inválida ou sobreposta!');
      return;
    }

    // Remove posição anterior se já estava colocado
    state.placement.ships = state.placement.ships.filter(s => s.id !== currentSpec.id);

    state.placement.ships.push({
      id: currentSpec.id,
      name: currentSpec.name,
      size: currentSpec.size,
      coords
    });

    window.tacticalAudio.click();
    window.tacticalHaptics.click();

    // Seleciona automaticamente o próximo navio ainda não colocado
    const remaining = state.shipSpecs.find(s => !state.placement.ships.some(p => p.id === s.id));
    if (remaining) {
      state.placement.selectedShipId = remaining.id;
    }

    renderPlacementFleetChips();
    updatePlacementGridDisplay();
    checkAllShipsPlaced();
  }

  function onPlacementCellHover(row, col) {
    const currentSpec = state.shipSpecs.find(s => s.id === state.placement.selectedShipId);
    if (!currentSpec) return;

    const coords = getShipCoordinates(row, col, currentSpec.size, state.placement.orientation);
    const valid = isValidPlacement(coords, currentSpec.id);

    // Limpa previews
    placementGridEl.querySelectorAll('.grid-cell').forEach(cell => {
      cell.classList.remove('ship-preview', 'ship-invalid');
    });

    coords.forEach(c => {
      if (c.row >= 0 && c.row < 10 && c.col >= 0 && c.col < 10) {
        const cell = placementGridEl.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
        if (cell) {
          cell.classList.add(valid ? 'ship-preview' : 'ship-invalid');
        }
      }
    });
  }

  function updatePlacementGridDisplay() {
    placementGridEl.querySelectorAll('.grid-cell').forEach(cell => {
      cell.className = 'grid-cell';
    });
    state.placement.ships.forEach(ship => {
      ship.coords.forEach(c => {
        const cell = placementGridEl.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
        if (cell) cell.classList.add('ship');
      });
    });
  }

  function checkAllShipsPlaced() {
    const count = state.placement.ships.length;
    btnConfirmFleet.textContent = `⚓ Confirmar Frota (${count}/5)`;
    btnConfirmFleet.disabled = count !== 5;
    if (count === 5) {
      showToast('Frota completa! Clique em Confirmar Frota.');
    }
  }

  function generateRandomFleet() {
    state.placement.ships = [];
    state.shipSpecs.forEach(spec => {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 100) {
        attempts++;
        const orientation = Math.random() < 0.5 ? 'H' : 'V';
        const maxR = orientation === 'H' ? 10 : 10 - spec.size;
        const maxC = orientation === 'H' ? 10 - spec.size : 10;
        const r = Math.floor(Math.random() * maxR);
        const c = Math.floor(Math.random() * maxC);
        const coords = getShipCoordinates(r, c, spec.size, orientation);

        if (isValidPlacement(coords)) {
          state.placement.ships.push({
            id: spec.id,
            name: spec.name,
            size: spec.size,
            coords
          });
          placed = true;
        }
      }
    });
  }

  // --- BATTLE PHASE LOGIC ---
  const attackGridEl = document.getElementById('attack-grid');
  const defenseGridEl = document.getElementById('defense-grid');
  const tabAttack = document.getElementById('tab-attack');
  const tabDefense = document.getElementById('tab-defense');
  const badgeDefense = document.getElementById('badge-defense-alert');

  function initBattlePhase(isMyTurn, activePlayerName) {
    state.battle.isMyTurn = isMyTurn;
    state.battle.attackGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    state.battle.defenseGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    state.battle.enemySunkCount = 0;
    state.battle.mySunkCount = 0;

    renderGrid(attackGridEl, true, onAttackCellClick);
    renderGrid(defenseGridEl, false);

    // Preenche os navios do próprio jogador no tabuleiro de defesa
    state.placement.ships.forEach(ship => {
      ship.coords.forEach(c => {
        const cell = defenseGridEl.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
        if (cell) cell.classList.add('ship');
      });
    });

    renderFleetPips();
    updateTurnDisplay(isMyTurn, activePlayerName);
    switchBattleTab('attack');
  }

  let splashTimeout = null;
  function showTurnSplash(type, title, desc, icon) {
    const overlay = document.getElementById('turn-splash-overlay');
    const card = document.getElementById('turn-splash-card');
    const iconEl = document.getElementById('turn-splash-icon');
    const titleEl = document.getElementById('turn-splash-title');
    const descEl = document.getElementById('turn-splash-desc');

    if (!overlay || !card) return;

    clearTimeout(splashTimeout);

    card.className = `turn-splash-card ${type}`;
    if (iconEl) iconEl.textContent = icon;
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;

    overlay.classList.add('show');

    splashTimeout = setTimeout(() => {
      overlay.classList.remove('show');
    }, 1800);
  }

  function updateTurnDisplay(isMyTurn, activePlayerName, isExtraTurn = false) {
    state.battle.isMyTurn = isMyTurn;
    const titleEl = document.getElementById('turn-banner-main');
    const subEl = document.getElementById('turn-banner-sub');
    const radarBadge = document.getElementById('radar-status-badge');
    const attackRadarCard = document.getElementById('card-attack-radar');

    if (isMyTurn) {
      if (isExtraTurn) {
        hudTurnBanner.className = 'turn-banner extra-turn';
        if (titleEl) titleEl.textContent = '💥 TIRO EXTRA CONCEDIDO!';
        if (subEl) subEl.textContent = 'Você acertou o navio! Toque no radar para atirar novamente.';
        showTurnSplash('extra', 'TIRO EXTRA!', 'Alvo atingido! Você ganhou mais um disparo.', '💥');
        window.tacticalAudio.extraShotSound();
        window.tacticalHaptics.extraTurn();
      } else {
        hudTurnBanner.className = 'turn-banner your-turn';
        if (titleEl) titleEl.textContent = '🟢 SUA VEZ DE ATACAR!';
        if (subEl) subEl.textContent = 'Disparo autorizado — toque nas coordenadas do radar inimigo.';
        showTurnSplash('', 'SUA VEZ DE ATACAR!', 'Disparo de míssil autorizado! Escolha seu alvo no radar.', '⚡');
        window.tacticalAudio.turnAlertSound();
        window.tacticalHaptics.yourTurn();
      }

      if (radarBadge) {
        radarBadge.textContent = '🟢 DISPARO AUTORIZADO';
        radarBadge.className = 'radar-status-badge badge-active';
      }
      if (attackRadarCard) {
        attackRadarCard.classList.add('radar-active');
        attackRadarCard.classList.remove('radar-locked');
      }

      switchBattleTab('attack');
    } else {
      hudTurnBanner.className = 'turn-banner opponent-turn';
      if (titleEl) titleEl.textContent = `⏳ TURNO DE ${activePlayerName.toUpperCase()}`;
      if (subEl) subEl.textContent = 'Aguarde o disparo do adversário...';

      if (radarBadge) {
        radarBadge.textContent = '🔒 RADAR TRAVADO';
        radarBadge.className = 'radar-status-badge badge-locked';
      }
      if (attackRadarCard) {
        attackRadarCard.classList.remove('radar-active');
        attackRadarCard.classList.add('radar-locked');
      }

      showTurnSplash('opponent', `TURNO DO INIMIGO`, `Aguardando coordenadas de disparo de ${activePlayerName}...`, '⏳');
    }
  }

  function switchBattleTab(tab) {
    state.battle.activeTab = tab;
    tabAttack.classList.toggle('active', tab === 'attack');
    tabDefense.classList.toggle('active', tab === 'defense');

    document.getElementById('card-attack-radar').style.display = tab === 'attack' ? 'block' : 'none';
    document.getElementById('card-defense-fleet').style.display = tab === 'defense' ? 'block' : 'none';

    if (tab === 'defense') {
      badgeDefense.classList.remove('active');
    }
  }

  tabAttack.addEventListener('click', () => switchBattleTab('attack'));
  tabDefense.addEventListener('click', () => switchBattleTab('defense'));

  function onAttackCellClick(row, col) {
    if (!state.battle.isMyTurn) {
      window.tacticalHaptics.miss();
      showToast('🔒 RADAR TRAVADO: Aguarde a sua vez de jogar!', 2500);
      return;
    }

    if (state.battle.attackGrid[row][col] !== null) {
      showToast('Esta coordenada já foi bombardeada!');
      return;
    }

    window.tacticalAudio.fireMissile();
    window.tacticalHaptics.fire();

    sendWS('fire', { row, col });
  }

  function handleShotResult(msg) {
    const { target, isHit, sunkShip, isYourTurn, activePlayerName, role } = msg;
    const { row, col } = target;

    if (role === 'attacker') {
      // Atualiza o Radar de Ataque
      state.battle.attackGrid[row][col] = isHit ? 'hit' : 'miss';
      const cell = attackGridEl.querySelector(`[data-row="${row}"][data-col="${col}"]`);

      if (isHit) {
        window.tacticalAudio.explosion();
        window.tacticalHaptics.hit();
        cell.className = 'grid-cell hit';

        if (sunkShip) {
          window.tacticalAudio.sunkAlarm();
          window.tacticalHaptics.sunk();
          showToast(`☠️ AFUNDOU! ${sunkShip.name} do inimigo destruído!`, 4000);
          state.battle.enemySunkCount++;
          markShipSunk(attackGridEl, sunkShip.coords);
          updateFleetPips();
        } else {
          showToast('💥 TIRO CERTEIRO! Fogo em navio inimigo!', 2500);
        }
      } else {
        window.tacticalAudio.waterSplash();
        window.tacticalHaptics.miss();
        cell.className = 'grid-cell miss';
        showToast('🌊 ÁGUA! O disparo errou o alvo.', 2000);
      }
    } else {
      // Atualiza a Frota de Defesa
      state.battle.defenseGrid[row][col] = isHit ? 'hit' : 'miss';
      const cell = defenseGridEl.querySelector(`[data-row="${row}"][data-col="${col}"]`);

      if (isHit) {
        window.tacticalAudio.explosion();
        window.tacticalHaptics.hit();
        cell.className = 'grid-cell hit';

        // Alerta na aba de defesa se o jogador estiver vendo o ataque
        if (state.battle.activeTab === 'attack') {
          badgeDefense.classList.add('active');
        }

        if (sunkShip) {
          window.tacticalAudio.sunkAlarm();
          window.tacticalHaptics.sunk();
          showToast(`🚨 ALERTA: Nosso ${sunkShip.name} foi afundado!`, 4000);
          state.battle.mySunkCount++;
          markShipSunk(defenseGridEl, sunkShip.coords);
          updateFleetPips();
        } else {
          showToast('⚠️ IMPACTO! Nossa frota sofreu dano!', 2500);
        }
      } else {
        window.tacticalAudio.waterSplash();
        cell.className = 'grid-cell miss';
      }
    }

    const isExtraTurn = isHit && isYourTurn && role === 'attacker';
    updateTurnDisplay(isYourTurn, activePlayerName, isExtraTurn);
  }

  function markShipSunk(gridEl, coords) {
    coords.forEach(c => {
      const cell = gridEl.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
      if (cell) cell.className = 'grid-cell sunk';
    });
  }

  function renderFleetPips() {
    const enemyContainer = document.getElementById('enemy-ships-pips');
    const myContainer = document.getElementById('my-ships-pips');
    if (!enemyContainer || !myContainer) return;

    enemyContainer.innerHTML = '';
    myContainer.innerHTML = '';

    state.shipSpecs.forEach((spec, i) => {
      const enemyPip = document.createElement('span');
      enemyPip.className = 'ship-pip';
      enemyPip.id = `enemy-pip-${spec.id}`;
      enemyPip.textContent = `${spec.icon} ${spec.name.slice(0, 4)}.`;
      enemyContainer.appendChild(enemyPip);

      const myPip = document.createElement('span');
      myPip.className = 'ship-pip';
      myPip.id = `my-pip-${spec.id}`;
      myPip.textContent = `${spec.icon} ${spec.name.slice(0, 4)}.`;
      myContainer.appendChild(myPip);
    });
  }

  function updateFleetPips() {
    // Pips are updated when ships sink
  }

  function handleGameOver(msg) {
    const isWin = msg.isWinner;
    const modal = modalGameOver;
    const card = modal.querySelector('.modal-card');

    card.className = `modal-card ${isWin ? 'victory' : 'defeat'}`;
    document.getElementById('modal-title').textContent = isWin ? '🏆 VITÓRIA NAVAL!' : '☠️ DERROTA!';
    document.getElementById('modal-subtitle').textContent = isWin 
      ? 'Você aniquilou toda a frota adversária!' 
      : 'Todos os seus navios de guerra foram afundados.';

    document.getElementById('stat-shots').textContent = msg.shotsFired;
    document.getElementById('stat-hits').textContent = msg.hitsLanded;
    document.getElementById('stat-accuracy').textContent = `${msg.accuracy}%`;

    const btnRematch = document.getElementById('btn-rematch');
    btnRematch.disabled = false;
    btnRematch.textContent = '🔄 Revanche Rápida';

    if (isWin) {
      window.tacticalAudio.victoryFanfare();
      window.tacticalHaptics.victory();
    } else {
      window.tacticalAudio.defeatSound();
    }

    modal.classList.add('active');
  }

  const btnRematch = document.getElementById('btn-rematch');
  btnRematch.addEventListener('click', () => {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    sendWS('request_rematch');
  });

  // --- GRID RENDER UTILITY ---
  function renderGrid(container, isInteractive, onClick, onHover) {
    container.innerHTML = '';
    const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    // Corner blank
    const corner = document.createElement('div');
    corner.className = 'grid-header-col';
    container.appendChild(corner);

    // Header cols A-J
    cols.forEach(label => {
      const colEl = document.createElement('div');
      colEl.className = 'grid-header-col';
      colEl.textContent = label;
      container.appendChild(colEl);
    });

    for (let r = 0; r < 10; r++) {
      // Row header 1-10
      const rowEl = document.createElement('div');
      rowEl.className = 'grid-header-row';
      rowEl.textContent = r + 1;
      container.appendChild(rowEl);

      // 10 cells
      for (let c = 0; c < 10; c++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.row = r;
        cell.dataset.col = c;

        if (onClick) {
          cell.addEventListener('click', () => onClick(r, c));
        }

        if (onHover) {
          cell.addEventListener('mouseenter', () => onHover(r, c));
          cell.addEventListener('touchstart', (e) => {
            onHover(r, c);
          }, { passive: true });
        }

        container.appendChild(cell);
      }
    }
  }

  // --- PWA SERVICE WORKER & INSTALAÇÃO ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[PWA] Service Worker tático registrado com sucesso:', reg.scope);
      }).catch((err) => {
        console.warn('[PWA] Falha ao registrar Service Worker:', err);
      });
    });
  }

  let deferredInstallPrompt = null;
  const btnInstallHeader = document.getElementById('btn-install-app');
  const lobbyInstallBox = document.getElementById('lobby-install-box');
  const btnLobbyInstall = document.getElementById('btn-lobby-install');
  const modalIosInstall = document.getElementById('modal-ios-install');
  const btnCloseIosModal = document.getElementById('btn-close-ios-modal');

  const isIos = () => {
    const ua = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(ua);
  };

  const isInStandaloneMode = () => {
    return ('standalone' in window.navigator && window.navigator.standalone) ||
           window.matchMedia('(display-mode: standalone)').matches;
  };

  // Se for iOS e não estiver em modo app instalado, exibe botão de instruções
  if (!isInStandaloneMode()) {
    if (isIos()) {
      if (btnInstallHeader) btnInstallHeader.style.display = 'flex';
      if (lobbyInstallBox) lobbyInstallBox.style.display = 'flex';
    }
  }

  // Captura o prompt de instalação nativo no Android/Chrome/Edge
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!isInStandaloneMode()) {
      if (btnInstallHeader) btnInstallHeader.style.display = 'flex';
      if (lobbyInstallBox) lobbyInstallBox.style.display = 'flex';
    }
  });

  function triggerInstall() {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') {
          showToast('🎉 Aplicativo instalado com sucesso na sua tela inicial!');
          if (btnInstallHeader) btnInstallHeader.style.display = 'none';
          if (lobbyInstallBox) lobbyInstallBox.style.display = 'none';
        }
        deferredInstallPrompt = null;
      });
    } else if (isIos()) {
      if (modalIosInstall) modalIosInstall.classList.add('active');
    } else {
      showToast('Abra as opções do navegador (⋮) e toque em "Adicionar à tela inicial"');
    }
  }

  if (btnInstallHeader) btnInstallHeader.addEventListener('click', triggerInstall);
  if (btnLobbyInstall) btnLobbyInstall.addEventListener('click', triggerInstall);
  if (btnCloseIosModal) {
    btnCloseIosModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalIosInstall) modalIosInstall.classList.remove('active');
    });
  }

  window.addEventListener('appinstalled', () => {
    showToast('⚓ Batalha Naval instalada como aplicativo!');
    if (btnInstallHeader) btnInstallHeader.style.display = 'none';
    if (lobbyInstallBox) lobbyInstallBox.style.display = 'none';
  });

})();
