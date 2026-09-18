import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TelegramBridge } from './telegram.js';
import type { TaskStatus } from './task-store.js';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Env ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
config({ path: path.join(projectRoot, '.env') });

// Redirect console.log → stderr (stdout is reserved for MCP JSON-RPC)
const _origLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
  : undefined;
const TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || '300000', 10);

if (!BOT_TOKEN) {
  console.error('[MCP] TELEGRAM_BOT_TOKEN is required in .env');
  process.exit(1);
}

// ── Telegram ────────────────────────────────────────────────────────────────

const telegram = new TelegramBridge(BOT_TOKEN, {
  chatId: CHAT_ID && !isNaN(CHAT_ID) ? CHAT_ID : undefined,
  dataDir: process.env.AETHERLINK_DATA_DIR || path.join(projectRoot, 'data'),
  timeoutMs: TIMEOUT_MS,
});

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'antigravity-telegram', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tools: List ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'tg_notify',
      description:
        'Send a notification to the user via Telegram. ' +
        'Use for task completion reports, progress updates, or important events. ' +
        'Supports Markdown formatting.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'Notification text (Markdown supported)',
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'tg_confirm',
      description:
        'Ask the user for yes/no confirmation via Telegram (Approve / Deny buttons). ' +
        'Use for permission requests. Blocks until the user responds.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: {
            type: 'string',
            description: 'The confirmation question (Markdown supported)',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Max wait time in seconds (default: 300)',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'tg_ask',
      description:
        'Ask the user a question via Telegram. ' +
        'Provide `options` for button-based answers, or omit for free-text reply. ' +
        'Blocks until the user responds.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask (Markdown supported)',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Answer choices shown as inline buttons. Omit for free-text response.',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Max wait time in seconds (default: 300)',
          },
          task_id: {
            type: 'string',
            description: 'Optional task ID whose state should become waiting_user',
          },
          accept_files: {
            type: 'boolean',
            description: 'Allow the user to answer with a photo or document',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'tg_inbox',
      description:
        'List durable Telegram tasks without removing them. ' +
        'Returns structured JSON including IDs, states, metadata, and attachments.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          statuses: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'new',
                'accepted',
                'running',
                'waiting_user',
                'completed',
                'failed',
                'cancel_requested',
                'cancelled',
              ],
            },
            description: 'Statuses to include (default: new)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of tasks, from 1 to 100 (default: 20)',
          },
        },
      },
    },
    {
      name: 'tg_ack',
      description:
        'Acknowledge one or more inbox tasks. New tasks become accepted and remain durable.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: {
            type: 'string',
            description: 'A single task ID',
          },
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple task IDs',
          },
        },
      },
    },
    {
      name: 'tg_progress',
      description:
        'Update task progress and edit one persistent Telegram status message. ' +
        'The message includes a Cancel button.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          text: { type: 'string', description: 'Current progress description' },
          percent: {
            type: 'number',
            description: 'Optional completion percentage from 0 to 100',
          },
        },
        required: ['task_id', 'text'],
      },
    },
    {
      name: 'tg_complete',
      description:
        'Complete a task, update its status message, and optionally send multiple result files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          summary: { type: 'string', description: 'Completion summary' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional local result file paths',
          },
        },
        required: ['task_id', 'summary'],
      },
    },
    {
      name: 'tg_fail',
      description:
        'Mark a task as failed and show Retry/Cancel controls in Telegram.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          error: { type: 'string', description: 'Human-readable failure reason' },
          retryable: {
            type: 'boolean',
            description: 'Whether the user may return this task to the inbox',
          },
        },
        required: ['task_id', 'error', 'retryable'],
      },
    },
    {
      name: 'tg_cancelled',
      description:
        'Check whether cancellation was requested for a task. ' +
        'Optionally acknowledge it by marking the task cancelled.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          mark_cancelled: {
            type: 'boolean',
            description: 'Mark the task cancelled when a request is present',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'tg_task_status',
      description: 'Get the durable state and metadata for one task.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'tg_get_tasks',
      description:
        'Legacy compatibility tool. Retrieves new tasks and marks them accepted. ' +
        'Prefer tg_inbox followed by tg_ack.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'tg_send_file',
      description:
        'Send a local file (archive, log, PDF, or image) to the user via Telegram. ' +
        'Automatically detects images and renders them inline.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file on disk',
          },
          caption: {
            type: 'string',
            description: 'Optional description of the file',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'tg_send_files',
      description:
        'Send multiple local files in one call. Consecutive images or documents ' +
        'are grouped into Telegram albums of up to 10 items.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Local file paths in send order',
          },
          caption: {
            type: 'string',
            description: 'Optional caption placed on the first item',
          },
        },
        required: ['filePaths'],
      },
    },
    {
      name: 'tg_take_screenshot',
      description:
        'Open a URL (e.g. local web app dev server, document, page) in headless Chromium, ' +
        'capture a screenshot, and send it to the user via Telegram.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'The URL to open and capture (e.g. http://localhost:5173)',
          },
          caption: {
            type: 'string',
            description: 'Optional description of the screenshot',
          },
        },
        required: ['url'],
      },
    },
  ],
}));

