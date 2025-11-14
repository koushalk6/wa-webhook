// server.js
const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '10mb' })); // WhatsApp payloads can be large

// ---------- 1. SECRETS (Cloud Run mounts them) ----------
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const BUSINESS_PHONE = process.env.BUSINESS_PHONE_NUMBER?.trim();

// Crash fast if any secret is missing (dev only – prod will have them)
if (!VERIFY_TOKEN || !GEMINI_API_KEY || !BUSINESS_PHONE) {
  console.error('Missing required env vars:', {
    VERIFY_TOKEN: !!VERIFY_TOKEN,
    GEMINI_API_KEY: !!GEMINI_API_KEY,
    BUSINESS_PHONE: !!BUSINESS_PHONE,
  });
  process.exit(1);
}

// ---------- 2. Firestore & Gemini ----------
const db = new Firestore();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ---------- 3. Helpers ----------
function getIndiaTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function logData(collection, data, ts, type) {
  try {
    await db.collection(collection).add({
      data: JSON.stringify(data),
      timestamp: ts,
      logType: type,
    });
  } catch (e) {
    console.error('logData error:', e);
  }
}

// ---------- 4. Chatbot (Gemini) ----------
async function handleChatbot(changes) {
  if (!changes.messages?.length) return;
  const msg = changes.messages[0];
  if (msg.type !== 'text') return;

  const userText = msg.text.body;
  const from = msg.from;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(userText);
    const botReply = result.response.text();

    await logOutgoingMessage(from, botReply, 'text');
    console.log(`Bot → ${from}: ${botReply}`);
  } catch (e) {
    console.error('Chatbot error:', e);
    await logData('logs', e.message, getIndiaTimestamp(), 'Chatbot error');
  }
}

// ---------- 5. Log outgoing message ----------
async function logOutgoingMessage(to, text, type) {
  const ts = getIndiaTimestamp();
  const unix = Math.floor(Date.now() / 1000);
  await db.collection('incoming').add({
    messageId: `BOT_${unix}`,
    timestamp: unix,
    sender: BUSINESS_PHONE,
    receiver: to,
    senderName: 'Bot',
    message: text,
    messageType: type,
    indiaTimestamp: ts,
    displaySide: 'Right (Bot Side)',
  });
}

// ---------- 6. Stubs (expand later) ----------
async function handleMessages(changes) { /* … */ }
async function handleOrders(changes) { /* … */ }

// ---------- 7. GET – Webhook verification (DEBUG LOGS) ----------
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // ***** DEBUG – ALWAYS LOG *****
  console.log('=== VERIFICATION ATTEMPT ===');
  console.log('Received mode:', mode);
  console.log('Received token:', token);
  console.log('Expected token:', VERIFY_TOKEN);
  console.log('Challenge:', challenge);
  console.log('==============================');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('VERIFICATION SUCCESS');
    return res.status(200).send(challenge);
  }

  console.log('VERIFICATION FAILED – Token mismatch');
  return res.status(403).send('Error: Token mismatch');
});

// ---------- 8. POST – Webhook payload ----------
app.post('/', async (req, res) => {
  const data = req.body;
  const ts = getIndiaTimestamp();

  try {
    if (data.entry?.[0]?.changes?.[0]?.value) {
      const changes = data.entry[0].changes[0].value;

      await Promise.all([
        handleChatbot(changes),
        logData('rawData', data, ts, 'Raw Data'),
        handleMessages(changes),
        handleOrders(changes),
      ]);
    }
    res.status(200).send('OK'); // WhatsApp expects 200
  } catch (e) {
    console.error('POST error:', e);
    await logData('logs', e.message, ts, 'Critical Error');
    res.status(500).send('Error');
  }
});

// ---------- 9. Start server ----------
// ---------- 9. Start server ----------
const PORT = Number(process.env.PORT) || 8080;          // <-- 1. Number()
app.listen(PORT, '0.0.0.0', () => {                     // <-- 2. bind 0.0.0.0
  console.log(`Server STARTED on ${PORT}`);
  console.log('Secrets →', {
    VERIFY_TOKEN: !!VERIFY_TOKEN,
    GEMINI_API_KEY: !!GEMINI_API_KEY,
    BUSINESS_PHONE: !!BUSINESS_PHONE,
  });
});



