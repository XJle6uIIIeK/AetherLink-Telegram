<p align="center">
  <img src="assets/icon.svg" width="220" alt="AetherLink Telegram">
</p>

# AetherLink Telegram — MCP / ChatGPT Plugin

AetherLink связывает ChatGPT, Codex, Claude и другие MCP-клиенты с личным Telegram-ботом.

## Возможности

- remote **Streamable HTTP MCP** для ChatGPT Web;
- OAuth Authorization Code + PKCE S256 и Dynamic Client Registration;
- ввод BotFather token во время OAuth;
- безопасная одноразовая привязка через `/start <key>`;
- GitHub plugin для Claude Code и совместимых клиентов;
- уведомления, подтверждения, вопросы, очередь задач, прогресс, файлы и скриншоты.

## ChatGPT Web

ChatGPT Web не запускает локальный `node`-процесс из GitHub, поэтому remote MCP нужно один раз развернуть как HTTPS-сервис.

```bash
cp .env.example .env
# PUBLIC_URL=https://your-domain.example
docker compose up -d --build
```

После развёртывания настройте URL:

```bash
npm run configure -- --url https://your-domain.example --github XJle6uIIIeK/AetherLink-Telegram
```

MCP endpoint: `https://your-domain.example/mcp`.

При **Connect**:

```text
ChatGPT → OAuth → Bot Token → Telegram → /start ONE_TIME_KEY → Connected
```

Bot Token не передаётся модели. На сервере он шифруется AES-256-GCM; access/refresh tokens сохраняются только как SHA-256 hashes. Pairing key одноразовый и имеет TTL.

## Claude Code

```text
/plugin marketplace add XJle6uIIIeK/AetherLink-Telegram
/plugin install aetherlink-telegram@aetherlink-telegram
```

При первом локальном запуске откроется страница настройки Bot Token и кнопка привязки Telegram.

## Проверка

```bash
npm ci
npm test
npm run test:oauth
```

Node.js: **22.5+**.

## Безопасность

Не коммитьте `.env`, `~/.aetherlink`, Bot Token, pairing keys или runtime data. Для remote MCP используйте HTTPS. Команда `/run` выполняет команды на хосте — Telegram-бот должен оставаться приватным.

MIT License.
