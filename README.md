# ⚓ Batalha Naval High-Tech (Tactical Cyber Command)

Jogo tático de **Batalha Naval** em tempo real projetado para dispositivos móveis e desktops, com arquitetura ultra-rápida em **Node.js + WebSockets**, suporte completo a **PWA Instalável**, **Notificações Web Push (VAPID)**, **Radar de Salas Públicas**, **Sistema de Amigos** e **Ranking Global**.

Disponível em produção em: [**https://batalha.bolsadedados.com.br**](https://batalha.bolsadedados.com.br)

📄 **Especificação Completa:** Consulte o [Plano Completo de Jogo Web Mobile](docs/plano_completo_batalha_naval.md).

---

## ⚡ Principais Recursos

1. **Ergonomia Mobile-First & Zero Scroll:** Interface adaptável que cabe 100% no viewport sem rolagem vertical, touch targets $\ge$ 42px e suporte a safe areas (iOS/Android).
2. **Salas Públicas & Radar em Tempo Real:** Criação de partidas públicas listadas ao vivo no radar do Lobby ou salas privadas via código e QR Code dinâmico.
3. **Sistema Social de Amigos & Desafio Push:** Código único de comandante (`CMD-XXXX`), amizade mútua anti-spam e envio de convites diretos via Web Push para a tela de bloqueio do celular.
4. **Regras Oficiais & Tiro Extra:** 5 navios regulamentares (Porta-Aviões, Encouraçado, Cruzador, Submarino e Contratorpedeiro). Acertou o navio? Ganha tiro extra imediatamente!
5. **Placar de Confronto & Revanche Rápida:** Contagem contínua de vitórias no confronto da sala e botão de revanche rápida sem perder a conexão.
6. **Quadro de Honra & Ranking Persistente:** Histórico de vitórias, derrotas, taxa de vitória e precisão de disparos persistidos em volume Docker (`data/rankings.json`).
7. **PWA & Instalação Assistida:** Modal inteligente de instalação e ativação push com intervalo suave de 24h.
8. **Áudio Procedural & Háptica:** Sintetizador sonoro nativo via Web Audio API (zero arquivos de áudio pesados) e vibrações táteis (`navigator.vibrate`).

---

## 🚀 Como Executar Localmente

### 1. Iniciar o Servidor
```bash
npm start
```
*(ou `PORT=3001 npm start`)*

O terminal exibirá:
- **Link Local:** `http://localhost:3001`
- **Link no Celular (mesmo Wi-Fi):** `http://<SEU_IP_LOCAL>:3001` (ex: `http://192.168.1.253:3001`)

---

## 🧪 Testes Automatizados

Para executar os testes automatizados com simulação completa de 2 jogadores, push notifications, amigos, salas públicas e ranking:
```bash
PORT=3001 node server.js &
node test_game.js
```

---

## 🐳 Deploy com Docker

```bash
docker compose up -d --build
```
O diretório `./data` é montado como volume persistente para manter rankings e amigos intactos entre deploys.
