import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin'; // <--- Использование Firebase Admin SDK
import { getFirestore, collection, onSnapshot, doc, updateDoc, query, where, serverTimestamp } from "firebase/firestore"; // Эта строка больше не нужна для инициализации, но может использоваться для типизации
import express from 'express';
import cors from 'cors';
import path from 'path'; // Для работы с путями к файлам
import fs from 'fs/promises'; // Для чтения файлов асинхронно


// --- ENV CHECK ---
console.log('--- STARTING BOT ---');
if (!process.env.TELEGRAM_BOT_TOKEN) console.error("FATAL: TELEGRAM_BOT_TOKEN is missing!");
// Вместо VITE_FIREBASE_API_KEY, теперь нужен путь к файлу сервисного аккаунта
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) console.error("FATAL: GOOGLE_APPLICATION_CREDENTIALS (path to service account key) is missing!");

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

// --- FIREBASE CONFIG (Используем Admin SDK) ---
// Загружаем ключ сервисного аккаунта
// PATH TO YOUR SERVICE ACCOUNT KEY FILE
// В продакшене, особенно на платформах вроде Render, можно указать
// полный путь к файлу, если вы его загрузили как часть деплоя,
// или хранить содержимое ключа как ENCODED_SERVICE_ACCOUNT_KEY в переменной окружения
// и декодировать его. Для простоты, здесь предполагается файл `serviceAccountKey.json`
// в корне проекта.
const serviceAccountPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (!serviceAccountPath) {
    console.error("FATAL: serviceAccountPath is not defined. Please set GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
}

let serviceAccount;
try {
    const serviceAccountJson = await fs.readFile(serviceAccountPath, 'utf8'); // Асинхронно читаем файл
    serviceAccount = JSON.parse(serviceAccountJson); // Парсим как JSON
    console.log('Service account key loaded successfully.');
} catch (e) {
    console.error(`FATAL: Failed to load service account key from ${serviceAccountPath}. Error:`, e.message);
    console.error("Please ensure GOOGLE_APPLICATION_CREDENTIALS points to a valid JSON service account key file.");
    process.exit(1);
}


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
  // Для Firestore не обязательно указывать databaseURL, но для Realtime Database это нужно:
  // databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore(); // <--- Теперь используем admin.firestore()

// --- BOT CONFIG ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEB_APP_URL;

const bot = new TelegramBot(token, { polling: true });

// --- LISTEN FOR NOTIFICATIONS ---
const notifQuery = db.collection("notification_queue").where("status", "==", "pending"); // <--- Используем admin.firestore().collection

console.log('Connecting to Firestore to listen for notifications...');

let unsubscribe = null;
let backoff = 1000; // ms
const MAX_BACKOFF = 60000;

function startFirestoreListener() {
  try {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  } catch (e) {
    console.warn('Error while unsubscribing previous listener:', e?.message || e);
  }

  unsubscribe = notifQuery.onSnapshot( // <--- Используем admin.firestore() snapshot
    (snapshot) => {
      backoff = 1000;

      if (snapshot.empty) {
          return;
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

                await db.collection("notification_queue").doc(docId).update({ // <--- Используем admin.firestore().collection
                    status: "sent",
                    sent_at: admin.firestore.FieldValue.serverTimestamp() // <--- Используем admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[NOTIF] Success: ${docId}`);
            } catch (error) {
                console.error(`[NOTIF] Error sending to ${notif.telegram_id}:`, error?.message || error);

                await db.collection("notification_queue").doc(docId).update({ // <--- Используем admin.firestore().collection
                    status: "error",
                    error_message: (error?.message || String(error))
                });
            }
        }
      });
    },
    (error) => {
      const msg = error?.message || '';
      const code = error?.code ?? '';

      if (msg.includes('Disconnecting idle stream') || msg.includes('Timed out waiting for new targets') || code === 1 || code === '1' || error instanceof admin.firestore.FirestoreError) {
        console.warn('Firestore listener disconnected (transient or FirestoreError). Will restart with backoff. Message:', msg, 'Code:', code);
      } else {
        console.error('FIRESTORE LISTENER ERROR:', error);
      }

      const delay = backoff;
      console.log(`Restarting Firestore listener in ${delay}ms`);
      setTimeout(() => {
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        startFirestoreListener();
      }, delay);
    }
  );
}

startFirestoreListener();

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
    try {
      if (unsubscribe) unsubscribe();
    } catch (e) {
      console.warn('Error during unsubscribe on shutdown:', e?.message || e);
    }
});