// const express = require('express');
// const { Firestore } = require('@google-cloud/firestore');
// const { GoogleGenerativeAI } = require('@google/generative-ai');

// const app = express();
// app.use(express.json());

// // Initialize Firestore (auto-uses Application Default Credentials)
// const db = new Firestore();

// // Load secrets (in prod, use Secret Manager; for dev, env vars)
// const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your-verify-token'; // From Secret Manager
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'your-gemini-key'; // From Vertex AI

// const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// // Helper: Get India Timestamp
// function getIndiaTimestamp() {
//   return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
// }

// // Log to Firestore (replacement for logData)
// async function logData(collectionName, data, timestamp, logType) {
//   try {
//     await db.collection(collectionName).add({
//       data: JSON.stringify(data),
//       timestamp,
//       logType
//     });
//   } catch (error) {
//     console.error('Error logging:', error);
//   }
// }

// // Handle Chatbot with Gemini (replacement for handleChatbotBySheetAndGemini)
// async function handleChatbotBySheetAndGemini(changes) {
//   if (!changes.messages || changes.messages.length === 0) return;

//   const message = changes.messages[0];
//   if (message.type !== 'text') return; // Only handle text for simplicity

//   const userMessage = message.text.body;
//   const phone = message.from;

//   try {
//     const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
//     const result = await model.generateContent(userMessage);
//     const responseText = result.response.text();

//     // Send response back (implement sendWhatsAppMessage function if needed)
//     console.log(`Chatbot response to ${phone}: ${responseText}`);
//     await logOutgoingMessage(phone, responseText, 'text'); // Log
//   } catch (error) {
//     await logData('logs', error.message, getIndiaTimestamp(), 'Error in chatbot');
//   }
// }

// // Log outgoing message (to 'incoming' collection)
// async function logOutgoingMessage(toPhone, messageText, messageType) {
//   const timestamp = getIndiaTimestamp();
//   const unixTimestamp = Math.floor(Date.now() / 1000);
//   const businessNumber = process.env.BUSINESS_PHONE_NUMBER || 'unknown';

//   await db.collection('incoming').add({
//     messageId: `BOT_${unixTimestamp}`,
//     timestamp: unixTimestamp,
//     sender: businessNumber,
//     receiver: toPhone,
//     senderName: 'Bot',
//     message: messageText,
//     messageType,
//     indiaTimestamp: timestamp,
//     displaySide: 'Right (Bot Side)'
//   });
// }

// // Handle Messages (stub; expand as needed)
// async function handleMessages(changes) {
//   // Your logic here (e.g., process messages)
//   console.log('Handling messages:', changes.messages);
// }

// // Handle Orders (stub; expand as needed)
// async function handleOrders(changes) {
//   // Your logic here (e.g., process orders)
//   console.log('Handling orders:', changes.order);
// }

// // Webhook Verification (GET)
// app.get('/', (req, res) => {
//   const mode = req.query['hub.mode'];
//   const token = req.query['hub.verify_token'];
//   const challenge = req.query['hub.challenge'];

//   if (mode === 'subscribe' && token === VERIFY_TOKEN) {
//     res.status(200).send(challenge);
//   } else {
//     res.status(403).send('Error: Token mismatch');
//   }
// });

// // Webhook Handler (POST)
// app.post('/', async (req, res) => {
//   const data = req.body;
//   const timestamp = getIndiaTimestamp();

//   try {
//     if (data.entry && data.entry.length > 0) {
//       const entry = data.entry[0];
//       if (entry.changes && entry.changes.length > 0) {
//         const changes = entry.changes[0].value;

//         // Handle Chatbot
//         await handleChatbotBySheetAndGemini(changes);

//         // Log Raw Data
//         await logData('rawData', data, timestamp, 'Raw Data');

//         // Handle Messages & Orders
//         await handleMessages(changes);
//         await handleOrders(changes);
//       }
//     }
//     res.status(200).send('OK');
//   } catch (error) {
//     await logData('logs', error.message, timestamp, 'Critical Error');
//     res.status(500).send('Error');
//   }
// });

// const port = process.env.PORT || 8080;
// app.listen(port, () => {
//   console.log(`Server running on port ${port}`);
// });
