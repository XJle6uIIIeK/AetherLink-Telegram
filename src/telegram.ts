import { Bot, InlineKeyboard, GrammyError, HttpError, InputFile, InputMediaBuilder } from 'grammy';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { chromium } from 'playwright';
import {
  CreateTaskInput,
  TaskStatus,
  TaskStore,
  TelegramTask,
} from './task-store.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface PendingRequest {
  id: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  taskId?: string;
  promptMessageId?: number;
  acceptText: boolean;
  acceptFiles: boolean;
}

interface QueuedMessage {
  text: string;
  date: string;
}

interface PhotoUploadItem {
  fileId: string;
  caption: string;
  messageId: number;
  updateId: number;
  replyToMessageId?: number;
}

interface PendingPhotoAlbum {
  chatId: number;
  items: PhotoUploadItem[];
  timeout: ReturnType<typeof setTimeout>;
}

interface RunningProcess {
  command: string;
  process: ChildProcess;
  outputBuffer: string[];
  messageId: number;
}

// ── Telegram Bridge ─────────────────────────────────────────────────────────

export class TelegramBridge {
  private bot: Bot;
  private chatId: number | null = null;
  private taskStore: TaskStore;
  private pendingRequests = new Map<string, PendingRequest>();
  private optionsMap = new Map<string, string[]>();
  private promptRequests = new Map<number, string>();
  private pendingPhotoAlbums = new Map<string, PendingPhotoAlbum>();
  private chatIdFile: string;
  private pairingKeyFile: string;
  private pairingKey: string | null = null;
  private defaultTimeout: number;

  // Remote Shell state
  private activeProcesses = new Map<string, RunningProcess>();
  
  // Gemini API key for audio transcription
  private geminiApiKey: string | null = null;

  // File Browser state
  private waitingForFileEdit: string | null = null;
  private pathIdMap = new Map<string, string>(); // id -> absolutePath
  private pathIdCounter = 0;


  constructor(token: string, options?: { chatId?: number; dataDir?: string; timeoutMs?: number }) {
    this.bot = new Bot(token);
    this.defaultTimeout = options?.timeoutMs ?? 300_000;
    this.geminiApiKey = process.env.GEMINI_API_KEY || null;

    const dataDir = options?.dataDir ?? path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.chatIdFile = path.join(dataDir, 'chat_id.txt');
    this.pairingKeyFile = path.join(dataDir, 'pairing_key.txt');
    this.pairingKey = process.env.AETHERLINK_PAIRING_KEY || null;
    this.taskStore = new TaskStore(path.join(dataDir, 'tasks.sqlite'));

    if (options?.chatId) {
      this.chatId = options.chatId;
    } else {
      this.loadChatId();
    }

    this.setupHandlers();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private loadChatId(): void {
    try {
      if (fs.existsSync(this.chatIdFile)) {
        const raw = fs.readFileSync(this.chatIdFile, 'utf-8').trim();
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) this.chatId = parsed;
      }
    } catch {
      // ignore
    }
  }

  private saveChatId(id: number): void {
    try {
      fs.writeFileSync(this.chatIdFile, id.toString(), 'utf-8');
    } catch {
      // ignore
    }
  }

  private createIncomingTask(input: CreateTaskInput): TelegramTask {
    return this.taskStore.create(input);
  }

  private findPendingResponseRequest(
    replyToMessageId: number | undefined,
    responseType: 'text' | 'file'
  ): string | null {
    if (replyToMessageId !== undefined) {
      const directRequestId = this.promptRequests.get(replyToMessageId);
      const directRequest = directRequestId
        ? this.pendingRequests.get(directRequestId)
        : undefined;
      if (
        directRequest
        && (responseType === 'text' ? directRequest.acceptText : directRequest.acceptFiles)
      ) {
        return directRequestId!;
      }
    }

    const matchingRequests = [...this.pendingRequests.entries()]
      .filter(([, pending]) => (
        responseType === 'text' ? pending.acceptText : pending.acceptFiles
      ));
    return matchingRequests.length === 1 ? matchingRequests[0][0] : null;
  }

  private resolveIncomingResponse(
    value: string,
    replyToMessageId: number | undefined,
    responseType: 'text' | 'file'
  ): boolean {
    const requestId = this.findPendingResponseRequest(replyToMessageId, responseType);
    if (!requestId) return false;

    return this.resolvePendingRequest(requestId, value);
  }

  private resolvePendingRequest(requestId: string, value: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    this.optionsMap.delete(requestId);
    if (pending.promptMessageId !== undefined) {
      this.promptRequests.delete(pending.promptMessageId);
    }
    if (pending.taskId) {
      this.taskStore.resume(pending.taskId);
    }
    pending.resolve(value);
    return true;
  }

  private queuePhotoAlbum(mediaGroupId: string, chatId: number, item: PhotoUploadItem): void {
    const pendingAlbum = this.pendingPhotoAlbums.get(mediaGroupId);
    if (pendingAlbum) {
      clearTimeout(pendingAlbum.timeout);
      pendingAlbum.items.push(item);
      pendingAlbum.timeout = setTimeout(() => {
        void this.flushPhotoAlbum(mediaGroupId);
      }, 750);
      return;
    }

    const timeout = setTimeout(() => {
      void this.flushPhotoAlbum(mediaGroupId);
    }, 750);

    this.pendingPhotoAlbums.set(mediaGroupId, {
      chatId,
      items: [item],
      timeout,
    });
  }

