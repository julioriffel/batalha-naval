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
    isPublicRoom: true,
    isHost: false,
    isBotMatch: false,
    botDifficulty: localStorage.getItem('naval_bot_difficulty') || 'medium',
    shipSpecs: [
      { id: 'carrier', name: 'Porta-Aviões', size: 5 },
      { id: 'battleship', name: 'Encouraçado', size: 4 },
      { id: 'cruiser', name: 'Cruzador', size: 3 },
      { id: 'submarine', name: 'Submarino', size: 3 },
      { id: 'destroyer', name: 'Contratorpedeiro', size: 2 }
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
    if (hudTurnBanner) {
      hudTurnBanner.style.display = (screenName === 'battle') ? 'flex' : 'none';
    }

    if (screenName === 'placement' || screenName === 'battle') {
      window.history.pushState({ screen: screenName, navalInGame: true }, '', window.location.href);
    }
  }

  // --- Sound & Audio Control ---
  function updateMuteButton() {
    const muted = window.tacticalAudio.isMuted();
    btnMute.innerHTML = muted 
      ? `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg><span class="btn-label">Mudo</span>` 
      : `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><span class="btn-label">Som</span>`;
  }

  btnMute.addEventListener('click', () => {
    const isMuted = window.tacticalAudio.toggleMute();
    updateMuteButton();
    if (!isMuted) {
      window.tacticalAudio.turnAlertSound();
      const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
      if (isIos) {
        showToast('iPhone: desative o modo silencioso para áudio.', 3500);
      }
    }
  });
  updateMuteButton();

  // --- WebSocket Setup ---
  let wsConnectingPromise = null;

  function initWebSocket() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(state.ws);
    }
    if (wsConnectingPromise && state.ws && state.ws.readyState === WebSocket.CONNECTING) {
      return wsConnectingPromise;
    }

    wsConnectingPromise = new Promise((resolve, reject) => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        const ws = new WebSocket(wsUrl);
        state.ws = ws;

        ws.onopen = () => {
          wsConnectingPromise = null;
          sendWS('register_user', {
            friendCode: state.friendCode,
            persistentId: state.persistentId,
            playerName: state.playerName
          });
          sendWS('get_public_rooms');
          resolve(ws);
        };

        ws.onerror = (err) => {
          wsConnectingPromise = null;
          console.warn('Conexão WebSocket:', err);
          if (screens.battle && screens.battle.classList.contains('active')) {
            showToast('Instabilidade na conexão do radar.');
          }
          reject(err);
        };

        ws.onclose = () => {
          wsConnectingPromise = null;
          state.ws = null;

          if (state.roomCode) {
            if (screens.battle && screens.battle.classList.contains('active')) {
              showToast('Radar desconectado. Tentando reconectar...');
              if (hudTurnBanner) {
                hudTurnBanner.textContent = 'RECONECTANDO AO RADAR...';
                hudTurnBanner.className = 'turn-banner alert-danger';
              }
            }
            setTimeout(() => {
              if (state.roomCode && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
                initWebSocket().then(() => {
                  sendWS('reconnect_room', {
                    roomCode: state.roomCode,
                    persistentId: state.persistentId,
                    friendCode: state.friendCode,
                    playerId: state.playerId,
                    playerName: state.playerName,
                    origin: window.location.origin
                  });
                }).catch(() => {});
              }
            }, 2000);
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
          } catch (e) {
            console.error('Erro decodificando mensagem:', e);
          }
        };
      } catch (err) {
        wsConnectingPromise = null;
        reject(err);
      }
    });

    return wsConnectingPromise;
  }

  function sendWS(type, payload = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  // --- Sincronização da URL com o Código da Sala Ativa ---
  function syncRoomUrl(roomCode) {
    const cleanCode = (roomCode || '').toUpperCase().trim();
    const currentParams = new URLSearchParams(window.location.search);
    const existingParam = currentParams.get('sala');

    if (cleanCode) {
      try {
        sessionStorage.setItem('naval_active_room', cleanCode);
      } catch (e) {}

      if (existingParam !== cleanCode) {
        currentParams.set('sala', cleanCode);
        const newUrl = `${window.location.pathname}?${currentParams.toString()}`;
        window.history.replaceState({ screen: state.screen || 'room', roomCode: cleanCode, navalInGame: true }, '', newUrl);
      }
    } else {
      try {
        sessionStorage.removeItem('naval_active_room');
      } catch (e) {}

      if (currentParams.has('sala') || currentParams.has('desafio')) {
        currentParams.delete('sala');
        currentParams.delete('desafio');
        const newQuery = currentParams.toString();
        const newUrl = newQuery ? `${window.location.pathname}?${newQuery}` : window.location.pathname;
        window.history.replaceState({ screen: 'lobby', navalInGame: false }, '', newUrl);
      }
    }
  }

  // --- Controle Visual do Código da Sala Ativa ---
  function updateActiveRoomCodeDisplay(code) {
    state.roomCode = code || null;
    const hudBadge = document.getElementById('hud-room-badge');
    const hudCode = document.getElementById('hud-room-code-text');
    const placementCode = document.getElementById('placement-room-code');
    const battleCode = document.getElementById('battle-room-code');
    const waitingCode = document.getElementById('display-room-code');

    if (code) {
      if (hudCode) hudCode.textContent = code;
      if (hudBadge) hudBadge.style.display = 'inline-flex';
      if (placementCode) placementCode.textContent = code;
      if (battleCode) battleCode.textContent = code;
      if (waitingCode) waitingCode.textContent = code;
    } else {
      if (hudBadge) hudBadge.style.display = 'none';
      if (hudCode) hudCode.textContent = '----';
      if (placementCode) placementCode.textContent = '----';
      if (battleCode) battleCode.textContent = '----';
      if (waitingCode) waitingCode.textContent = '----';
    }

    syncRoomUrl(code);
  }

  // --- Message Dispatcher ---
  function handleServerMessage(msg) {
    console.log('[Radar Naval In]', msg);

    switch (msg.type) {
      case 'room_created':
        updateActiveRoomCodeDisplay(msg.roomCode);
        state.playerId = msg.playerId;
        state.isHost = true;
        state.isBotMatch = Boolean(msg.isBot);
        if (msg.opponentName) state.opponentName = msg.opponentName;
        state.joinUrl = msg.joinUrl || `${window.location.origin}/?sala=${msg.roomCode}`;

        if (!msg.isBot) {
          const qrImg = document.getElementById('qr-img');
          if (qrImg && msg.qrDataUrl) {
            qrImg.src = msg.qrDataUrl;
          }

          const netIpEl = document.getElementById('network-ip-display');
          if (netIpEl) {
            netIpEl.textContent = state.joinUrl;
          }

          const waitingPrivacyBadge = document.getElementById('waiting-privacy-badge');
          if (waitingPrivacyBadge) {
            if (msg.isPublic !== false) {
              waitingPrivacyBadge.textContent = 'Sala Pública • Aberta no radar';
              waitingPrivacyBadge.style.background = 'rgba(0, 240, 255, 0.15)';
              waitingPrivacyBadge.style.color = 'var(--cyan)';
              waitingPrivacyBadge.style.borderColor = 'var(--cyan)';
            } else {
              waitingPrivacyBadge.textContent = 'Sala Privada • Oculta do radar';
              waitingPrivacyBadge.style.background = 'rgba(255, 170, 0, 0.15)';
              waitingPrivacyBadge.style.color = '#ffaa00';
              waitingPrivacyBadge.style.borderColor = '#ffaa00';
            }
          }

          const waitingParticipantsText = document.getElementById('waiting-participants-text');
          if (waitingParticipantsText) {
            waitingParticipantsText.textContent = '1/2 Jogadores';
          }

          showScreen('waitingHost');
          window.tacticalAudio.sonarPing();
        }
        break;

      case 'public_rooms_updated':
        renderPublicRooms(msg.rooms);
        break;

      case 'room_joined':
        updateActiveRoomCodeDisplay(msg.roomCode);
        state.playerId = msg.playerId;
        state.isHost = false;
        state.isBotMatch = Boolean(msg.isBot);
        state.opponentName = msg.opponentName;
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        if (!msg.isBot) {
          showToast(`Conectado à sala #${msg.roomCode}`);
        }
        break;

      case 'opponent_joined':
        if (state.roomCode) updateActiveRoomCodeDisplay(state.roomCode);
        state.opponentName = msg.opponentName;
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        showToast(`${msg.opponentName} conectado ao radar`);
        break;

      case 'start_placement':
        if (msg.shipSpecs) state.shipSpecs = msg.shipSpecs;
        if (state.roomCode) updateActiveRoomCodeDisplay(state.roomCode);
        if (msg.opponentName) state.opponentName = msg.opponentName;
        if (msg.isBot !== undefined) state.isBotMatch = Boolean(msg.isBot);
        initPlacementPhase();
        showScreen('placement');
        window.tacticalAudio.sonarPing();
        break;

      case 'fleet_confirmed':
        document.getElementById('btn-confirm-fleet').disabled = true;
        document.getElementById('btn-confirm-fleet').textContent = 'Frota Pronta';
        document.getElementById('placement-status-text').textContent = 'Aguardando oponente...';
        break;

      case 'opponent_ready':
        showToast('Oponente pronto para a batalha');
        break;

      case 'battle_started':
        if (state.roomCode) updateActiveRoomCodeDisplay(state.roomCode);
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
        window.tacticalAudio.sonarPing();
        if (window.tacticalHaptics) window.tacticalHaptics.radarPing();
        if (msg.isMutual) {
          showToast(`Comandante ${msg.fromName} retribuiu seu pedido! Vocês agora são amigos mútuos.`, 5000);
        } else {
          showToast(`Pedido de amizade recebido do Comandante ${msg.fromName}! Toque em Amigos para responder.`, 5500);
        }
        fetchAndRenderFriends();
        break;

      case 'opponent_wants_rematch':
        showToast(msg.message || 'Oponente pediu revanche.');
        break;

      case 'rematch_pending':
        const btnRematch = document.getElementById('btn-rematch');
        if (btnRematch) {
          btnRematch.disabled = true;
          btnRematch.textContent = 'Aguardando adversário...';
        }
        break;

      case 'rematch_accepted':
        modalGameOver.classList.remove('active');
        showToast('Revanche iniciada! Reposicione sua frota.');
        break;

      case 'opponent_disconnected':
        showToast(msg.message, 4000);
        hudTurnBanner.textContent = 'ADVERSÁRIO DESCONECTOU';
        hudTurnBanner.className = 'turn-banner alert-danger';
        break;

      case 'opponent_reconnected':
        showToast(msg.message || 'O comandante adversário reconectou!', 4000);
        window.tacticalAudio.sonarPing();
        if (screens.battle && screens.battle.classList.contains('active')) {
          updateTurnDisplay(state.battle.isMyTurn, state.battle.turnPlayerName);
        }
        break;

      case 'reconnect_placement':
        state.roomCode = msg.roomCode;
        updateActiveRoomCodeDisplay(msg.roomCode);
        state.playerId = msg.playerId;
        state.playerName = msg.playerName;
        state.opponentName = msg.opponentName;
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        state.isHost = Boolean(msg.isHost);
        state.isBotMatch = Boolean(msg.isBot);
        if (msg.shipSpecs) state.shipSpecs = msg.shipSpecs;

        initPlacementPhase();
        showScreen('placement');

        if (msg.ready && Array.isArray(msg.ships) && msg.ships.length > 0) {
          state.placement.ships = msg.ships;
          renderPlacementFleetChips();
          updatePlacementGridDisplay();
          document.getElementById('btn-confirm-fleet').disabled = true;
          document.getElementById('btn-confirm-fleet').textContent = 'Frota Pronta';
          document.getElementById('placement-status-text').textContent = 'Aguardando oponente...';
        } else if (Array.isArray(msg.ships) && msg.ships.length > 0) {
          state.placement.ships = msg.ships;
          renderPlacementFleetChips();
          updatePlacementGridDisplay();
          checkAllShipsPlaced();
        }

        showToast('Reconectado à sala de preparação!', 3500);
        window.tacticalAudio.sonarPing();
        break;

      case 'battle_reconnected':
        state.roomCode = msg.roomCode;
        updateActiveRoomCodeDisplay(msg.roomCode);
        state.playerId = msg.playerId;
        state.playerName = msg.playerName;
        state.opponentName = msg.opponentName;
        if (msg.opponentFriendCode) {
          state.opponentFriendCode = msg.opponentFriendCode;
          updateOpponentFriendButtons();
        }
        state.isHost = Boolean(msg.isHost);
        state.isBotMatch = Boolean(msg.isBot);

        state.battle.isMyTurn = msg.isYourTurn;
        state.battle.turnPlayerName = msg.activePlayerName;
        state.battle.attackGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
        state.battle.defenseGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

        renderGrid(attackGridEl, true, onAttackCellClick);
        renderGrid(defenseGridEl, false);

        state.placement.ships = msg.myFleet || [];
        (msg.myFleet || []).forEach(ship => {
          ship.coords.forEach(c => {
            const cell = defenseGridEl.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
            if (cell) cell.classList.add('ship');
          });
        });

        (msg.myHitsReceived || []).forEach(coordStr => {
          const [r, c] = coordStr.split(',').map(Number);
          if (state.battle.defenseGrid[r]) state.battle.defenseGrid[r][c] = 'hit';
          const cell = defenseGridEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
          if (cell) cell.className = 'grid-cell hit';
        });

        (msg.myMissesReceived || []).forEach(coordStr => {
          const [r, c] = coordStr.split(',').map(Number);
          if (state.battle.defenseGrid[r]) state.battle.defenseGrid[r][c] = 'miss';
          const cell = defenseGridEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
          if (cell) cell.className = 'grid-cell miss';
        });

        (msg.opponentHitsReceived || []).forEach(coordStr => {
          const [r, c] = coordStr.split(',').map(Number);
          if (state.battle.attackGrid[r]) state.battle.attackGrid[r][c] = 'hit';
          const cell = attackGridEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
          if (cell) cell.className = 'grid-cell hit';
        });

        (msg.opponentMissesReceived || []).forEach(coordStr => {
          const [r, c] = coordStr.split(',').map(Number);
          if (state.battle.attackGrid[r]) state.battle.attackGrid[r][c] = 'miss';
          const cell = attackGridEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
          if (cell) cell.className = 'grid-cell miss';
        });

        renderFleetPips();
        let enemySunkCount = 0;
        (msg.opponentSunkShips || []).forEach(ship => {
          enemySunkCount++;
          markShipSunk(attackGridEl, ship.coords);
          const enemyPip = document.getElementById(`enemy-pip-${ship.id}`);
          if (enemyPip) enemyPip.classList.add('sunk');
        });
        state.battle.enemySunkCount = enemySunkCount;

        if (msg.sessionScore) {
          updateDuelScore(msg.sessionScore);
        }

        showScreen('battle');
        updateTurnDisplay(msg.isYourTurn, msg.activePlayerName);
        showToast('Reconectado à batalha naval!', 3500);
        window.tacticalAudio.sonarPing();
        break;

      case 'reconnect_failed':
        const prevActiveRoom = (function() {
          try { return sessionStorage.getItem('naval_active_room'); } catch (e) { return null; }
        })();
        if (prevActiveRoom && prevActiveRoom === msg.roomCode) {
          showToast('A sala anterior foi encerrada ou expirou.', 4000);
          syncRoomUrl(null);
        } else {
          showToast(msg.message || `Sala #${msg.roomCode} pronta. Toque em Entrar na Sala.`);
        }
        break;

      case 'surrender_acknowledged':
        showToast('Partida encerrada.');
        resetMatchToLobby();
        break;

      case 'opponent_left':
        showToast(msg.message || 'O adversário saiu da sala.', 4000);
        hudTurnBanner.textContent = 'ADVERSÁRIO SAIU';
        hudTurnBanner.className = 'turn-banner alert-danger';
        break;

      case 'left_room_success':
        resetMatchToLobby();
        break;

      case 'error':
        showToast(msg.message);
        break;
    }
  }

  // --- LOBBY INTERACTIONS ---
  const inputPlayerName = document.getElementById('input-player-name');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const inputRoomCode = document.getElementById('input-room-code');
  const btnPrivacyPublic = document.getElementById('btn-privacy-public');
  const btnPrivacyPrivate = document.getElementById('btn-privacy-private');
  const publicRoomsContainer = document.getElementById('public-rooms-container');
  const badgePublicRoomsCount = document.getElementById('badge-public-rooms-count');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');

  if (state.playerName) {
    inputPlayerName.value = state.playerName;
  }

  function setRoomPrivacy(isPublic) {
    state.isPublicRoom = isPublic;
    if (btnPrivacyPublic && btnPrivacyPrivate) {
      btnPrivacyPublic.classList.toggle('active', isPublic);
      btnPrivacyPrivate.classList.toggle('active', !isPublic);
    }
  }

  if (btnPrivacyPublic) {
    btnPrivacyPublic.addEventListener('click', () => {
      window.tacticalAudio.click();
      setRoomPrivacy(true);
    });
  }

  if (btnPrivacyPrivate) {
    btnPrivacyPrivate.addEventListener('click', () => {
      window.tacticalAudio.click();
      setRoomPrivacy(false);
    });
  }

  let isCreatingRoom = false;

  btnCreateRoom.addEventListener('click', async () => {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    if (isCreatingRoom) return;
    isCreatingRoom = true;
    setTimeout(() => { isCreatingRoom = false; }, 1500);

    state.playerName = inputPlayerName.value.trim() || 'Comandante 1';
    localStorage.setItem('naval_player_name', state.playerName);
    await initWebSocket();
    sendWS('create_room', {
      playerName: state.playerName,
      friendCode: state.friendCode,
      persistentId: state.persistentId,
      isPublic: state.isPublicRoom,
      origin: window.location.origin
    });
  });

  // --- CONTROLE DO MODAL DE BATALHA CONTRA BOT ---
  const modalBot = document.getElementById('modal-bot');
  const btnOpenBotModal = document.getElementById('btn-open-bot-modal');
  const btnCloseBotModalX = document.getElementById('btn-close-bot-modal-x');
  const btnStartBotGame = document.getElementById('btn-start-bot-game');
  const botDifficultyCards = document.querySelectorAll('.difficulty-card');

  function syncBotDifficultyUI() {
    botDifficultyCards.forEach(card => {
      const diff = card.getAttribute('data-difficulty');
      card.classList.toggle('active', diff === state.botDifficulty);
    });
  }

  if (btnOpenBotModal) {
    btnOpenBotModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      window.tacticalHaptics.click();
      syncBotDifficultyUI();
      if (modalBot) modalBot.classList.add('active');
    });
  }

  if (btnCloseBotModalX) {
    btnCloseBotModalX.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalBot) modalBot.classList.remove('active');
    });
  }

  if (modalBot) {
    modalBot.addEventListener('click', (e) => {
      if (e.target === modalBot) {
        modalBot.classList.remove('active');
      }
    });
  }

  botDifficultyCards.forEach(card => {
    card.addEventListener('click', () => {
      window.tacticalAudio.click();
      window.tacticalHaptics.click();
      const diff = card.getAttribute('data-difficulty');
      if (diff) {
        state.botDifficulty = diff;
        localStorage.setItem('naval_bot_difficulty', diff);
        syncBotDifficultyUI();
      }
    });
  });

  if (btnStartBotGame) {
    let isStartingBot = false;
    btnStartBotGame.addEventListener('click', async () => {
      window.tacticalAudio.click();
      window.tacticalHaptics.click();
      if (isStartingBot) return;
      isStartingBot = true;
      setTimeout(() => { isStartingBot = false; }, 1500);

      if (modalBot) modalBot.classList.remove('active');

      state.playerName = inputPlayerName.value.trim() || 'Comandante';
      localStorage.setItem('naval_player_name', state.playerName);
      state.isBotMatch = true;

      await initWebSocket();
      sendWS('create_bot_game', {
        playerName: state.playerName,
        difficulty: state.botDifficulty,
        friendCode: state.friendCode,
        persistentId: state.persistentId,
        origin: window.location.origin
      });
      window.tacticalAudio.sonarPing();
    });
  }

  let isJoiningRoom = false;

  async function joinRoomByCode(code) {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode) {
      showToast('Digite o código da sala!');
      return;
    }

    // Impedir a entrada na própria sala se já for anfitrião dela
    if (state.roomCode && cleanCode === state.roomCode.toUpperCase()) {
      showToast('Você já está nesta sala!');
      return;
    }

    if (isJoiningRoom) return;
    isJoiningRoom = true;
    setTimeout(() => { isJoiningRoom = false; }, 1500);

    state.playerName = inputPlayerName.value.trim() || 'Comandante 2';
    localStorage.setItem('naval_player_name', state.playerName);
    await initWebSocket();
    sendWS('join_room', {
      roomCode: cleanCode,
      playerName: state.playerName,
      friendCode: state.friendCode,
      persistentId: state.persistentId
    });
  }

  btnJoinRoom.addEventListener('click', () => {
    joinRoomByCode(inputRoomCode.value);
  });

  // --- RADAR DE PARTIDAS PÚBLICAS ---
  function renderPublicRooms(rooms) {
    if (!publicRoomsContainer) return;
    const list = Array.isArray(rooms) ? rooms : [];
    if (badgePublicRoomsCount) {
      badgePublicRoomsCount.textContent = list.length;
    }

    if (list.length === 0) {
      publicRoomsContainer.innerHTML = `
        <div class="open-rooms-empty">
          Nenhuma sala aberta no momento.
        </div>
      `;
      return;
    }

    publicRoomsContainer.innerHTML = list.map(room => {
      const hostName = escapeHtml(room.hostName || 'Comandante');
      const code = escapeHtml(room.roomCode);
      const isMyRoom = (state.roomCode && state.roomCode.toUpperCase() === code) ||
                       (state.persistentId && room.hostPersistentId === state.persistentId) ||
                       (state.friendCode && room.hostFriendCode === state.friendCode);

      const createdTime = typeof room.createdAt === 'number' ? room.createdAt : (room.createdAt ? new Date(room.createdAt).getTime() : Date.now());
      const waitingSec = Math.max(0, Math.floor((Date.now() - createdTime) / 1000));
      let timeText = 'agora';
      if (waitingSec >= 60) {
        timeText = `${Math.floor(waitingSec / 60)}m atrás`;
      } else if (waitingSec > 5) {
        timeText = `${waitingSec}s atrás`;
      }

      if (isMyRoom) {
        return `
          <div class="public-room-item my-room-item" data-code="${code}" title="Sua sala de espera">
            <div class="public-room-info">
              <div class="public-room-host">${hostName}</div>
              <div class="public-room-meta">
                <span class="room-tag-pill">#${code}</span>
                <span class="room-my-badge">Sua Sala</span>
                <span class="room-players-badge">${room.playerCount || 1}/${room.maxPlayers || 2}</span>
                <span class="room-time-ago">${timeText}</span>
              </div>
            </div>
            <span class="btn-my-room-label">Aguardando</span>
          </div>
        `;
      }

      return `
        <div class="public-room-item" data-code="${code}" title="Toque para entrar na batalha">
          <div class="public-room-info">
            <div class="public-room-host">${hostName}</div>
            <div class="public-room-meta">
              <span class="room-tag-pill">#${code}</span>
              <span class="room-players-badge">${room.playerCount || 1}/${room.maxPlayers || 2}</span>
              <span class="room-time-ago">${timeText}</span>
            </div>
          </div>
          <button class="btn-join-public-room btn-tactical-accent" data-code="${code}">
            Entrar
          </button>
        </div>
      `;
    }).join('');

    publicRoomsContainer.querySelectorAll('.public-room-item').forEach(item => {
      item.addEventListener('click', () => {
        const code = item.getAttribute('data-code');
        if (item.classList.contains('my-room-item')) {
          showToast('Você é o anfitrião desta sala. Aguarde outro comandante entrar.');
          return;
        }
        joinRoomByCode(code);
      });
    });
  }

  async function fetchAndRenderPublicRooms(notify = false) {
    try {
      const res = await fetch(`/api/rooms/public?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      const data = await res.json();
      if (data && Array.isArray(data.rooms)) {
        renderPublicRooms(data.rooms);
        if (notify) showToast('Radar atualizado.');
      }
    } catch (err) {
      console.warn('Erro ao consultar salas abertas:', err);
    }
  }

  if (btnRefreshRooms) {
    btnRefreshRooms.addEventListener('click', () => {
      window.tacticalAudio.click();
      fetchAndRenderPublicRooms(true);
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        sendWS('get_public_rooms');
      } else {
        initWebSocket().catch(() => {});
      }
    });
  }

  // Consulta inicial e conexão WebSocket imediata para receber atualizações do radar em tempo real
  fetchAndRenderPublicRooms();
  initWebSocket().catch(() => {});

  // Polling como redundância a cada 4 segundos no Lobby
  setInterval(() => {
    if (screens.lobby && screens.lobby.classList.contains('active')) {
      fetchAndRenderPublicRooms();
    }
  }, 4000);

  // Sincroniza imediatamente quando a aba volta a ficar visível
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (screens.lobby && screens.lobby.classList.contains('active')) {
        fetchAndRenderPublicRooms();
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          sendWS('get_public_rooms');
        } else {
          initWebSocket().catch(() => {});
        }
      }
    }
  });

  // Share / Copy Link Button
  const btnCopyLink = document.getElementById('btn-copy-link');
  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', () => {
      const netIpEl = document.getElementById('network-ip-display');
      const url = (netIpEl && netIpEl.textContent) || state.joinUrl || `${window.location.origin}/?sala=${state.roomCode}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link da sala copiado!');
      }).catch(() => {
        showToast(`Código da sala: ${state.roomCode}`);
      });
    });
  }

  // --- URL Param Auto-Fill & Auto-Reconexão (?sala=XYZ ou ?amigo=CMD-XYZ) ---
  const urlParams = new URLSearchParams(window.location.search);
  const paramSala = urlParams.get('sala');
  const isChallenge = urlParams.get('desafio') === '1';

  if (paramSala) {
    const cleanRoomCode = paramSala.toUpperCase().trim();
    inputRoomCode.value = cleanRoomCode;
    inputRoomCode.focus();

    // Conecta WebSocket e tenta restaurar automaticamente a partida em caso de recarregamento
    initWebSocket().then(() => {
      sendWS('reconnect_room', {
        roomCode: cleanRoomCode,
        persistentId: state.persistentId,
        friendCode: state.friendCode,
        playerName: state.playerName,
        origin: window.location.origin
      });
    }).catch(err => {
      console.warn('Erro ao conectar WebSocket para reconexão:', err);
    });

    if (isChallenge) {
      showToast(`Desafio recebido: sala ${cleanRoomCode}`, 5000);
      window.tacticalAudio.turnAlertSound();
    } else {
      showToast(`Código ${cleanRoomCode} carregado.`);
    }
  }

  const paramAmigo = urlParams.get('amigo');
  const autoAcceptAmigo = urlParams.get('aceitar') === '1';
  if (paramAmigo) {
    const friendCandidate = paramAmigo.toUpperCase().trim();
    setTimeout(async () => {
      await syncPlayerProfile();
      if (autoAcceptAmigo) {
        await addFriendByCode(friendCandidate);
        openFriendsModal();
      } else {
        if (confirm(`Deseja aceitar o pedido do Comandante ${friendCandidate} e adicioná-lo aos seus amigos?`)) {
          await addFriendByCode(friendCandidate);
          openFriendsModal();
        }
      }
    }, 800);
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
    btnConfirmFleet.textContent = 'Pronto (0/5)';
    document.getElementById('placement-status-text').textContent = 'Posicione os navios no radar.';

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

      chip.innerHTML = `<span class="ship-chip-name">${spec.name}</span> <span class="ship-chip-size">${spec.size}</span>${isPlaced ? ' •' : ''}`;
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
    btnRotate.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg> <span>Girar (${state.placement.orientation})</span>`;
  });

  btnClearPlacement.addEventListener('click', () => {
    window.tacticalAudio.click();
    state.placement.ships = [];
    renderPlacementFleetChips();
    updatePlacementGridDisplay();
    btnConfirmFleet.disabled = true;
    btnConfirmFleet.textContent = 'Pronto (0/5)';
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
    btnConfirmFleet.textContent = count === 5 ? 'Iniciar Batalha' : `Pronto (${count}/5)`;
    btnConfirmFleet.disabled = count !== 5;
    if (count === 5) {
      showToast('Frota pronta. Inicie a batalha.');
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

  function updateTurnDisplay(isMyTurn, activePlayerName, isExtraTurn = false) {
    state.battle.isMyTurn = isMyTurn;
    const titleEl = document.getElementById('turn-banner-main');
    const subEl = document.getElementById('turn-banner-sub');
    const radarBadge = document.getElementById('radar-status-badge');
    const attackRadarCard = document.getElementById('card-attack-radar');

    if (isMyTurn) {
      if (isExtraTurn) {
        hudTurnBanner.className = 'turn-banner extra-turn';
        if (titleEl) titleEl.textContent = 'TIRO EXTRA';
        if (subEl) subEl.textContent = 'Dispare novamente.';
        window.tacticalAudio.extraShotSound();
        window.tacticalHaptics.extraTurn();
      } else {
        hudTurnBanner.className = 'turn-banner your-turn';
        if (titleEl) titleEl.textContent = 'SEU TURNO';
        if (subEl) subEl.textContent = 'Toque no radar para disparar.';
        window.tacticalAudio.turnAlertSound();
        window.tacticalHaptics.yourTurn();
      }

      if (radarBadge) {
        radarBadge.textContent = 'AUTORIZADO';
        radarBadge.className = 'radar-status-badge badge-active';
      }
      if (attackRadarCard) {
        attackRadarCard.classList.add('radar-active');
        attackRadarCard.classList.remove('radar-locked');
      }

      switchBattleTab('attack');
    } else {
      hudTurnBanner.className = 'turn-banner opponent-turn';
      if (titleEl) titleEl.textContent = `TURNO: ${activePlayerName.toUpperCase()}`;
      if (subEl) subEl.textContent = state.isBotMatch ? 'Aguardando disparo da IA...' : 'Aguardando oponente...';

      if (radarBadge) {
        radarBadge.textContent = 'BLOQUEADO';
        radarBadge.className = 'radar-status-badge badge-locked';
      }
      if (attackRadarCard) {
        attackRadarCard.classList.remove('radar-active');
        attackRadarCard.classList.add('radar-locked');
      }
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
      showToast('Aguarde sua vez de disparar.', 2000);
      return;
    }

    if (state.battle.attackGrid[row][col] !== null) {
      showToast('Coordenada já bombardeada!');
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
          showToast(`${sunkShip.name} destruído!`, 3000);
          state.battle.enemySunkCount++;
          markShipSunk(attackGridEl, sunkShip.coords);
          const enemyPip = document.getElementById(`enemy-pip-${sunkShip.id}`);
          if (enemyPip) enemyPip.classList.add('sunk');
        } else {
          showToast('Tiro certeiro!', 2000);
        }
      } else {
        window.tacticalAudio.waterSplash();
        window.tacticalHaptics.miss();
        cell.className = 'grid-cell miss';
        showToast('Água', 1500);
      }
    } else {
      // Atualiza a Frota de Defesa
      state.battle.defenseGrid[row][col] = isHit ? 'hit' : 'miss';
      const cell = defenseGridEl.querySelector(`[data-row="${row}"][data-col="${col}"]`);

      if (isHit) {
        window.tacticalAudio.explosion();
        window.tacticalHaptics.hit();
        cell.className = 'grid-cell hit';

        if (state.battle.activeTab === 'attack') {
          badgeDefense.classList.add('active');
        }

        if (sunkShip) {
          window.tacticalAudio.sunkAlarm();
          window.tacticalHaptics.sunk();
          showToast(`Nosso ${sunkShip.name} afundou!`, 3000);
          state.battle.mySunkCount++;
          markShipSunk(defenseGridEl, sunkShip.coords);
          const myPip = document.getElementById(`my-pip-${sunkShip.id}`);
          if (myPip) myPip.classList.add('sunk');
        } else {
          showToast('Navio atingido!', 2000);
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

    state.shipSpecs.forEach(spec => {
      const enemyPip = document.createElement('span');
      enemyPip.className = 'ship-pip';
      enemyPip.id = `enemy-pip-${spec.id}`;
      enemyPip.title = `${spec.name} (${spec.size})`;
      enemyPip.innerHTML = `<span class="pip-size">${spec.size}</span>`;
      enemyContainer.appendChild(enemyPip);

      const myPip = document.createElement('span');
      myPip.className = 'ship-pip';
      myPip.id = `my-pip-${spec.id}`;
      myPip.title = `${spec.name} (${spec.size})`;
      myPip.innerHTML = `<span class="pip-size">${spec.size}</span>`;
      myContainer.appendChild(myPip);
    });
  }

  function updateFleetPips() {
    // Sunk status is updated in handleShotResult
  }

  function handleGameOver(msg) {
    const isWin = msg.isWinner;
    const modal = modalGameOver;
    const card = modal.querySelector('.modal-card');

    card.className = `modal-card ${isWin ? 'victory' : 'defeat'}`;
    document.getElementById('modal-title').textContent = isWin ? 'VITÓRIA' : 'DERROTA';
    document.getElementById('modal-subtitle').textContent = isWin 
      ? 'Frota inimiga destruída.' 
      : 'Sua frota foi destruída.';

    document.getElementById('stat-shots').textContent = msg.shotsFired;
    document.getElementById('stat-hits').textContent = msg.hitsLanded;
    document.getElementById('stat-accuracy').textContent = `${msg.accuracy}%`;

    // Atualiza placar do confronto da sessão
    if (msg.sessionScore) {
      updateDuelScore(msg.sessionScore);
      const duelText = document.getElementById('gameover-duel-text');
      if (duelText) {
        duelText.textContent = `${state.playerName} ${msg.sessionScore.myWins} x ${msg.sessionScore.opponentWins} ${msg.sessionScore.opponentName}`;
      }
    }

    // Se o servidor enviou o ranking atualizado, pré-renderiza
    if (msg.leaderboard) {
      renderLeaderboard(msg.leaderboard);
    }

    const btnRematch = document.getElementById('btn-rematch');
    btnRematch.disabled = false;
    btnRematch.textContent = 'Revanche';

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
      let posBadge = `<span class="pos-num pos-${pos}">${pos}</span>`;
      let trClass = '';

      if (pos === 1) {
        trClass = 'top-1';
      } else if (pos === 2) {
        trClass = 'top-2';
      } else if (pos === 3) {
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

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          sendWS('register_user', {
            friendCode: data.code,
            persistentId: state.persistentId,
            playerName: state.playerName
          });
        }
        fetchAndRenderFriends();
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
      if (icon) icon.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      if (title) title.textContent = 'Notificações Ativas';
      if (desc) desc.textContent = 'Você receberá chamados de amigos direto no celular.';
      btn.textContent = 'Ativado';
      btn.disabled = true;
    } else {
      box.classList.remove('active');
      if (icon) icon.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
      if (title) title.textContent = 'Notificações Push';
      if (desc) desc.textContent = 'Receba chamados de batalha fora do jogo.';
      btn.textContent = 'Ativar';
      btn.disabled = false;
    }
    updateInstallPushPromptUI();
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
      showToast('Seu navegador não suporta notificações Push.');
      return;
    }

    if (isIos() && !isInStandaloneMode()) {
      showToast('No iPhone: instale o app na Tela de Início para habilitar o Push.', 5000);
      if (modalIosInstall) modalIosInstall.classList.add('active');
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('Permissão de notificações não concedida no navegador.');
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
        showToast('Notificações push ativadas com sucesso.');
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
    const incomingSection = document.getElementById('incoming-requests-section');
    const incomingContainer = document.getElementById('incoming-requests-container');
    const incomingBadge = document.getElementById('incoming-requests-badge');
    const headerPip = document.getElementById('header-friends-pip');
    const lobbyPip = document.getElementById('lobby-friends-pip');

    try {
      const res = await fetch(`/api/friends/list?code=${state.friendCode}`);
      const data = await res.json();
      const friends = data.friends || [];
      const incomingRequests = data.incomingRequests || [];
      state.friends = friends;

      // Atualiza indicadores visuais de novos pedidos pendentes
      const pendingCount = incomingRequests.length;
      if (headerPip) headerPip.style.display = pendingCount > 0 ? 'block' : 'none';
      if (lobbyPip) lobbyPip.style.display = pendingCount > 0 ? 'block' : 'none';

      // Renderiza Seção de Pedidos Recebidos
      if (incomingSection && incomingContainer) {
        if (pendingCount > 0) {
          incomingSection.style.display = 'block';
          if (incomingBadge) incomingBadge.textContent = pendingCount;
          incomingContainer.innerHTML = incomingRequests.map(req => {
            return `
              <div class="incoming-request-item">
                <div class="friend-info">
                  <div class="friend-name-row">
                    <span class="friend-name">${escapeHtml(req.name)}</span>
                    <span style="font-size:0.75rem; color:#ffaa00;">${req.code}</span>
                  </div>
                  <div class="friend-badges">
                    <span class="badge-pending">Quer ser seu amigo</span>
                    ${req.pushEnabled ? '<span class="badge-push-on">Push Ativo</span>' : ''}
                  </div>
                </div>
                <div class="friend-actions">
                  <button class="btn-accept-request" data-code="${req.code}" title="Aceitar pedido de amizade">
                    Aceitar
                  </button>
                  <button class="btn-decline-request" data-code="${req.code}" title="Recusar pedido">
                    Recusar
                  </button>
                </div>
              </div>
            `;
          }).join('');

          incomingContainer.querySelectorAll('.btn-accept-request').forEach(btn => {
            btn.addEventListener('click', () => {
              const code = btn.getAttribute('data-code');
              addFriendByCode(code);
            });
          });

          incomingContainer.querySelectorAll('.btn-decline-request').forEach(btn => {
            btn.addEventListener('click', () => {
              const code = btn.getAttribute('data-code');
              declineFriendRequest(code);
            });
          });
        } else {
          incomingSection.style.display = 'none';
        }
      }

      if (!container) return;
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
                ${f.isMutual ? '<span class="badge-mutual">Mútuo</span>' : '<span class="badge-pending">Pendente</span>'}
                ${f.pushEnabled ? '<span class="badge-push-on">Push Ativo</span>' : '<span class="badge-push-off">Sem Push</span>'}
              </div>
            </div>
            <div class="friend-actions">
              <button class="btn-challenge" ${canChallenge ? '' : 'disabled'} title="${challengeTitle}" data-code="${f.code}">
                Desafiar
              </button>
              <button class="btn-remove-friend" title="Remover amigo" data-code="${f.code}">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

  async function declineFriendRequest(requesterCode) {
    if (!requesterCode) return;
    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    try {
      const res = await fetch('/api/friends/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myCode: state.friendCode,
          requesterCode
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Pedido de amizade recusado.');
        fetchAndRenderFriends();
      }
    } catch (e) {
      console.warn('Erro ao recusar pedido de amizade:', e);
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
          showToast(`Comandante ${data.friend.name} agora é seu amigo mútuo.`);
        } else {
          showToast(`Comandante ${data.friend.name} adicionado (pendente recíproco).`);
        }
        const input = document.getElementById('input-add-friend-code');
        if (input) input.value = '';
        fetchAndRenderFriends();
      } else {
        showToast(data.error || 'Erro ao adicionar amigo');
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
    showToast(`Enviando convite de batalha para ${targetCode}...`);

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
        showToast(data.error || 'Não foi possível enviar o desafio');
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
        persistentId: state.persistentId,
        roomCode: data.roomCode,
        origin: window.location.origin
      });

      window.tacticalAudio.sonarPing();
      showToast(`Convite enviado para ${targetCode}! Aguardando na sala ${data.roomCode}...`, 5000);
    } catch (err) {
      console.error('Erro ao desafiar amigo:', err);
      showToast('Falha de conexão ao enviar desafio.');
    }
  }

  function updateOpponentFriendButtons() {
    const btnBattleAddFriend = document.getElementById('btn-battle-add-friend');
    const btnGameOverAddFriend = document.getElementById('btn-gameover-add-friend');

    if (!state.isBotMatch && state.opponentFriendCode && state.opponentFriendCode !== state.friendCode) {
      if (btnBattleAddFriend) btnBattleAddFriend.style.display = 'inline-block';
      if (btnGameOverAddFriend) btnGameOverAddFriend.style.display = 'block';
    } else {
      if (btnBattleAddFriend) btnBattleAddFriend.style.display = 'none';
      if (btnGameOverAddFriend) btnGameOverAddFriend.style.display = 'none';
    }
  }

  const btnBattleAddFriend = document.getElementById('btn-battle-add-friend');
  if (btnBattleAddFriend) {
    btnBattleAddFriend.addEventListener('click', async () => {
      window.tacticalAudio.click();
      if (state.opponentFriendCode) {
        await addFriendByCode(state.opponentFriendCode);
        btnBattleAddFriend.textContent = 'Adicionado';
      }
    });
  }

  const btnGameOverAddFriend = document.getElementById('btn-gameover-add-friend');
  if (btnGameOverAddFriend) {
    btnGameOverAddFriend.addEventListener('click', async () => {
      window.tacticalAudio.click();
      if (state.opponentFriendCode) {
        await addFriendByCode(state.opponentFriendCode);
        btnGameOverAddFriend.textContent = 'Amigo Adicionado';
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
        showToast(`Código ${state.friendCode} copiado`);
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
          showToast('Link de convite copiado');
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
    const registerSW = () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[PWA] Service Worker tático registrado com sucesso:', reg.scope);
      }).catch((err) => {
        console.warn('[PWA] Falha ao registrar Service Worker:', err);
      });
    };
    if (document.readyState === 'complete') {
      registerSW();
    } else {
      window.addEventListener('load', registerSW);
    }
  }

  let deferredInstallPrompt = null;
  const btnInstallHeader = document.getElementById('btn-install-app');
  const lobbyInstallBox = document.getElementById('lobby-install-box');
  const btnLobbyInstall = document.getElementById('btn-lobby-install');
  const modalIosInstall = document.getElementById('modal-ios-install');
  const btnCloseIosModal = document.getElementById('btn-close-ios-modal');
  const modalAndroidInstall = document.getElementById('modal-android-install');
  const btnCloseAndroidModal = document.getElementById('btn-close-android-modal');

  const isIos = () => {
    const ua = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(ua);
  };

  const isInStandaloneMode = () => {
    return ('standalone' in window.navigator && window.navigator.standalone) ||
           window.matchMedia('(display-mode: standalone)').matches;
  };

  // Se não estiver em modo app instalado, exibe botão no HUD
  if (!isInStandaloneMode()) {
    if (btnInstallHeader) btnInstallHeader.style.display = 'flex';
    if (lobbyInstallBox) lobbyInstallBox.style.display = 'flex';
  }

  // Captura o prompt de instalação nativo no Android/Chrome/Edge
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!isInStandaloneMode()) {
      if (btnInstallHeader) btnInstallHeader.style.display = 'flex';
      if (lobbyInstallBox) lobbyInstallBox.style.display = 'flex';
    }
    updateInstallPushPromptUI();
  });

  function triggerInstall() {
    window.tacticalAudio.click();
    window.tacticalHaptics.click();

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') {
          showToast('Aplicativo instalado com sucesso na tela inicial.');
          if (btnInstallHeader) btnInstallHeader.style.display = 'none';
          if (lobbyInstallBox) lobbyInstallBox.style.display = 'none';
          if (modalInstallPush) modalInstallPush.classList.remove('active');
          if (modalAndroidInstall) modalAndroidInstall.classList.remove('active');
        }
        deferredInstallPrompt = null;
        updateInstallPushPromptUI();
      });
    } else if (isIos()) {
      if (modalIosInstall) modalIosInstall.classList.add('active');
    } else {
      if (modalAndroidInstall) {
        modalAndroidInstall.classList.add('active');
      } else {
        openInstallPushPrompt(true);
        showToast('No Chrome: toque nos 3 pontinhos (⋮) e selecione "Instalar aplicativo"', 5000);
      }
    }
  }

  if (btnInstallHeader) {
    btnInstallHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerInstall();
    });
  }
  if (btnLobbyInstall) {
    btnLobbyInstall.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerInstall();
    });
  }
  if (btnCloseIosModal) {
    btnCloseIosModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalIosInstall) modalIosInstall.classList.remove('active');
    });
  }
  if (btnCloseAndroidModal) {
    btnCloseAndroidModal.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (modalAndroidInstall) modalAndroidInstall.classList.remove('active');
    });
  }

  window.addEventListener('appinstalled', () => {
    showToast('Batalha Naval instalada como aplicativo.');
    if (btnInstallHeader) btnInstallHeader.style.display = 'none';
    if (lobbyInstallBox) lobbyInstallBox.style.display = 'none';
    updateInstallPushPromptUI();
  });

  // --- POPUP NOTIFICAÇÃO: INSTALAR APP & ATIVAR PUSH ---
  const modalInstallPush = document.getElementById('modal-install-push-prompt');
  const btnCloseInstallPushX = document.getElementById('btn-close-install-push-x');
  const btnDismissInstallPush = document.getElementById('btn-dismiss-install-push');
  const btnPromptInstall = document.getElementById('btn-prompt-install');
  const btnPromptPush = document.getElementById('btn-prompt-push');

  function updateInstallPushPromptUI() {
    const isInstalled = isInStandaloneMode();
    const hasPush = state.pushEnabled;

    if (btnPromptInstall) {
      if (isInstalled) {
        btnPromptInstall.textContent = 'Instalado';
        btnPromptInstall.disabled = true;
        btnPromptInstall.className = 'btn-prompt-action completed';
      } else {
        btnPromptInstall.textContent = isIos() ? 'Como Instalar' : 'Instalar';
        btnPromptInstall.disabled = false;
        btnPromptInstall.className = 'btn-prompt-action btn-install';
      }
    }

    if (btnPromptPush) {
      if (hasPush) {
        btnPromptPush.textContent = 'Ativado';
        btnPromptPush.disabled = true;
        btnPromptPush.className = 'btn-prompt-action completed';
      } else {
        btnPromptPush.textContent = 'Ativar';
        btnPromptPush.disabled = false;
        btnPromptPush.className = 'btn-prompt-action btn-push';
      }
    }
  }

  function openInstallPushPrompt(forced = false) {
    if (!modalInstallPush) return;
    const isInstalled = isInStandaloneMode();
    const hasPush = state.pushEnabled;

    if (!forced && isInstalled && hasPush) return;

    updateInstallPushPromptUI();
    modalInstallPush.classList.add('active');
  }

  function dismissInstallPushPrompt() {
    if (!modalInstallPush) return;
    modalInstallPush.classList.remove('active');
    // Salva horário de dispensa (não perguntar novamente por 24 horas)
    localStorage.setItem('naval_install_push_dismissed_at', Date.now().toString());
  }

  if (btnCloseInstallPushX) {
    btnCloseInstallPushX.addEventListener('click', () => {
      window.tacticalAudio.click();
      dismissInstallPushPrompt();
    });
  }

  if (btnDismissInstallPush) {
    btnDismissInstallPush.addEventListener('click', () => {
      window.tacticalAudio.click();
      dismissInstallPushPrompt();
    });
  }

  if (modalInstallPush) {
    modalInstallPush.addEventListener('click', (e) => {
      if (e.target === modalInstallPush) {
        dismissInstallPushPrompt();
      }
    });
  }

  if (btnPromptInstall) {
    btnPromptInstall.addEventListener('click', () => {
      window.tacticalAudio.click();
      if (isIos()) {
        if (modalIosInstall) modalIosInstall.classList.add('active');
      } else {
        triggerInstall();
      }
      setTimeout(updateInstallPushPromptUI, 800);
    });
  }

  if (btnPromptPush) {
    btnPromptPush.addEventListener('click', async () => {
      await subscribeToPushNotifications();
      updateInstallPushPromptUI();
      if (state.pushEnabled) {
        setTimeout(() => {
          if (isInStandaloneMode()) {
            modalInstallPush.classList.remove('active');
          }
        }, 1200);
      }
    });
  }


  // Disparo automático suave no Lobby após carregar a página
  setTimeout(() => {
    if (screens.lobby && screens.lobby.classList.contains('active')) {
      const dismissedAt = parseInt(localStorage.getItem('naval_install_push_dismissed_at') || '0', 10);
      const oneDay = 24 * 60 * 60 * 1000;
      const isRecentlyDismissed = Date.now() - dismissedAt < oneDay;

      const isInstalled = isInStandaloneMode();
      const hasPush = state.pushEnabled;

      if (!isRecentlyDismissed && (!isInstalled || !hasPush)) {
        openInstallPushPrompt(false);
      }
    }
  }, 2200);

  // =========================================================================
  // --- PROTEÇÃO ANTI-FECHAMENTO E ANTI-VOLTA (PARTIDA EM ANDAMENTO) ---
  // =========================================================================

  function isGameInProgress() {
    const isPlacement = screens.placement && screens.placement.classList.contains('active');
    const isBattle = screens.battle && screens.battle.classList.contains('active');
    const isGameOver = modalGameOver && modalGameOver.classList.contains('active');
    return Boolean(state.roomCode && (isPlacement || isBattle) && !isGameOver);
  }

  function resetMatchToLobby() {
    updateActiveRoomCodeDisplay(null);
    state.placement.ships = [];
    state.battle.attackGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    state.battle.defenseGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    state.battle.enemySunkCount = 0;
    state.battle.mySunkCount = 0;
    state.battle.isMyTurn = false;
    state.isBotMatch = false;

    if (modalGameOver) modalGameOver.classList.remove('active');
    if (modalConfirmLeave) modalConfirmLeave.classList.remove('active');

    if (window.location.search) {
      window.history.replaceState({ screen: 'lobby', navalInGame: false }, '', window.location.pathname);
    } else {
      window.history.replaceState({ screen: 'lobby', navalInGame: false }, '', window.location.href);
    }

    showScreen('lobby');
    fetchAndRenderPublicRooms();
  }

  // 1. IMPEDIR FECHAMENTO / RECARREGAMENTO ACIDENTAL DA ABA (BEFOREUNLOAD)
  window.addEventListener('beforeunload', (event) => {
    if (isGameInProgress()) {
      event.preventDefault();
      event.returnValue = '';
      return '';
    }
  });

  // 2. MODAL DE CONFIRMAÇÃO DE ABANDONO DE PARTIDA
  const modalConfirmLeave = document.getElementById('modal-confirm-leave');
  const confirmLeaveTitle = document.getElementById('confirm-leave-title');
  const confirmLeaveDesc = document.getElementById('confirm-leave-desc');
  const btnStayGame = document.getElementById('btn-stay-game');
  const btnConfirmLeave = document.getElementById('btn-confirm-leave');
  const btnBattleSurrender = document.getElementById('btn-battle-surrender');
  const btnPlacementLeave = document.getElementById('btn-placement-leave');
  const btnCancelWaitingRoom = document.getElementById('btn-cancel-waiting-room');
  const btnGameOverLobby = document.getElementById('btn-gameover-lobby');

  function openConfirmLeaveModal() {
    if (!modalConfirmLeave) return;
    const isBattle = screens.battle && screens.battle.classList.contains('active');

    if (isBattle) {
      if (confirmLeaveTitle) confirmLeaveTitle.textContent = 'Abandonar Batalha?';
      if (confirmLeaveDesc) confirmLeaveDesc.textContent = 'A vitória será concedida ao adversário.';
      if (btnStayGame) btnStayGame.textContent = 'Continuar Jogando';
      if (btnConfirmLeave) btnConfirmLeave.textContent = 'Abandonar';
    } else {
      if (confirmLeaveTitle) confirmLeaveTitle.textContent = 'Cancelar Sala?';
      if (confirmLeaveDesc) confirmLeaveDesc.textContent = 'O posicionamento atual será perdido.';
      if (btnStayGame) btnStayGame.textContent = 'Continuar';
      if (btnConfirmLeave) btnConfirmLeave.textContent = 'Sair';
    }

    window.tacticalAudio.click();
    window.tacticalHaptics.click();
    modalConfirmLeave.classList.add('active');
  }

  function closeConfirmLeaveModal() {
    if (modalConfirmLeave) modalConfirmLeave.classList.remove('active');
  }

  if (btnStayGame) {
    btnStayGame.addEventListener('click', () => {
      window.tacticalAudio.click();
      window.tacticalHaptics.click();
      closeConfirmLeaveModal();
    });
  }

  if (btnConfirmLeave) {
    btnConfirmLeave.addEventListener('click', () => {
      window.tacticalAudio.click();
      window.tacticalHaptics.click();
      closeConfirmLeaveModal();

      if (screens.battle && screens.battle.classList.contains('active')) {
        sendWS('surrender');
        resetMatchToLobby();
      } else {
        sendWS('leave_room', { playerName: state.playerName });
        resetMatchToLobby();
      }
    });
  }

  if (modalConfirmLeave) {
    modalConfirmLeave.addEventListener('click', (e) => {
      if (e.target === modalConfirmLeave) {
        closeConfirmLeaveModal();
      }
    });
  }

  if (btnBattleSurrender) {
    btnBattleSurrender.addEventListener('click', (e) => {
      e.stopPropagation();
      openConfirmLeaveModal();
    });
  }

  if (btnPlacementLeave) {
    btnPlacementLeave.addEventListener('click', () => {
      openConfirmLeaveModal();
    });
  }

  if (btnCancelWaitingRoom) {
    btnCancelWaitingRoom.addEventListener('click', () => {
      window.tacticalAudio.click();
      sendWS('leave_room', { playerName: state.playerName });
      resetMatchToLobby();
    });
  }

  if (btnGameOverLobby) {
    btnGameOverLobby.addEventListener('click', () => {
      window.tacticalAudio.click();
      sendWS('leave_room', { playerName: state.playerName });
      resetMatchToLobby();
    });
  }

  // 3. IMPEDIR GESTO DE VOLTAR / BOTÃO VOLTAR DO CELULAR (POPSTATE)
  if (!window.history.state) {
    window.history.replaceState({ screen: 'lobby', navalInGame: false }, '', window.location.href);
  }

  window.addEventListener('popstate', (event) => {
    // A. Se houver modal aberto de consulta (amigos, ranking, prompt pwa, ou confirmação), fecha primeiro o modal
    const openModals = [modalFriends, modalRanking, modalInstallPush, modalIosInstall, modalConfirmLeave];
    let modalClosed = false;
    for (const m of openModals) {
      if (m && m.classList.contains('active')) {
        m.classList.remove('active');
        modalClosed = true;
      }
    }
    if (modalClosed) {
      if (isGameInProgress()) {
        window.history.pushState({ navalInGame: true }, '', window.location.href);
      }
      return;
    }

    // B. Se estiver no meio de um jogo ativo (posicionamento ou combate), bloqueia voltar e abre modal de confirmação
    if (isGameInProgress()) {
      window.history.pushState({ navalInGame: true }, '', window.location.href);
      openConfirmLeaveModal();
      return;
    }

    // C. Se estiver aguardando oponente como Host e apertar voltar, cancela a sala e volta suave ao lobby
    if (screens.waitingHost && screens.waitingHost.classList.contains('active')) {
      sendWS('leave_room', { playerName: state.playerName });
      resetMatchToLobby();
      return;
    }

    // D. Se estiver na tela de fim de jogo e apertar voltar, vai para o lobby
    if (modalGameOver && modalGameOver.classList.contains('active')) {
      modalGameOver.classList.remove('active');
      resetMatchToLobby();
    }
  });

})();
