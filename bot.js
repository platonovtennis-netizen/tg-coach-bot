import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin'; 
import { getFirestore } from "firebase-admin/firestore";
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';

// --- ENV CHECK ---
console.log('--- STARTING BOT ---');
if (!process.env.TELEGRAM_BOT_TOKEN) console.error("FATAL: TELEGRAM_BOT_TOKEN is missing!");

// --- SERVICE ACCOUNT SETUP ---
// Если переменная окружения содержит JSON строку ключа (для простоты деплоя)
let serviceAccount;
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        console.log('Service account loaded from JSON string env var.');
    } catch(e) {
        console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_JSON', e);
    }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Иначе читаем из файла
    const serviceAccountPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    try {
        const serviceAccountJson = await fs.readFile(serviceAccountPath, 'utf8');
        serviceAccount = JSON.parse(serviceAccountJson);
        console.log('Service account loaded from file.');
    } catch (e) {
        console.error(`Failed to load service account key from ${serviceAccountPath}`, e);
        process.exit(1);
    }
} else {
    console.error("FATAL: No Google Credentials provided.");
    // В dev режиме можно не выходить, если вы хотите протестировать что-то другое, но для Firestore это критично
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// --- EXPRESS SERVER ---
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Tennis Coach Bot is Running!');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const server = app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

// --- BOT CONFIG ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEB_APP_URL; 

const bot = new TelegramBot(token, { polling: true });

// --- LISTEN FOR NOTIFICATIONS ---
// Слушаем коллекцию очереди
const notifCollection = db.collection("notification_queue");
const notifQuery = notifCollection.where("status", "==", "pending");

console.log('Connecting to Firestore to listen for notifications...');

// Логика подписки с обработкой ошибок
const unsubscribe = notifQuery.onSnapshot(
    (snapshot) => {
        if (snapshot.empty) return;

        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
                const notif = change.doc.data();
                const docId = change.doc.id;
                
                console.log(`[NOTIF] Processing for User TG ID: ${notif.telegram_id}`);

                try {
                    // Формируем клавиатуру с кнопкой Web App
                    // Мы добавляем параметр ?view=notifications, чтобы приложение открылось сразу на нужном экране
                    const keyboard = {
                        inline_keyboard: [[
                            {
                                text: "🔔 Открыть уведомления",
                                web_app: { url: `${webAppUrl}?view=notifications` }
                            }
                        ]]
                    };

                    await bot.sendMessage(notif.telegram_id, notif.message, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });

                    // Обновляем статус
                    await notifCollection.doc(docId).update({
                        status: "sent",
                        sent_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[NOTIF] Sent successfully: ${docId}`);

                } catch (error) {
                    console.error(`[NOTIF] Error sending to ${notif.telegram_id}:`, error.message);
                    
                    // Помечаем как ошибку
                    await notifCollection.doc(docId).update({
                        status: "error",
                        error_message: error.message || "Unknown error"
                    });
                }
            }
        });
    },
    (error) => {
        console.error("FATAL FIRESTORE LISTENER ERROR:", error);
        // В реальном продакшене здесь можно добавить логику перезапуска слушателя
    }
);

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
     // ignore minor warnings
  } else {
      console.error(`[Polling Error] ${error.message}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down...');
    server.close();
    bot.stopPolling();
    unsubscribe();
});
