# Бот P2P Study (Cloudflare Worker)

Бесплатный сервер для `@ptp_study_bot`: ответ на /start, проверка подписки на канал, рассылки.

## Запуск (один раз, ~15 минут)
1. Аккаунт на cloudflare.com (бесплатный).
2. Workers & Pages → Create → Create Worker → имя `p2p-study-bot` → Deploy → Edit code → вставить весь `worker.js` → Deploy.
3. Storage & Databases → KV → Create → имя `SUBS`. В Worker → Settings → Bindings → Add → KV namespace → переменная `SUBS`, выбрать созданное.
4. Worker → Settings → Variables and Secrets:
   - `BOT_TOKEN` (Secret): токен из BotFather (/mybots → бот → API Token)
   - `WEBHOOK_SECRET` (Secret): любая случайная строка из 20+ букв и цифр
5. Открыть в браузере `https://<адрес-воркера>.workers.dev/setup?key=<WEBHOOK_SECRET>` — должно показать `"ok":true` трижды.
6. Написать боту `/myid`, взять число, добавить переменную `OWNER_ID` (Variable) с этим числом.
7. Добавить бота администратором в канал (нужно для проверки подписки).

## Команды владельца (в чате с ботом)
- `/post <id>` — рассылка о новом материале (id из `content/materials.json`)
- `/broadcast текст` — произвольная рассылка
- `/stats` — число подписчиков
