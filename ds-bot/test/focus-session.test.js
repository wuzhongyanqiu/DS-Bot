import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botSessionOf } from '../src/client/focus-session.js'

// The window reports only a Bot's own chat; a group chat or an Agent Session must
// report null so the host can release the Bot chat it kept warm.
test('only a Bot session counts as the focused conversation', () => {
  const roster = {
    bots: [
      { id: 'chief', sessionId: 'part-2', parts: ['part-1', 'part-2'] },
      { id: 'writer', sessionId: 'writer', parts: [] },
    ],
  }
  // The Bot's id and any of its parts map to the current chat that stays warm.
  assert.equal(botSessionOf(roster, 'chief'), 'part-2')
  assert.equal(botSessionOf(roster, 'part-2'), 'part-2')
  // An earlier part maps to the Bot's current chat, which is the one that stays warm.
  assert.equal(botSessionOf(roster, 'part-1'), 'part-2')
  assert.equal(botSessionOf(roster, 'writer'), 'writer')
  // A group chat's own Session, a DSH Agent Session and an empty view release it.
  assert.equal(botSessionOf(roster, 'room-1'), null)
  assert.equal(botSessionOf(roster, 'agent-session'), null)
  assert.equal(botSessionOf(roster, ''), null)
  assert.equal(botSessionOf(roster, undefined), null)
  assert.equal(botSessionOf({}, 'chief'), null)
})
