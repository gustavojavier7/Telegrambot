// index.js – Bot de liquidaciones (OKX + Binance + Huobi)
// ==========================================================
// Características principales
// • Envía mensaje inicial "🚀 Bot activo" a Telegram.
// • Conexiones WebSocket: OKX (liquidations‑orders), Binance (!forceOrder@arr), Huobi (liquidation_orders).
// • Huobi: obtiene la lista de pares admitidos vía REST y se re‑suscribe **cada hora**.
// • Reconexión automática y ping/keep‑alive en todos los WebSockets.
// • Cola de envío anti‑spam (máx 20 msg/s) para cumplir con límites de Telegram.
// • Variables de entorno (definidas en Cloud Run / Secret Manager):
//     TELEGRAM_TOKEN, CHAT_ID

// ─── Dependencias ──────────────────────────────────────────
require('dotenv').config();
const express   = require('express');
const fetch     = require('node-fetch');
const WebSocket = require('ws');
const zlib      = require('zlib');

// ─── Config Express (HealthCheck) ─────────────────────────
const app  = express();
const PORT = process.env.PORT || 8080;
app.get('/health', (_, res) => res.send('✅ Bot activo'));
app.listen(PORT, () => console.log(`🌐 HTTP vivo en puerto ${PORT}`));

// ─── Config Telegram ──────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

function enviarATelegram(texto) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Falta TELEGRAM_TOKEN o CHAT_ID');
    return;
  }
  cola.push(texto);
}

// Cola anti‑spam (máx 20 msg/s) --------------------------------
const cola = [];
setInterval(() => {
  if (cola.length === 0) return;
  const bloque = cola.splice(0, 20); // hasta 20 mensajes por segundo
  bloque.forEach(msg => {
    fetch(TG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    }).then(r => r.json())
      .then(j => { if (!j.ok) console.error('❌ Telegram error:', j.description); })
      .catch(e => console.error('❌ Fetch Telegram:', e.message));
  });
}, 1000);

// Mensaje de arranque
enviarATelegram('🚀 Bot activo');

// ─── Utilidad de reconexión genérica ──────────────────────
function crearWS(nombre, url, onOpen, onMsg, getPingData = null, pingMs = 20000) {
  let ws; let ping;
  const conectar = () => {
    ws = new WebSocket(url);
    ws.on('open', () => {
      console.log(`✅ WebSocket abierto en ${nombre}`);
      onOpen(ws);
      if (getPingData) ping = setInterval(() => ws.readyState === 1 && ws.send(getPingData()), pingMs);
    });
    ws.on('message', onMsg);
    ws.on('close', () => {
      console.warn(`🔴 ${nombre} desconectado. Reconectando en 5 s`);
      clearInterval(ping);
      setTimeout(conectar, 5000);
    });
    ws.on('error', err => console.error(`❌ ${nombre} WS error:`, err.message));
  };
  conectar();
  return () => { try { ws.close(); } catch(e){} };
}

// ─── Binance (!forceOrder@arr) ─────────────────────────────
crearWS('Binance', 'wss://fstream.binance.com/ws/!forceOrder@arr',
  () => {},
  data => {
    const msg = JSON.parse(data);
    if (msg.e !== 'forceOrder') return;
    const monto = (parseFloat(msg.o.p) * parseFloat(msg.o.q)).toLocaleString();
    const texto = `🟡 #${msg.o.s} Liquidated ${msg.o.S}: $${monto} at $${msg.o.p}`;
    console.log(texto);
    enviarATelegram(texto);
  }
);

// ─── OKX (liquidation-orders) ──────────────────────────────
crearWS('OKX', 'wss://ws.okx.com:8443/ws/v5/public',
  ws => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })),
  data => {
    const msg = JSON.parse(data);
    if (msg.arg?.channel !== 'liquidation-orders') return;
    msg.data?.forEach(d => {
      const price = Number(d.fillPx || d.bkPx);
      const qty   = Number(d.sz || d.accFillSz);
      const side  = d.side === 'buy' ? 'Long' : 'Short';
      const monto = (!isNaN(price) && !isNaN(qty)) ? (price * qty).toLocaleString() : '–';
      const texto = `🟢 #${d.instId} Liquidated ${side}: $${monto} at $${isNaN(price) ? '–' : price}`;
      console.log(texto);
      enviarATelegram(texto);
    });
  },
  () => JSON.stringify({ event: 'ping' }), 15000
);

// ─── Huobi (pares dinámicos) ───────────────────────────────
let cerrarHuobi = () => {};

async function obtenerParesHuobi() {
  try {
    const res = await fetch('https://api.hbdm.com/linear-swap-api/v1/swap_contract_info');
    const json = await res.json();
    return [...new Set(json.data.filter(c => c.contract_code.endsWith('-USDT')).map(c => c.contract_code))];
  } catch (e) {
    console.error('❌ Error al obtener pares Huobi:', e.message);
    return [];
  }
}

function conectarHuobi(pares) {
  if (!pares.length) {
    console.warn('⚠️ Sin pares Huobi para suscribirse');
    return;
  }
  cerrarHuobi(); // cierra conexión previa si existe

  let ws;
  cerrarHuobi = () => { try { ws && ws.close(); } catch(e){} };

  ws = new WebSocket('wss://api.hbdm.com/linear-swap-ws');

  ws.on('open', () => {
    console.log('🔵 WebSocket abierto en Huobi');
    pares.forEach(par => {
      ws.send(JSON.stringify({ op: 'sub', topic: `public.${par.replace('-', '')}.liquidation_orders`, cid: `${par}-liq` }));
    });
  });

  ws.on('message', data => {
    let text;
    try {
      text = typeof data === 'string' ? data : zlib.gunzipSync(data).toString();
    } catch { return; }
    if (text.includes('ping')) {
      const ts = JSON.parse(text).ts;
      ws.send(JSON.stringify({ pong: ts }));
      return;
    }
    const msg = JSON.parse(text);
    if (!msg.topic || !msg.data) return;
    const par = msg.topic.match(/public\.(.+?)\.liquidation_orders/)[1].toUpperCase();
    const d   = msg.data;
    const price = parseFloat(d.price);
    const qty   = parseFloat(d.vol);
    const side  = d.direction === 'buy' ? 'Long' : 'Short';
    const monto = (!isNaN(price) && !isNaN(qty)) ? (price * qty).toLocaleString() : '–';
    const texto = `🔵 #${par} Liquidated ${side}: $${monto} at $${isNaN(price) ? '–' : price}`;
    console.log(texto);
    enviarATelegram(texto);
  });

  ws.on('close', () => enviarATelegram('🔵 Huobi WebSocket cerrado'));
  ws.on('error', err => enviarATelegram('❌ Error en Huobi WS: ' + err.message));
}

// Suscribirse inicialmente y refrescar cada hora
(async function initHuobi() {
  const pares = await obtenerParesHuobi();
  console.log(`🔵 Huobi pares iniciales: ${pares.join(', ')}`);
  conectarHuobi(pares);
})();

setInterval(async () => {
  console.log('🔄 Actualizando lista de pares Huobi...');
  const nuevos = await obtenerParesHuobi();
  conectarHuobi(nuevos);
}, 3600_000); // cada hora

// ─── Latido general cada minuto ────────────────────────────
setInterval(() => console.log('⏱️ Servicio sigue vivo…'), 60000);
