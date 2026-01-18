import TelegramBot from 'node-telegram-bot-api';
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, doc, updateDoc, query, where } from "firebase/firestore";
import express from 'express';
import cors from 'cors';

// --- EXPRESS SERVER (REQUIRED FOR RENDER WEB SERVICE) ---
// Render требует, чтобы приложение слушало порт, иначе он посчитает деплой неудачным.
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Tennis Coach Bot is Running!');
});

// Health check endpoint (для UptimeRobot или внутренних проверок Render)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

// --- FIREBASE CONFIG ---
// Берем ключи из переменных окружения Render
const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID
};

// Проверка на наличие ключей (чтобы в логах было видно ошибку)
if (!firebaseConfig.apiKey) {
    console.error("ОШИБКА: Не найдены ключи Firebase в переменных окружения!");
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// --- BOT CONFIG ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEB_APP_URL || 'https://tenniscoach-e9aa6.web.app/'; 

if (!token) {
    console.error("ОШИБКА: Не задан TELEGRAM_BOT_TOKEN!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- LISTEN FOR NOTIFICATIONS ---
console.log('Подключение к Firestore для уведомлений...');

// Слушаем только уведомления со статусом 'pending'
const q = query(collection(db, "notification_queue"), where("status", "==", "pending"));

const unsubscribe = onSnapshot(q, (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === "added") {
        const notif = change.doc.data();
        const docId = change.doc.id;
        
        console.log(`Новое уведомление для ${notif.telegram_id}: ${notif.message}`);

        try {
            await bot.sendMessage(notif.telegram_id, notif.message, {
                parse_mode: 'HTML'
            });

            // Обновляем статус на 'sent'
            await updateDoc(doc(db, "notification_queue", docId), {
                status: "sent",
                sent_at: new Date()
            });
            console.log(`Уведомление ${docId} отправлено.`);
        } catch (error) {
            console.error(`Ошибка отправки сообщения пользователю ${notif.telegram_id}:`, error.message);
            // Помечаем как ошибку
             await updateDoc(doc(db, "notification_queue", docId), {
                status: "error",
                error_message: error.message
            });
        }
    }
  });
}, (error) => {
    console.error("Firestore listen error:", error);
});

// --- STANDARD BOT LOGIC ---

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Обработка команды /start
  if (text === '/start') {
    await bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже, чтобы записаться на тренировку:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎾 Записаться", web_app: { url: webAppUrl } }]
        ]
      }
    });
  }
});

bot.on('polling_error', (error) => {
  if (error.code !== 'EFATAL') {
      console.log(`[Polling Warning] ${error.code}: ${error.message}`);
  } else {
      console.error(`[Polling Error] ${error.code}: ${error.message}`);
  }
});

console.log('Бот запущен и слушает очередь уведомлений...');