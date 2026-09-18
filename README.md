<p align="center">
  <img src="assets/icon.png" width="220" alt="AetherLink Telegram icon">
</p>

# AetherLink Telegram — local stdio MCP

AetherLink Telegram связывает локальный MCP-клиент с вашим личным Telegram-ботом.

Версия **2.2.0** работает только локально через **stdio**. Remote MCP, OAuth, Docker и внешний HTTPS-сервер больше не нужны.

## Как это работает

```text
MCP client
   │
   │ stdio
   ▼
node start.mjs
   │
   ├─ локальный setup в браузере
   ├─ ~/.aetherlink/config.json
   └─ Telegram Bot API
            │
            └─ /start <одноразовый ключ>
```

После настройки MCP-инструменты работают напрямую из локального процесса.

## Требования

- Node.js **22.5+**
- Git
- доступ к Telegram
- Bot Token от **@BotFather**

Проект использует только две прямые runtime-зависимости:

- `@modelcontextprotocol/sdk`
- `grammy`

При первом запуске `start.mjs` автоматически выполнит минимальную установку runtime-зависимостей, если `node_modules` ещё нет.

## Быстрый запуск

```bash
git clone https://github.com/XJle6uIIIeK/AetherLink-Telegram.git
cd AetherLink-Telegram
node start.mjs
```

При первом запуске автоматически откроется локальная страница настройки.

1. Вставьте Bot Token от @BotFather.
2. AetherLink проверит токен через Telegram `getMe`.
3. Нажмите **Открыть Telegram и привязать**.
4. Бот получит `/start <key>`.
5. После привязки MCP продолжает работать локально через stdio.

Bot Token хранится только на вашем компьютере:

```text
~/.aetherlink/config.json
```

Данные Telegram bridge:

```text
~/.aetherlink/data/
├── chat_id.txt
├── pairing_key.txt
└── tasks.sqlite
```

## Подключение как обычного stdio MCP

Конфигурация клиента:

```json
{
  "mcpServers": {
    "aetherlink-telegram": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/AetherLink-Telegram/start.mjs"
      ]
    }
  }
}
```

На Windows используйте полный путь, например:

```json
{
  "mcpServers": {
    "aetherlink-telegram": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_NAME\\AetherLink-Telegram\\start.mjs"
      ]
    }
  }
}
```

В самом репозитории также лежит `.mcp.json` для клиентов, которые умеют запускать MCP из корня проекта.

## Claude Code plugin

Репозиторий остаётся устанавливаемым локальным Claude plugin:

```text
/plugin marketplace add XJle6uIIIeK/AetherLink-Telegram
/plugin install aetherlink-telegram@aetherlink-telegram
```

Claude запускает:

```text
node ${CLAUDE_PLUGIN_ROOT}/start.mjs
```

После этого setup и Telegram pairing происходят на компьютере пользователя.

## MCP tools

Основные инструменты:

- `tg_notify` — отправить уведомление;
- `tg_confirm` — запросить Approve / Deny;
- `tg_ask` — задать вопрос через Telegram;
- `tg_inbox` — получить входящие задачи;
- `tg_ack` — принять задачи;
- `tg_progress` — обновить прогресс;
- `tg_complete` — завершить задачу;
- `tg_fail` — отметить ошибку;
- `tg_cancelled` — проверить отмену;
- `tg_task_status` — получить статус задачи;
- `tg_send_file` / `tg_send_files` — отправить файлы;
- `tg_take_screenshot` — сделать screenshot через установленный Chrome/Chromium.

## Скриншоты

Playwright не используется. Для `tg_take_screenshot` AetherLink пытается найти установленный Chrome/Chromium.

При необходимости задайте:

```text
CHROME_PATH=/path/to/chrome
```

## Перенастройка Telegram

Чтобы поменять Bot Token, удалите:

```text
~/.aetherlink/config.json
```

Чтобы заново привязать Telegram-аккаунт, удалите:

```text
~/.aetherlink/data/chat_id.txt
~/.aetherlink/data/pairing_key.txt
```

и перезапустите MCP.

## Разработка

```bash
npm install
npm run build
npm test
```

Исходники находятся в `src/`, готовый runtime — в `dist/`.

## Безопасность

- Bot Token не коммитьте в Git.
- Конфиг хранится вне репозитория.
- Pairing требует ключ из ссылки `/start <key>`.
- `/run` предоставляет удалённое выполнение команд внутри локального процесса, поэтому используйте его только с личным Telegram-ботом.
- `stdout` зарезервирован для MCP JSON-RPC; служебные логи идут в `stderr`.

## Что удалено в 2.2.0

Local-only версия больше не содержит:

- remote Streamable HTTP MCP;
- OAuth;
- Back4App/Docker deployment;
- `PUBLIC_URL`;
- `AETHERLINK_MASTER_KEY`;
- web-only OpenAI plugin manifests.

Это намеренно: один процесс, один компьютер, один stdio transport.
