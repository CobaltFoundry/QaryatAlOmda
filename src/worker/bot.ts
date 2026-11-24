import { BOOST_MAX_STACK_MS, newState } from '../engine/engine.ts';
import type { GameState } from '../engine/types.ts';
import { displayName } from './api.ts';
import { say } from './data.ts';
import type { PlayerRow, Store } from './store.ts';
import type { TgUser } from './telegram.ts';

export interface TgUpdate {
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: TgUser;
  };
}

export type TgCall = (method: string, body: unknown) => Promise<unknown>;

export interface BotDeps {
  store: Store;
  origin: string;
  now: number;
  call: TgCall;
  rand?: () => number;
}

export const WELCOME_BOOST_MS = 30 * 60_000;
export const REFERRAL_BOOST_MS = 60 * 60_000;

function withBoost(state: GameState, now: number, ms: number): GameState {
  const until = Math.min(Math.max(now, state.boostUntil) + ms, now + BOOST_MAX_STACK_MS);
  return { ...state, boostUntil: until };
}

async function updatePlayer(store: Store, userId: number, now: number, fn: (s: GameState) => GameState): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const row: PlayerRow | null = await store.get(userId);
    if (!row) return false;
    if (await store.save({ ...row, state: fn(row.state) }, now)) return true;
  }
  return false;
}

const playKeyboard = (origin: string) => ({
  inline_keyboard: [[{ text: '🎮 العب دلوقتي', web_app: { url: origin } }]],
});

const HELP_TEXT =
  'لعبة العمدة 👑\n\n' +
  '• دوس على الطربوش تجيب فلوس.\n' +
  '• اشتري أصول (توك توك، كشري، عمارات...) والفلوس تيجي لوحدها حتى وانت مقفل اللعبة.\n' +
  '• لما تكبر كفاية، ورّث الكرسي للولد وابدأ بنجوم تقوّيك.\n' +
  '• الهدف: القصر الجمهوري.\n\n' +
  'ادعُ صاحبك من جوه اللعبة وخدوا ساعة دخل مضاعف.';

/**
 * Handles one Telegram update. Only private /start and /help are handled;
 * everything else gets a nudge toward the Mini App.
 */
export async function handleUpdate(update: TgUpdate, deps: BotDeps): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== 'private') return;

  const { store, origin, now, call } = deps;
  const rand = deps.rand ?? Math.random;
  const parts = (msg.text ?? '').trim().split(/\s+/);
  const command = (parts[0] ?? '').split('@')[0].toLowerCase();
  const chatId = msg.chat.id;

  if (command === '/id') {
    await call('sendMessage', { chat_id: chatId, text: `رقمك على تليجرام: ${msg.from.id}` });
    return;
  }

  if (command === '/mute' || command === '/unmute') {
    const off = command === '/mute';
    const ok = await updatePlayer(store, msg.from.id, now, (s) => ({ ...s, notifyOff: off }));
    const text = !ok
      ? 'ابدأ اللعب الأول بـ /start.'
      : off
        ? 'تمام يا عمدة، مش هبعتلك تنبيهات تاني. لو عاوزها ارجع ابعت /unmute.'
        : 'تمام، هنبهك لما الخزنة تتملي. 🔔';
    await call('sendMessage', { chat_id: chatId, text });
    return;
  }

  if (command === '/help') {
    await call('sendMessage', { chat_id: chatId, text: HELP_TEXT, reply_markup: playKeyboard(origin) });
    return;
  }

  if (command === '/start') {
    const user = msg.from;
    const refMatch = /^ref_(\d{1,15})$/.exec(parts[1] ?? '');
    const referrerId = refMatch ? Number(refMatch[1]) : null;

    let welcome = withBoost(newState(now), now, WELCOME_BOOST_MS);
    let referrer: number | null = null;
    if (referrerId !== null && referrerId !== user.id && (await store.get(referrerId))) {
      referrer = referrerId;
      welcome = withBoost(welcome, now, REFERRAL_BOOST_MS);
    }

    const isNew = await store.create(user.id, displayName(user), welcome, referrer, now);

    if (isNew && referrer !== null) {
      const ok = await updatePlayer(store, referrer, now, (s) => withBoost(s, now, REFERRAL_BOOST_MS));
      if (ok) {
        await call('sendMessage', {
          chat_id: referrer,
          text: `🎁 ${displayName(user)} دخل اللعبة بدعوتك، واتضافتلك ساعة دخل مضاعف!`,
        });
      }
    }

    const intro = isNew ? '\n\nعشان أول مرة، معاك نص ساعة دخل مضاعف هدية. 🎁' : '';
    await call('sendMessage', {
      chat_id: chatId,
      text: `${say('greeting', {}, rand)} 👑${intro}`,
      reply_markup: playKeyboard(origin),
    });
    return;
  }

  await call('sendMessage', {
    chat_id: chatId,
    text: 'دوس على الزرار وادخل اللعبة يا عمدة 👇',
    reply_markup: playKeyboard(origin),
  });
}

/** Registers the webhook, the menu button and the command list. Safe to run repeatedly. */
/** Shown when someone opens the bot for the first time (Telegram allows up to 512 characters). */
export const BOT_DESCRIPTION = `ابدأ بتوك توك وخلّيك العمدة 👑
اضغط على العمدة، اشتري عربية فول وتاكسي وفيلا ويخت، والفلوس تفضل تجري حتى وانت نايم 😴
• توريث الكرسي ولقب أكبر كل مرة
• شلة مع صحابك وترتيب أسبوعي
• مهام وهدايا كل يوم، ومطر دهب كل جمعة
• جابي الضرايب ممكن يطلعلك جاكبوت 🎰
لعبة مصرية ببلاش على تليجرام. اضغط ابدأ.`;
/** Shown on the bot's profile and when it is shared (up to 120 characters). */
export const BOT_SHORT_DESCRIPTION = 'لعبة العمدة 👑 ابدأ بتوك توك وخلّيك عمدة البلد. ببلاش وعلى تليجرام.';

export async function setupBot(origin: string, webhookSecret: string, call: TgCall): Promise<Record<string, unknown>> {
  return {
    webhook: await call('setWebhook', {
      url: `${origin}/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
    menuButton: await call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'العب', web_app: { url: origin } },
    }),
    commands: await call('setMyCommands', {
      commands: [
        { command: 'start', description: 'ابدأ اللعب' },
        { command: 'help', description: 'إزاي تلعب' },
        { command: 'mute', description: 'وقف التنبيهات' },
        { command: 'unmute', description: 'شغل التنبيهات' },
      ],
    }),
    description: await call('setMyDescription', { description: BOT_DESCRIPTION }),
    shortDescription: await call('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }),
  };
}
