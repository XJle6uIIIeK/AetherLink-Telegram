<p align="center">
  <img src="assets/icon.png" width="220" alt="AetherLink Telegram icon">
</p>

# AetherLink Telegram — MCP / ChatGPT Plugin

AetherLink связывает AI-клиент с вашим личным Telegram-ботом. Один репозиторий поддерживает:

- **ChatGPT Web / Codex** через remote Streamable HTTP MCP + OAuth;
- **Claude Code** как GitHub plugin с локальным stdio MCP;
- обычные MCP-клиенты;
- уведомления, подтверждения, вопросы, inbox задач, прогресс, файлы и скриншоты;
- одноразовую безопасную привязку Telegram через `/start <key>`.

## Что нового в 2.1.0

GPT-режим больше не использует `MCP_PATH_KEY`. Вместо него сервер реализует OAuth Authorization Code flow с PKCE S256, Dynamic Client Registration, refresh tokens и MCP OAuth discovery.

Пользовательский сценарий:

```text
ChatGPT → Connect
        → страница AetherLink
        → Telegram Bot Token
        → Проверить
        → Открыть Telegram
        → /start <одноразовый ключ>
        → Продолжить в ChatGPT
        → MCP подключён
```

Bot Token не отправляется модели. На сервере он хранится зашифрованным AES-256-GCM. Access/refresh tokens сохраняются только в виде SHA-256 хэшей. Pairing key одноразовый и по умолчанию действует 10 минут.

---

## Структура плагина

```text
plugin.json                 OpenAI portable Agent Plugin
mcp.json                    remote MCP для ChatGPT/Codex
.codex-plugin/plugin.json   compatibility manifest
.mcp.json                   compatibility MCP config
.claude-plugin/             Claude Code plugin/marketplace
skills/                     инструкции для агента
remote.mjs                  ChatGPT-ready OAuth + MCP server
start.mjs                   локальный stdio launcher
src/                        TypeScript source
Dockerfile
docker-compose.yml
```

## 1. Развёртывание GPT-сервера

Для ChatGPT Web MCP должен быть доступен по HTTPS. Самый простой вариант — Docker на VPS/Render/Railway/Fly.io/другом контейнерном хостинге.

Создайте `.env`:

```bash
cp .env.example .env
```

Минимально укажите:

```env
PUBLIC_URL=https://telegram-mcp.example.com
AETHERLINK_DATA_DIR=/data
```

`TELEGRAM_BOT_TOKEN` здесь **не нужен**: каждый пользователь вводит его во время OAuth-подключения.

Запуск:

```bash
docker compose up -d --build
```

Проверка:

```text
https://telegram-mcp.example.com/health
https://telegram-mcp.example.com/.well-known/oauth-protected-resource
https://telegram-mcp.example.com/.well-known/oauth-authorization-server
https://telegram-mcp.example.com/mcp
```

`/mcp` без Bearer token специально отвечает `401` и публикует OAuth challenge.

### Важно про reverse proxy

TLS должен завершаться на HTTPS. Прокси должен передавать `Host` и `X-Forwarded-Proto`. В production всегда задавайте `PUBLIC_URL` — это фиксирует OAuth issuer/resource и защищает от неверного определения внешнего URL.

## 2. Настройка GitHub plugin под ваш домен

После того как сервер развёрнут, выполните в репозитории:

```bash
npm run configure -- \
  --url https://telegram-mcp.example.com \
  --github XJle6uIIIeK/AetherLink-Telegram
```

Скрипт автоматически изменит:

- `mcp.json`;
- `.mcp.json`;
- GitHub URL в Claude marketplace;
- `repository`/`homepage` в `plugin.json`.

Закоммитьте изменения и загрузите репозиторий на GitHub.

## 3. Подключение в ChatGPT Web

### Вариант A — напрямую как MCP app

В ChatGPT создайте custom MCP/app и укажите:

```text
https://telegram-mcp.example.com/mcp
```

При OAuth ChatGPT автоматически найдёт:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/register
/authorize
/token
```

После нажатия Connect откроется AetherLink setup:

1. вставьте Bot Token от `@BotFather`;
2. токен проверится через Telegram `getMe`;
3. нажмите **Открыть Telegram и привязать**;
4. Telegram откроет ссылку вида `https://t.me/MyBot?start=<KEY>`;
5. бот получит `/start <KEY>`;
6. когда статус станет `Telegram привязан`, нажмите **Продолжить в ChatGPT**.

