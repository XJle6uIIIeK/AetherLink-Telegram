import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../dist/task-store.js';

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-task-store-'));
  const attachmentPath = path.join(directory, 'photo.jpg');
  fs.writeFileSync(attachmentPath, Buffer.from('image'));
  const databasePath = path.join(directory, 'tasks.sqlite');
  const store = new TaskStore(databasePath);
  return { attachmentPath, databasePath, directory, store };
}

test('persists and deduplicates structured tasks with attachments', () => {
  const fixture = createFixture();
  try {
    const created = fixture.store.create({
      kind: 'photo',
      text: 'Inspect these photos',
      dedupeKey: 'media:album-1',
      telegramChatId: 42,
      telegramMessageId: 100,
      mediaGroupId: 'album-1',
      attachments: [{
        kind: 'image',
        path: fixture.attachmentPath,
        mimeType: 'image/jpeg',
        size: 5,
      }],
    });
    const duplicate = fixture.store.create({
      kind: 'photo',
      text: 'Duplicate Telegram update',
      dedupeKey: 'media:album-1',
    });

    assert.equal(duplicate.id, created.id);
    assert.equal(fixture.store.list(['new']).length, 1);
    assert.equal(created.attachments.length, 1);
    assert.equal(created.attachments[0].path, path.resolve(fixture.attachmentPath));

    fixture.store.close();
    const reopened = new TaskStore(fixture.databasePath);
    try {
      const persisted = reopened.get(created.id);
      assert.ok(persisted);
      assert.equal(persisted.text, 'Inspect these photos');
      assert.equal(persisted.attachments.length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('supports the accepted, running, waiting, and completed lifecycle', () => {
  const fixture = createFixture();
  try {
    const task = fixture.store.create({ kind: 'text', text: 'Build it' });
    assert.equal(task.status, 'new');

    assert.equal(fixture.store.ack([task.id])[0].status, 'accepted');
    const running = fixture.store.updateProgress(task.id, 'Working', 25);
    assert.equal(running.status, 'running');
    assert.equal(running.progressPercent, 25);

    assert.equal(fixture.store.markWaiting(task.id, 'Which color?').status, 'waiting_user');
    assert.equal(fixture.store.resume(task.id).status, 'running');

    const completed = fixture.store.complete(task.id, 'Done');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progressPercent, 100);
    assert.throws(
      () => fixture.store.updateProgress(task.id, 'Too late'),
      /already completed/
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('supports retry and cooperative cancellation', () => {
  const fixture = createFixture();
  try {
    const retryTask = fixture.store.create({ kind: 'text', text: 'Retry me' });
    fixture.store.ack([retryTask.id]);
    assert.equal(fixture.store.fail(retryTask.id, 'Temporary failure', true).status, 'failed');
    const retried = fixture.store.retry(retryTask.id);
    assert.equal(retried.status, 'new');
    assert.equal(retried.retryCount, 1);

    const cancelTask = fixture.store.create({ kind: 'text', text: 'Cancel me' });
    const requested = fixture.store.requestCancel(cancelTask.id);
    assert.equal(requested.status, 'cancel_requested');
    assert.equal(requested.cancelRequested, true);
    assert.throws(
      () => fixture.store.complete(cancelTask.id, 'Should not complete'),
      /Cancellation was requested/
    );
    assert.equal(fixture.store.markCancelled(cancelTask.id).status, 'cancelled');
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