// ── Tools: Call ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── tg_notify ──────────────────────────────────────────────────────
      case 'tg_notify': {
        const message = args?.message as string;
        if (!message) throw new Error('`message` is required');
        await telegram.notify(message);
        return { content: [{ type: 'text', text: '✅ Notification sent.' }] };
      }

      // ── tg_confirm ─────────────────────────────────────────────────────
      case 'tg_confirm': {
        const question = args?.question as string;
        if (!question) throw new Error('`question` is required');
        const timeoutMs =
          ((args?.timeout_seconds as number | undefined) ?? 300) * 1000;

        const approved = await telegram.confirm(question, timeoutMs);
        return {
          content: [
            {
              type: 'text',
              text: approved ? 'APPROVED' : 'DENIED',
            },
          ],
        };
      }

      // ── tg_ask ─────────────────────────────────────────────────────────
      case 'tg_ask': {
        const question = args?.question as string;
        if (!question) throw new Error('`question` is required');
        const options = args?.options as string[] | undefined;
        const timeoutMs =
          ((args?.timeout_seconds as number | undefined) ?? 300) * 1000;
        const taskId = args?.task_id as string | undefined;
        const acceptFiles = (args?.accept_files as boolean | undefined) ?? false;

        const answer = await telegram.ask(
          question,
          options,
          timeoutMs,
          taskId,
          acceptFiles
        );
        return { content: [{ type: 'text', text: answer }] };
      }

      // ── tg_inbox ───────────────────────────────────────────────────────
      case 'tg_inbox': {
        const statuses = args?.statuses as TaskStatus[] | undefined;
        const limit = (args?.limit as number | undefined) ?? 20;
        const tasks = telegram.getInbox(statuses, limit);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
          }],
        };
      }

      // ── tg_ack ─────────────────────────────────────────────────────────
      case 'tg_ack': {
        const singleId = args?.task_id as string | undefined;
        const multipleIds = args?.task_ids as string[] | undefined;
        const taskIds = [...new Set([
          ...(singleId ? [singleId] : []),
          ...(multipleIds ?? []),
        ])];
        const tasks = telegram.ackTasks(taskIds);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ acknowledged: tasks.map((task) => task.id), tasks }, null, 2),
          }],
        };
      }

      // ── tg_progress ────────────────────────────────────────────────────
      case 'tg_progress': {
        const taskId = args?.task_id as string;
        const text = args?.text as string;
        if (!taskId) throw new Error('`task_id` is required');
        if (!text) throw new Error('`text` is required');
        const percent = args?.percent as number | undefined;
        const task = await telegram.updateTaskProgress(taskId, text, percent);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      // ── tg_complete ────────────────────────────────────────────────────
      case 'tg_complete': {
        const taskId = args?.task_id as string;
        const summary = args?.summary as string;
        if (!taskId) throw new Error('`task_id` is required');
        if (!summary) throw new Error('`summary` is required');
        const files = (args?.files as string[] | undefined) ?? [];
        const task = await telegram.completeTask(taskId, summary, files);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      // ── tg_fail ────────────────────────────────────────────────────────
      case 'tg_fail': {
        const taskId = args?.task_id as string;
        const error = args?.error as string;
        if (!taskId) throw new Error('`task_id` is required');
        if (!error) throw new Error('`error` is required');
        if (typeof args?.retryable !== 'boolean') {
          throw new Error('`retryable` is required');
        }
        const task = await telegram.failTask(taskId, error, args.retryable as boolean);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      // ── tg_cancelled ───────────────────────────────────────────────────
      case 'tg_cancelled': {
        const taskId = args?.task_id as string;
        if (!taskId) throw new Error('`task_id` is required');
        const markCancelled = (args?.mark_cancelled as boolean | undefined) ?? false;
        const task = telegram.checkTaskCancellation(taskId, markCancelled);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: task.id,
              status: task.status,
              cancellation_requested: task.cancelRequested,
              cancelled: task.status === 'cancelled',
            }, null, 2),
          }],
        };
      }

      // ── tg_task_status ─────────────────────────────────────────────────
      case 'tg_task_status': {
        const taskId = args?.task_id as string;
        if (!taskId) throw new Error('`task_id` is required');
        const task = telegram.getTask(taskId);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      // ── tg_get_tasks ───────────────────────────────────────────────────
      case 'tg_get_tasks': {
        const messages = telegram.getMessages();
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No new tasks.' }] };
        }
        const formatted = messages
          .map((m, i) => `${i + 1}. [${m.date}] ${m.text}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `${messages.length} new task(s):\n${formatted}`,
            },
          ],
        };
      }

      // ── tg_send_file ───────────────────────────────────────────────────
      case 'tg_send_file': {
        const filePath = args?.filePath as string;
        if (!filePath) throw new Error('`filePath` is required');
        const caption = args?.caption as string | undefined;

        await telegram.sendFile(filePath, caption);
        return { content: [{ type: 'text', text: `✅ File "${path.basename(filePath)}" sent.` }] };
      }

      // ── tg_send_files ──────────────────────────────────────────────────
      case 'tg_send_files': {
        const filePaths = args?.filePaths as string[] | undefined;
        if (!filePaths || filePaths.length === 0) {
          throw new Error('`filePaths` must contain at least one path');
        }
        const caption = args?.caption as string | undefined;
        await telegram.sendFiles(filePaths, caption);
        return {
          content: [{
            type: 'text',
            text: `✅ ${filePaths.length} file(s) sent.`,
          }],
        };
      }

      // ── tg_take_screenshot ──────────────────────────────────────────────
      case 'tg_take_screenshot': {
        const url = args?.url as string;
        if (!url) throw new Error('`url` is required');
        const caption = args?.caption as string | undefined;

        const savedPath = await telegram.takeScreenshot(url, caption);
        return { content: [{ type: 'text', text: `✅ Screenshot captured and sent. Saved locally at ${savedPath}` }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error('[MCP] Starting Antigravity Telegram Bridge…');

  await telegram.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] MCP server connected via stdio');

  const shutdown = async () => {
    console.error('[MCP] Shutting down…');
    await telegram.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[MCP] Fatal:', err);
  process.exit(1);
});
