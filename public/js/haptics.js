/**
 * Haptics - Feedback tátil para smartphones via Navigator.vibrate
 */

class TacticalHaptics {
  constructor() {
    this.supported = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  }

  vibrate(pattern) {
    if (this.supported) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Fallback silencioso caso bloqueado por política de permissão
      }
    }
  }

  // Toque suave em botão
  click() {
    this.vibrate(15);
  }

  // Tiro disparado
  fire() {
    this.vibrate([20, 20, 30]);
  }

  // Água / Splash
  miss() {
    this.vibrate(40);
  }

  // Acerto em navio (Impacto forte)
  hit() {
    this.vibrate([80, 40, 120]);
  }

  // Navio afundado (Vibração dupla prolongada)
  sunk() {
    this.vibrate([150, 70, 200, 70, 300]);
  }

  // Sua vez de jogar (Vibração dupla firme e inconfundível)
  yourTurn() {
    this.vibrate([120, 70, 180]);
  }

  // Tiro extra por acerto
  extraTurn() {
    this.vibrate([70, 40, 70, 40, 140]);
  }

  // Vitória
  victory() {
    this.vibrate([100, 50, 100, 50, 250]);
  }
}

window.tacticalHaptics = new TacticalHaptics();
