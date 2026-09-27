import { loadConfig } from './config.js';
import { createApp } from './server.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: settings come from the environment.
}

const config = loadConfig();
const app = createApp(config);
const { port } = await app.listen();
console.log(`HOROVOD wishlist is running on port ${port}${config.publicUrl ? ` (${config.publicUrl})` : ''}.`);
if (!config.groupChatId && config.allowedUserIds.size === 0) {
  console.warn('GROUP_CHAT_ID is not set: anyone who opens the bot can use the wishlist.');
}
app.bot.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
