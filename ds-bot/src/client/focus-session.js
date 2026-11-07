// The Bot chat in front, or null: a group chat and a DSH Agent Session are not a
// Bot's own chat, so reporting null lets the host release the Bot chat it kept warm.
export function botSessionOf(roster, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const known = (roster?.bots ?? []).find(bot => bot.id === sessionId
    || bot.sessionId === sessionId
    || (bot.parts ?? []).includes(sessionId))
  // An earlier part is read-only: the Bot's current chat is what stays warm.
  return known === undefined ? null : (known.sessionId ?? known.id)
}
