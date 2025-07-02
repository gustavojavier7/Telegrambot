require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TELEGRAM_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

function enviarATelegram(mensaje) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ TELEGRAM_TOKEN o CHAT_ID no definidos.");
    return;
  }
  fetch(TELEGRAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: mensaje })
  }).catch(err => console.error("❌ Error al enviar a Telegram:", err));
}

app.get('/health', (_, res) => res.send('✅ Bot activo'));
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  enviarATelegram('🚀 Bot iniciado en Cloud Run. Esperando liquidaciones...');
});

let ws;
function conectarWS() {
  ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');

  ws.on('open', () => {
    console.log("✅ Conectado a WebSocket OKX");
    enviarATelegram('🟢 Conexión WebSocket OKX establecida');
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [{ channel: "liquidation-orders", instType: "SWAP" }]
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.data && Array.isArray(msg.data)) {
        msg.data.forEach(entry => {
          const precio = parseFloat(entry.price);
          const cantidad = parseFloat(entry.sz);
          const monto = (!isNaN(precio) && !isNaN(cantidad)) ? (precio * cantidad).toFixed(2) : '–';
          const texto = `🟢 #${entry.instId} Liquidated ${entry.side === 'buy' ? 'Long' : 'Short'}: $${monto} at $${!isNaN(precio) ? precio : '–'}`;
          console.log(texto);
          enviarATelegram(texto);
        });
      }
    } catch (err) {
      console.error("❌ Error al procesar mensaje:", err);
    }
  });

  ws.on('close', () => {
    console.warn("🔴 WebSocket cerrado. Reconectando...");
    enviarATelegram('🔴 OKX WebSocket desconectado. Reconectando en 5s...');
    setTimeout(conectarWS, 5000);
  });

  ws.on('error', (err) => {
    console.error("❌ Error en WebSocket:", err.message || err);
    enviarATelegram(`❌ Error en WebSocket de OKX: ${err.message || err}`);
  });
}

conectarWS();
