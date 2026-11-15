// Fixed values shared by the host modules: colors, OCR settings, the client route, and
// the limits on messages, group chats, and chat reads.

// Classic avatar inks, offered as Bot colors.
export const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
// Deeper inks, also offered as accent swatches; each is a valid Bot color too.
export const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
// Renamed color ids, so a Bot saved with an old one keeps its color (LEGACY: old id → new id).
export const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
// Renamed theme ids, so a saved choice keeps its look (LEGACY: old id → new id).
export const LEGACY_THEMES = { grok: 'mono' }

export const OCR_PROMPT = [
  'Transcribe all text in this image exactly, in its original language, keeping line breaks and reading order; use Markdown tables for tables.',
  'Then add a line starting with "Image:" that describes in one to three sentences what is not text (photo, chart, diagram, screen layout).',
  'Reply with only that. If there is no text, reply with only the "Image:" line.',
].join(' ')
export const OCR_TIMEOUT_MS = 120_000
export const OCR_RETRY_MS = 120_000
export const OCR_CACHE_MAX = 500
export const MAX_AVATAR_IMAGE = 160_000
export const ROUTE = '/api/bot'
export const MAX_EXCHANGES = 600
// state.json is written whole on every save, so a long message between Bots or a long
// group line keeps only its start there. The rest stays where it already is (a message
// in the Session it was delivered to) or in a file of its own (a group line).
export const TEXT_KEPT = 2000
// Of one group line, a member reads this much: in its prompt, and with read_group_chat.
export const GROUP_LINE_READ = 20_000
// The Bot exchange dialog shows at most this much of one message.
export const TEXT_SHOW_MAX = 200_000
// A message a Bot sends past this goes as a DSH file, which the recipient reads with its
// file tools; the message keeps its first LONG_HEAD characters.
export const MESSAGE_INLINE_MAX = GROUP_LINE_READ
export const LONG_HEAD = 1000
// DSH's read tool shows this much of one line (dsh-tool-fs `readMaxLineLength`, default).
export const READ_LINE_MAX = 2000
export const ROOM_REPLY_TIMEOUT_MS = 240_000
// Lines a member writes less than this apart while it works reach its group together.
export const ROOM_STEP_GAP_MS = 30_000
export const SOURCE_KIND = 'bot'
// The fixed reply that opens a fresh conversation part; it is never shown or sent on.
export const HANDOFF_ACK = 'Noted. I have my handoff note and carry on from here.'
// A result that arrives after the user gave up waiting for it: it settled once
// already, so it closes nothing and opens nothing, and its text says why it is late.
export const LATE_ANSWER = '[Late answer: the user had already given up waiting for this work; its result was settled then.]\n\n'
// An answer from a question card, in the shape DSH's own late question replies use.
export const REPLY_KIND = 'user-question-reply'
// DSH's snapshot of a referenced conversation, logged right after the user's message
// that cites it.
export const REFERENCE_KIND = 'session-reference'
// `everyone`: every member answers a plain message in turn, admin first. `admin`: a
// plain message goes to the admin, who calls others with @mentions. New groups start
// in `admin` mode, because every extra speaker re-reads its whole context; a group
// without an admin still answers as `everyone`.
export const ROOM_MODES = ['everyone', 'admin']
export const ROOM_NAME_MAX = 60
export const ROOM_NOTICE_MAX = 2000
export const ROOM_MAX_MEMBERS = 12
export const SECTION_NAME_MAX = 32
export const SECTION_COLORS = ['blue', 'orange', 'green', 'violet', 'rose']

// DSH tools a Bot Session never gets: the blocking question tool (Bots ask through
// ask_user instead), DSH's own goals (DS Bot has group goals), and the delegation tools
// that start child agents the user cannot watch or stop.
export const BLOCKING_QUESTION_TOOL = 'ask_user_question'
export const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
export const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
// restrict() refuses a whole list when one name is registered in the Agent's own
// scope, so each group is masked on its own.
export const HIDDEN_TOOL_GROUPS = [[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS], DELEGATION_TOOLS]
export const HIDDEN_TOOLS = HIDDEN_TOOL_GROUPS.flat()
// The guidance DSH writes into the prompt for the hidden tools. Agent Teams makes
// every root Session a Team Lead and tells it to spawn teammates in `team:policy`;
// its `team:identity` context is required, so DSH puts it back after any filter.
export const HIDDEN_SECTIONS = new Set([...HIDDEN_TOOLS.map(name => `tool:${name}`), 'tool:goal', 'team:policy'])

// An isolation space is a sandbox for what a Bot may touch, not a lock on what it is.
// These are the tools it is always offered and allowed to call: chat, its own memory,
// changing its own profile (update_bot cannot raise permission, move the folder or add
// capabilities, and those refusals live in updateBot), asking for a key through the
// secure card, running on an endpoint it set for itself, and drawing a picture on the
// host's own image server. The user may add exact tool names to one Bot's
// `isolationGrants`; those join this list, and only those. The guard in tools.js
// refuses every other name — shell, files, the open network, MCP, browser, jobs — so a
// line of instructions, a stale tool list, or a newer plugin cannot widen it.
export const ISOLATION_TOOLS = ['list_bots', 'ask_user', 'show_view', 'read_own_chat', 'remember', 'forget', 'recall', 'update_bot', 'request_secret', 'set_model_endpoint', 'generate_image']
export const ISOLATION_REFUSAL = 'This Bot is in an isolation space: it can chat, but commands, files, the network and every other tool are off. Answer in words instead of running or reading anything.'
export const ISOLATION_PASSCODE_HASH = '38cb221132630e458dc78ee5732a8531a3983949518515e48537e5f68b222999'

// A team's one DSH Agent: a plain dsh entry in the sidebar, not a Bot. Its Sessions
// are ordinary root Sessions, so the team tools must not be offered to them.
export const AGENT_NAME = 'DSH Agent'
export const AGENT_SESSION_TITLE_MAX = 80
// Every tool this plugin defines for Bot Sessions; tools.js registers them in
// each Bot session's own scope. `read_browser` only exists in the Desktop
// profile, so the list served to one session can be shorter.
export const TEAM_TOOLS = [
  'list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_bot_models',
  'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'show_view',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
  'list_capabilities', 'save_capability', 'delete_capability',
  'attach_capability', 'detach_capability', 'group_goal', 'list_connectors', 'request_connector',
  'generate_image',
]
// Consecutive automatic admin wakes with no goal progress before the goal waits
// for the user instead of waking the admin again.
export const GOAL_IDLE_NUDGES = 2
// A member still at work this long after its first tool call lets the round go on; it
// posts its reply when the work is done.
export const ROOM_WORK_GRACE_MS = 15_000
// Consecutive Bot-to-Bot relays with no tool call and only repetitive or ack text
// before the round parks the remaining calls and asks the user before continuing.
export const ROOM_IDLE_RELAY_LIMIT = 6

export const OWN_CHAT_LINE_MAX = 400
// The message an anchor points at is shown whole (up to this), so a long draft takes
// one read instead of many searches for its pieces.
export const ANCHOR_LINE_MAX = 8000
export const OWN_CHAT_BRIEF = 10
export const OWN_CHAT_READ = 12
export const OWN_CHAT_SEARCH = 20
export const HISTORY_PAGE = 200
export const HISTORY_PAGES_MAX = 50
export const HISTORY_TIMEOUT_MS = 20_000
// Shown when an aside stops at the route's own output limit. The partial answer stays.
export const ASIDE_LIMIT = 'Answer cut off at the output limit.'

export const STEER_CUT = 'ds-bot/steer'
