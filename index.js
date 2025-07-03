// index.js – Bot de liquidaciones (OKX + Binance)
// ==========================================================
// Versión: 2.1.0
// Funciones clave:
//   • Envía mensaje inicial "🚀 Bot activo" al arrancar.
//   • Conexiones WebSocket:
//       🟢 OKX  – channel: liquidation-orders  (ping keep‑alive 15 s)
//       🟡 Binance – stream: !forceOrder@arr     (ping 30 s)
//   • Reconexión automática con back‑off.
//   • Cola anti‑spam y envío en lotes (máx. 4000 caracteres).
//   • Manejo de error 429 (Too Many Requests) con reintentos exponenciales.
//   • Variables de entorno: TELEGRAM_TOKEN, CHAT_ID (Cloud Run).

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
let lastSentTime = 0;
const MIN_INTERVAL_MS = 1000;

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
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ Falta TELEGRAM_TOKEN o CHAT_ID");
    return;
  }

  try {
    const response = await fetch(TG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
    const json = await response.json();
    if (!json.ok) {
      if (json.error_code === 429 && retryCount < 3) {
        const wait = Math.pow(2, retryCount) * 1000;
        console.warn(`⚠️ 429 Too Many Requests, reintentando en ${wait}ms`);
        setTimeout(() => sendToTelegram(text, retryCount + 1), wait);
      } else {
        console.error("❌ Telegram error:", json.description);
      }
    } else {
      console.log("✅ Mensaje enviado a Telegram");
    }
  } catch (e) {
    console.error("❌ Telegram fetch err:", e.message);
  }
}

function enviarATelegram(text) {
  if (typeof text === "string" && text.length > 0) {
    messageQueue.push({ text });
  } else {
    console.warn("⚠️ Intento de encolar mensaje inválido:", text);
  }
}

// ──────────────────────────────────────────────
// Express /health
// ──────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 8080;
app.get("/health", (_, res) => res.send("✅ Bot activo"));
app.listen(PORT, () => console.log(`🌐 HTTP server on ${PORT}`));

enviarATelegram("🚀 Bot activo");
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
    try {
      const msg = JSON.parse(data);
      if (msg.arg?.channel === "liquidation-orders" && Array.isArray(msg.data)) {
        msg.data.forEach((d) => {
          const price = Number(d.fillPx || d.bkPx || 0);
          const qty = Number(d.sz || d.accFillSz || 0);
          const usd = price && qty ? `$${(price * qty).toLocaleString()}` : "$–";
          const texto = `🟢 #${d.instId || "unknown"} Liquidated ${d.side === "buy" ? "Long" : "Short"}: ${usd} at $${price || "–"}`;
          console.log(texto);
          enviarATelegram(texto);
        });
      }
    } catch (e) {
      console.error("❌ Error procesando mensaje OKX:", e.message);
    }
  });
  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectOKX, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };
  let reconnectAttempts = 0;
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
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const p = Number(msg.o.p || 0);
        const q = Number(msg.o.q || 0);
        const usd = p && q ? `$${(p * q).toLocaleString()}` : "$–";
        const texto = `🟡 #${msg.o.s || "unknown"} Liquidated ${msg.o.S || "unknown"}: ${usd} at $${p || "–"}`;
        console.log(texto);
        enviarATelegram(texto);
      }
    } catch (e) {
      console.error("❌ Error procesando mensaje Binance:", e.message);
    }
  });
  const restart = () => {
    clearInterval(pingInt);
    setTimeout(connectBinance, Math.pow(2, Math.min(5, reconnectAttempts++)) * 1000);
  };
  let reconnectAttempts = 0;
  ws.on("close", restart);
  ws.on("error", restart);
}
connectBinance();
