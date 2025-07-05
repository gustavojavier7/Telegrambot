// index.js – Bot de liquidaciones (OKX + Binance)
// ==========================================================
// Versión: 2.7.0  ← 2025-07-05
// • Estrategia *Token Bucket* (ráfagas + descanso) ajustada a 0.3 msg/s.
// • Eliminado **por completo** el control de tráfico Cloud Run.
// • Código reescrito y simplificado. Mantiene:
//   - Lote ≤ 4 000 caracteres
//   - Back‑off 429
//   - Reportes 5 m / 15‑30‑60 m
//   - Conexión WS a OKX y Binance

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");

// ──────────────────────────────────────────────
// Configuración Telegram + limitador Token Bucket
// ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

const TOKEN_CAP   = 20;
const REFILL_RATE = Number(process.env.REFILL_RATE || 0.3);
let availableTokens = TOKEN_CAP;
let lastRefill = Date.now();

const messageQueue = [];
const AGRUPA_TAMANIO = 5;                 // tamaño orientativo (pivote)
const MAX_TG_LENGTH   = 4000;             // límite duro de Telegram
const startTime = Date.now();
let lastMessageSent = null;
let okxConnected = false;
let binanceConnected = false;

function formatTimestamp(ts) {
  const date = new Date(ts - 3 * 60 * 60 * 1000);
  const Y = date.getUTCFullYear();
  const M = String(date.getUTCMonth() + 1).padStart(2, '0');
  const D = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `[${Y}-${M}-${D} ${h}:${m}:${s} GMT-3]`;
}

