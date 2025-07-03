// ──────────────────────────────────────────────
// index.js – Bot de liquidaciones (OKX + Binance)
// ==========================================================
// Funciones clave:
//   • Envía mensaje inicial "🚀 Bot activo" al arrancar.
//   • Conexiones WebSocket:
//       🟢 OKX  – channel: liquidation-orders  (ping keep‑alive 15 s)
//       🟡 Binance – stream: !forceOrder@arr     (ping 30 s)
//   • Reconexión automática con back‑off.
//   • Cola anti‑spam (máx. 20 msg/s) para Telegram.
//   • Detección de saturación y modo lote con límite de caracteres.
//   • Variables de entorno: TELEGRAM_TOKEN, CHAT_ID  (mismas que en Cloud Run).
// ──────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");

// ──────────────────────────────────────────────
// Configuración Telegram
// ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

const messageQueue = [];
let sentTimestamps = []; // Para calcular la tasa de envío
let batchMode = false;

setInterval(() => {
  // Remover timestamps viejos
  const now = Date.now();
  sentTimestamps = sentTimestamps.filter(ts => now - ts < 60000);

  // Evaluar tasa de mensajes
  const rate = sentTimestamps.length / 60;
  const limitePorSegundo = 20;

  if (rate > limitePorSegundo * 0.8) {
    if (!batchMode) {
      batchMode = true;
      enviarATelegram("⚠️ Ratio mensajes/minuto mayor al 80%. Activando modo lote.");
    }
  } else {
    batchMode = false;
  }

  if (messageQueue.length === 0) return;

  if (!batchMode) {
    const { text } = messageQueue.shift();
    sendToTelegram(text);
  } else {
    let lote = [];
    let totalLength = 0;
    while (messageQueue.length > 0 && lote.length < 100) {
      const { text } = messageQueue[0];
      if (totalLength + text.length + 1 > 4000) break;
      lote.push(text);
      totalLength += text.length + 1;
      messageQueue.shift();
    }
    if (lote.length > 0) {
      sendToTelegram("***[mensajes en lote]***\n" + lote.join("\n"));
    }
  }
}, 50); // ≈20 msg/s

function sendToTelegram(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ Falta TELEGRAM_TOKEN o CHAT_ID");
    return;
  }
  fetch(TG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  })
    .then(r => r.json())
    .then(j => {
      if (!j.ok) {
        console.error("❌ Telegram error:", j.description);
      } else {
        sentTimestamps.push(Date.now());
      }
    })
    .catch(e => console.error("❌ Telegram fetch err:", e.message));
}

function enviarATelegram(text) {
  messageQueue.push({ text });
}

// ──────────────────────────────────────────────
// Express /health
// ──────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 8080;
app.get("/health", (_, res) => res.send("✅ Bot activo"));
app.listen(PORT, () => console.log(`🌐 HTTP server on ${PORT}`));

// Mensaje inicial
enviarATelegram("🚀 Bot activo");

// Latido de logs
setInterval(() => console.log("⏱️ Servicio en ejecución…"), 60000);

// ──────────────────────────────────────────────
// OKX WebSocket
// ──────────────────────────────────────────────
function connectOKX() {
  const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
  let pingInt;
  ws.on("open", () => {
    console.log("🟢 Conectado a OKX");
    enviarATelegram("🟢 OKX conectado");
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [{ channel: "liquidation-orders", instType: "SWAP" }]
    }));
    pingInt = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 15000);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.arg?.channel === "liquidation-orders" && msg.data) {
      msg.data.forEach((d) => {
        const price = Number(d.fillPx || d.bkPx);
        const qty = Number(d.sz || d.accFillSz);
        const usd = price && qty ? `$${(price * qty).toLocaleString()}` : "$–";
        const texto = `🟢 #${d.instId} Liquidated ${d.side === "buy" ? "Long" : "Short"}: ${usd} at $${price || "–"}`;
        console.log(texto);
        enviarATelegram(texto);
      });
    }
  });
  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectOKX, 5000);
  };
  ws.on("close", restart);
  ws.on("error", restart);
}
connectOKX();

// ──────────────────────────────────────────────
// Binance WebSocket (!forceOrder@arr)
// ──────────────────────────────────────────────
function connectBinance() {
  const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
  let pingInt;
  ws.on("open", () => {
    console.log("🟡 Conectado a Binance");
    enviarATelegram("🟡 Binance conectado");
    pingInt = setInterval(() => ws.ping(), 30000);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.e === "forceOrder") {
      const p = Number(msg.o.p);
      const q = Number(msg.o.q);
      const usd = p && q ? `$${(p * q).toLocaleString()}` : "$–";
      const texto = `🟡 #${msg.o.s} Liquidated ${msg.o.S}: ${usd} at $${p || "–"}`;
      console.log(texto);
      enviarATelegram(texto);
    }
  });
  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectBinance, 5000);
  };
  ws.on("close", restart);
  ws.on("error", restart);
}
connectBinance();
