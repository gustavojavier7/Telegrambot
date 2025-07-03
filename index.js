// index.js – Bot de liquidaciones (OKX + Binance)
// ==========================================================
// Versión: 2.3.0  ← 2025‑07‑03
// • Ventanas deslizantes 5m, 15m, 30m, 1h para estadísticas BUY/SELL.
// • Reporte automático cada 5 min (300 000 ms) en Markdown.
// • Precisión HH:MM:SS.mmm. Nombres de exchange entre corchetes.
// • Se mantienen: lote ≤ 4‌000 caracteres, 1‌msg/s, backoff 429, WS OKX & Binance.

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

const messageQueue = [];
let lastSentTime = 0;
const MIN_INTERVAL_MS = 1000;

// Ventanas deslizantes
const ventanas = {
  '5m': [],
  '15m': [],
  '30m': [],
  '1h': []
};
const DURACIONES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000
};

function addEvento(tipo) {
  const ts = Date.now();
  for (const key of Object.keys(ventanas)) {
    ventanas[key].push({ ts, tipo });
  }
}

setInterval(async () => {
  if (messageQueue.length === 0 || Date.now() - lastSentTime < MIN_INTERVAL_MS) return;
  const lotes = [];
  let lote = [];
  let totalLength = 0;
  for (let i = 0; i < messageQueue.length; i++) {
    const texto = messageQueue[i].text;
    if (texto.length > 3990) {
      lote.push(texto.slice(0, 3990) + " […]");
    } else if (totalLength + texto.length + 1 > 4000) {
      lotes.push(lote);
      lote = [texto];
      totalLength = texto.length + 1;
    } else {
      lote.push(texto);
      totalLength += texto.length + 1;
    }
  }
  if (lote.length > 0) lotes.push(lote);
  for (let i = 0; i < lotes.length; i++) {
    const encabezado = lotes.length > 1 ? `***[mensajes en lote ${i + 1}/${lotes.length}]***\n` : "";
    const texto = encabezado + lotes[i].join("\n");
    await sendToTelegram(texto);
    lastSentTime = Date.now();
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  }
  messageQueue.splice(0, messageQueue.length);
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
        console.warn(`⚠️ 429 Too Many Requests, reintentando en ${wait}ms`);
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

const app = express();
const PORT = process.env.PORT || 8080;
app.get("/health", (_, res) => res.send("✅ Bot activo"));
app.listen(PORT, () => console.log(`🌐 HTTP server on ${PORT}`));

enviarATelegram("🚀 Bot activo");
setInterval(() => console.log("⏱️ Servicio en ejecución…"), 60000);

function enviarEstadisticas() {
  const ahora = Date.now();
  const hhmmss = new Date(ahora).toISOString().split("T")[1].replace("Z", "");
  const lines = [`*Estadísticas de liquidaciones (actualizado ${hhmmss})*\n`];
  for (const key of Object.keys(ventanas)) {
    const limite = ahora - DURACIONES[key];
    while (ventanas[key].length && ventanas[key][0].ts < limite) ventanas[key].shift();
    const eventos = ventanas[key];
    const total = eventos.length;
    if (total === 0) continue;
    const buy = eventos.filter(e => e.tipo === "buy").length;
    const sell = total - buy;
    const ratio = ((buy / total) * 100).toFixed(1);
    lines.push(`• Últimos ${key}:\n  – BUY: ${buy} | SELL: ${sell} | % BUY: ${ratio}%`);
  }
  if (lines.length > 1) enviarATelegram(lines.join("\n"));
}
setInterval(enviarEstadisticas, 300000);

function connectOKX() {
  const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
  let pingInt, reconnectAttempts = 0;
  ws.on("open", () => {
    console.log("🟢 Conectado a OKX");
    enviarATelegram("[OKX] conectado");
    ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
    pingInt = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 15000);
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.arg?.channel === "liquidation-orders" && Array.isArray(msg.data)) {
        msg.data.forEach(d => {
          const price = Number(d.fillPx || d.bkPx || 0);
          const qty = Number(d.sz || d.accFillSz || 0);
          const usd = price && qty ? `$${(price * qty).toLocaleString()}` : "$–";
          const tipo = d.side === "buy" ? "buy" : "sell";
          addEvento(tipo);
          const emoji = tipo === "buy" ? "🟥" : "🟩";
          const texto = `${emoji} [OKX] #${d.instId || "unknown"} Liquidated ${tipo === "buy" ? "Long" : "Short"}: ${usd} at $${price || "–"}`;
          console.log(texto);
          enviarATelegram(texto);
        });
      }
    } catch (e) { console.error("❌ Err OKX:", e.message); }
  });
  const restart = () => { clearInterval(pingInt); setTimeout(connectOKX, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000); };
  ws.on("close", () => { enviarATelegram("[OKX] 🔌 desconectado"); restart(); });
  ws.on("error", () => { enviarATelegram("[OKX] ❌ error en conexión"); restart(); });
}
connectOKX();

function connectBinance() {
  const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
  let pingInt, reconnectAttempts = 0;
  ws.on("open", () => {
    console.log("🟡 Conectado a Binance");
    enviarATelegram("[BINANCE] conectado");
    pingInt = setInterval(() => ws.ping(), 30000);
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const p = Number(msg.o.p || 0); const q = Number(msg.o.q || 0);
        const usd = p && q ? `$${(p * q).toLocaleString()}` : "$–";
        const tipo = msg.o.S.toUpperCase() === "BUY" ? "buy" : "sell";
        addEvento(tipo);
        const emoji = tipo === "buy" ? "🟥" : "🟩";
        const texto = `${emoji} [BINANCE] #${msg.o.s || "unknown"} Liquidated ${msg.o.S || "unknown"}: ${usd} at $${p || "–"}`;
        console.log(texto); enviarATelegram(texto);
      }
    } catch (e) { console.error("❌ Err Binance:", e.message); }
  });
  const restart = () => { clearInterval(pingInt); setTimeout(connectBinance, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000); };
  ws.on("close", () => { enviarATelegram("[BINANCE] 🔌 desconectado"); restart(); });
  ws.on("error", () => { enviarATelegram("[BINANCE] ❌ error en conexión"); restart(); });
}
connectBinance();
