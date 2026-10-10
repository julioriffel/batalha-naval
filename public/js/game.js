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
    playerName: localStorage.getItem('naval_player_name') || 'Comandante',
    opponentName: 'Inimigo',
    opponentFriendCode: null,
    persistentId: localStorage.getItem('naval_player_uuid') || (function() {
      const id = 'usr_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
      localStorage.setItem('naval_player_uuid', id);
      return id;
    })(),
    friendCode: localStorage.getItem('naval_friend_code') || null,
    pushEnabled: false,
    friends: [],
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
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        showToast(`Entrou na sala do Comandante ${msg.opponentName}!`);
        break;

      case 'opponent_joined':
        state.opponentName = msg.opponentName;
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
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
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        initBattlePhase(msg.isYourTurn, msg.activePlayerName);
        if (msg.sessionScore) {
          updateDuelScore(msg.sessionScore);
        }
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
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        handleGameOver(msg);
        break;

      case 'leaderboard_data':
        renderLeaderboard(msg.leaderboard);
        break;

      case 'friend_added_notice':
        showToast(`⭐ O Comandante ${msg.fromName} (${msg.fromCode}) adicionou você como amigo!`, 5000);
        window.tacticalAudio.sonarPing();
        fetchAndRenderFriends();
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

  if (state.playerName) {
    inputPlayerName.value = state.playerName;
  }

  btnCreateRoom.addEventListener('click', async () => {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    state.playerName = inputPlayerName.value.trim() || 'Comandante 1';
    localStorage.setItem('naval_player_name', state.playerName);
    await initWebSocket();
    sendWS('create_room', {
      playerName: state.playerName,
      friendCode: state.friendCode,
      origin: window.location.origin
    });
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
    localStorage.setItem('naval_player_name', state.playerName);
    await initWebSocket();
    sendWS('join_room', {
      roomCode: code,
      playerName: state.playerName,
      friendCode: state.friendCode
    });
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

  // --- URL Param Auto-Fill (?sala=XYZ ou ?amigo=CMD-XYZ) ---
  const urlParams = new URLSearchParams(window.location.search);
  const paramSala = urlParams.get('sala');
  const isChallenge = urlParams.get('desafio') === '1';

  if (paramSala) {
    inputRoomCode.value = paramSala.toUpperCase();
    inputRoomCode.focus();
    if (isChallenge) {
      showToast(`⚔️ DESAFIO PUSH RECEBIDO! Sala ${paramSala.toUpperCase()} carregada. Entre na partida!`, 6000);
      window.tacticalAudio.turnAlertSound();
    } else {
      showToast(`Código ${paramSala.toUpperCase()} carregado! Digite seu nome e entre.`);
    }
  }

  const paramAmigo = urlParams.get('amigo');
  if (paramAmigo) {
    const friendCandidate = paramAmigo.toUpperCase().trim();
    setTimeout(() => {
      if (confirm(`Deseja adicionar o Comandante com código ${friendCandidate} aos seus amigos?`)) {
        addFriendByCode(friendCandidate);
      }
    }, 1000);
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

    // Atualiza placar do confronto da sessão
    if (msg.sessionScore) {
      updateDuelScore(msg.sessionScore);
      const duelText = document.getElementById('gameover-duel-text');
      if (duelText) {
        duelText.textContent = `${state.playerName} ${msg.sessionScore.myWins} ⚔️ ${msg.sessionScore.opponentWins} ${msg.sessionScore.opponentName}`;
      }
    }

    // Se o servidor enviou o ranking atualizado, pré-renderiza
    if (msg.leaderboard) {
      renderLeaderboard(msg.leaderboard);
    }

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

  // --- RANKING & DUEL SCORE UTILITIES ---
  function updateDuelScore(score) {
    if (!score) return;
    const myNameEl = document.getElementById('duel-my-name');
    const myScoreEl = document.getElementById('duel-my-score');
    const oppNameEl = document.getElementById('duel-opp-name');
    const oppScoreEl = document.getElementById('duel-opp-score');

    if (myNameEl) myNameEl.textContent = state.playerName || 'Você';
    if (myScoreEl) myScoreEl.textContent = score.myWins ?? 0;
    if (oppNameEl) oppNameEl.textContent = score.opponentName || state.opponentName || 'Inimigo';
    if (oppScoreEl) oppScoreEl.textContent = score.opponentWins ?? 0;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderLeaderboard(leaderboard) {
    const tbody = document.getElementById('ranking-table-body');
    if (!tbody) return;

    if (!Array.isArray(leaderboard) || leaderboard.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-dim); padding: 22px;">
            Nenhuma batalha registrada ainda. Vença a primeira para liderar o quadro de honra!
          </td>
        </tr>
      `;
      return;
    }

    const currentName = (state.playerName || '').trim().toLowerCase();

    tbody.innerHTML = leaderboard.map((item, idx) => {
      const pos = idx + 1;
      let posBadge = `${pos}º`;
      let trClass = '';

      if (pos === 1) {
        posBadge = '🥇 1º';
        trClass = 'top-1';
      } else if (pos === 2) {
        posBadge = '🥈 2º';
        trClass = 'top-2';
      } else if (pos === 3) {
        posBadge = '🥉 3º';
        trClass = 'top-3';
      }

      const isMe = (item.name || '').trim().toLowerCase() === currentName;
      if (isMe) {
        trClass += (trClass ? ' ' : '') + 'is-me';
      }

      const nameDisplay = escapeHtml(item.name) + (isMe ? ' <span style="font-size:0.75rem; color:var(--cyan); font-weight:normal;">(Você)</span>' : '');

      return `
        <tr class="${trClass}">
          <td style="font-weight: 800;">${posBadge}</td>
          <td>${nameDisplay}</td>
          <td><strong style="color: #00ff88;">${item.wins}</strong></td>
          <td style="color: var(--text-dim);">${item.losses}</td>
          <td>${item.winRate}%</td>
          <td>${item.accuracy}%</td>
        </tr>
      `;
    }).join('');
  }

  async function fetchAndShowLeaderboard() {
    window.tacticalAudio.click();
    const modalRanking = document.getElementById('modal-ranking');
    if (modalRanking) modalRanking.classList.add('active');

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      sendWS('get_leaderboard');
    } else {
      try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        if (data.leaderboard) {
          renderLeaderboard(data.leaderboard);
        }
      } catch (err) {
        console.error('Erro buscando ranking:', err);
      }
    }
  }

  const modalRanking = document.getElementById('modal-ranking');
  const btnOpenRanking = document.getElementById('btn-open-ranking');
  const btnLobbyRanking = document.getElementById('btn-lobby-ranking');
  const btnGameOverRanking = document.getElementById('btn-gameover-ranking');
  const btnCloseRankingModal = document.getElementById('btn-close-ranking-modal');

  if (btnOpenRanking) btnOpenRanking.addEventListener('click', fetchAndShowLeaderboard);
  if (btnLobbyRanking) btnLobbyRanking.addEventListener('click', fetchAndShowLeaderboard);
  if (btnGameOverRanking) btnGameOverRanking.addEventListener('click', fetchAndShowLeaderboard);

  if (btnCloseRankingModal) {
    btnCloseRankingModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalRanking) modalRanking.classList.remove('active');
    });
  }

  if (modalRanking) {
    modalRanking.addEventListener('click', (e) => {
      if (e.target === modalRanking) {
        modalRanking.classList.remove('active');
      }
    });
  }

  // --- SISTEMA DE AMIGOS E NOTIFICAÇÕES PUSH ---
  async function syncPlayerProfile() {
    try {
      const res = await fetch('/api/player/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persistentId: state.persistentId,
          name: state.playerName,
          code: state.friendCode
        })
      });
      const data = await res.json();
      if (data.code) {
        state.friendCode = data.code;
        localStorage.setItem('naval_friend_code', data.code);
        const codeDisplay = document.getElementById('my-display-friend-code');
        if (codeDisplay) codeDisplay.textContent = data.code;
      }
      state.pushEnabled = !!data.pushEnabled;
      updatePushStatusUI(state.pushEnabled);
    } catch (e) {
      console.warn('Erro sincronizando perfil do jogador:', e);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function updatePushStatusUI(active) {
    const box = document.getElementById('push-status-box');
    const title = document.getElementById('push-status-title');
    const desc = document.getElementById('push-status-desc');
    const btn = document.getElementById('btn-enable-push');
    const icon = document.getElementById('push-status-icon');

    if (!box || !btn) return;

    if (active) {
      box.classList.add('active');
      if (icon) icon.textContent = '✅';
      if (title) title.textContent = 'Notificações Push Ativas';
      if (desc) desc.textContent = 'Você receberá os chamados de batalha dos seus amigos direto no celular!';
      btn.textContent = 'Ativado';
      btn.disabled = true;
    } else {
      box.classList.remove('active');
      if (icon) icon.textContent = '🔔';
      if (title) title.textContent = 'Notificações Push';
      if (desc) desc.textContent = 'Ative para receber chamados de batalha mesmo fora do jogo.';
      btn.textContent = 'Ativar';
      btn.disabled = false;
    }
  }

  async function checkPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        state.pushEnabled = true;
        updatePushStatusUI(true);
      }
    } catch (e) {
      console.warn('Erro verificando push subscription:', e);
    }
  }

  async function subscribeToPushNotifications() {
    window.tacticalAudio.click();
    if (!('Notification' in window) || !('PushManager' in window)) {
      showToast('⚠️ Seu navegador não suporta Web Push Notifications.');
      return;
    }

    if (isIos() && !isInStandaloneMode()) {
      showToast('📲 No iPhone: instale o app na Tela de Início primeiro para habilitar o Push!', 5000);
      if (modalIosInstall) modalIosInstall.classList.add('active');
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('⚠️ Permissão de notificações não concedida no navegador.');
        return;
      }

      const vapidRes = await fetch('/api/push/vapid-public-key');
      const vapidData = await vapidRes.json();
      if (!vapidData.publicKey) throw new Error('Chave VAPID não recebida');

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey)
        });
      }

      const subRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: state.friendCode,
          subscription: sub
        })
      });

      const subData = await subRes.json();
      if (subData.success) {
        state.pushEnabled = true;
        updatePushStatusUI(true);
        window.tacticalAudio.sonarPing();
        showToast('🔔 Notificações push ativadas com sucesso! Você receberá desafios de amigos.');
      } else {
        showToast(subData.error || 'Erro ao ativar push.');
      }
    } catch (err) {
      console.error('Erro ao subscrever push:', err);
      showToast('Falha ao ativar notificações push.');
    }
  }

  async function fetchAndRenderFriends() {
    if (!state.friendCode) await syncPlayerProfile();
    const container = document.getElementById('friends-list-container');
    const badge = document.getElementById('friends-count-badge');
    if (!container) return;

    try {
      const res = await fetch(`/api/friends/list?code=${state.friendCode}`);
      const data = await res.json();
      const friends = data.friends || [];
      state.friends = friends;

      if (badge) badge.textContent = friends.length;

      if (friends.length === 0) {
        container.innerHTML = `
          <div class="friends-empty-hint">
            Você ainda não adicionou nenhum comandante amigo.<br>
            Compartilhe seu código <strong>${state.friendCode || '...'}</strong> ou adicione adversários após as batalhas!
          </div>
        `;
        return;
      }

      container.innerHTML = friends.map(f => {
        const canChallenge = f.isMutual && f.pushEnabled;
        const challengeTitle = !f.isMutual 
          ? 'Apenas amigos mútuos podem ser desafiados via push. Ele também precisa adicionar seu código.' 
          : (!f.pushEnabled ? 'O amigo precisa ativar notificações push no app.' : 'Chamar para uma Batalha Naval agora!');

        return `
          <div class="friend-item ${f.isMutual ? 'mutual' : ''}">
            <div class="friend-info">
              <div class="friend-name-row">
                <span class="friend-name">${escapeHtml(f.name)}</span>
                <span style="font-size:0.75rem; color:var(--text-dim);">${f.code}</span>
              </div>
              <div class="friend-badges">
                ${f.isMutual ? '<span class="badge-mutual">✅ Amigos Mútuos</span>' : '<span class="badge-pending">⏳ Aguardando ele te adicionar</span>'}
                ${f.pushEnabled ? '<span class="badge-push-on">🔔 Push Ativo</span>' : '<span class="badge-push-off">🔕 Sem Push</span>'}
              </div>
            </div>
            <div class="friend-actions">
              <button class="btn-challenge" ${canChallenge ? '' : 'disabled'} title="${challengeTitle}" data-code="${f.code}">
                ⚔️ Chamar
              </button>
              <button class="btn-remove-friend" title="Remover amigo" data-code="${f.code}">
                🗑️
              </button>
            </div>
          </div>
        `;
      }).join('');

      container.querySelectorAll('.btn-challenge').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = btn.getAttribute('data-code');
          challengeFriend(code);
        });
      });

      container.querySelectorAll('.btn-remove-friend').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = btn.getAttribute('data-code');
          removeFriendByCode(code);
        });
      });

    } catch (err) {
      console.error('Erro buscando lista de amigos:', err);
    }
  }

  async function addFriendByCode(targetCode) {
    if (!targetCode) return;
    targetCode = targetCode.trim().toUpperCase();
    if (!targetCode) return;

    if (targetCode === state.friendCode) {
      showToast('Você não pode adicionar seu próprio código!');
      return;
    }

    try {
      const res = await fetch('/api/friends/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myCode: state.friendCode,
          targetCode
        })
      });
      const data = await res.json();
      if (data.success) {
        window.tacticalAudio.sonarPing();
        if (data.isMutual) {
          showToast(`🎉 Comandante ${data.friend.name} é agora seu amigo mútuo! Vocês podem se desafiar via push.`);
        } else {
          showToast(`⭐ Comandante ${data.friend.name} adicionado! Quando ele te adicionar de volta, vocês serão amigos mútuos.`);
        }
        const input = document.getElementById('input-add-friend-code');
        if (input) input.value = '';
        fetchAndRenderFriends();
      } else {
        showToast(`⚠️ ${data.error || 'Erro ao adicionar amigo'}`);
      }
    } catch (err) {
      console.error('Erro ao adicionar amigo:', err);
      showToast('Erro de conexão ao adicionar amigo.');
    }
  }

  async function removeFriendByCode(targetCode) {
    if (!confirm(`Remover o Comandante ${targetCode} dos seus amigos?`)) return;
    try {
      await fetch('/api/friends/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myCode: state.friendCode,
          targetCode
        })
      });
      showToast('Amigo removido da sua lista.');
      fetchAndRenderFriends();
    } catch (err) {
      console.error('Erro ao remover amigo:', err);
    }
  }

  async function challengeFriend(targetCode) {
    window.tacticalAudio.click();
    showToast(`📡 Enviando convite de batalha para ${targetCode}...`);

    try {
      const res = await fetch('/api/friends/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myCode: state.friendCode,
          targetCode,
          origin: window.location.origin
        })
      });
      const data = await res.json();
      if (!data.success) {
        showToast(`⚠️ ${data.error || 'Não foi possível enviar o desafio'}`);
        return;
      }

      // Sucesso! Fecha modal de amigos e entra na sala criada
      const modalFriends = document.getElementById('modal-friends');
      if (modalFriends) modalFriends.classList.remove('active');

      state.roomCode = data.roomCode;
      state.playerName = inputPlayerName.value.trim() || 'Comandante 1';
      await initWebSocket();

      sendWS('create_room', {
        playerName: state.playerName,
        friendCode: state.friendCode,
        roomCode: data.roomCode,
        origin: window.location.origin
      });

      window.tacticalAudio.sonarPing();
      showToast(`🚀 Notificação enviada para ${targetCode}! Aguardando na sala ${data.roomCode}...`, 5000);
    } catch (err) {
      console.error('Erro ao desafiar amigo:', err);
      showToast('Falha de conexão ao enviar desafio.');
    }
  }

  function updateOpponentFriendButtons() {
    const btnBattleAddFriend = document.getElementById('btn-battle-add-friend');
    const btnGameOverAddFriend = document.getElementById('btn-gameover-add-friend');

    if (state.opponentFriendCode && state.opponentFriendCode !== state.friendCode) {
      if (btnBattleAddFriend) btnBattleAddFriend.style.display = 'inline-block';
      if (btnGameOverAddFriend) btnGameOverAddFriend.style.display = 'block';
    }
  }

  const btnBattleAddFriend = document.getElementById('btn-battle-add-friend');
  if (btnBattleAddFriend) {
    btnBattleAddFriend.addEventListener('click', async () => {
      window.tacticalAudio.click();
      if (state.opponentFriendCode) {
        await addFriendByCode(state.opponentFriendCode);
        btnBattleAddFriend.textContent = '✅ Amigo!';
      }
    });
  }

  const btnGameOverAddFriend = document.getElementById('btn-gameover-add-friend');
  if (btnGameOverAddFriend) {
    btnGameOverAddFriend.addEventListener('click', async () => {
      window.tacticalAudio.click();
      if (state.opponentFriendCode) {
        await addFriendByCode(state.opponentFriendCode);
        btnGameOverAddFriend.textContent = '✅ Amigo Adicionado!';
      }
    });
  }

  const modalFriends = document.getElementById('modal-friends');
  const btnOpenFriends = document.getElementById('btn-open-friends');
  const btnLobbyFriends = document.getElementById('btn-lobby-friends');
  const btnCloseFriendsModal = document.getElementById('btn-close-friends-modal');
  const btnCopyFriendCode = document.getElementById('btn-copy-friend-code');
  const btnShareFriendCode = document.getElementById('btn-share-friend-code');
  const btnEnablePush = document.getElementById('btn-enable-push');
  const btnSubmitAddFriend = document.getElementById('btn-submit-add-friend');
  const inputAddFriendCode = document.getElementById('input-add-friend-code');

  function openFriendsModal() {
    window.tacticalAudio.click();
    if (modalFriends) modalFriends.classList.add('active');
    fetchAndRenderFriends();
  }

  if (btnOpenFriends) btnOpenFriends.addEventListener('click', openFriendsModal);
  if (btnLobbyFriends) btnLobbyFriends.addEventListener('click', openFriendsModal);

  if (btnCloseFriendsModal) {
    btnCloseFriendsModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalFriends) modalFriends.classList.remove('active');
    });
  }

  if (modalFriends) {
    modalFriends.addEventListener('click', (e) => {
      if (e.target === modalFriends) modalFriends.classList.remove('active');
    });
  }

  if (btnCopyFriendCode) {
    btnCopyFriendCode.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (!state.friendCode) return;
      navigator.clipboard.writeText(state.friendCode).then(() => {
        showToast(`📋 Código ${state.friendCode} copiado!`);
      }).catch(() => {
        showToast(`Seu código é ${state.friendCode}`);
      });
    });
  }

  if (btnShareFriendCode) {
    btnShareFriendCode.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (!state.friendCode) return;
      const shareUrl = `${window.location.origin}/?amigo=${state.friendCode}`;
      if (navigator.share) {
        navigator.share({
          title: 'Batalha Naval High-Tech',
          text: `Adicione o Comandante ${state.playerName} (${state.friendCode}) na Batalha Naval!`,
          url: shareUrl
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(shareUrl).then(() => {
          showToast('📋 Link de convite copiado!');
        });
      }
    });
  }

  if (btnEnablePush) {
    btnEnablePush.addEventListener('click', subscribeToPushNotifications);
  }

  if (btnSubmitAddFriend && inputAddFriendCode) {
    btnSubmitAddFriend.addEventListener('click', () => {
      window.tacticalAudio.click();
      addFriendByCode(inputAddFriendCode.value);
    });
    inputAddFriendCode.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        window.tacticalAudio.click();
        addFriendByCode(inputAddFriendCode.value);
      }
    });
  }

  // Inicializa o perfil e verifica suporte a push no carregamento
  syncPlayerProfile();
  checkPushSubscription();

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
