# ⚓ Batalha Naval High-Tech (Multiplayer Mobile-First)

Jogo tático de **Batalha Naval** em tempo real projetado para 2 jogadores disputarem partidas diretamente pelo navegador dos seus smartphones conectados à mesma rede Wi-Fi / Intranet (ou computador).

---

## 🚀 Como Executar

### 1. Iniciar o Servidor
```bash
npm start
```
*(ou `npm run dev` para modo de desenvolvimento com recarregamento automático).*

O terminal exibirá imediatamente:
- **Link Local:** `http://localhost:3001`
- **Link no Celular (mesmo Wi-Fi):** `http://<SEU_IP_LOCAL>:3001` (ex: `http://192.168.1.253:3001`)

---

## 📱 Como Jogar no Celular

1. **Jogador 1 (Host):**
   - Acesse o link no computador ou no celular e clique em **"Criar Nova Sala"**.
   - Será gerado um **Código de Sala** e um **QR Code tático** na tela.
2. **Jogador 2:**
   - Aponte a câmera do celular para o QR Code na tela do Jogador 1 (ou acesse o link e digite o código).
   - O jogo conecta automaticamente!
3. **Fase de Posicionamento:**
   - Cada comandante posiciona seus 5 navios no radar 10x10.
   - Use o botão **"Girar"** para alternar horizontal/vertical ou o botão **"🎲 Aleatório"** para posicionamento instantâneo.
   - Clique em **"⚓ Confirmar Frota"**.
4. **Fase de Combate (Turnos):**
   - **🎯 Radar de Ataque:** Toque na célula inimiga para disparar mísseis.
   - **Acertou joga de novo!** Se errar (água), a vez passa para o adversário.
   - **🛡️ Minha Frota:** Aba com alerta sonoro e visual em tempo real mostrando onde os mísseis inimigos atingiram sua frota.
5. **Vitória & Revanche:**
   - O primeiro a afundar todos os 5 navios vence.
   - Clique em **"🔄 Revanche Rápida"** para reiniciar sem sair da sala!

---

## 🛠️ Tecnologias Utilizadas

- **Backend:** Node.js, `ws` (WebSockets com validação anti-cheat e sincronização em tempo real).
- **Auto IP & QR Code:** Leitura automática de interfaces Wi-Fi locais (`os.networkInterfaces`) e geração de QR code via biblioteca `qrcode`.
- **Frontend:** Vanilla HTML5, CSS3 tático militar (Cyber Radar, tema escuro, responsivo mobile-first).
- **Áudio Procedural:** Web Audio API sintetizada nativamente (sonar pings, mísseis, água, explosões, alarme de navio afundado).
- **Vibração Háptica:** `navigator.vibrate` em smartphones para sensação de disparo, acerto e afundamento.

---

## 🧪 Testes Automatizados

Para testar a simulação completa de 2 jogadores via WebSocket:
```bash
npm test
```
