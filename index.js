require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (_, res) => res.send('✅ Bot activo'));
app.listen(PORT, () => console.log(`Servidor HTTP en puerto ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

function enviarATelegram(mensaje) {
  fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: mensaje })
  }).catch(err => console.error("Error al enviar a Telegram:", err));
}

const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');

ws.on('open', () => {
  console.log("Conectado a OKX");
  ws.send(JSON.stringify({
    op: "subscribe",
    args: [{ channel: "liquidation-orders", instType: "SWAP" }]
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.data && msg.data.length) {
    msg.data.forEach(entry => {
      const precio = entry.price || '–';
      const monto = (parseFloat(entry.sz) * parseFloat(precio) || '–').toLocaleString();
      const texto = `🟢 #${entry.instId} Liquidated ${entry.side === 'buy' ? 'Long' : 'Short'}: $${monto} at $${precio}`;
      console.log(texto);
      enviarATelegram(texto);
    });
  }
});

ws.on('close', () => enviarATelegram('🔴 OKX WebSocket desconectado'));
ws.on('error', () => enviarATelegram('❌ Error en WebSocket de OKX'));