### Вариант B — установка GitHub plugin

После замены URL в `mcp.json` репозиторий является portable Agent Plugin. Если ваша версия/Workspace ChatGPT поддерживает repository marketplaces, добавьте URL GitHub-репозитория как источник плагина и установите `aetherlink-telegram`.

Remote MCP всё равно должен быть развернут — GitHub содержит manifest/skills, а не выполняющийся сервер.

## 4. OAuth endpoints

Реализовано:

- RFC-style protected resource metadata;
- Authorization Server Metadata;
- Dynamic Client Registration (`POST /register`);
- Authorization Code;
- PKCE `S256`;
- `resource` binding;
- access token TTL;
- rotating refresh tokens;
- `offline_access`;
- OAuth bearer challenge на `/mcp`;
- authenticated `get_profile` MCP tool с `_meta["openai/profile"]`.

Основные scopes:

```text
telegram:read
telegram:write
offline_access
```

## 5. Хранение данных

По умолчанию remote server использует:

```text
~/.aetherlink/data/
```

В Docker:

```text
/data/
```

Там находятся:

```text
master.key                 локальный ключ шифрования
 oauth-store.json          OAuth clients/accounts/token hashes
accounts/<profile>/
  chat_id.txt
  tasks.sqlite
```

Не теряйте `master.key`, если не задаёте `AETHERLINK_MASTER_KEY`: без него сохранённые Bot Token нельзя расшифровать.

## 6. Локальный Claude/MCP режим

Claude plugin запускает:

```text
node start.mjs
```

При первом запуске открывается локальная setup-страница, куда вводится Bot Token. Затем появляется Telegram deep-link с одноразовым `/start` ключом.

Установка Claude Code после публикации GitHub marketplace:

```text
/plugin marketplace add XJle6uIIIeK/AetherLink-Telegram
/plugin install aetherlink-telegram@aetherlink-telegram
```

## 7. MCP tools

Основные инструменты:

- `tg_notify` — отправить уведомление;
- `tg_confirm` — Approve / Deny;
- `tg_ask` — вопрос с кнопками или свободным ответом;
- `tg_inbox` — durable inbox задач;
- `tg_ack` — принять задачи;
- `tg_progress` — обновить прогресс;
- `tg_complete` — завершить задачу и отправить файлы;
- `tg_fail` — отметить ошибку;
- `tg_cancelled` — проверить отмену;
- `tg_task_status` — статус задачи;
- `tg_send_file` / `tg_send_files` — отправка файлов;
- `tg_take_screenshot` — screenshot URL через установленный Chrome/Chromium (без Playwright);
- `get_profile` — профиль текущего OAuth-подключения в ChatGPT.

## 8. Безопасность

Для production:

- используйте только HTTPS;
- храните `/data` на persistent volume;
- не публикуйте `master.key` и `oauth-store.json`;
- не коммитьте `.env`;
- не логируйте Bot Token;
- запускайте контейнер с минимальными правами;
- если используете Telegram `/run`, считайте его удалённым shell-доступом к контейнеру и изолируйте deployment соответствующим образом.

Pairing больше не работает по принципу «первый `/start` становится владельцем». Требуется криптографически случайный одноразовый ключ.

## 9. Зависимости

У проекта только две прямые runtime-зависимости:

- `@modelcontextprotocol/sdk` — совместимость с MCP/ChatGPT;
- `grammy` — Telegram Bot API и polling.

`express`, `dotenv` и `playwright` не используются напрямую: HTTP/OAuth и `.env` работают на стандартной библиотеке Node.js, а скриншоты вызывают установленный Chrome/Chromium через `CHROME_PATH` или системный PATH. Сам MCP SDK может иметь собственные транзитивные зависимости.

## 10. Проверка

После установки зависимостей:

```bash
npm install
npm run test:oauth
```

Smoke test проверяет:

- OAuth metadata;
- PKCE S256 declaration;
- Dynamic Client Registration;
- обязательный `401 + WWW-Authenticate` на `/mcp` без токена.

Полный pairing test требует настоящего Bot Token и Telegram-аккаунта.
