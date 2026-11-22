import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerQuestionHandoff } from '../src/worker-question.mjs';
test('an unresolved question stops the runtime and remains visible to the caller', async () => {
  let handler, disposed = 0, published = 0;
  const ctx = { on(name, h, prepend) { assert.equal(name, 'user-questions/request'); assert.equal(prepend, true); handler = h; } };
  const job = { status: 'running', handle: { dispose() { disposed++; } } };
  installWorkerQuestionHandoff(ctx, job, () => published++);
  await assert.rejects(handler({ questions: [{ id: 'overwrite', question: 'Overwrite existing file?', options: [{ label: 'Yes' }, { label: 'No' }] }] }), /no option was selected automatically/);
  assert.equal(disposed, 1); assert.equal(published, 1); assert.equal(job.status, 'needs_input');
  assert.equal(job.questions[0].question, 'Overwrite existing file?');
  assert.equal(JSON.parse(job.result).needs_input, true);
});

test('a persistent job cancels only the turn and keeps its reusable handle', async () => {
  let handler, disposed = 0, published = 0;
  const cancels = [];
  const ctx = { on(name, h, prepend) { assert.equal(name, 'user-questions/request'); assert.equal(prepend, true); handler = h; } };
  // Persistent sessions pass a getter: the active job may be replaced between
  // turns, so the handler must resolve it at fire time, not at install time.
  let current = null;
  const job = {
    status: 'running',
    persistent: true,
    handle: {
      dispose() { disposed++; },
      agent: { cancel(reason) { cancels.push(reason); } },
    },
  };
  current = { status: 'running', persistent: true, handle: { dispose() { disposed++; } } };
  installWorkerQuestionHandoff(ctx, () => current, () => published++);
  current = job;
  await assert.rejects(
    handler({ questions: [{ id: 'overwrite', question: 'Overwrite existing file?', options: [{ label: 'Yes' }, { label: 'No' }] }] }),
    /no option was selected automatically/,
  );
  assert.deepEqual(cancels, [{ kind: 'hook', reason: 'unattended-worker' }]);
  assert.equal(disposed, 0);
  assert.equal(published, 1);
  assert.equal(job.status, 'needs_input');
  assert.equal(job.questions[0].question, 'Overwrite existing file?');
  assert.equal(JSON.parse(job.result).needs_input, true);
  // The resolver is consulted per event, so a replaced active job gets the update.
  assert.equal(current.status, 'needs_input');
});

test('question fields are still truncated to their documented limits', async () => {
  let handler;
  const ctx = { on(name, h, prepend) { assert.equal(name, 'user-questions/request'); assert.equal(prepend, true); handler = h; } };
  const job = { status: 'running', persistent: true, handle: { agent: { cancel() {} } } };
  installWorkerQuestionHandoff(ctx, () => job, () => {});
  await assert.rejects(handler({
    questions: Array.from({ length: 20 }, (_, i) => ({
      id: 'i'.repeat(300),
      question: 'q'.repeat(5000),
      detail: 'd'.repeat(13000),
      options: Array.from({ length: 40 }, (_, n) => ({ label: 'l'.repeat(600) + n })),
    })),
  }), /no option was selected automatically/);
  assert.equal(job.questions.length, 16);
  assert.equal(job.questions[0].id.length, 200);
  assert.equal(job.questions[0].question.length, 4000);
  assert.equal(job.questions[0].detail.length, 12000);
  assert.equal(job.questions[0].options.length, 32);
  assert.equal(job.questions[0].options[0].label.length, 500);
});
