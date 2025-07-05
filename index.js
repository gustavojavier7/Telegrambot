// index.js – Bot de liquidaciones (OKX + Binance)
// ==========================================================
// Versión: 2.5.0  ← 2025-07-04
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

function refillTokens() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  availableTokens = Math.min(TOKEN_CAP, availableTokens + elapsed * REFILL_RATE);
  lastRefill = now;
}

setInterval(async () => {
  refillTokens();
  while (messageQueue.length && availableTokens >= 1) {
    const { text } = messageQueue.shift();
    await sendToTelegram(text);
    availableTokens -= 1;
  }
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

function enviarATelegram(text) {
  if (typeof text === "string" && text.length) messageQueue.push({ text });
}

function logYEncolar(text) {
  console.log(text);
  enviarATelegram(text);
}

const app = express();
const PORT = process.env.PORT || 8080;
app.get("/health", (_, res) => res.send("✅ Bot activo"));
app.listen(PORT, () => console.log(`🌐 HTTP server on ${PORT}`));

enviarATelegram("🚀 Bot activo (v2.5.0)");
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
  if (linea) enviarATelegram(`*Estadísticas 5m ${hhmmss}*\n${linea}`);
}

function enviarEstadisticasLargas() {
  const hhmmss = new Date().toISOString().split("T")[1].replace("Z", "");
  const partes = [
    resumenEstadisticas(15 * 60 * 1000),
    resumenEstadisticas(30 * 60 * 1000),
    resumenEstadisticas(60 * 60 * 1000)
  ].filter(Boolean);
  if (partes.length) enviarATelegram(`*Estadísticas ampliadas ${hhmmss}*\n${partes.join("\n")}`);
}

setInterval(enviarEstadisticas5m, 150000);
setInterval(enviarEstadisticasLargas, 300000);

function connectOKX() {
  const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
  let pingInt, reconnectAttempts = 0;

  ws.on("open", () => {
    console.log("🟢 Conectado a OKX");
    enviarATelegram("🟢 OKX conectado");
    ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
    pingInt = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 15000);
  });

  ws.on("message", (data) => {
    try {
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
          logYEncolar(texto);
        });
      }
    } catch (e) {
      console.error("❌ Err OKX:", e.message);
    }
  });

  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectOKX, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };

  ws.on("close", () => { enviarATelegram("🔌 OKX desconectado"); restart(); });
  ws.on("error", () => { enviarATelegram("❌ Error en conexión OKX"); restart(); });
}
connectOKX();

function connectBinance() {
  const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
  let pingInt, reconnectAttempts = 0;

  ws.on("open", () => {
    console.log("🟡 Conectado a Binance");
    enviarATelegram("🟡 Binance conectado");
    pingInt = setInterval(() => ws.ping(), 30000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const p = Number(msg.o.p || 0);
        const q = Number(msg.o.q || 0);
        const usd = p && q ? `$${(p * q).toLocaleString()}` : "$–";
        const tipo = msg.o.S.toUpperCase() === "BUY" ? "buy" : "sell";
        addEvento(tipo);
        const emoji = tipo === "buy" ? "🟩" : "🟥";
        const texto = `${emoji} [BINANCE] #${msg.o.s || "unknown"} Liquidated ${msg.o.S || "unknown"}: ${usd} at $${p || "–"}`;
        logYEncolar(texto);
      }
    } catch (e) {
      console.error("❌ Err Binance:", e.message);
    }
  });

  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectBinance, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };

  ws.on("close", () => { enviarATelegram("🔌 Binance desconectado"); restart(); });
  ws.on("error", () => { enviarATelegram("❌ Error en conexión Binance"); restart(); });
}
connectBinance();
