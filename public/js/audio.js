/**
 * Web Audio API & HTML5 Audio Dual-Engine - Sintetizador Tático
 * Compatibilidade total com iOS Safari, Android e navegadores desktop.
 * Inclui desbloqueio automático de áudio no primeiro toque e fallback HTML5 Audio para iPhone.
 */

class TacticalAudio {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('naval_muted') === 'true';
    this.unlocked = false;
    this.htmlAudioChime = null;
    this.htmlAudioExtra = null;
    this.keepAliveOsc = null;

    // Inicializa fallback de áudio HTML5 pré-sintetizado para iOS
    this.initHtmlAudioFallbacks();

    // Registra desbloqueio automático em qualquer toque inicial na tela
    this.attachAutoUnlock();
  }

  // Gera data URI de áudio WAV puro (PCM 16-bit) para compatibilidade nativa com iOS Safari
  generateWavDataUri(patternType) {
    try {
      const sampleRate = 22050;
      const duration = patternType === 'extra' ? 0.45 : 0.6;
      const numSamples = Math.floor(sampleRate * duration);
      const buffer = new ArrayBuffer(44 + numSamples * 2);
      const view = new DataView(buffer);

      function writeString(v, offset, str) {
        for (let i = 0; i < str.length; i++) {
          v.setUint8(offset + i, str.charCodeAt(i));
        }
      }

      // Cabeçalho RIFF WAV padrão
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + numSamples * 2, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // Mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, 'data');
      view.setUint32(40, numSamples * 2, true);

      // Sintetiza forma de onda
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        let freq = 587.33; // D5

        if (patternType === 'extra') {
          freq = t < 0.2 ? 659.25 : 987.77;
        } else {
          // Arpeggio tático D5 -> A5 -> D6
          if (t > 0.15 && t <= 0.32) freq = 880;
          else if (t > 0.32) freq = 1174.66;
        }

        const env = Math.exp(-4.0 * (t % 0.16));
        const sample = Math.sin(2 * Math.PI * freq * t) * env * 0.75;
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
      }

      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return 'data:audio/wav;base64,' + btoa(binary);
    } catch (e) {
      console.warn('[Audio] Erro sintetizando WAV fallback:', e);
      return null;
    }
  }

  initHtmlAudioFallbacks() {
    try {
      const chimeUri = this.generateWavDataUri('turn');
      if (chimeUri) {
        this.htmlAudioChime = new Audio(chimeUri);
        this.htmlAudioChime.preload = 'auto';
      }

      const extraUri = this.generateWavDataUri('extra');
      if (extraUri) {
        this.htmlAudioExtra = new Audio(extraUri);
        this.htmlAudioExtra.preload = 'auto';
      }
    } catch (e) {
      console.warn('[Audio] HTML5 Audio fallback indisponível:', e);
    }
  }

  attachAutoUnlock() {
    const unlockHandler = () => {
      this.unlock();
      // Não remove imediatamente para garantir desbloqueio em toques subsequentes se o iOS suspender
    };

    ['touchstart', 'touchend', 'click', 'keydown'].forEach(evt => {
      document.addEventListener(evt, unlockHandler, { passive: true });
    });
  }

  unlock() {
    if (this.muted) return;

    // 1. Inicializa e descongela AudioContext
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // 2. Toca buffer de silêncio de 1 amostra para forçar hardware do iOS a acordar
    if (this.ctx && !this.unlocked) {
      try {
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        source.start(0);
        this.unlocked = true;
        console.log('[Audio] Web Audio context desbloqueado no iOS/Android');
      } catch (e) {}
    }

    // 3. Pré-ativa elemento HTML5 Audio no iOS
    if (this.htmlAudioChime && this.htmlAudioChime.paused) {
      try {
        this.htmlAudioChime.play().then(() => {
          this.htmlAudioChime.pause();
          this.htmlAudioChime.currentTime = 0;
        }).catch(() => {});
      } catch (e) {}
    }

    if (this.htmlAudioExtra && this.htmlAudioExtra.paused) {
      try {
        this.htmlAudioExtra.play().then(() => {
          this.htmlAudioExtra.pause();
          this.htmlAudioExtra.currentTime = 0;
        }).catch(() => {});
      } catch (e) {}
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('naval_muted', this.muted);
    return this.muted;
  }

  isMuted() {
    return this.muted;
  }

  init() {
    this.unlock();
  }

  // --- EFEITOS SONOROS PROCEDURAIS (WEB AUDIO API) ---

  // 1. Sonar Ping
  sonarPing() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(1150, t + 1.2);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + 1.5);
    } catch (e) {}
  }

  // 2. Disparo de Míssil
  fireMissile() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const bufferSize = this.ctx.sampleRate * 0.4;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(800, t);
      filter.frequency.exponentialRampToValueAtTime(2400, t + 0.35);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      noise.start(t);
      noise.stop(t + 0.4);
    } catch (e) {}
  }

  // 3. Água / Splash
  waterSplash() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const bufferSize = this.ctx.sampleRate * 0.6;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400, t);
      filter.frequency.exponentialRampToValueAtTime(250, t + 0.5);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      noise.start(t);
      noise.stop(t + 0.6);
    } catch (e) {}
  }

  // 4. Explosão
  explosion() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.4);
      oscGain.gain.setValueAtTime(0.4, t);
      oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

      osc.connect(oscGain);
      oscGain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);

      const bufferSize = this.ctx.sampleRate * 0.7;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, t);
      filter.frequency.exponentialRampToValueAtTime(150, t + 0.65);

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.35, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);

      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(this.ctx.destination);

      noise.start(t);
      noise.stop(t + 0.7);
    } catch (e) {}
  }

  // 5. Alarme de Navio Afundado
  sunkAlarm() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const startT = t + i * 0.35;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(700, startT);
        osc.frequency.linearRampToValueAtTime(450, startT + 0.3);

        gain.gain.setValueAtTime(0.2, startT);
        gain.gain.exponentialRampToValueAtTime(0.001, startT + 0.32);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startT);
        osc.stop(startT + 0.33);
      }
    } catch (e) {}
  }

  // 6. Fanfarra de Vitória
  victoryFanfare() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const notes = [440, 554.37, 659.25, 880];

      notes.forEach((freq, idx) => {
        const noteT = t + idx * 0.15;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, noteT);

        gain.gain.setValueAtTime(0.2, noteT);
        gain.gain.exponentialRampToValueAtTime(idx === 3 ? 0.001 : 0.05, noteT + 0.6);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(noteT);
        osc.stop(noteT + (idx === 3 ? 1.2 : 0.25));
      });
    } catch (e) {}
  }

  // 7. Derrota
  defeatSound() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const notes = [330, 311.13, 293.66, 220];

      notes.forEach((freq, idx) => {
        const noteT = t + idx * 0.25;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, noteT);

        gain.gain.setValueAtTime(0.18, noteT);
        gain.gain.exponentialRampToValueAtTime(0.001, noteT + 0.5);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(noteT);
        osc.stop(noteT + 0.55);
      });
    } catch (e) {}
  }

  // 8. Clique tático
  click() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(900, t);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + 0.04);
    } catch (e) {}
  }

  // 9. ALERTA DE TURNO (DUAL ENGINE: HTML5 AUDIO + WEB AUDIO API PARA IPHONE)
  turnAlertSound() {
    if (this.muted) return;

    // A. Fallback imediato via HTML5 Audio (imune à suspensão do Web Audio no iOS)
    if (this.htmlAudioChime) {
      try {
        this.htmlAudioChime.currentTime = 0;
        const playPromise = this.htmlAudioChime.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.log('[Audio] HTML5 chime aguardando gesto:', err);
          });
        }
      } catch (e) {}
    }

    // B. Sintetizador Web Audio API em paralelo
    this.init();
    if (!this.ctx || this.ctx.state !== 'running') return;

    try {
      const t = this.ctx.currentTime;
      const freqs = [587.33, 880, 1174.66]; // D5, A5, D6

      freqs.forEach((freq, idx) => {
        const startT = t + idx * 0.08;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, startT);

        gain.gain.setValueAtTime(0.28, startT);
        gain.gain.exponentialRampToValueAtTime(0.001, startT + 0.35);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startT);
        osc.stop(startT + 0.36);
      });
    } catch (e) {}
  }

  // 10. TIRO EXTRA (DUAL ENGINE PARA IPHONE)
  extraShotSound() {
    if (this.muted) return;

    // A. Fallback HTML5 Audio
    if (this.htmlAudioExtra) {
      try {
        this.htmlAudioExtra.currentTime = 0;
        const playPromise = this.htmlAudioExtra.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {});
        }
      } catch (e) {}
    }

    // B. Sintetizador Web Audio API
    this.init();
    if (!this.ctx || this.ctx.state !== 'running') return;

    try {
      const t = this.ctx.currentTime;
      const notes = [659.25, 987.77];

      notes.forEach((freq, idx) => {
        const startT = t + idx * 0.09;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startT);

        gain.gain.setValueAtTime(0.25, startT);
        gain.gain.exponentialRampToValueAtTime(0.001, startT + 0.28);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startT);
        osc.stop(startT + 0.3);
      });
    } catch (e) {}
  }
}

window.tacticalAudio = new TacticalAudio();
