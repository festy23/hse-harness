import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Approvals } from '../src/approvals.js';
import type { Store, Approval } from '../src/store.js';
function pending(id: string, chat: string): Approval {
  return {
    id,
    kind: 'question',
    payload: { chat, text: 'fixture' },
    state: 'sending',
    randomId: id,
    created: 0,
  };
}
test('revoked historical approval is terminalized without blocking recovery of another send', async () => {
  const revoked = pending('1', 'revoked'),
    valid = pending('2', 'allowed');
  let writes = 0;
  const sent: string[] = [];
  const store = {
    state: { approvals: [revoked, valid], notices: {} },
    save: async () => {
      writes++;
    },
  } as unknown as Store;
  const a = new Approvals(
    store,
    { send: async () => {} },
    {
      question: async (_chat, _text, id) => {
        sent.push(id);
        return 'reply';
      },
      lesson: async () => {},
    },
    new Set(['allowed']),
  );
  await assert.rejects(() => a.recover(), /больше не разрешен/);
  assert.equal(revoked.state, 'rejected');
  assert.equal(valid.state, 'sent');
  assert.deepEqual(sent, ['2']);
  assert.match(Object.values(store.state.notices)[0]!, /неизвестен/);
  assert.ok(writes >= 2);
  await a.recover();
  assert.deepEqual(sent, ['2']);
  assert.equal(revoked.randomId, '1');
});
test('unknown send result retains payload and random ID, while other approvals recover', async () => {
  const uncertain = pending('1', 'allowed'),
    valid = pending('2', 'allowed');
  const ids: string[] = [];
  const store = {
    state: { approvals: [uncertain, valid], notices: {} },
    save: async () => {},
  } as unknown as Store;
  const a = new Approvals(
    store,
    { send: async () => {} },
    {
      question: async (_c, _t, id) => {
        ids.push(id);
        if (id === '1') {
          throw Error('reply lost');
        }
        return 'reply';
      },
      lesson: async () => {},
    },
    new Set(['allowed']),
  );
  await assert.rejects(() => a.recover(), /reply lost/);
  assert.equal(uncertain.state, 'sending');
  assert.equal(valid.state, 'sent');
  await assert.rejects(() => a.recover(), /reply lost/);
  assert.deepEqual(ids, ['1', '2', '1']);
});
