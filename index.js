// ──────────────────────────────────────────────
// index.js  –  Bot de liquidaciones: OKX + Binance (auth opcional)
// Funciones nuevas:
//  • Mensaje inicial "🚀 Bot activo" al arrancar.
//  • Reconexión automática y logs detallados.
//  • Conexión WebSocket a Binance (!forceOrder@arr) y OKX (liquidation-orders).
//  • Latido cada 60 s para ver actividad en logs.
//  • Variables de entorno soportadas:
//      TELEGRAM_TOKEN, CHAT_ID,
//      BINANCE_API_KEY, BINANCE_API_SECRET  (opcionales si luego quieres stream privado)
// ──────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── Express server (healthcheck) ─────────────────────────────
const app  = express();
const PORT = process.env.PORT || 8080;
app.get('/health', (_, res) => res.send('✅ Bot activo'));
app.listen(PORT, () => console.log(`🌐 Servidor HTTP en puerto ${PORT}`));

// ── Telegram helpers ─────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

function enviarATelegram(texto) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Falta TELEGRAM_TOKEN o CHAT_ID');
    return;
  }
  console.log(`📤 Telegram: ${texto}`);
  fetch(TG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: texto })
  }).catch(err => console.error('❌ Error Telegram:', err));
}

// Enviar mensaje al iniciar
enviarATelegram('🚀 Bot activo');

// ── Función genérica de reconexión WebSocket ────────────────
function crearWS(nombre, url, onOpen, onMsg, pingMs = null) {
  let ws; let ping;
  const conecta = () => {
    console.log(`🛠️ Conectando a ${nombre}…`);
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`✅ ${nombre} WebSocket abierto`);
      enviarATelegram(`🟢 Conexión ${nombre} establecida`);
      if (onOpen) onOpen(ws);
      if (pingMs) {
        ping = setInterval(() => ws.readyState === 1 && ws.ping(), pingMs);
      }
    });

    ws.on('message', data => {
      try { onMsg(JSON.parse(data)); }
      catch (e) { console.error(`${nombre} JSON err:`, e); }
    });

    ws.on('close', () => {
      console.warn(`🔴 ${nombre} WS cerrado → reconexión en 5 s`);
      enviarATelegram(`🔴 ${nombre} desconectado. Reintentando…`);
      clearInterval(ping);
      setTimeout(conecta, 5000);
    });

    ws.on('error', err => {
      console.error(`❌ ${nombre} WS error:`, err.message);
    });
  };
  conecta();
}

// ── Binance – stream público de liquidaciones ───────────────
const binanceURL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
crearWS(
  'Binance',
  binanceURL,
  null,
  msg => {
    if (msg.e !== 'forceOrder') return;
    const { s: symbol, p: price, q: qty, S: side } = msg.o;
    const monto = (parseFloat(price) * parseFloat(qty)).toFixed(2);
    const texto = `🟡 #${symbol} Liquidated ${side}: $${monto} at $${price}`;
    console.log(texto);
    enviarATelegram(texto);
  }
);

// ── OKX – liquidation-orders SWAP ───────────────────────────
const okxURL = 'wss://ws.okx.com:8443/ws/v5/public';
crearWS(
  'OKX',
  okxURL,
  ws => ws.send(JSON.stringify({
    op: 'subscribe',
    args: [{ channel: 'liquidation-orders', instType: 'SWAP' }]
  })),
  msg => {
    if (msg.arg?.channel !== 'liquidation-orders') return;
    msg.data.forEach(d => {
      const precio = parseFloat(d.fillPx ?? d.bkPx);
      const qty    = parseFloat(d.sz    ?? d.accFillSz);
      const side   = d.side === 'buy' ? 'BUY' : 'SELL';
      const monto  = (!isNaN(precio) && !isNaN(qty)) ? (precio * qty).toFixed(2) : '–';
      const texto  = `🟢 #${d.instId} Liquidated ${side === 'SELL' ? 'Short' : 'Long'}: $${monto} at $${!isNaN(precio) ? precio : '–'}`;
      console.log(texto);
      enviarATelegram(texto);
    });
  },
  15000 // ping cada 15 s
);

// ── Latido de servicio cada 60 s ────────────────────────────
setInterval(() => console.log('⏱️ Servicio en ejecución…'), 60000);