  private async flushPhotoAlbum(mediaGroupId: string): Promise<void> {
    const pendingAlbum = this.pendingPhotoAlbums.get(mediaGroupId);
    if (!pendingAlbum) return;

    clearTimeout(pendingAlbum.timeout);
    this.pendingPhotoAlbums.delete(mediaGroupId);

    let loadingMessageId: number | null = null;
    try {
      const loadingMsg = await this.bot.api.sendMessage(
        pendingAlbum.chatId,
        `📸 *Downloading ${pendingAlbum.items.length} photos...*`,
        { parse_mode: 'Markdown' }
      );
      loadingMessageId = loadingMsg.message_id;
    } catch (err) {
      console.error(`[TG] Failed to send photo album progress message (${mediaGroupId}):`, err);
    }

    await this.processPhotoUploads(
      pendingAlbum.chatId,
      pendingAlbum.items,
      loadingMessageId,
      mediaGroupId
    );
  }

  private async processPhotoUploads(
    chatId: number,
    items: PhotoUploadItem[],
    loadingMessageId: number | null,
    mediaGroupId?: string
  ): Promise<void> {
    try {
      const receivedDir = path.join(process.cwd(), 'data', 'received');
      if (!fs.existsSync(receivedDir)) fs.mkdirSync(receivedDir, { recursive: true });

      const orderedItems = [...items].sort((a, b) => a.messageId - b.messageId);
      const batchTimestamp = Date.now();
      const absolutePaths = await Promise.all(
        orderedItems.map(async (item, index) => {
          const buffer = await this.downloadTelegramFile(item.fileId);
          const filename = `image_${batchTimestamp}_${index + 1}.jpg`;
          const destPath = path.join(receivedDir, filename);
          fs.writeFileSync(destPath, buffer);
          return path.resolve(destPath);
        })
      );

      const captions = [...new Set(
        orderedItems
          .map((item) => item.caption.trim())
          .filter((caption) => caption.length > 0)
      )];
      const attachmentText = absolutePaths
        .map((absolutePath) => `[Attached Image: ${absolutePath.replace(/\\/g, '/')}]`)
        .join('\n');
      const taskText = `${attachmentText}${captions.length ? ` Caption: ${captions.join('\n')}` : ''}`;

      const deliveredToPendingRequest = this.resolveIncomingResponse(
        taskText,
        orderedItems[0]?.replyToMessageId,
        'file'
      );
      const task = deliveredToPendingRequest
        ? null
        : this.createIncomingTask({
            kind: 'photo',
            text: taskText,
            dedupeKey: mediaGroupId
              ? `media:${mediaGroupId}`
              : `update:${orderedItems[0].updateId}`,
            telegramChatId: chatId,
            telegramMessageId: orderedItems[0].messageId,
            replyToMessageId: orderedItems[0].replyToMessageId,
            mediaGroupId,
            attachments: absolutePaths.map((absolutePath) => ({
              kind: 'image',
              path: absolutePath,
              name: path.basename(absolutePath),
              size: fs.statSync(absolutePath).size,
            })),
          });

      const count = absolutePaths.length;
      const savedPaths = absolutePaths.map((absolutePath) => `\`${absolutePath}\``).join('\n');
      const deliveryStatus = deliveredToPendingRequest
        ? 'Attachment details sent to agent.'
        : count === 1
          ? `Queued as task \`${task!.id}\`.`
          : `Queued together as one task \`${task!.id}\`.`;

      await this.updatePhotoStatus(
        chatId,
        loadingMessageId,
        `📸 *${count === 1 ? 'Photo' : `${count} photos`} received & saved!*\n${savedPaths}\n${deliveryStatus}`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.updatePhotoStatus(
        chatId,
        loadingMessageId,
        `⚠️ *Failed to download ${items.length === 1 ? 'photo' : 'photo album'}:*\n\`${errorMsg}\``
      );
    }
  }

  private async updatePhotoStatus(
    chatId: number,
    loadingMessageId: number | null,
    text: string
  ): Promise<void> {
    if (loadingMessageId === null) {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      return;
    }

    await this.bot.api.editMessageText(chatId, loadingMessageId, text, { parse_mode: 'Markdown' });
  }

  private async upsertTaskStatus(
    task: TelegramTask,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<TelegramTask> {
    const chatId = task.telegramChatId ?? this.chatId;
    if (!chatId) throw new Error('Task has no Telegram chat ID');

    if (task.statusMessageId !== null) {
      try {
        await this.bot.api.editMessageText(chatId, task.statusMessageId, text, {
          reply_markup: keyboard,
        });
        return this.taskStore.get(task.id) ?? task;
      } catch (err) {
        console.error(`[TG] Failed to edit status message for task ${task.id}:`, err);
      }
    }

    const statusMessage = await this.bot.api.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });
    return this.taskStore.setStatusMessageId(task.id, statusMessage.message_id);
  }

  // ── Bot Handlers ────────────────────────────────────────────────────────

  private setupHandlers(): void {
    // Global access control middleware — Foolproof security block
    this.bot.use(async (ctx, next) => {
      const senderId = ctx.from?.id;
      
      // First-run pairing requires a high-entropy one-time /start key.
      if (this.chatId === null) {
        const text = ctx.message?.text?.trim() ?? '';
        const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/);
        const suppliedKey = match?.[1]?.trim();
        if (senderId && this.pairingKey && suppliedKey === this.pairingKey) {
          this.chatId = senderId;
          this.saveChatId(senderId);
          this.pairingKey = null;
          delete process.env.AETHERLINK_PAIRING_KEY;
          try { fs.unlinkSync(this.pairingKeyFile); } catch { /* already removed */ }
          console.error(`[Security] Telegram owner paired: ${senderId}`);
          return await next();
        }
        await ctx.reply(
          "🔒 *AetherLink is not paired.*\nUse the private pairing button generated by the plugin setup window.",
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Check if the sender is the authorized owner
      if (senderId !== this.chatId) {
        console.error(`[Security] Unauthorized access attempt from User ID: ${senderId}`);
        try {
          await ctx.reply("⛔ *Access Denied.*\nThis is a private AetherLink control bot.", { parse_mode: 'Markdown' });
        } catch {
          // ignore
        }
        return;
      }

      await next();
    });

    // /start — register chat and save ID
    this.bot.command('start', async (ctx) => {
      await this.sendMenu(ctx.chat.id);
    });

    // /menu — show interactive dashboard
    this.bot.command('menu', async (ctx) => {
      await this.sendMenu(ctx.chat.id);
    });

    // /status
    this.bot.command('status', async (ctx) => {
      await ctx.reply(this.getStatusText(), { parse_mode: 'Markdown' });
    });

    // /run <command> — execute terminal command remotely
    this.bot.command('run', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;
      const cmd = ctx.match?.trim();
      if (!cmd) {
        await ctx.reply('⚠️ Please specify a command. Example: `/run npm test`', { parse_mode: 'Markdown' });
        return;
      }
      await this.executeRemoteCommand(cmd);
    });

    // /files — list files in workspace
    this.bot.command('files', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;
      await this.sendFileBrowser(ctx.chat.id, process.cwd());
    });

