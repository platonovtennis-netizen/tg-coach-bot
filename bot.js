import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, doc, updateDoc, query, where } from "firebase/firestore";
import express from 'express';
import cors from 'cors';

// --- ENV CHECK ---
console.log('--- STARTING BOT ---');
if (!process.env.TELEGRAM_BOT_TOKEN) console.error("FATAL: TELEGRAM_BOT_TOKEN is missing!");
if (!process.env.VITE_FIREBASE_API_KEY) console.error("FATAL: VITE_FIREBASE_API_KEY is missing!");

// --- EXPRESS SERVER (REQUIRED FOR RENDER WEB SERVICE) ---
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Tennis Coach Bot is Running and Healthy!');
});

// Health check to keep instance alive via UptimeRobot
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const server = app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

// --- FIREBASE CONFIG ---
const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// --- BOT CONFIG ---
const token = process.env.TELEGRAM_BOT_TOKEN;
// Make sure to set WEB_APP_URL in Render env vars to your actual hosted URL
const webAppUrl = process.env.WEB_APP_URL; 

const bot = new TelegramBot(token, { polling: true });

// --- LISTEN FOR NOTIFICATIONS ---
console.log('Connecting to Firestore to listen for notifications...');

// We listen for 'pending' status.
const q = query(collection(db, "notification_queue"), where("status", "==", "pending"));

// onSnapshot automatically handles reconnection
const unsubscribe = onSnapshot(q, (snapshot) => {
  if (snapshot.empty) {
      // Useful log to see if connection is alive but just no data
      // console.log("No pending notifications at the moment."); 
  }

  snapshot.docChanges().forEach(async (change) => {
    if (change.type === "added") {
        const notif = change.doc.data();
        const docId = change.doc.id;
        
        console.log(`[NOTIF] Processing for ID: ${notif.telegram_id}`);

        try {
            await bot.sendMessage(notif.telegram_id, notif.message, {
                parse_mode: 'HTML'
            });

            // Update status to 'sent'
            await updateDoc(doc(db, "notification_queue", docId), {
                status: "sent",
                sent_at: new Date()
            });
            console.log(`[NOTIF] Success: ${docId}`);
        } catch (error) {
            console.error(`[NOTIF] Error sending to ${notif.telegram_id}:`, error.message);
            
            // Mark as error so we don't retry indefinitely
             await updateDoc(doc(db, "notification_queue", docId), {
                status: "error",
                error_message: error.message
            });
        }
    }
  });
}, (error) => {
    console.error("FATAL FIRESTORE LISTENER ERROR:", error);
});

// --- STANDARD BOT LOGIC ---

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/start') {
    await bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже, чтобы открыть приложение:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎾 Открыть приложение", web_app: { url: webAppUrl } }]
        ]
      }
    });
  }
});

bot.on('polling_error', (error) => {
  // Suppress harmless deprecation warnings if any
  if (error.code !== 'EFATAL') {
      // console.log(`[Polling Warning] ${error.code}`);
  } else {
      console.error(`[Polling Error] ${error.message}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close();
    bot.stopPolling();
    unsubscribe(); // Stop firestore listener
});
