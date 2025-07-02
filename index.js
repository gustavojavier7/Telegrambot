// ──────────────────────────────────────────────
// index.js – Bot de liquidaciones (OKX + Binance + Huobi)
// ==========================================================
// Funciones clave:
//   • Envía mensaje inicial "🚀 Bot activo" al arrancar.
//   • Conexiones WebSocket:
//       🟢 OKX  – channel: liquidation-orders  (ping keep‑alive 15 s)
//       🟡 Binance – stream: !forceOrder@arr     (ping 30 s)
//       🔴 Huobi  – linear-swap (REST + WS, gzip) (ping/pong + recarga de pares 1 h)
//   • Reconexión automática con back‑off.
//   • Cola anti‑spam (máx. 20 msg/s) para Telegram.
//   • Variables de entorno: TELEGRAM_TOKEN, CHAT_ID  (mismas que en Cloud Run).
// ──────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");
const zlib = require("zlib"); // Para descomprimir mensajes gzip de Huobi

// ──────────────────────────────────────────────
// Configuración Telegram
// ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

const messageQueue = [];
setInterval(() => {
  if (messageQueue.length === 0) return;
  const { text } = messageQueue.shift();
  fetch(TG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) console.error("❌ Telegram error:", j.description);
    })
    .catch((e) => console.error("❌ Telegram fetch err:", e.message));
}, 50); // ≈20 msg/s

function enviarATelegram(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ Falta TELEGRAM_TOKEN o CHAT_ID");
    return;
  }
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

// ──────────────────────────────────────────────
// Huobi – REST fetch de pares + WebSocket con gzip
// ──────────────────────────────────────────────
const HUOBI_REST_URL = "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info";
let huobiPairs = [];
function fetchHuobiPairs() {
  fetch(HUOBI_REST_URL)
    .then((r) => r.json())
    .then((j) => {
      huobiPairs = (j.data || [])
        .filter((c) => c.contract_code.endsWith("USDT"))
        .map((c) => c.contract_code.toUpperCase());
      console.log("🔴 Pares Huobi actualizados:", huobiPairs.length);
      connectHuobi(); // Reconecta para re‑suscribirse
    })
    .catch((e) => console.error("❌ Error fetch Huobi REST:", e.message));
}

function connectHuobi() {
  if (typeof connectHuobi.ws !== "undefined") {
    try { connectHuobi.ws.close(); } catch {}
  }
  const ws = new WebSocket("wss://api.hbdm.com/linear-swap-ws");
  connectHuobi.ws = ws;
  ws.on("open", () => {
    console.log("🔴 Conectado a Huobi");
    enviarATelegram("🔴 Huobi conectado");
    huobiPairs.forEach((pair) => {
      ws.send(JSON.stringify({
        op: "sub",
        topic: `public.${pair.toLowerCase()}.liquidation_orders`,
        cid: `${pair}-liq`
      }));
    });
  });

  ws.on("message", (data) => {
    let msg;
    try {
      // Huobi envía gzip
      const decompressed = zlib.gunzipSync(data);
      msg = JSON.parse(decompressed.toString());
    } catch (e) {
      console.error("❌ Error gzip Huobi:", e.message);
      return;
    }

    if (msg.ping) { // Ping/pong
      ws.send(JSON.stringify({ pong: msg.ping }));
      return;
    }

    if (msg.ch && msg.tick?.data) {
      const instId = msg.ch.split(".")[1].toUpperCase();
      msg.tick.data.forEach((d) => {
        const price = Number(d.price);
        const qty = Number(d.vol);
        const usd = price && qty ? `$${(price * qty).toLocaleString()}` : "$–";
        const side = d.direction === "buy" ? "Long" : "Short";
        const texto = `🔴 #${instId} Liquidated ${side}: ${usd} at $${price || "–"}`;
        console.log(texto);
        enviarATelegram(texto);
      });
    }
  });

  const restart = () => setTimeout(connectHuobi, 5000);
  ws.on("close", restart);
  ws.on("error", restart);
}

// Obtiene pares y establece refresh cada hora
fetchHuobiPairs();
setInterval(fetchHuobiPairs, 60 * 60 * 1000); // 1 hora
