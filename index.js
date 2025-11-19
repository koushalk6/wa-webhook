// index.js - WhatsApp webhook with Google Sheet flow + Gemini AI fallback
// --------------------------------------------------
// ENV needed:
//  - META_VERIFY_TOKEN        (for GET verification)
//  - WHATSAPP_TOKEN           (Graph API token) - optional if not sending messages
//  - WHATSAPP_PHONE_ID        (WhatsApp phone ID used by Graph API) - optional
//  - GOOGLE_SHEET_ID          (sheet ID for loading flow)
//  - GEMINI_API_KEY           (Gemini AI key)
//  - SHEET_REFRESH_SECONDS    (optional, default 300)
// --------------------------------------------------

require('dotenv').config();
const express = require('express');
const NodeCache = require('node-cache');
const Papa = require('papaparse');
const stringSimilarity = require('string-similarity');

const app = express();
app.use(express.json({ limit: "20mb" }));

// Universal fetch
let fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
if (!fetcher) fetcher = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Config
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "mySuperSecret123!@";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || null;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || null;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || null;
const SHEET_REFRESH_SECONDS = Number(process.env.SHEET_REFRESH_SECONDS || 300);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;

const flowCache = new NodeCache({ stdTTL: SHEET_REFRESH_SECONDS, checkperiod: 60 });

// Fallback node
const FALLBACK_NODE = {
  node_id: "fallback",
  type: "fallback",
  text: "Welcome to Avasar, I'm Avasar bot, currently under development.",
  ctas: []
};