function formatHora(ts) {
  const date = new Date(ts - 3 * 60 * 60 * 1000);
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s} GMT-3]`;
}

function refillTokens() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  availableTokens = Math.min(TOKEN_CAP, availableTokens + elapsed * REFILL_RATE);
  lastRefill = now;
}

setInterval(async () => {
  refillTokens();

  // Mientras haya tokens y mensajes, armar lotes ≤ 4 000 caracteres
  while (availableTokens >= 1 && messageQueue.length) {
    let charCount = 0;
    const loteItems = [];

    // Empaquetar mensajes hasta rozar el límite o vaciar cola
    while (messageQueue.length) {
      const next = messageQueue[0];
      // +1 por el \n que añadiremos
      if (charCount + next.text.length + 1 > MAX_TG_LENGTH) break;
      loteItems.push(messageQueue.shift());
      charCount += next.text.length + 1;
      // Salir si ya tenemos 5 para mantener lotes “manejables”
      if (loteItems.length >= AGRUPA_TAMANIO) break;
    }

    // Formatear lote (con timestamp línea por línea)
    const encabezado = formatHora(loteItems[0].timestamp);
    const body = loteItems
      .map(i => `${formatHora(i.timestamp)} ${i.text}`)
      .join("\n");

    await sendToTelegram(`${encabezado} *Resumen de ${loteItems.length} liquidaciones:*\n${body}`);
    lastMessageSent = new Date().toISOString();
    availableTokens -= 1;
  }

  // Si no hay tokens, simplemente esperamos al próximo refill
}, 250);

async function sendToTelegram(text, retryCount = 0) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) return console.error("❌ Falta TELEGRAM_TOKEN o CHAT_ID");
  try {
    const res = await fetch(TG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" })
    });
    const json = await res.json();
    if (!json.ok) {
      if (json.error_code === 429 && retryCount < 3) {
        const wait = Math.max(json.parameters?.retry_after * 1000 || 0, Math.pow(2, retryCount) * 1000);
        console.warn(`⚠️ 429 Too Many Requests · reintento en ${wait} ms`);
        return setTimeout(() => sendToTelegram(text, retryCount + 1), wait);
      }
      console.error("❌ Telegram error:", json.description);
    }
  } catch (e) {
    console.error("❌ Telegram fetch err:", e.message);
  }
}

function encolarMensaje(text, timestamp) {
  if (typeof text === "string" && text.length) {
    messageQueue.push({ text, timestamp: timestamp || Date.now() });
  }
}

function logYEncolar(text, timestamp) {
  console.log(text);
  encolarMensaje(text, timestamp);
}

const app = express();
const PORT = process.env.PORT || 8080;
app.get("/health", (_, res) => {
  const uptimeMs = Date.now() - startTime;
  const hrs = String(Math.floor(uptimeMs / 3600000)).padStart(2, '0');
  const mins = String(Math.floor((uptimeMs % 3600000) / 60000)).padStart(2, '0');
  const secs = String(Math.floor((uptimeMs % 60000) / 1000)).padStart(2, '0');
  const recientes = eventos.filter(e => e.ts >= Date.now() - 5 * 60 * 1000);
  const total = recientes.length;
  const buy = recientes.filter(e => e.tipo === "buy").length;
  const sell = total - buy;
  res.json({
    status: "ok",
    uptime: `${hrs}:${mins}:${secs}`,
    messagesInQueue: messageQueue.length,
    lastMessageSent,
    connectedExchanges: { okx: okxConnected, binance: binanceConnected },
    eventStats: { last5min: { total, buy, sell } }
  });
});
app.listen(PORT, () => console.log(`🌐 HTTP server on ${PORT}`));

encolarMensaje("🚀 Bot activo (v2.7.0)");
setInterval(() => console.log("⏱️ Servicio en ejecución…"), 60000);

const eventos = [];
const MAX_EVENT_AGE = 60 * 60 * 1000;

function limpiarEventos() {
  const limite = Date.now() - MAX_EVENT_AGE;
  while (eventos.length && eventos[0].ts < limite) eventos.shift();
}

function addEvento(tipo) {
  eventos.push({ ts: Date.now(), tipo });
  limpiarEventos();
}

function resumenEstadisticas(windowMs) {
  const ahora = Date.now();
  const recientes = eventos.filter(e => e.ts >= ahora - windowMs);
  const total = recientes.length;
  if (!total) return null;
  const buy  = recientes.filter(e => e.tipo === "buy").length;
  const sell = total - buy;
  const pctBuy  = ((buy  / total) * 100).toFixed(1);
  const pctSell = ((sell / total) * 100).toFixed(1);
  const label = `${(windowMs / 60000).toFixed(1)} min`;
  return `• *${label}* → Total: ${total}, BUY: ${buy} (${pctBuy}%), SELL: ${sell} (${pctSell}%)`;
}

function enviarEstadisticas5m() {
  const hhmmss = new Date().toISOString().split("T")[1].replace("Z", "");
  const linea = resumenEstadisticas(5 * 60 * 1000);
  if (linea) encolarMensaje(`*Estadísticas 5m ${hhmmss}*\n${linea}`);
}

function enviarEstadisticasLargas() {
  const hhmmss = new Date().toISOString().split("T")[1].replace("Z", "");
  const partes = [
    resumenEstadisticas(15 * 60 * 1000),
    resumenEstadisticas(30 * 60 * 1000),
    resumenEstadisticas(60 * 60 * 1000)
  ].filter(Boolean);
  if (partes.length) encolarMensaje(`*Estadísticas ampliadas ${hhmmss}*\n${partes.join("\n")}`);
}

setInterval(enviarEstadisticas5m, 150000);
setInterval(enviarEstadisticasLargas, 300000);

function connectOKX() {
  const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
  let pingInt, reconnectAttempts = 0;

  ws.on("open", () => {
    console.log("🟢 Conectado a OKX");
    okxConnected = true;
    encolarMensaje("🟢 OKX conectado");
    ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
    pingInt = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 15000);
  });

  ws.on("message", (data) => {
    try {
      const receptionTimestamp = Date.now();
      const msg = JSON.parse(data);
      if (msg.arg?.channel === "liquidation-orders" && Array.isArray(msg.data)) {
        msg.data.forEach(d => {
          const price = Number(d.fillPx || d.bkPx || 0);
          const qty   = Number(d.sz || d.accFillSz || 0);
          const usd   = price && qty ? `$${(price * qty).toLocaleString()}` : "$–";
          const tipo  = d.side === "buy" ? "buy" : "sell";
          addEvento(tipo);
          const emoji = tipo === "buy" ? "🟩" : "🟥";
          const texto = `${emoji} [OKX] #${d.instId || "unknown"} Liquidated ${tipo === "buy" ? "Long" : "Short"}: ${usd} at $${price || "–"}`;
          logYEncolar(texto, receptionTimestamp);
        });
      }
    } catch (e) {
      console.error("❌ Err OKX:", e.message);
    }
  });

  const restart = () => {
    clearInterval(pingInt);
    okxConnected = false;
    setTimeout(connectOKX, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };

  ws.on("close", () => { encolarMensaje("🔌 OKX desconectado"); restart(); });
  ws.on("error", () => { encolarMensaje("❌ Error en conexión OKX" ); restart(); });
}
connectOKX();

function connectBinance() {
  const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
  let pingInt, reconnectAttempts = 0;

  ws.on("open", () => {
    console.log("🟡 Conectado a Binance");
    binanceConnected = true;
    encolarMensaje("🟡 Binance conectado");
    pingInt = setInterval(() => ws.ping(), 30000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const eventTimestamp = msg.o.T;
        const p = Number(msg.o.p || 0);
        const q = Number(msg.o.q || 0);
        const usd = p && q ? `$${(p * q).toLocaleString()}` : "$–";
        const tipo = msg.o.S.toUpperCase() === "BUY" ? "buy" : "sell";
        addEvento(tipo);
        const emoji = tipo === "buy" ? "🟩" : "🟥";
        const texto = `${emoji} [BINANCE] #${msg.o.s || "unknown"} Liquidated ${msg.o.S || "unknown"}: ${usd} at $${p || "–"}`;
        logYEncolar(texto, eventTimestamp);
      }
    } catch (e) {
      console.error("❌ Err Binance:", e.message);
    }
  });

  const restart = () => {
    clearInterval(pingInt);
    binanceConnected = false;
    setTimeout(connectBinance, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };

  ws.on("close", () => { encolarMensaje("🔌 Binance desconectado"); restart(); });
  ws.on("error", () => { encolarMensaje("❌ Error en conexión Binance" ); restart(); });
}
connectBinance();
