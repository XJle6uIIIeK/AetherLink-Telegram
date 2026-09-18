export type TaskStatus = 'new' | 'accepted' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled';
export type TaskKind = 'text' | 'voice' | 'photo' | 'file' | 'local_file';
export interface TaskAttachment {
    id: number;
    taskId: string;
    kind: 'image' | 'file';
    path: string;
    name: string;
    mimeType: string | null;
    size: number | null;
    sortOrder: number;
}
export interface TelegramTask {
    id: string;
    kind: TaskKind;
    text: string;
    status: TaskStatus;
    priority: number;
    progressPercent: number | null;
    progressText: string | null;
    error: string | null;
    retryable: boolean;
    retryCount: number;
    cancelRequested: boolean;
    telegramChatId: number | null;
    telegramMessageId: number | null;
    replyToMessageId: number | null;
    mediaGroupId: string | null;
    statusMessageId: number | null;
    createdAt: string;
    updatedAt: string;
    acceptedAt: string | null;
    completedAt: string | null;
    attachments: TaskAttachment[];
}
export interface CreateTaskInput {
    kind: TaskKind;
    text: string;
    dedupeKey?: string;
    priority?: number;
    telegramChatId?: number;
    telegramMessageId?: number;
    replyToMessageId?: number;
    mediaGroupId?: string;
    attachments?: Array<{
        kind: 'image' | 'file';
        path: string;
        name?: string;
        mimeType?: string;
        size?: number;
    }>;
}
export declare class TaskStore {
    private readonly db;
    constructor(dbPath: string);
    create(input: CreateTaskInput): TelegramTask;
    list(statuses?: TaskStatus[], limit?: number): TelegramTask[];
    get(id: string): TelegramTask | null;
    ack(ids: string[]): TelegramTask[];
    updateProgress(id: string, text: string, percent?: number): TelegramTask;
    markWaiting(id: string, question: string): TelegramTask;
    resume(id: string): TelegramTask;
    complete(id: string, summary: string): TelegramTask;
    fail(id: string, error: string, retryable: boolean): TelegramTask;
    requestCancel(id: string): TelegramTask;
    markCancelled(id: string): TelegramTask;
    retry(id: string): TelegramTask;
    setStatusMessageId(id: string, messageId: number): TelegramTask;
    countOpen(): number;
    close(): void;
    private migrate;
    private require;
    private getByDedupeKey;
    private hydrate;
    private ensureNotTerminal;
    private ensureActionable;
    private addEvent;
}
