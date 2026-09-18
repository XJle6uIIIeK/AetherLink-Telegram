import { Bot } from 'grammy';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("No TELEGRAM_BOT_TOKEN found in .env");
  process.exit(1);
}

const bot = new Bot(token);

console.log("=== TG BOT CHAT ID FETCH SYSTEM ===");
console.log("Бот запущен. Пожалуйста, отправьте любое сообщение или /start боту в Telegram...");

bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`\n🎉 Успешно! Получен Chat ID: ${chatId}`);
  
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(path.join(dataDir, 'chat_id.txt'), chatId.toString(), 'utf-8');
  console.log(`Сохранено в data/chat_id.txt`);
  
  await ctx.reply("✅ Связь установлена! Ваш Chat ID успешно сохранен. Возвращайтесь в Antigravity.");
  process.exit(0);
});

bot.catch((err) => {
  console.error("Ошибка бота:", err);
});

bot.start();
