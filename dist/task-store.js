import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class TaskStore {
    db;
    constructor(dbPath) {
        const absolutePath = path.resolve(dbPath);
        const directory = path.dirname(absolutePath);
        if (!fs.existsSync(directory))
            fs.mkdirSync(directory, { recursive: true });
        this.db = new DatabaseSync(absolutePath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrate();
    }
    create(input) {
        const id = randomUUID();
        const now = new Date().toISOString();
        const dedupeKey = input.dedupeKey ?? null;
        const statement = this.db.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, dedupe_key, kind, text, status, priority,
        telegram_chat_id, telegram_message_id, reply_to_message_id, media_group_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
    `);
        const result = statement.run(id, dedupeKey, input.kind, input.text, input.priority ?? 0, input.telegramChatId ?? null, input.telegramMessageId ?? null, input.replyToMessageId ?? null, input.mediaGroupId ?? null, now, now);
        if (result.changes === 0) {
            if (!dedupeKey)
                throw new Error('Failed to create task');
            const existing = this.getByDedupeKey(dedupeKey);
            if (!existing)
                throw new Error(`Task deduplication failed for ${dedupeKey}`);
            return existing;
        }
        const attachmentStatement = this.db.prepare(`
      INSERT INTO task_attachments (
        task_id, kind, path, name, mime_type, size, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        for (const [index, attachment] of (input.attachments ?? []).entries()) {
            attachmentStatement.run(id, attachment.kind, path.resolve(attachment.path), attachment.name ?? path.basename(attachment.path), attachment.mimeType ?? null, attachment.size ?? null, index);
        }
        this.addEvent(id, 'created', { kind: input.kind });
        return this.require(id);
    }
    list(statuses = ['new'], limit = 20) {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
        const selectedStatuses = statuses.length > 0 ? statuses : ['new'];
        const placeholders = selectedStatuses.map(() => '?').join(', ');
        const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN (${placeholders})
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(...selectedStatuses, safeLimit);
        return rows.map((row) => this.hydrate(row));
    }
    get(id) {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        return row ? this.hydrate(row) : null;
    }
    ack(ids) {
        const now = new Date().toISOString();
        const statement = this.db.prepare(`
      UPDATE tasks
      SET status = CASE WHEN status = 'new' THEN 'accepted' ELSE status END,
          accepted_at = COALESCE(accepted_at, ?),
          updated_at = ?
      WHERE id = ?
    `);
        const tasks = [];
        for (const id of ids) {
            const result = statement.run(now, now, id);
            if (result.changes === 0)
                throw new Error(`Task not found: ${id}`);
            this.addEvent(id, 'accepted');
            tasks.push(this.require(id));
        }
        return tasks;
    }
    updateProgress(id, text, percent) {
        const task = this.require(id);
        this.ensureActionable(task);
        const normalizedPercent = percent === undefined
            ? null
            : Math.min(Math.max(Math.trunc(percent), 0), 100);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'running',
          progress_text = ?,
          progress_percent = ?,
          updated_at = ?
      WHERE id = ?
    `).run(text, normalizedPercent, now, id);
        this.addEvent(id, 'progress', { text, percent: normalizedPercent });
        return this.require(id);
    }
    markWaiting(id, question) {
        const task = this.require(id);
        this.ensureActionable(task);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'waiting_user', progress_text = ?, updated_at = ?
      WHERE id = ?
    `).run(question, now, id);
        this.addEvent(id, 'waiting_user', { question });
        return this.require(id);
    }
    resume(id) {
        const task = this.require(id);
        if (task.status !== 'waiting_user')
            return task;
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'running', updated_at = ?
      WHERE id = ?
    `).run(now, id);
        this.addEvent(id, 'user_responded');
        return this.require(id);
    }
    complete(id, summary) {
        const task = this.require(id);
        this.ensureActionable(task);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'completed',
          progress_text = ?,
          progress_percent = 100,
          cancel_requested = 0,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(summary, now, now, id);
        this.addEvent(id, 'completed', { summary });
        return this.require(id);
    }
    fail(id, error, retryable) {
        const task = this.require(id);
        this.ensureActionable(task);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'failed',
          error = ?,
          retryable = ?,
          updated_at = ?
      WHERE id = ?
    `).run(error, retryable ? 1 : 0, now, id);
        this.addEvent(id, 'failed', { error, retryable });
        return this.require(id);
    }
    requestCancel(id) {
        const task = this.require(id);
        if (task.status === 'completed' || task.status === 'cancelled')
            return task;
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'cancel_requested',
          cancel_requested = 1,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
        this.addEvent(id, 'cancel_requested');
        return this.require(id);
    }
    markCancelled(id) {
        const task = this.require(id);
        if (task.status === 'completed')
            return task;
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'cancelled',
          cancel_requested = 1,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
        this.addEvent(id, 'cancelled');
        return this.require(id);
    }
    retry(id) {
        const task = this.require(id);
        if (!['failed', 'cancel_requested', 'cancelled'].includes(task.status)) {
            throw new Error(`Task ${id} cannot be retried from status ${task.status}`);
        }
        if (task.status === 'failed' && !task.retryable) {
            throw new Error(`Task ${id} is not retryable`);
        }
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status = 'new',
          progress_percent = NULL,
          progress_text = NULL,
          error = NULL,
          cancel_requested = 0,
          retry_count = retry_count + 1,
          accepted_at = NULL,
          completed_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
        this.addEvent(id, 'retried');
        return this.require(id);
    }
    setStatusMessageId(id, messageId) {
        this.require(id);
        const now = new Date().toISOString();
        this.db.prepare(`
      UPDATE tasks
      SET status_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(messageId, now, id);
        return this.require(id);
    }
    countOpen() {
        const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE status NOT IN ('completed', 'cancelled')
    `).get();
        return row.count;
    }
    close() {
        this.db.close();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        progress_percent INTEGER,
        progress_text TEXT,
        error TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        telegram_chat_id INTEGER,
        telegram_message_id INTEGER,
        reply_to_message_id INTEGER,
        media_group_id TEXT,
        status_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_created
        ON tasks(status, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_task
        ON task_attachments(task_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_events_task
        ON task_events(task_id, created_at);
    `);
    }
    require(id) {
        const task = this.get(id);
        if (!task)
            throw new Error(`Task not found: ${id}`);
        return task;
    }
    getByDedupeKey(dedupeKey) {
        const row = this.db.prepare('SELECT * FROM tasks WHERE dedupe_key = ?').get(dedupeKey);
        return row ? this.hydrate(row) : null;
    }
    hydrate(row) {
        const attachmentRows = this.db.prepare(`
      SELECT * FROM task_attachments
      WHERE task_id = ?
      ORDER BY sort_order ASC, id ASC
    `).all(row.id);
        return {
            id: row.id,
            kind: row.kind,
            text: row.text,
            status: row.status,
            priority: row.priority,
            progressPercent: row.progress_percent,
            progressText: row.progress_text,
            error: row.error,
            retryable: row.retryable === 1,
            retryCount: row.retry_count,
            cancelRequested: row.cancel_requested === 1,
            telegramChatId: row.telegram_chat_id,
            telegramMessageId: row.telegram_message_id,
            replyToMessageId: row.reply_to_message_id,
            mediaGroupId: row.media_group_id,
            statusMessageId: row.status_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            acceptedAt: row.accepted_at,
            completedAt: row.completed_at,
            attachments: attachmentRows.map((attachment) => ({
                id: attachment.id,
                taskId: attachment.task_id,
                kind: attachment.kind,
                path: attachment.path,
                name: attachment.name,
                mimeType: attachment.mime_type,
                size: attachment.size,
                sortOrder: attachment.sort_order,
            })),
        };
    }
    ensureNotTerminal(task) {
        if (task.status === 'completed' || task.status === 'cancelled') {
            throw new Error(`Task ${task.id} is already ${task.status}`);
        }
    }
    ensureActionable(task) {
        this.ensureNotTerminal(task);
        if (task.cancelRequested || task.status === 'cancel_requested') {
            throw new Error(`Cancellation was requested for task ${task.id}`);
        }
    }
    addEvent(taskId, event, payload) {
        this.db.prepare(`
      INSERT INTO task_events (task_id, event, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, event, payload === undefined ? null : JSON.stringify(payload), new Date().toISOString());
    }
}