    // /help — show help commands
    this.bot.command('help', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;
      await ctx.reply(
        `📚 *Antigravity Remote Help*\n\n` +
        `🎮 *Команды управления:*\n` +
        `/menu — Открыть панель управления\n` +
        `/status — Статус подключения и ресурсов\n` +
        `/files — Файловый менеджер проекта\n` +
        `/run <команда> — Выполнить команду (например, \`/run npm run build\`)\n` +
        `/help — Показать эту справку\n\n` +
        `🎙️ *Голосовой ввод:* Надиктуйте задачу голосом, чтобы агент её выполнил.\n` +
        `📁 *Загрузка файлов:* Отправьте файл или фото, чтобы сохранить его на диск ПК и передать агенту.`,
        { parse_mode: 'Markdown' }
      );
    });


    // Interactive button callbacks
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      // Handle custom menu items
      if (data === 'menu:status') {
        await ctx.answerCallbackQuery();
        await ctx.reply(this.getStatusText(), { parse_mode: 'Markdown' });
        return;
      }

      if (data === 'menu:tasks') {
        await ctx.answerCallbackQuery();
        const tasks = this.taskStore.list(
          ['new', 'accepted', 'running', 'waiting_user', 'failed', 'cancel_requested'],
          20
        );
        if (tasks.length === 0) {
          await ctx.reply('📝 Queue is empty.');
        } else {
          const list = tasks
            .map((task, i) => (
              `${i + 1}. [${task.status}] \`${task.id}\` ${task.text}`
            ))
            .join('\n');
          await ctx.reply(`📝 *Queued Tasks:*\n\n${list}`, { parse_mode: 'Markdown' });
        }
        return;
      }

      if (data === 'menu:stop_all') {
        await ctx.answerCallbackQuery({ text: 'Stopping running commands...' });
        for (const [pid, proc] of this.activeProcesses) {
          proc.process.kill('SIGTERM');
          this.activeProcesses.delete(pid);
        }
        await ctx.reply('🛑 All active processes terminated.');
        return;
      }

      // Handle process cancellation
      if (data.startsWith('kill_proc:')) {
        const pid = data.replace('kill_proc:', '');
        const proc = this.activeProcesses.get(pid);
        if (proc) {
          proc.process.kill('SIGTERM');
          this.activeProcesses.delete(pid);
          await ctx.answerCallbackQuery({ text: 'Process terminated.' });
          try {
            await this.bot.api.editMessageText(
              this.chatId!,
              proc.messageId,
              `🛑 *Command cancelled:* \`${proc.command}\``,
              { parse_mode: 'Markdown' }
            );
          } catch {
            // ignore
          }
        } else {
          await ctx.answerCallbackQuery({ text: 'Process not running.' });
        }
        return;
      }

      // Handle file browser interactions
      if (data.startsWith('fb_dir:')) {
        const pathId = data.replace('fb_dir:', '');
        const targetPath = this.getPathFromId(pathId);
        if (targetPath) {
          await ctx.answerCallbackQuery();
          await this.editFileBrowser(ctx, targetPath);
        } else {
          await ctx.answerCallbackQuery({ text: '⚠️ Path expired or not found.' });
        }
        return;
      }

      if (data.startsWith('fb_file:')) {
        const pathId = data.replace('fb_file:', '');
        const targetPath = this.getPathFromId(pathId);
        if (targetPath) {
          await ctx.answerCallbackQuery();
          await this.showFileMenu(ctx, targetPath);
        } else {
          await ctx.answerCallbackQuery({ text: '⚠️ Path expired or not found.' });
        }
        return;
      }

      if (data.startsWith('fb_view:')) {
        const pathId = data.replace('fb_view:', '');
        const targetPath = this.getPathFromId(pathId);
        if (targetPath) {
          await ctx.answerCallbackQuery();
          await this.viewFileContent(ctx, targetPath);
        } else {
          await ctx.answerCallbackQuery({ text: '⚠️ Path expired or not found.' });
        }
        return;
      }

      if (data.startsWith('fb_agent:')) {
        const pathId = data.replace('fb_agent:', '');
        const targetPath = this.getPathFromId(pathId);
        if (targetPath) {
          const absolutePath = path.resolve(targetPath);
          const taskText = `[Attached File: ${absolutePath.replace(/\\/g, '/')}] Please review and work on this file.`;
          const task = this.createIncomingTask({
            kind: 'local_file',
            text: taskText,
            dedupeKey: `callback:${ctx.callbackQuery.id}`,
            telegramChatId: ctx.chat?.id,
            telegramMessageId: ctx.callbackQuery.message?.message_id,
            attachments: [{
              kind: 'file',
              path: absolutePath,
              name: path.basename(absolutePath),
              size: fs.statSync(absolutePath).size,
            }],
          });
          await ctx.answerCallbackQuery({ text: 'Queued to agent!' });
          await ctx.reply(
            `🤖 File sent to agent: \`${path.basename(absolutePath)}\`\nTask: \`${task.id}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.answerCallbackQuery({ text: '⚠️ Path expired or not found.' });
        }
        return;
      }

      if (data.startsWith('fb_edit:')) {
        const pathId = data.replace('fb_edit:', '');
        const targetPath = this.getPathFromId(pathId);
        if (targetPath) {
          this.waitingForFileEdit = targetPath;
          await ctx.answerCallbackQuery();
          await ctx.reply(
            `✏️ *Editing file:* \`${path.basename(targetPath)}\`\n\n` +
            `Отправьте новое содержимое файла обычным сообщением. Файл на ПК будет полностью перезаписан.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.answerCallbackQuery({ text: '⚠️ Path expired or not found.' });
        }
        return;
      }

      if (data.startsWith('task_retry:')) {
        const taskId = data.replace('task_retry:', '');
        try {
          const task = this.taskStore.retry(taskId);
          await ctx.answerCallbackQuery({ text: 'Task returned to the inbox.' });
          await ctx.reply(`🔄 Task \`${task.id}\` is ready for retry.`, {
            parse_mode: 'Markdown',
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: errorMsg.slice(0, 180), show_alert: true });
        }
        return;
      }

      if (data.startsWith('task_cancel:')) {
        const taskId = data.replace('task_cancel:', '');
        try {
          const task = this.taskStore.requestCancel(taskId);
          const text = task.status === 'completed'
            ? 'Task is already completed.'
            : 'Cancellation requested.';
          await ctx.answerCallbackQuery({ text });
          if (task.status !== 'completed') {
            await ctx.reply(`🛑 Cancellation requested for task \`${task.id}\`.`, {
              parse_mode: 'Markdown',
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: errorMsg.slice(0, 180), show_alert: true });
        }
        return;
      }


      // Handle standard question response callbacks (MCP-driven confirmations/asks)
      const sepIdx = data.indexOf(':');
      if (sepIdx === -1) {
        await ctx.answerCallbackQuery({ text: '❌ Invalid callback' });
        return;
      }

      const requestId = data.substring(0, sepIdx);
      const rawValue = data.substring(sepIdx + 1);

      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: '⏰ Request expired' });
        return;
      }

      // Resolve the actual value (option text from index, or raw value)
      const options = this.optionsMap.get(requestId);
      let resolvedValue: string;
      if (options) {
        const idx = parseInt(rawValue, 10);
        resolvedValue = !isNaN(idx) && idx < options.length ? options[idx] : rawValue;
        this.optionsMap.delete(requestId);
      } else {
        resolvedValue = rawValue;
      }

      this.resolvePendingRequest(requestId, resolvedValue);

      await ctx.answerCallbackQuery({ text: `✅ ${resolvedValue}` });

      // Update message to show selection
      try {
        const original = ctx.callbackQuery.message?.text ?? '';
        await ctx.editMessageText(`${original}\n\n✅ *Selected:* ${resolvedValue}`, {
          parse_mode: 'Markdown',
        });
      } catch {
        // ignore edit errors
      }
    });

    // Voice message → transcribing voice using Gemini API
    this.bot.on('message:voice', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;

      const voice = ctx.message.voice;
      const fileId = voice.file_id;

      const loadingMsg = await ctx.reply('🎙️ *Processing voice message...*', { parse_mode: 'Markdown' });

      try {
        if (!this.geminiApiKey) {
          throw new Error('GEMINI_API_KEY is not set. Please add it to your `C:\\MCP\\.env` file.');
        }

        // Fetch file buffer using helper
        const buffer = await this.downloadTelegramFile(fileId);

        // Transcribe voice message via Gemini API
        const base64Audio = buffer.toString('base64');
        const mimeType = 'audio/ogg'; // Telegram voice notes are usually ogg/opus

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.geminiApiKey}`;
        const transcriptionResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inlineData: { mimeType, data: base64Audio } },
                  { text: 'Transcribe this voice message. Output only the transcription, nothing else. Write in the same language as the spoken audio.' }
                ]
              }
            ]
          })
        });

        if (!transcriptionResponse.ok) {
          const errMsg = await transcriptionResponse.text();
          throw new Error(`Gemini API Error: ${transcriptionResponse.statusText} (${errMsg})`);
        }

        const resJson = await transcriptionResponse.json() as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>;
            };
          }>;
        };
        const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) {
          throw new Error('Gemini API returned an empty transcription.');
        }

        const deliveredToPendingRequest = this.resolveIncomingResponse(
          text,
          ctx.message.reply_to_message?.message_id,
          'text'
        );
        if (deliveredToPendingRequest) {
          await this.bot.api.editMessageText(
            ctx.chat.id,
            loadingMsg.message_id,
            `🎙️ *Voice response sent to agent:* \n\n_"${text}"_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const task = this.createIncomingTask({
          kind: 'voice',
          text,
          dedupeKey: `update:${ctx.update.update_id}`,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.message.message_id,
          replyToMessageId: ctx.message.reply_to_message?.message_id,
        });

        await this.bot.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          `📝 *Voice task transcribed and queued:*\n\n_"${text}"_\n\nTask: \`${task.id}\``,
          { parse_mode: 'Markdown' }
        );

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.bot.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          `⚠️ *Failed to transcribe voice:* \n\`${errorMsg}\``,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Photo upload -> save as image and queue task
    this.bot.on('message:photo', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;

      const photo = ctx.message.photo;
      const item: PhotoUploadItem = {
        fileId: photo[photo.length - 1].file_id, // highest resolution
        caption: ctx.message.caption || '',
        messageId: ctx.message.message_id,
        updateId: ctx.update.update_id,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
      };
      const mediaGroupId = ctx.message.media_group_id;

      if (mediaGroupId) {
        this.queuePhotoAlbum(mediaGroupId, ctx.chat.id, item);
        return;
      }

      const loadingMsg = await ctx.reply('📸 *Downloading photo...*', { parse_mode: 'Markdown' });
      await this.processPhotoUploads(ctx.chat.id, [item], loadingMsg.message_id);
    });

    // Document upload -> save file and queue task
    this.bot.on('message:document', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return;

      const doc = ctx.message.document;
      const fileId = doc.file_id;
      const originalFilename = doc.file_name || `file_${Date.now()}`;
      const caption = ctx.message.caption || '';

      const loadingMsg = await ctx.reply(`📁 *Downloading file:* \`${originalFilename}\`...`, { parse_mode: 'Markdown' });

      try {
        const buffer = await this.downloadTelegramFile(fileId);
        const receivedDir = path.join(process.cwd(), 'data', 'received');
        if (!fs.existsSync(receivedDir)) fs.mkdirSync(receivedDir, { recursive: true });

        const destPath = path.join(receivedDir, originalFilename);
        fs.writeFileSync(destPath, buffer);

        const absolutePath = path.resolve(destPath);
        const taskText = `[Attached File: ${absolutePath.replace(/\\/g, '/')}]${caption ? ` Caption: ${caption}` : ''}`;
        
        const deliveredToPendingRequest = this.resolveIncomingResponse(
          taskText,
          ctx.message.reply_to_message?.message_id,
          'file'
        );
        if (deliveredToPendingRequest) {
          await this.bot.api.editMessageText(
            ctx.chat.id,
            loadingMsg.message_id,
            `📁 *File received & saved!* \nAttachment details sent to agent: \`${absolutePath}\``,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const task = this.createIncomingTask({
          kind: 'file',
          text: taskText,
          dedupeKey: `update:${ctx.update.update_id}`,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.message.message_id,
          replyToMessageId: ctx.message.reply_to_message?.message_id,
          attachments: [{
            kind: 'file',
            path: absolutePath,
            name: originalFilename,
            mimeType: doc.mime_type,
            size: doc.file_size,
          }],
        });

        await this.bot.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          `📁 *File received & saved!* \nSaved to: \`${absolutePath}\`\nTask: \`${task.id}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.bot.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          `⚠️ *Failed to download file:* \n\`${errorMsg}\``,
          { parse_mode: 'Markdown' }
        );
      }
    });


    // Text messages → free-text answer or new task
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) return; // skip commands

      // If waiting for file edit
      if (this.waitingForFileEdit) {
        const filePath = this.waitingForFileEdit;
        try {
          fs.writeFileSync(filePath, text, 'utf-8');
          await ctx.reply(`✅ File \`${path.basename(filePath)}\` updated successfully on PC!`);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`⚠️ Failed to edit file:\n\`${errorMsg}\``);
        }
        this.waitingForFileEdit = null;
        return;
      }

      const deliveredToPendingRequest = this.resolveIncomingResponse(
        text,
        ctx.message.reply_to_message?.message_id,
        'text'
      );
      if (deliveredToPendingRequest) {
        await ctx.reply('✅ Response sent to the agent.');
        return;
      }

      const task = this.createIncomingTask({
        kind: 'text',
        text,
        dedupeKey: `update:${ctx.update.update_id}`,
        telegramChatId: ctx.chat.id,
        telegramMessageId: ctx.message.message_id,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
      });
      await ctx.reply(`📝 Task queued: \`${task.id}\``, { parse_mode: 'Markdown' });
    });

    // Error handler
    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error('[TG] Grammy error:', e.description);
      } else if (e instanceof HttpError) {
        console.error('[TG] HTTP error:', e);
      } else {
        console.error('[TG] Unknown error:', e);
      }
    });
  }

  // ── Remote Shell Execution ───────────────────────────────────────────────

  private async executeRemoteCommand(cmd: string): Promise<void> {
    const pid = Math.random().toString(36).substring(2, 8);
    const initialMsg = await this.bot.api.sendMessage(
      this.chatId!,
      `⏳ *Running command:* \`${cmd}\`\n\`\`\`\nStarting...\n\`\`\``,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('🛑 Cancel', `kill_proc:${pid}`),
      }
    );

    // Spawn command shell on Windows with explicit UTF-8 output encoding setup
    const utf8Setup = '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
    const processInstance = spawn('powershell.exe', ['-NoProfile', '-Command', `${utf8Setup} ${cmd}`], {
      windowsHide: true,
    });

    const runProc: RunningProcess = {
      command: cmd,
      process: processInstance,
      outputBuffer: [],
      messageId: initialMsg.message_id,
    };

    this.activeProcesses.set(pid, runProc);

    const onData = (data: Buffer) => {
      const text = data.toString('utf-8');
      runProc.outputBuffer.push(text);
    };

    processInstance.stdout.on('data', onData);
    processInstance.stderr.on('data', onData);

    // Periodic screen update (every 1.5s) to simulate a real terminal
    const interval = setInterval(async () => {
      if (!this.activeProcesses.has(pid)) {
        clearInterval(interval);
        return;
      }

      const rawLogs = runProc.outputBuffer.join('');
      const logs = rawLogs.length > 3000 ? '... [truncated] ...\n' + rawLogs.substring(rawLogs.length - 3000) : rawLogs;

      try {
        await this.bot.api.editMessageText(
          this.chatId!,
          runProc.messageId,
          `⏳ *Running:* \`${cmd}\`\n\`\`\`\n${logs || 'Waiting for output...'}\n\`\`\``,
          {
            parse_mode: 'Markdown',
            reply_markup: new InlineKeyboard().text('🛑 Cancel', `kill_proc:${pid}`),
          }
        );
      } catch {
        // ignore telegram rate limits / unchanged message body errors
      }
    }, 1500);

    processInstance.on('close', async (code) => {
      clearInterval(interval);
      this.activeProcesses.delete(pid);

      const rawLogs = runProc.outputBuffer.join('');
      const logs = rawLogs.length > 3000 ? '... [truncated] ...\n' + rawLogs.substring(rawLogs.length - 3000) : rawLogs;
      const statusIcon = code === 0 ? '✅' : '❌';

      try {
        await this.bot.api.editMessageText(
          this.chatId!,
          runProc.messageId,
          `${statusIcon} *Completed:* \`${cmd}\` (Code: ${code})\n\`\`\`\n${logs || 'No output'}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } catch {
        // ignore
      }
    });
  }

  // ── Menu Dashboard Construction ──────────────────────────────────────────

  private async sendMenu(targetChatId: number): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('📊 System Status', 'menu:status')
      .text('📝 View Task Queue', 'menu:tasks')
      .row()
      .text('🛑 Stop Commands', 'menu:stop_all');

    await this.bot.api.sendMessage(
      targetChatId,
      '🎮 *Antigravity Dashboard*\n\n' +
      'Управляйте вашим ИИ-агентом удаленно с помощью этого пульта.',
      {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      }
    );
  }

  private getStatusText(): string {
    return (
      `📊 *Antigravity Remote Status*\n\n` +
      `🔗 *Connected:* ✅\n` +
      `⏳ *Pending input requests:* ${this.pendingRequests.size}\n` +
      `📝 *Open tasks:* ${this.taskStore.countOpen()}\n` +
      `💻 *Active processes:* ${this.activeProcesses.size}\n` +
      `🎙️ *Voice control:* ${this.geminiApiKey ? '✅ Enabled' : '⚠️ Offline (No GEMINI_API_KEY in .env)'}`
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      this.bot
        .start({
          onStart: async (botInfo) => {
            console.error(`[TG] Bot @${botInfo.username} is polling`);
            
            try {
              await this.bot.api.setMyCommands([
                { command: 'menu', description: '🎮 Панель управления' },
                { command: 'files', description: '📂 Файловый проводник' },
                { command: 'status', description: '📊 Показать статус ресурсов и задач' },
                { command: 'help', description: '📚 Показать справку по командам' },
                { command: 'run', description: '💻 Запустить консольную команду' }
              ]);
              console.error('[TG] Commands registered successfully');
            } catch (err) {
              console.error('[TG] Failed to register commands:', err);
            }

            if (this.chatId) {
              console.error(`[TG] Chat ID: ${this.chatId}`);
            } else {
              console.error('[TG] No chat ID yet — use the one-time /start pairing key from setup');
            }
            resolved = true;
            resolve();
          },
        })
        .catch((err) => {
          if (!resolved) reject(err);
          else console.error('[TG] Polling stopped:', err);
        });
    });
  }

  async stop(): Promise<void> {
    for (const album of this.pendingPhotoAlbums.values()) {
      clearTimeout(album.timeout);
    }
    this.pendingPhotoAlbums.clear();

    // Terminate all active processes
    for (const [pid, proc] of this.activeProcesses) {
      proc.process.kill('SIGTERM');
    }
    this.activeProcesses.clear();

    // Reject all pending requests
    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error('Server shutting down'));
    }
    this.pendingRequests.clear();
    this.promptRequests.clear();
    try {
      await this.bot.stop();
    } finally {
      this.taskStore.close();
    }
  }

  // ── Public API (MCP-Facing) ──────────────────────────────────────────────

  get isReady(): boolean {
    return this.chatId !== null;
  }

  async notify(message: string): Promise<void> {
    this.ensureChatId();
    await this.bot.api.sendMessage(this.chatId!, message, { parse_mode: 'Markdown' });
  }

  async confirm(question: string, timeoutMs?: number): Promise<boolean> {
    this.ensureChatId();
    const requestId = this.uid();
    const timeout = timeoutMs ?? this.defaultTimeout;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `${requestId}:approve`)
      .text('❌ Deny', `${requestId}:deny`);

    const prompt = await this.bot.api.sendMessage(this.chatId!, question, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    });

    const result = await this.waitForResponse(requestId, timeout, {
      promptMessageId: prompt.message_id,
      acceptText: false,
      acceptFiles: false,
    });
    return result === 'approve';
  }

  async ask(
    question: string,
    options?: string[],
    timeoutMs?: number,
    taskId?: string,
    acceptFiles = false
  ): Promise<string> {
    this.ensureChatId();
    const requestId = this.uid();
    const timeout = timeoutMs ?? this.defaultTimeout;
    if (taskId) this.taskStore.markWaiting(taskId, question);

    let promptMessageId: number;
    if (options && options.length > 0) {
      this.optionsMap.set(requestId, options);
      const keyboard = new InlineKeyboard();
      options.forEach((opt, i) => {
        keyboard.text(opt, `${requestId}:${i}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      });
      if (options.length % 2 !== 0) keyboard.row();

      const prompt = await this.bot.api.sendMessage(this.chatId!, question, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
      promptMessageId = prompt.message_id;
    } else {
      const responseHint = acceptFiles
        ? '_↩️ Reply with text, a photo, or a file_'
        : '_↩️ Reply with a text message_';
      const prompt = await this.bot.api.sendMessage(
        this.chatId!,
        `${question}\n\n${responseHint}`,
        { parse_mode: 'Markdown' }
      );
      promptMessageId = prompt.message_id;
    }

    return this.waitForResponse(requestId, timeout, {
      taskId,
      promptMessageId,
      acceptText: !options || options.length === 0,
      acceptFiles,
    });
  }

  getInbox(statuses?: TaskStatus[], limit = 20): TelegramTask[] {
    return this.taskStore.list(statuses ?? ['new'], limit);
  }

  getTask(taskId: string): TelegramTask {
    const task = this.taskStore.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  ackTasks(taskIds: string[]): TelegramTask[] {
    if (taskIds.length === 0) throw new Error('At least one task ID is required');
    return this.taskStore.ack(taskIds);
  }

  async updateTaskProgress(
    taskId: string,
    text: string,
    percent?: number
  ): Promise<TelegramTask> {
    const task = this.taskStore.updateProgress(taskId, text, percent);
    const percentText = task.progressPercent === null ? '' : ` — ${task.progressPercent}%`;
    const keyboard = new InlineKeyboard().text('🛑 Cancel', `task_cancel:${task.id}`);
    return this.upsertTaskStatus(
      task,
      `⏳ Task ${task.id}${percentText}\n\n${text}`,
      keyboard
    );
  }

  async completeTask(
    taskId: string,
    summary: string,
    filePaths: string[] = []
  ): Promise<TelegramTask> {
    if (filePaths.length > 0) {
      await this.sendFiles(filePaths);
    }
    const task = this.taskStore.complete(taskId, summary);
    return this.upsertTaskStatus(task, `✅ Task ${task.id} completed\n\n${summary}`);
  }

  async failTask(
    taskId: string,
    error: string,
    retryable: boolean
  ): Promise<TelegramTask> {
    const task = this.taskStore.fail(taskId, error, retryable);
    const keyboard = new InlineKeyboard();
    if (retryable) keyboard.text('🔄 Retry', `task_retry:${task.id}`);
    keyboard.text('🛑 Cancel', `task_cancel:${task.id}`);
    return this.upsertTaskStatus(
      task,
      `⚠️ Task ${task.id} failed\n\n${error}`,
      keyboard
    );
  }

  checkTaskCancellation(taskId: string, markCancelled = false): TelegramTask {
    const task = this.getTask(taskId);
    if (markCancelled && task.cancelRequested && task.status !== 'cancelled') {
      return this.taskStore.markCancelled(taskId);
    }
    return task;
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    this.ensureChatId();
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const file = fs.readFileSync(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const filename = path.basename(absolutePath);

    // If it's an image, send as Photo. Otherwise send as Document.
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      await this.bot.api.sendPhoto(this.chatId!, new InputFile(file, filename), { caption });
    } else {
      await this.bot.api.sendDocument(this.chatId!, new InputFile(file, filename), { caption });
    }
  }

  async sendFiles(filePaths: string[], caption?: string): Promise<void> {
    this.ensureChatId();
    if (filePaths.length === 0) throw new Error('At least one file path is required');

    const files = filePaths.map((filePath) => {
      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new Error(`File not found: ${filePath}`);
      }
      const ext = path.extname(absolutePath).toLowerCase();
      return {
        absolutePath,
        filename: path.basename(absolutePath),
        isPhoto: ['.jpg', '.jpeg', '.png', '.webp'].includes(ext),
      };
    });

    let captionSent = false;
    for (let start = 0; start < files.length;) {
      const isPhotoGroup = files[start].isPhoto;
      const group: typeof files = [];
      while (
        start < files.length
        && files[start].isPhoto === isPhotoGroup
        && group.length < 10
      ) {
        group.push(files[start]);
        start += 1;
      }

      const groupCaption = !captionSent ? caption : undefined;
      if (group.length === 1) {
        await this.sendFile(group[0].absolutePath, groupCaption);
      } else if (isPhotoGroup) {
        const media = group.map((item, index) => InputMediaBuilder.photo(
          new InputFile(fs.readFileSync(item.absolutePath), item.filename),
          index === 0 && groupCaption ? { caption: groupCaption } : {}
        ));
        await this.bot.api.sendMediaGroup(this.chatId!, media);
      } else {
        const media = group.map((item, index) => InputMediaBuilder.document(
          new InputFile(fs.readFileSync(item.absolutePath), item.filename),
          index === 0 && groupCaption ? { caption: groupCaption } : {}
        ));
        await this.bot.api.sendMediaGroup(this.chatId!, media);
      }
      if (groupCaption) captionSent = true;
    }
  }

  async takeScreenshot(url: string, caption?: string): Promise<string> {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Set typical desktop view
    await page.setViewportSize({ width: 1280, height: 800 });
    
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    const screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    
    const filename = `screenshot_${Date.now()}.png`;
    const screenshotPath = path.join(screenshotDir, filename);
    
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await browser.close();
    
    // Upload screenshot to telegram
    await this.sendFile(screenshotPath, caption || `📸 Screenshot of ${url}`);
    
    return screenshotPath;
  }

  getMessages(): QueuedMessage[] {
    const tasks = this.taskStore.list(['new'], 100);
    if (tasks.length > 0) this.taskStore.ack(tasks.map((task) => task.id));
    return tasks.map((task) => ({
      text: `[Task ID: ${task.id}]\n${task.text}`,
      date: task.createdAt,
    }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private getPathId(absolutePath: string): string {
    for (const [id, p] of this.pathIdMap.entries()) {
      if (p === absolutePath) return id;
    }
    const id = `p${this.pathIdCounter++}`;
    this.pathIdMap.set(id, absolutePath);
    return id;
  }

  private getPathFromId(id: string): string | undefined {
    return this.pathIdMap.get(id);
  }

  private buildFileBrowserKeyboard(targetPath: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    
    // Up button
    const parentPath = path.dirname(targetPath);
    if (parentPath !== targetPath) {
      keyboard.text('⬆️ Up', `fb_dir:${this.getPathId(parentPath)}`).row();
    }

    try {
      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      
      // Filter out system folders
      const ignored = ['node_modules', '.git', 'dist', 'data', '.agents', '.gemini', 'package-lock.json'];
      
      const dirs = items
        .filter(item => item.isDirectory() && !ignored.includes(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));
        
      const files = items
        .filter(item => item.isFile() && !ignored.includes(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Add directories first
      dirs.slice(0, 15).forEach((d) => {
        const fullPath = path.join(targetPath, d.name);
        keyboard.text(`📁 ${d.name}`, `fb_dir:${this.getPathId(fullPath)}`).row();
      });

      // Add files
      files.slice(0, 15).forEach((f) => {
        const fullPath = path.join(targetPath, f.name);
        keyboard.text(`📄 ${f.name}`, `fb_file:${this.getPathId(fullPath)}`).row();
      });

      if (dirs.length + files.length > 30) {
        keyboard.text('⚠️ ... (truncated) ...', 'noop').row();
      }
    } catch (err) {
      keyboard.text('⚠️ Error reading directory', 'noop').row();
    }

    // Refresh and Menu buttons
    keyboard.text('🔄 Refresh', `fb_dir:${this.getPathId(targetPath)}`);
    keyboard.text('🔙 Dashboard', 'menu:status');

    return keyboard;
  }

  private async sendFileBrowser(chatId: number, targetPath: string): Promise<void> {
    const keyboard = this.buildFileBrowserKeyboard(targetPath);
    await this.bot.api.sendMessage(
      chatId,
      `📂 *File Browser*\n\nPath: \`${targetPath.replace(/\\/g, '/')}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
  }

  private async editFileBrowser(ctx: any, targetPath: string): Promise<void> {
    const keyboard = this.buildFileBrowserKeyboard(targetPath);
    try {
      await ctx.editMessageText(
        `📂 *File Browser*\n\nPath: \`${targetPath.replace(/\\/g, '/')}\``,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );
    } catch {
      // ignore
    }
  }

  private async showFileMenu(ctx: any, filePath: string): Promise<void> {
    const pathId = this.getPathId(filePath);
    const parentPath = path.dirname(filePath);
    const keyboard = new InlineKeyboard()
      .text('📄 View Content', `fb_view:${pathId}`)
      .text('✏️ Edit File', `fb_edit:${pathId}`)
      .row()
      .text('🤖 Send to Agent', `fb_agent:${pathId}`)
      .text('🔙 Back', `fb_dir:${this.getPathId(parentPath)}`);

    await ctx.editMessageText(
      `📄 *File:* \`${path.basename(filePath)}\`\n` +
      `Path: \`${filePath.replace(/\\/g, '/')}\`\n\n` +
      `Выберите действие:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
  }

  private getMarkdownLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.js': return 'javascript';
      case '.ts': return 'typescript';
      case '.jsx': return 'jsx';
      case '.tsx': return 'tsx';
      case '.json': return 'json';
      case '.md': return 'markdown';
      case '.py': return 'python';
      case '.html': return 'html';
      case '.css': return 'css';
      case '.sh': return 'bash';
      case '.ps1': return 'powershell';
      case '.yml':
      case '.yaml': return 'yaml';
      default: return '';
    }
  }

  private async viewFileContent(ctx: any, filePath: string): Promise<void> {
    try {
      const stats = fs.statSync(filePath);
      const filename = path.basename(filePath);
      const pathId = this.getPathId(filePath);

      // Read file content first to check for formatting conflicts
      const content = fs.readFileSync(filePath, 'utf-8');
      const containsBackticks = content.includes('```');

      // If file is large (> 10KB) OR contains nested triple backticks that break Telegram formatting, send as document
      if (stats.size > 10_000 || containsBackticks) {
        const reason = containsBackticks 
          ? 'для сохранения структуры разметки кода' 
          : `размер ${Math.round(stats.size / 1024)} KB превышает лимит сообщения`;
        
        await ctx.reply(`📦 *Файл отправлен в виде документа (${reason}).*`, { parse_mode: 'Markdown' });
        
        const keyboard = new InlineKeyboard()
          .text('✏️ Edit File', `fb_edit:${pathId}`)
          .text('🤖 Send to Agent', `fb_agent:${pathId}`)
          .row()
          .text('🔙 Back', `fb_file:${pathId}`);

        await this.sendFile(filePath, `📄 ${filename}`);
        await ctx.reply('Выберите действие для этого файла:', { reply_markup: keyboard });
        return;
      }

      // Small file -> show inline with correct markdown formatting
      const lang = this.getMarkdownLanguage(filePath);
      
      const keyboard = new InlineKeyboard()
        .text('✏️ Edit File', `fb_edit:${pathId}`)
        .text('🤖 Send to Agent', `fb_agent:${pathId}`)
        .row()
        .text('🔙 Back', `fb_file:${pathId}`);

      await ctx.reply(
        `📄 *File:* \`${filename}\`\n\n` +
        `\`\`\`${lang}\n${content}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`⚠️ Failed to view file: \`${errorMsg}\``);
    }
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const fileInfo = await this.bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download file from Telegram: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private ensureChatId(): void {
    if (!this.chatId) {
      throw new Error('Chat ID not set. Send /start to the Telegram bot first.');
    }
  }

  private waitForResponse(
    requestId: string,
    timeoutMs: number,
    options?: {
      taskId?: string;
      promptMessageId?: number;
      acceptText?: boolean;
      acceptFiles?: boolean;
    }
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.optionsMap.delete(requestId);
        if (options?.promptMessageId !== undefined) {
          this.promptRequests.delete(options.promptMessageId);
        }
        if (options?.taskId) {
          this.taskStore.resume(options.taskId);
        }
        reject(new Error(`Response timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        id: requestId,
        resolve,
        reject,
        timeout,
        taskId: options?.taskId,
        promptMessageId: options?.promptMessageId,
        acceptText: options?.acceptText ?? false,
        acceptFiles: options?.acceptFiles ?? false,
      });
      if (options?.promptMessageId !== undefined) {
        this.promptRequests.set(options.promptMessageId, requestId);
      }
    });
  }

  private uid(): string {
    return Math.random().toString(36).substring(2, 11);
  }
}