// ---------------------- Google Sheet CSV loader ------------------------
async function loadFlowFromGoogleSheet() {
  if (!GOOGLE_SHEET_ID) {
    console.warn("No GOOGLE_SHEET_ID configured. Using fallback flow.");
    flowCache.set("chatFlow", [FALLBACK_NODE]);
    return [FALLBACK_NODE];
  }

  const csvUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`;
  console.log("Loading Google Sheet CSV:", csvUrl);

  try {
    const resp = await fetcher(csvUrl);
    if (!resp.ok) throw new Error(`Google sheet HTTP ${resp.status}`);
    const csvText = await resp.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: h => h?.trim() });
    const rows = parsed.data.map(r => {
      const node = {
        node_id: (r.node_id || "").toString(),
        type: (r.type || "").toString(),
        text: (r.text || "").toString(),
        keyword: (r.keyword || "").toString(),
        media_url: (r.media_url || "").toString(),
        raw: r,
        ctas: []
      };
      for (let i = 1; i <= 5; i++) {
        const txt = r[`cta${i}`];
        const id = r[`cta${i}_id`] || r[`cta${i}_payload`];
        const next = r[`cta${i}_next_id`];
        if (txt && id) node.ctas.push({ text: txt.toString(), id: id.toString(), next_id: next ? next.toString() : null });
      }
      return node;
    });

    const flow = rows.length ? rows : [FALLBACK_NODE];
    flowCache.set("chatFlow", flow);
    console.log(`Flow loaded: ${flow.length} nodes`);
    return flow;
  } catch (err) {
    console.error("Error loading Google Sheet:", err?.message || err);
    if (!flowCache.get("chatFlow")) flowCache.set("chatFlow", [FALLBACK_NODE]);
    return flowCache.get("chatFlow");
  }
}

async function ensurePeriodicLoad() {
  await loadFlowFromGoogleSheet();
  setInterval(() => loadFlowFromGoogleSheet().catch(e => console.error("Periodic reload failed:", e)), Math.max(30, SHEET_REFRESH_SECONDS) * 1000);
}

// ---------------------- Chat flow helpers ------------------------
function getChatFlow() {
  const f = flowCache.get("chatFlow");
  return Array.isArray(f) ? f : [FALLBACK_NODE];
}

function getNodeByCtaId(ctaId) {
  const flow = getChatFlow();
  for (const node of flow) {
    if (Array.isArray(node.ctas)) {
      const c = node.ctas.find(x => x.id === ctaId);
      if (c) return { node, next_id: c.next_id };
    }
  }
  return null;
}

function getNodeByExactOrFuzzy(text) {
  if (!text) return null;
  const flow = getChatFlow().filter(n => n.keyword); // ignore empty keywords

  // Exact match
  const exact = flow.find(n => n.keyword.toLowerCase() === text.toLowerCase());
  if (exact) return exact;

  // Fuzzy match
  const keywords = flow.map(n => n.keyword);
  const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(text, keywords);
  if (bestMatch.rating >= 0.6) return flow[bestMatchIndex];

  return null;
}

// ---------------------- Gemini AI fallback ------------------------
async function getAIResponse(message) {
  if (!GEMINI_API_KEY || !message) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: `Reply to: "${message}" in under 600 characters.` }] }]
    };
    const res = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    return json?.candidates?.[0]?.content?.[0]?.text || null;
  } catch (err) {
    console.error("Gemini AI error:", err?.message || err);
    return null;
  }
}

// ---------------------- WhatsApp sender ------------------------
async function sendWhatsAppMessage(phoneNumber, text, ctas = [], media = null) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return null;
  const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
  const body = { messaging_product: "whatsapp", to: phoneNumber, type: media ? "image" : (ctas.length ? "interactive" : "text") };

  if (media) body.image = { link: media };
  else if (ctas.length) body.interactive = { type: "button", body: { text: text || "Choose" }, action: { buttons: ctas.map(c => ({ type: "reply", reply: { id: c.id, title: c.text } })) } } ;
  else body.text = { body: text || FALLBACK_NODE.text };

  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    console.log("WhatsApp send response:", json);
    return json;
  } catch (err) {
    console.error("WhatsApp send error:", err?.message || err);
    return null;
  }
}

// ---------------------- Webhook GET / verification ------------------------
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.status(403).send("Verification token mismatch");
});

// ---------------------- Webhook POST ------------------------
app.post(['/', '/webhook'], (req, res) => {
  res.sendStatus(200); // immediate 200
  processWebhookSafely(req.body).catch(err => console.error("Async processing error:", err));
});

// ---------------------- Core webhook processing ------------------------
async function processWebhookSafely(body) {
  try {
    const entry = body.entry?.[0];
    if (!entry) return;
    const messages = entry.changes?.[0]?.value?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return;

    let flow = getChatFlow();
    if (!flow || flow.length === 0) flow = await loadFlowFromGoogleSheet();

    for (const msg of messages) {
      try {
        const phone = msg.from;
        const text = msg.text?.body || msg?.interactive?.button_reply?.title || "";
        const ctaId = msg.button?.payload || msg?.interactive?.button_reply?.id || null;

        let nodeToSend = null;

        // CTA id
        if (ctaId) {
          const result = getNodeByCtaId(ctaId);
          if (result) nodeToSend = flow.find(n => n.node_id === result.next_id) || result.node;
        }

        // Exact/fuzzy keyword match
        if (!nodeToSend && text) nodeToSend = getNodeByExactOrFuzzy(text);

        // Gemini AI fallback
        if (!nodeToSend && text) {
          const aiText = await getAIResponse(text);
          if (aiText) nodeToSend = { text: aiText, ctas: [], media_url: null };
        }

        // Final fallback
        if (!nodeToSend) nodeToSend = flow.find(n => n.type === 'fallback') || FALLBACK_NODE;

        await sendWhatsAppMessage(phone, nodeToSend.text, nodeToSend.ctas || [], nodeToSend.media_url || null);
      } catch (innerErr) {
        console.error("Message processing error:", innerErr);
        try { if (msg?.from) await sendWhatsAppMessage(msg.from, FALLBACK_NODE.text, []); } catch {}
      }
    }
  } catch (err) {
    console.error("processWebhookSafely top-level error:", err);
  }
}

// ---------------------- Admin helpers ------------------------
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/flow', (req, res) => res.json({ flow: getChatFlow(), rows: getChatFlow().length }));
app.get('/reload-flow', async (req, res) => { const flow = await loadFlowFromGoogleSheet(); res.json({ reloaded: true, rows: flow.length }); });

// ---------------------- Startup ------------------------
(async () => {
  try {
    console.log("Starting WhatsApp webhook server...");
    await ensurePeriodicLoad();
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();












// // index.js - Avasar WhatsApp webhook with Gemini AI fallback
// // --------------------------------------------------
// // ENV needed:
// //  - META_VERIFY_TOKEN        (for GET verification)
// //  - WHATSAPP_TOKEN           (graph api bearer token) - optional if not sending messages
// //  - WHATSAPP_PHONE_ID        (whatsapp phone id used by Graph API) - optional
// //  - GOOGLE_SHEET_ID          (sheet id for loading flow)
// //  - GEMINI_API_KEY           (for AI fallback)
// //  - SHEET_REFRESH_SECONDS    (optional, default 300)
// // --------------------------------------------------

// require('dotenv').config();
// const express = require('express');
// const NodeCache = require('node-cache');
// const Papa = require('papaparse');
// const stringSimilarity = require('string-similarity');

// const app = express();
// app.use(express.json({ limit: "20mb" }));

// // Universal fetch: global or node-fetch
// let fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
// if (!fetcher) fetcher = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// // Config
// const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "mySuperSecret123!@";
// const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || null;
// const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || null;
// const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || null;
// const SHEET_REFRESH_SECONDS = Number(process.env.SHEET_REFRESH_SECONDS || 300);
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;

// const flowCache = new NodeCache({ stdTTL: SHEET_REFRESH_SECONDS, checkperiod: 60 });

// // Fallback node
// const FALLBACK_NODE = {
//   node_id: "fallback",
//   type: "fallback",
//   text: "Welcome to Avasar, I'm Avasar bot, in development today.",
//   ctas: []
// };

// // ---------------------- Google Sheet CSV loader ------------------------
// async function loadFlowFromGoogleSheet() {
//   if (!GOOGLE_SHEET_ID) {
//     console.warn("No GOOGLE_SHEET_ID configured. Using fallback flow only.");
//     flowCache.set("chatFlow", [FALLBACK_NODE]);
//     return [FALLBACK_NODE];
//   }

//   const csvUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`;
//   console.log("Loading Google Sheet CSV:", csvUrl);

//   try {
//     const resp = await fetcher(csvUrl, { timeout: 20000 });
//     if (!resp || typeof resp.text !== "function") throw new Error("fetch did not return expected response");
//     if (!resp.ok) throw new Error(`Google sheet HTTP ${resp.status}`);

//     const csvText = await resp.text();
//     if (!csvText || csvText.length < 10) throw new Error("CSV appears empty");

//     const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: h => h?.trim() });
//     if (parsed.errors?.length) console.warn("Sheet parse warnings/errors:", parsed.errors.slice(0,3));

//     const rows = parsed.data.map(r => {
//       const node = {
//         node_id: (r.node_id || "").toString(),
//         type: (r.type || "").toString(),
//         text: (r.text || "").toString(),
//         keyword: (r.keyword || "").toString(),
//         media_url: (r.media_url || "").toString(),
//         raw: r,
//         ctas: []
//       };
//       for (let i = 1; i <= 5; i++) {
//         const txt = r[`cta${i}`];
//         const id = r[`cta${i}_id`] || r[`cta${i}_payload`];
//         const next = r[`cta${i}_next_id`];
//         if (txt && id) node.ctas.push({ text: txt.toString(), id: id.toString(), next_id: next ? next.toString() : null });
//       }
//       return node;
//     });

//     const flow = rows.length ? rows : [FALLBACK_NODE];
//     flowCache.set("chatFlow", flow);
//     console.log(`Flow loaded: ${flow.length} nodes`);
//     return flow;

//   } catch (err) {
//     console.error("Error loading Google Sheet:", err?.message || err);
//     if (!flowCache.get("chatFlow")) flowCache.set("chatFlow", [FALLBACK_NODE]);
//     return flowCache.get("chatFlow");
//   }
// }

// // Periodic reload
// async function ensurePeriodicLoad() {
//   await loadFlowFromGoogleSheet();
//   setInterval(() => loadFlowFromGoogleSheet().catch(e => console.error("Periodic reload failed:", e)), Math.max(30, SHEET_REFRESH_SECONDS) * 1000);
// }

// // ---------------------- Chat flow helpers ------------------------
// function getChatFlow() {
//   const f = flowCache.get("chatFlow");
//   return Array.isArray(f) ? f : [FALLBACK_NODE];
// }

// function getNodeByCtaId(ctaId) {
//   const flow = getChatFlow();
//   for (const node of flow) {
//     if (Array.isArray(node.ctas)) {
//       const c = node.ctas.find(x => x.id === ctaId);
//       if (c) return { node, next_id: c.next_id };
//     }
//   }
//   return null;
// }

// // Multi-tier keyword match: exact → fuzzy
// function getNodeByExactOrFuzzy(text) {
//   if (!text) return null;
//   const flow = getChatFlow();

//   // Exact match
//   const exact = flow.find(n => n.keyword && n.keyword.toLowerCase() === text.toLowerCase());
//   if (exact) return exact;

//   // Fuzzy match
//   const keywords = flow.map(n => n.keyword || "");
//   const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(text, keywords);
//   if (bestMatch.rating > 0.6) return flow[bestMatchIndex];

//   return null;
// }

// // Gemini AI fallback
// async function getAIResponse(message) {
//   if (!GEMINI_API_KEY || !message) return null;
//   try {
//     const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
//     const payload = { prompt: `Reply to: "${message}" in under 600 characters.`, maxOutputTokens: 300 };
//     const res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
//     const json = await res.json();
//     return json?.candidates?.[0]?.output || null;
//   } catch (err) {
//     console.error("Gemini AI error:", err?.message || err);
//     return null;
//   }
// }

// // ---------------------- WhatsApp sender ------------------------
// async function sendWhatsAppMessage(phoneNumber, text, ctas = [], media = null) {
//   if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return null;

//   const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
//   const body = { messaging_product: "whatsapp", to: phoneNumber, type: media ? "image" : (ctas.length ? "interactive" : "text") };

//   if (media) body.image = { link: media };
//   else if (ctas.length) body.interactive = { type: "button", body: { text: text || "Choose an option" }, action: { buttons: ctas.map(c => ({ type: "reply", reply: { id: c.id, title: c.text } })) } } ;
//   else body.text = { body: text || FALLBACK_NODE.text };

//   try {
//     const res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WHATSAPP_TOKEN}` }, body: JSON.stringify(body) });
//     const json = await res.json();
//     console.log("WhatsApp send response:", json);
//     return json;
//   } catch (err) {
//     console.error("WhatsApp send error:", err?.message || err);
//     return null;
//   }
// }

// // ---------------------- Webhook GET / verification ------------------------
// app.get('/', (req, res) => {
//   const mode = req.query['hub.mode'];
//   const token = req.query['hub.verify_token'];
//   const challenge = req.query['hub.challenge'];
//   if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
//   return res.status(403).send("Verification token mismatch");
// });

// // ---------------------- Webhook POST ------------------------
// app.post(['/', '/webhook'], (req, res) => {
//   res.sendStatus(200); // immediate 200
//   processWebhookSafely(req.body).catch(err => console.error("Async processing error:", err));
// });

// // ---------------------- Core webhook processing ------------------------
// async function processWebhookSafely(body) {
//   try {
//     const entry = body.entry?.[0];
//     if (!entry) return;
//     const messages = entry.changes?.[0]?.value?.messages || [];
//     if (!Array.isArray(messages) || messages.length === 0) return;

//     let flow = getChatFlow();
//     if (!flow || flow.length === 0) flow = await loadFlowFromGoogleSheet();

//     for (const msg of messages) {
//       try {
//         const phone = msg.from;
//         const text = msg.text?.body || msg?.interactive?.button_reply?.title || "";
//         const ctaId = msg.button?.payload || msg?.interactive?.button_reply?.id || null;

//         let nodeToSend = null;

//         // CTA id
//         if (ctaId) {
//           const result = getNodeByCtaId(ctaId);
//           if (result) nodeToSend = flow.find(n => n.node_id === result.next_id) || result.node;
//         }

//         // Exact/fuzzy keyword match
//         if (!nodeToSend && text) nodeToSend = getNodeByExactOrFuzzy(text);

//         // Gemini AI fallback
//         if (!nodeToSend && text) {
//           const aiText = await getAIResponse(text);
//           if (aiText) nodeToSend = { text: aiText, ctas: [], media_url: null };
//         }

//         // Final fallback
//         if (!nodeToSend) nodeToSend = flow.find(n => n.type === 'fallback') || FALLBACK_NODE;

//         await sendWhatsAppMessage(phone, nodeToSend.text, nodeToSend.ctas || [], nodeToSend.media_url || null);
//       } catch (innerErr) {
//         console.error("Message processing error:", innerErr);
//         try { if (msg?.from) await sendWhatsAppMessage(msg.from, FALLBACK_NODE.text, []); } catch {}
//       }
//     }
//   } catch (err) {
//     console.error("processWebhookSafely top-level error:", err);
//   }
// }

// // ---------------------- Admin helpers ------------------------
// app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
// app.get('/flow', (req, res) => res.json({ flow: getChatFlow(), rows: getChatFlow().length }));
// app.get('/reload-flow', async (req, res) => { const flow = await loadFlowFromGoogleSheet(); res.json({ reloaded: true, rows: flow.length }); });

// // ---------------------- Startup ------------------------
// (async () => {
//   try {
//     console.log("Starting Avasar webhook server...");
//     await ensurePeriodicLoad();
//     const PORT = process.env.PORT || 8080;
//     app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
//   } catch (err) {
//     console.error("Startup error:", err);
//     process.exit(1);
//   }
// })();





























// // // index.js - Avasar WhatsApp webhook (Cloud Run ready)
// // // --------------------------------------------------
// // // ENV needed:
// // //  - META_VERIFY_TOKEN        (for GET verification)
// // //  - WHATSAPP_TOKEN           (graph api bearer token) - optional if not sending messages
// // //  - WHATSAPP_PHONE_ID        (whatsapp phone id used by Graph API) - optional
// // //  - GOOGLE_SHEET_ID          (sheet id for loading flow)
// // //  - SHEET_REFRESH_SECONDS    (optional, default 300)
// // // --------------------------------------------------

// // require('dotenv').config();
// // const express = require('express');
// // const NodeCache = require('node-cache');
// // const Papa = require('papaparse');

// // const app = express();

// // // Body size safe for media/webhooks
// // app.use(express.json({ limit: "20mb" }));

// // // Universal fetch: use global if available else dynamic import node-fetch
// // let fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
// // if (!fetcher) {
// //   fetcher = (...args) =>
// //     import('node-fetch').then(({ default: f }) => f(...args));
// // }

// // // Config & cache
// // const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "mySuperSecret123!@";
// // const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || null;
// // const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || null;
// // const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || null;
// // const SHEET_REFRESH_SECONDS = Number(process.env.SHEET_REFRESH_SECONDS || 300);

// // const flowCache = new NodeCache({ stdTTL: SHEET_REFRESH_SECONDS, checkperiod: 60 });

// // // Fallback node
// // const FALLBACK_NODE = {
// //   node_id: "fallback",
// //   type: "fallback",
// //   text: "Welcome to Avasar, I'm Avasar bot, in development today.",
// //   ctas: []
// // };

// // // ---------------------- Google Sheet CSV loader ------------------------
// // async function loadFlowFromGoogleSheet() {
// //   if (!GOOGLE_SHEET_ID) {
// //     console.warn("No GOOGLE_SHEET_ID configured. Using fallback flow only.");
// //     flowCache.set("chatFlow", [FALLBACK_NODE]);
// //     return [FALLBACK_NODE];
// //   }

// //   const csvUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`;
// //   console.log("Loading Google Sheet CSV:", csvUrl);

// //   try {
// //     const resp = await fetcher(csvUrl, { timeout: 20000 });
// //     if (!resp || typeof resp.text !== "function") {
// //       throw new Error("fetch did not return expected response object");
// //     }

// //     if (!resp.ok) {
// //       throw new Error(`Google sheet HTTP ${resp.status}`);
// //     }

// //     const csvText = await resp.text();

// //     if (!csvText || csvText.length < 10) {
// //       throw new Error("CSV appears empty");
// //     }

// //     const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: h => h?.trim() });
// //     if (parsed.errors && parsed.errors.length) {
// //       console.warn("Sheet parse warnings/errors:", parsed.errors.slice(0,3));
// //     }

// //     // Map CSV rows to flow nodes (expecting columns like node_id, type, text, keyword, media_url, cta1, cta1_id, cta1_next_id, ...)
// //     const rows = parsed.data.map(r => {
// //       const node = {
// //         node_id: (r.node_id || "").toString(),
// //         type: (r.type || "").toString(),
// //         text: (r.text || "").toString(),
// //         keyword: (r.keyword || "").toString(),
// //         media_url: (r.media_url || "").toString(),
// //         raw: r,
// //         ctas: []
// //       };

// //       for (let i = 1; i <= 5; i++) {
// //         const txt = r[`cta${i}`];
// //         const id = r[`cta${i}_id`] || r[`cta${i}_payload`];
// //         const next = r[`cta${i}_next_id`];
// //         if (txt && id) {
// //           node.ctas.push({
// //             text: txt.toString(),
// //             id: id.toString(),
// //             next_id: next ? next.toString() : null
// //           });
// //         }
// //       }
// //       return node;
// //     });

// //     // If result empty, keep fallback
// //     const flow = rows.length ? rows : [FALLBACK_NODE];
// //     flowCache.set("chatFlow", flow);
// //     console.log(`Flow loaded: ${flow.length} nodes`);
// //     return flow;

// //   } catch (err) {
// //     console.error("Error loading Google Sheet:", err && err.message ? err.message : err);
// //     // keep previous cache if any, else set fallback
// //     if (!flowCache.get("chatFlow")) flowCache.set("chatFlow", [FALLBACK_NODE]);
// //     return flowCache.get("chatFlow");
// //   }
// // }

// // // schedule periodic reload
// // async function ensurePeriodicLoad() {
// //   await loadFlowFromGoogleSheet();
// //   setInterval(() => {
// //     loadFlowFromGoogleSheet().catch(e => console.error("Periodic sheet reload failed:", e));
// //   }, Math.max(30, SHEET_REFRESH_SECONDS) * 1000);
// // }

// // // ---------------------- Chat flow helpers ------------------------
// // function getChatFlow() {
// //   const f = flowCache.get("chatFlow");
// //   return Array.isArray(f) ? f : [FALLBACK_NODE];
// // }

// // function getNodeByCtaId(ctaId) {
// //   const flow = getChatFlow();
// //   for (const node of flow) {
// //     if (Array.isArray(node.ctas)) {
// //       const c = node.ctas.find(x => x.id === ctaId);
// //       if (c) return { node, next_id: c.next_id };
// //     }
// //   }
// //   return null;
// // }

// // function getNodeByKeyword(message) {
// //   if (!message) return null;
// //   const flow = getChatFlow();
// //   for (const node of flow) {
// //     if (node.type !== 'interactive' && node.keyword) {
// //       try {
// //         if (message.toLowerCase().includes(node.keyword.toLowerCase())) return node;
// //       } catch (_) {}
// //     }
// //   }
// //   return null;
// // }

// // // ---------------------- WhatsApp sender (safe) ------------------------
// // async function sendWhatsAppMessage(phoneNumber, text, ctas = [], media = null) {
// //   if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
// //     console.warn("WhatsApp credentials not configured; skipping send. To enable set WHATSAPP_TOKEN & WHATSAPP_PHONE_ID.");
// //     return null;
// //   }

// //   const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
// //   const body = {
// //     messaging_product: "whatsapp",
// //     to: phoneNumber,
// //     type: media ? "image" : (ctas && ctas.length ? "interactive" : "text")
// //   };

// //   if (media) {
// //     body.image = { link: media };
// //   } else if (ctas && ctas.length) {
// //     body.interactive = {
// //       type: "button",
// //       body: { text: text || "Choose an option" },
// //       action: { buttons: ctas.map(c => ({ type: "reply", reply: { id: c.id, title: c.text } })) }
// //     };
// //   } else {
// //     body.text = { body: text || FALLBACK_NODE.text };
// //   }

// //   try {
// //     const res = await fetcher(url, {
// //       method: "POST",
// //       headers: {
// //         "Content-Type": "application/json",
// //         "Authorization": `Bearer ${WHATSAPP_TOKEN}`
// //       },
// //       body: JSON.stringify(body)
// //     });

// //     const json = await res.json();
// //     console.log("WhatsApp send response:", json);
// //     return json;
// //   } catch (err) {
// //     console.error("WhatsApp send error:", err && err.message ? err.message : err);
// //     return null;
// //   }
// // }

// // // ---------------------- Meta verification GET / ------------------------
// // app.get('/', (req, res) => {
// //   const mode = req.query['hub.mode'];
// //   const token = req.query['hub.verify_token'];
// //   const challenge = req.query['hub.challenge'];

// //   console.log("META VERIFY REQUEST:", { mode, token: !!token, challenge: !!challenge });

// //   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// //     console.log("Webhook verified - sending challenge");
// //     return res.status(200).send(challenge);
// //   }

// //   return res.status(403).send("Verification token mismatch");
// // });

// // // ---------------------- Accept POST / root (some setups send to /) -------------
// // // Always return 200 immediately to satisfy Meta; process body safely afterwards.
// // app.post('/', (req, res) => {
// //   // Send 200 immediately as Meta expects quick 200
// //   res.sendStatus(200);

// //   // Process the webhook asynchronously but catch errors
// //   processWebhookSafely(req.body).catch(err => console.error("Async processing error:", err));
// // });

// // // Also expose explicit /webhook route
// // app.post('/webhook', (req, res) => {
// //   // For clients calling /webhook directly, still respond 200 quick
// //   res.sendStatus(200);
// //   processWebhookSafely(req.body).catch(err => console.error("Async processing error:", err));
// // });

// // // ---------------------- Core webhook processing (safe) ------------------------
// // async function processWebhookSafely(body) {
// //   try {
// //     if (!body) {
// //       console.warn("Empty webhook body received");
// //       return;
// //     }

// //     // Typical WhatsApp webhook structure: body.entry[0].changes[0].value.messages[]
// //     const entry = body.entry?.[0];
// //     if (!entry) {
// //       console.log("No entry in webhook; nothing to do.");
// //       return;
// //     }

// //     const messages = entry.changes?.[0]?.value?.messages || [];
// //     if (!Array.isArray(messages) || messages.length === 0) {
// //       console.log("No messages found in webhook entry");
// //       return;
// //     }

// //     // Ensure chat flow available
// //     let flow = getChatFlow();
// //     if (!flow || flow.length === 0) {
// //       console.log("Flow empty - attempting reload synchronously");
// //       flow = await loadFlowFromGoogleSheet();
// //     }

// //     for (const msg of messages) {
// //       try {
// //         const phone = msg.from;
// //         const text = msg.text?.body || msg?.interactive?.button_reply?.title || "";
// //         // button payload or reply id (varies)
// //         const ctaId = msg.button?.payload || msg?.interactive?.button_reply?.id || null;

// //         // Determine node to send
// //         let nodeToSend = null;

// //         if (ctaId) {
// //           const result = getNodeByCtaId(ctaId);
// //           if (result) {
// //             // prefer next_id if present
// //             nodeToSend = flow.find(n => n.node_id === result.next_id) || result.node;
// //           }
// //         }

// //         if (!nodeToSend && text) {
// //           nodeToSend = getNodeByKeyword(text);
// //         }

// //         if (!nodeToSend) {
// //           nodeToSend = flow.find(n => n.type === 'fallback') || FALLBACK_NODE;
// //         }

// //         // Send response (do not block other messages)
// //         await sendWhatsAppMessage(phone, nodeToSend.text, nodeToSend.ctas || [], nodeToSend.media_url || null);
// //       } catch (innerErr) {
// //         console.error("Message processing error (single message):", innerErr);
// //         // Attempt to send fallback greeting to the user if we have number
// //         try {
// //           const phoneFallback = msg?.from;
// //           if (phoneFallback) {
// //             await sendWhatsAppMessage(phoneFallback, FALLBACK_NODE.text, []);
// //           }
// //         } catch (sendErr) {
// //           console.error("Failed to send fallback after message processing error:", sendErr);
// //         }
// //       }
// //     }
// //   } catch (err) {
// //     console.error("processWebhookSafely top-level error:", err);
// //   }
// // }

// // // ---------------------- Admin helpers ------------------------
// // app.get('/health', (req, res) => {
// //   res.json({ ok: true, ts: new Date().toISOString() });
// // });

// // app.get('/flow', (req, res) => {
// //   res.json({ flow: getChatFlow(), rows: getChatFlow().length });
// // });

// // app.get('/reload-flow', async (req, res) => {
// //   const flow = await loadFlowFromGoogleSheet();
// //   res.json({ reloaded: true, rows: (flow || []).length });
// // });

// // // ---------------------- Startup ------------------------
// // (async () => {
// //   try {
// //     console.log("Starting Avasar webhook server...");
// //     await ensurePeriodicLoad();
// //     const PORT = process.env.PORT || 8080;
// //     app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
// //   } catch (err) {
// //     console.error("Startup error:", err);
// //     process.exit(1);
// //   }
// // })();
























// // // // index.js
// // // const express = require('express');
// // // const { Firestore } = require('@google-cloud/firestore');
// // // const fetch = require('node-fetch');   // npm i node-fetch@2

// // // const app = express();
// // // app.use(express.json({ limit: '10mb' }));

// // // // ---------- Firestore ----------
// // // const db = new Firestore();

// // // // ---------- Tokens ----------
// // // const VERIFY_TOKEN = 'mySuperSecret123!@';      
// // // const SCRIPT_TOKEN = 'your123@655';

// // // // ---------- Python Call Agent URL ----------
// // // const PYTHON_CALL_AGENT_URL =
// // //   process.env.PYTHON_CALL_AGENT_URL ||
// // //   "https://python-agent-995267578420.asia-south1.run.app/";   // <-- REPLACE AFTER DEPLOYING PYTHON SERVICE

// // // // ---------- Helper ----------
// // // function getIndiaTimestamp() {
// // //   return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
// // // }

// // // // ---------- Log raw payload to Firestore ----------
// // // async function logRawData(data, ts) {
// // //   try {
// // //     await db.collection('rawData').add({
// // //       data: JSON.stringify(data),
// // //       timestamp: ts,
// // //       logType: 'Raw Data'
// // //     });
// // //   } catch (e) {
// // //     console.error('Firestore log error:', e);
// // //   }
// // // }

// // // // ---------- Forward payload to Google Apps Script ----------
// // // async function forwardToScript(data) {
// // //   const scriptUrl = 'https://script.google.com/macros/s/AKfycby-01RpkLXTBtCbV0IKY5CFzFOL6EdoslHpG_hpbgSj1PwuFyWWsS3RkOcWZdARsM0J/exec';

// // //   try {
// // //     await fetch(scriptUrl, {
// // //       method: 'POST',
// // //       headers: {
// // //         'Content-Type': 'application/json',
// // //         'Authorization': `Bearer ${SCRIPT_TOKEN}`
// // //       },
// // //       body: JSON.stringify(data)
// // //     });
// // //   } catch (e) {
// // //     console.error('Forward error:', e);
// // //   }
// // // }

// // // // =============================================================
// // // // ==================== GET – Verification ======================
// // // // =============================================================
// // // app.get('/', (req, res) => {
// // //   const mode = req.query['hub.mode'];
// // //   const token = req.query['hub.verify_token'];
// // //   const challenge = req.query['hub.challenge'];

// // //   console.log('VERIFY →', { mode, token, expected: VERIFY_TOKEN });

// // //   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // //     console.log('SUCCESS → returning challenge:', challenge);
// // //     return res.send(challenge);
// // //   }

// // //   console.log('FAILED → token mismatch');
// // //   return res.status(403).send('Error: Token mismatch');
// // // });

// // // // =============================================================
// // // // ===================== POST – Webhook =========================
// // // // =============================================================
// // // app.post('/', async (req, res) => {
// // //   const data = req.body;
// // //   const ts = getIndiaTimestamp();

// // //   try {
// // //     // 1. Log to Firestore
// // //     await logRawData(data, ts);

// // //     // 2. Forward to Apps Script
// // //     await forwardToScript(data);

// // //     // 3. Check if the webhook contains CALL events
// // //     if (
// // //       data.entry &&
// // //       data.entry[0].changes &&
// // //       data.entry[0].changes[0].value &&
// // //       data.entry[0].changes[0].value.calls
// // //     ) {
// // //       const calls = data.entry[0].changes[0].value.calls;

// // //       for (const call of calls) {
// // //         console.log("Forwarding call event to Python AIORTC service...");

// // //         fetch(PYTHON_CALL_AGENT_URL, {
// // //           method: "POST",
// // //           headers: { "Content-Type": "application/json" },
// // //           body: JSON.stringify(call),
// // //         })
// // //           .then(() => console.log("Call forwarded to Python service"))
// // //           .catch(err => console.error("Python Service Error:", err));
// // //       }
// // //     }

// // //     // 4. Respond quickly to WhatsApp
// // //     res.status(200).send('OK');

// // //   } catch (e) {
// // //     console.error('POST error:', e);

// // //     try {
// // //       await db.collection('logs').add({ error: e.message, ts });
// // //     } catch (_) {}

// // //     res.status(500).send('Error');
// // //   }
// // // });

// // // // =============================================================
// // // // ====================== Start Server ==========================
// // // // =============================================================
// // // const PORT = Number(process.env.PORT) || 8080;
// // // app.listen(PORT, '0.0.0.0', () => {
// // //   console.log(`Server STARTED on port ${PORT}`);
// // //   console.log('Verify token :', VERIFY_TOKEN);
// // //   console.log('Script token :', SCRIPT_TOKEN);
// // //   console.log('Python Call Agent :', PYTHON_CALL_AGENT_URL);
// // // });


















// // // // // index.js
// // // // const express = require('express');
// // // // const { Firestore } = require('@google-cloud/firestore');
// // // // const fetch = require('node-fetch');   // <-- Cloud Run में fetch नहीं होता → npm i node-fetch@2

// // // // const app = express();
// // // // app.use(express.json({ limit: '10mb' }));

// // // // // ---------- 1. Firestore ----------
// // // // const db = new Firestore();

// // // // // ---------- 2. Verify token (hard-coded for test) ----------
// // // // const VERIFY_TOKEN = 'mySuperSecret123!@';          // GET verification
// // // // const SCRIPT_TOKEN = 'your123@655';              // POST to Apps Script

// // // // // ---------- 3. Helper ----------
// // // // function getIndiaTimestamp() {
// // // //   return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
// // // // }

// // // // // ---------- 4. Log raw payload to Firestore ----------
// // // // async function logRawData(data, ts) {
// // // //   try {
// // // //     await db.collection('rawData').add({
// // // //       data: JSON.stringify(data),
// // // //       timestamp: ts,
// // // //       logType: 'Raw Data'
// // // //     });
// // // //   } catch (e) {
// // // //     console.error('Firestore log error:', e);
// // // //   }
// // // // }

// // // // // ---------- 5. Forward payload to Google Apps Script ----------
// // // // async function forwardToScript(data) {
// // // //   const scriptUrl = 'https://script.google.com/macros/s/AKfycby-01RpkLXTBtCbV0IKY5CFzFOL6EdoslHpG_hpbgSj1PwuFyWWsS3RkOcWZdARsM0J/exec';
// // // //   try {
// // // //     await fetch(scriptUrl, {
// // // //       method: 'POST',
// // // //       headers: {
// // // //         'Content-Type': 'application/json',
// // // //         'Authorization': `Bearer ${SCRIPT_TOKEN}`   // token header
// // // //       },
// // // //       body: JSON.stringify(data)
// // // //     });
// // // //   } catch (e) {
// // // //     console.error('Forward error:', e);
// // // //   }
// // // // }

// // // // // =============================================================
// // // // // ====================  GET – Verification  ===================
// // // // // =============================================================
// // // // app.get('/', (req, res) => {
// // // //   const mode = req.query['hub.mode'];
// // // //   const token = req.query['hub.verify_token'];
// // // //   const challenge = req.query['hub.challenge'];

// // // //   console.log('VERIFY →', { mode, token, expected: VERIFY_TOKEN });

// // // //   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // // //     console.log('SUCCESS → returning challenge:', challenge);
// // // //     return res.send(challenge);
// // // //   }

// // // //   console.log('FAILED → token mismatch');
// // // //   return res.status(403).send('Error: Token mismatch');
// // // // });

// // // // // =============================================================
// // // // // ====================  POST – Webhook  =======================
// // // // // =============================================================
// // // // app.post('/', async (req, res) => {
// // // //   const data = req.body;
// // // //   const ts = getIndiaTimestamp();

// // // //   try {
// // // //     // ---- 1. Log to Firestore (rawData) ----
// // // //     await logRawData(data, ts);

// // // //     // ---- 2. Forward to Apps Script (same payload) ----
// // // //     await forwardToScript(data);

// // // //     // ---- 200 OK for WhatsApp (must be fast) ----
// // // //     res.status(200).send('OK');
// // // //   } catch (e) {
// // // //     console.error('POST error:', e);
// // // //     // still try to log error
// // // //     try { await db.collection('logs').add({ error: e.message, ts }); } catch (_) {}
// // // //     res.status(500).send('Error');
// // // //   }
// // // // });

// // // // // =============================================================
// // // // // ====================  Start Server  =========================
// // // // // =============================================================
// // // // const PORT = Number(process.env.PORT) || 8080;
// // // // app.listen(PORT, '0.0.0.0', () => {
// // // //   console.log(`Server STARTED on port ${PORT}`);
// // // //   console.log('Verify token :', VERIFY_TOKEN);
// // // //   console.log('Script token :', SCRIPT_TOKEN);
// // // // });















// // // // // const express = require('express');
// // // // // const { Firestore } = require('@google-cloud/firestore');
// // // // // const { GoogleGenerativeAI } = require('@google/generative-ai');

// // // // // const app = express();
// // // // // app.use(express.json());

// // // // // // Initialize Firestore (auto-uses Application Default Credentials)
// // // // // const db = new Firestore();

// // // // // // Load secrets (in prod, use Secret Manager; for dev, env vars)
// // // // // const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your-verify-token'; // From Secret Manager
// // // // // const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'your-gemini-key'; // From Vertex AI

// // // // // const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// // // // // // Helper: Get India Timestamp
// // // // // function getIndiaTimestamp() {
// // // // //   return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
// // // // // }

// // // // // // Log to Firestore (replacement for logData)
// // // // // async function logData(collectionName, data, timestamp, logType) {
// // // // //   try {
// // // // //     await db.collection(collectionName).add({
// // // // //       data: JSON.stringify(data),
// // // // //       timestamp,
// // // // //       logType
// // // // //     });
// // // // //   } catch (error) {
// // // // //     console.error('Error logging:', error);
// // // // //   }
// // // // // }

// // // // // // Handle Chatbot with Gemini (replacement for handleChatbotBySheetAndGemini)
// // // // // async function handleChatbotBySheetAndGemini(changes) {
// // // // //   if (!changes.messages || changes.messages.length === 0) return;

// // // // //   const message = changes.messages[0];
// // // // //   if (message.type !== 'text') return; // Only handle text for simplicity

// // // // //   const userMessage = message.text.body;
// // // // //   const phone = message.from;

// // // // //   try {
// // // // //     const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
// // // // //     const result = await model.generateContent(userMessage);
// // // // //     const responseText = result.response.text();

// // // // //     // Send response back (implement sendWhatsAppMessage function if needed)
// // // // //     console.log(`Chatbot response to ${phone}: ${responseText}`);
// // // // //     await logOutgoingMessage(phone, responseText, 'text'); // Log
// // // // //   } catch (error) {
// // // // //     await logData('logs', error.message, getIndiaTimestamp(), 'Error in chatbot');
// // // // //   }
// // // // // }

// // // // // // Log outgoing message (to 'incoming' collection)
// // // // // async function logOutgoingMessage(toPhone, messageText, messageType) {
// // // // //   const timestamp = getIndiaTimestamp();
// // // // //   const unixTimestamp = Math.floor(Date.now() / 1000);
// // // // //   const businessNumber = process.env.BUSINESS_PHONE_NUMBER || 'unknown';

// // // // //   await db.collection('incoming').add({
// // // // //     messageId: `BOT_${unixTimestamp}`,
// // // // //     timestamp: unixTimestamp,
// // // // //     sender: businessNumber,
// // // // //     receiver: toPhone,
// // // // //     senderName: 'Bot',
// // // // //     message: messageText,
// // // // //     messageType,
// // // // //     indiaTimestamp: timestamp,
// // // // //     displaySide: 'Right (Bot Side)'
// // // // //   });
// // // // // }

// // // // // // Handle Messages (stub; expand as needed)
// // // // // async function handleMessages(changes) {
// // // // //   // Your logic here (e.g., process messages)
// // // // //   console.log('Handling messages:', changes.messages);
// // // // // }

// // // // // // Handle Orders (stub; expand as needed)
// // // // // async function handleOrders(changes) {
// // // // //   // Your logic here (e.g., process orders)
// // // // //   console.log('Handling orders:', changes.order);
// // // // // }

// // // // // // // Webhook Verification (GET)
// // // // // // app.get('/', (req, res) => {
// // // // // //   const mode = req.query['hub.mode'];
// // // // // //   const token = req.query['hub.verify_token'];
// // // // // //   const challenge = req.query['hub.challenge'];

// // // // // //   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
// // // // // //     res.status(200).send(challenge);
// // // // // //   } else {
// // // // // //     res.status(403).send('Error: Token mismatch');
// // // // // //   }
// // // // // // });

// // // // // // app.get('/', (req, res) => {
// // // // // //   const mode = req.query['hub.mode'];
// // // // // //   const token = req.query['hub.verify_token'];
// // // // // //   const challenge = req.query['hub.challenge'];

// // // // // //   console.log('VERIFY →', { mode, token, expected: process.env.WEBHOOK_VERIFY_TOKEN });

// // // // // //   if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
// // // // // //     console.log('SUCCESS → returning:', challenge);
// // // // // //     return res.send(challenge);  // ← MUST be plain text, no HTML
// // // // // //   } else {
// // // // // //     console.log('FAILED → token mismatch');
// // // // // //     return res.status(403).send('Error: Token mismatch');
// // // // // //   }
// // // // // // });



// // // // // // ---------- GET – Webhook verification (with TEST MODE fallback) ----------
// // // // // app.get('/', (req, res) => {
// // // // //   const mode = req.query['hub.mode'];
// // // // //   const token = req.query['hub.verify_token'];
// // // // //   const challenge = req.query['hub.challenge'];

// // // // //   // === FALLBACK TOKEN FOR TESTING ===
// // // // //   //const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN || 'mySuperSecret123!@'; // fallback
// // // // //   const expectedToken = 'mySuperSecret123!@'; // fallback
// // // // //   const isTestMode = !process.env.WEBHOOK_VERIFY_TOKEN || process.env.NODE_ENV === 'test';

// // // // //   console.log('VERIFY →', {
// // // // //     mode,
// // // // //     token,
// // // // //     expected: expectedToken,
// // // // //     testMode: isTestMode ? 'YES (fallback used)' : 'NO (Secret Manager)',
// // // // //     source: process.env.WEBHOOK_VERIFY_TOKEN ? 'Secret Manager' : 'Fallback'
// // // // //   });

// // // // //   if (mode === 'subscribe' && token === expectedToken) {
// // // // //     console.log('SUCCESS → returning challenge:', challenge);
// // // // //     return res.send(challenge); // Plain text
// // // // //   } else {
// // // // //     console.log('FAILED → token mismatch');
// // // // //     return res.status(403).send('Error: Token mismatch');
// // // // //   }
// // // // // });




// // // // // // Webhook Handler (POST)
// // // // // app.post('/', async (req, res) => {
// // // // //   const data = req.body;
// // // // //   const timestamp = getIndiaTimestamp();

// // // // //   try {
// // // // //     if (data.entry && data.entry.length > 0) {
// // // // //       const entry = data.entry[0];
// // // // //       if (entry.changes && entry.changes.length > 0) {
// // // // //         const changes = entry.changes[0].value;

// // // // //         // Handle Chatbot
// // // // //         await handleChatbotBySheetAndGemini(changes);

// // // // //         // Log Raw Data
// // // // //         await logData('rawData', data, timestamp, 'Raw Data');

// // // // //         // Handle Messages & Orders
// // // // //         await handleMessages(changes);
// // // // //         await handleOrders(changes);
// // // // //       }
// // // // //     }
// // // // //     res.status(200).send('OK');
// // // // //   } catch (error) {
// // // // //     await logData('logs', error.message, timestamp, 'Critical Error');
// // // // //     res.status(500).send('Error');
// // // // //   }
// // // // // });

// // // // // const port = process.env.PORT || 8080;
// // // // // app.listen(port, () => {
// // // // //   console.log(`Server running on port ${port}`);
// // // // // });
