
const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// Initialize Firestore (auto-uses Application Default Credentials)
const db = new Firestore();

// Load secrets (in prod, use Secret Manager; for dev, env vars)
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your-verify-token'; // From Secret Manager
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'your-gemini-key'; // From Vertex AI

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Helper: Get India Timestamp
function getIndiaTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// Log to Firestore (replacement for logData)
async function logData(collectionName, data, timestamp, logType) {
  try {
    await db.collection(collectionName).add({
      data: JSON.stringify(data),
      timestamp,
      logType
    });
  } catch (error) {
    console.error('Error logging:', error);
  }
}

// Handle Chatbot with Gemini (replacement for handleChatbotBySheetAndGemini)
async function handleChatbotBySheetAndGemini(changes) {
  if (!changes.messages || changes.messages.length === 0) return;

  const message = changes.messages[0];
  if (message.type !== 'text') return; // Only handle text for simplicity

  const userMessage = message.text.body;
  const phone = message.from;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(userMessage);
    const responseText = result.response.text();

    // Send response back (implement sendWhatsAppMessage function if needed)
    console.log(`Chatbot response to ${phone}: ${responseText}`);
    await logOutgoingMessage(phone, responseText, 'text'); // Log
  } catch (error) {
    await logData('logs', error.message, getIndiaTimestamp(), 'Error in chatbot');
  }
}

// Log outgoing message (to 'incoming' collection)
async function logOutgoingMessage(toPhone, messageText, messageType) {
  const timestamp = getIndiaTimestamp();
  const unixTimestamp = Math.floor(Date.now() / 1000);
  const businessNumber = process.env.BUSINESS_PHONE_NUMBER || 'unknown';

  await db.collection('incoming').add({
    messageId: `BOT_${unixTimestamp}`,
    timestamp: unixTimestamp,
    sender: businessNumber,
    receiver: toPhone,
    senderName: 'Bot',
    message: messageText,
    messageType,
    indiaTimestamp: timestamp,
    displaySide: 'Right (Bot Side)'
  });
}

// Handle Messages (stub; expand as needed)
async function handleMessages(changes) {
  // Your logic here (e.g., process messages)
  console.log('Handling messages:', changes.messages);
}

// Handle Orders (stub; expand as needed)
async function handleOrders(changes) {
  // Your logic here (e.g., process orders)
  console.log('Handling orders:', changes.order);
}

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

// app.get('/', (req, res) => {
//   const mode = req.query['hub.mode'];
//   const token = req.query['hub.verify_token'];
//   const challenge = req.query['hub.challenge'];

//   console.log('VERIFY →', { mode, token, expected: process.env.WEBHOOK_VERIFY_TOKEN });

//   if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
//     console.log('SUCCESS → returning:', challenge);
//     return res.send(challenge);  // ← MUST be plain text, no HTML
//   } else {
//     console.log('FAILED → token mismatch');
//     return res.status(403).send('Error: Token mismatch');
//   }
// });



// ---------- GET – Webhook verification (with TEST MODE fallback) ----------
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // === FALLBACK TOKEN FOR TESTING ===
  //const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN || 'mySuperSecret123!@'; // fallback
  const expectedToken = 'mySuperSecret123!@'; // fallback
  const isTestMode = !process.env.WEBHOOK_VERIFY_TOKEN || process.env.NODE_ENV === 'test';

  console.log('VERIFY →', {
    mode,
    token,
    expected: expectedToken,
    testMode: isTestMode ? 'YES (fallback used)' : 'NO (Secret Manager)',
    source: process.env.WEBHOOK_VERIFY_TOKEN ? 'Secret Manager' : 'Fallback'
  });

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('SUCCESS → returning challenge:', challenge);
    return res.send(challenge); // Plain text
  } else {
    console.log('FAILED → token mismatch');
    return res.status(403).send('Error: Token mismatch');
  }
});




// Webhook Handler (POST)
app.post('/', async (req, res) => {
  const data = req.body;
  const timestamp = getIndiaTimestamp();

  try {
    if (data.entry && data.entry.length > 0) {
      const entry = data.entry[0];
      if (entry.changes && entry.changes.length > 0) {
        const changes = entry.changes[0].value;

        // Handle Chatbot
        await handleChatbotBySheetAndGemini(changes);

        // Log Raw Data
        await logData('rawData', data, timestamp, 'Raw Data');

        // Handle Messages & Orders
        await handleMessages(changes);
        await handleOrders(changes);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    await logData('logs', error.message, timestamp, 'Critical Error');
    res.status(500).send('Error');
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
