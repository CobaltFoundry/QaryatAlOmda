// El-Omda Mini App. Plain ES module, no build step.
// The server owns every game rule; this file only draws what the server sends,
// keeps the cash number ticking smoothly between requests, and batches taps.
import { formatNumber, formatRate, toArabicDigits } from './format.js';

const BOT_USERNAME = 'QaryatAlOmdaBot';
/** Flip to true after adding /img/assets/<key>.webp files (one per asset key). */
const ASSET_IMAGES = false;

const tg = window.Telegram?.WebApp;
const initData = tg?.initData ?? '';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = (n) => formatNumber(n);
const rate = (n) => formatRate(n);
const ar = (n) => toArabicDigits(String(n));

const CATS = [
  ['transport', 'مواصلات'],
  ['food', 'أكل'],
  ['realestate', 'عقارات'],
  ['industry', 'صناعة'],
  ['vip', 'VIP'],
];
const COLORS = { transport: '#F28C28', food: '#E0645F', realestate: '#6AA9E0', industry: '#7CB87C', vip: '#B48AE0' };
const ICONS = {
  transport: '<path d="M3 15V9l5-3h8l5 5v4"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  food: '<path d="M4 11h16a8 8 0 0 1-16 0z"/><path d="M9 7c0-2 3-2 3-4M14 7c0-2 3-2 3-4"/>',
  realestate: '<path d="M4 21V5l8-3 8 3v16"/><path d="M9 9h2M13 9h2M9 13h2M13 13h2M10 21v-4h4v4"/>',
  industry: '<path d="M3 21V10l6 4v-4l6 4V6h6v15z"/>',
  vip: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
};

// ---- State ------------------------------------------------------------------
let strings = {};
let V = null; // latest view from the server
let cash = 0; // locally integrated cash (view.cash + idle income since + pending taps)
let cashAt = Date.now();
let clockOffset = 0; // serverNow - Date.now()
let pending = 0; // taps not yet sent
let tapCount = 0;
let tab = 'home';
let cat = 'transport';
let qty = 1; // 1 | 10 | 'max'
let hiddenAt = 0;

const say = (key, vars = {}) => {
  const list = strings[key] || [''];
  const text = list[Math.floor(Math.random() * list.length)] || '';
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
};
const serverNow = () => Date.now() + clockOffset;
const curCps = () => (V ? V.baseCps * (serverNow() < V.boostUntil ? 2 : 1) : 0);

// ---- Small helpers ------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function bubble(text) {
  const el = $('#bubble');
  el.textContent = text;
  clearTimeout(bubble.t);
  bubble.t = setTimeout(() => (el.textContent = ''), 3200);
}

function haptic(kind) {
  try {
    if (kind === 'success') tg?.HapticFeedback?.notificationOccurred('success');
    else tg?.HapticFeedback?.impactOccurred(kind || 'light');
  } catch {}
}

function showFatal(text) {
  const el = $('#fatal');
  el.textContent = text;
  el.hidden = false;
}

// ---- Network ------------------------------------------------------------------
let chain = Promise.resolve();
async function rawCall(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'tma ' + initData },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 401) {
    showFatal('افتح اللعبة من تليجرام عن طريق البوت @' + BOT_USERNAME);
    throw new Error('unauthorized');
  }
  return res.json();
}
// Requests go one at a time so a tap batch never races a purchase.
function call(path, body) {
  const p = chain.then(() => rawCall(path, body));
  chain = p.catch(() => {});
  return p;
}

async function flushTaps() {
  if (pending <= 0 || !V) return;
  const n = pending;
  pending = 0;
  try {
    const r = await call('/api/tap', { count: n });
    if (r.ok) applyView(r.view);
  } catch {
    pending += n; // try again on the next flush
  }
}

const ERRORS = {
  not_enough_cash: () => say('not_enough_cash'),
  locked: () => say('locked'),
  limit: () => 'وصلت للحد اليومي، تعال بكرة',
  not_enough_stars: () => 'النجوم مش كفاية',
  max_level: () => 'وصلت للآخر',
  not_ready: () => 'لسه مش وقته يا عمدة',
  busy: () => 'الدنيا زحمة، جرب تاني',
};

async function act(path, body) {
  await flushTaps();
  let r;
  try {
    r = await call(path, body);
  } catch {
    toast('النت واقف، جرب تاني');
    return null;
  }
  if (r.view) applyView(r.view);
  if (!r.ok) {
    toast((ERRORS[r.error] || (() => 'حصل خطأ، جرب تاني'))());
    return null;
  }
  return r;
}

// ---- View ---------------------------------------------------------------------
function applyView(view) {
  V = view;
  clockOffset = view.now - Date.now();
  cash = view.cash + pending * view.tapPower;
  cashAt = Date.now();
  renderHeader();
  renderTab();
}

function renderHeader() {
  const user = tg?.initDataUnsafe?.user;
  $('#whoName').textContent = user?.first_name || 'عمدة';
  $('#whoLevel').textContent = 'توريث ' + ar(V.prestigeLevel);
  $('#starsChip').textContent = fmt(V.stars) + ' نجمة';
  $('#tapInfo').textContent = fmt(V.tapPower) + ' جنيه في الضغطة  ·  أوفلاين لحد ' + ar(V.offlineCapHours) + ' ساعة';
  const left = V.boostClaimsLeft;
  $('#boostBtn').disabled = left <= 0;
  $('#boostSub').textContent = left > 0 ? 'نص ساعة، متبقي ' + ar(left) + ' النهاردة' : 'خلصت النهاردة، تعال بكرة';
}

function assetIcon(a) {
  const box = h('div', { class: 'ico' });
  box.style.background = COLORS[a.category];
  box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[a.category]}</svg>`;
  if (ASSET_IMAGES) {
    const img = new Image();
    img.alt = '';
    img.onload = () => box.replaceChildren(img);
    img.src = `/img/assets/${a.key}.webp`;
  }
  return box;
}

function buyLabel(a) {
  if (qty === 10) return fmt(a.cost10);
  if (qty === 'max' && a.maxQty > 1) return 'أقصى ×' + ar(a.maxQty);
  return fmt(a.cost);
}
const buyNeed = (a) => (qty === 10 ? a.cost10 : a.cost);

function renderShop() {
  $('#cats').replaceChildren(
    ...CATS.map(([id, label]) =>
      h('button', {
        class: id === cat ? 'on' : '',
        text: label,
        onclick: () => {
          cat = id;
          renderShop();
        },
      }),
    ),
  );
  $$('#qty button').forEach((b) => b.classList.toggle('on', String(qty) === b.dataset.qty));

  $('#shopList').replaceChildren(
    ...V.assets
      .filter((a) => a.category === cat)
      .map((a) => {
        if (!a.unlocked) {
          const why =
            a.lock?.kind === 'prestige' ? 'يتفتح بعد التوريث ' + ar(a.lock.level) : 'يتفتح بعد شراء ' + (a.lock?.name ?? '');
          return h(
            'div',
            { class: 'row locked' },
            assetIcon(a),
            h('div', { class: 'txt' }, h('b', { text: a.name }), h('small', { text: why })),
          );
        }
        const gain = 'دخل ' + rate(a.perLevel) + ' في الثانية لكل مستوى' + (a.tapBonus ? '  ·  وزيادة ' + ar(a.tapBonus) + ' في الضغطة' : '');
        return h(
          'div',
          { class: 'row' },
          assetIcon(a),
          h(
            'div',
            { class: 'txt' },
            h('b', { text: a.name + (a.level ? '  ·  مستوى ' + ar(a.level) : '') }),
            h('small', { text: gain }),
            h('span', { class: 'desc', text: a.description }),
          ),
          h('button', { class: 'btn', 'data-cost': buyNeed(a), text: buyLabel(a), onclick: () => buy(a) }),
        );
      }),
  );
  refreshAffordable();
}

function renderUpgrades() {
  const list = [...V.upgrades].sort((x, y) => Number(y.available) - Number(x.available) || x.cost - y.cost);
  const nodes = [];
  let hidden = 0;
  for (const u of list) {
    if (!u.available && nodes.length >= 12) {
      hidden++;
      continue;
    }
    nodes.push(
      h(
        'div',
        { class: 'row' + (u.available ? '' : ' locked') },
        h(
          'div',
          { class: 'txt' },
          h('b', { text: u.name }),
          h('span', { class: 'desc', text: u.description }),
          u.need ? h('small', { text: 'محتاج ' + u.need.name + ' مستوى ' + ar(u.need.level) }) : null,
        ),
        h('button', { class: 'btn', 'data-cost': u.cost, 'data-locked': u.available ? null : '1', text: fmt(u.cost), onclick: () => upgrade(u) }),
      ),
    );
  }
  if (!nodes.length) nodes.push(h('div', { class: 'card', text: 'اشتريت كل الترقيات المتاحة، كمّل ورّث وهتفتحلك تانية.' }));
  $('#upList').replaceChildren(...nodes);
  refreshAffordable();
}

function renderPrestige() {
  const pct = Math.min(100, (V.runEarned / V.prestigeMin) * 100);
  $('#prestigeBar').style.width = pct + '%';
  $('#prestigeText').textContent = V.canPrestige
    ? 'جاهز! هتاخد ' + ar(V.prestigeGain) + ' نجمة وتبدأ من الأول بأصول أقوى. النجوم بتفضل معاك للأبد.'
    : 'لازم تجمع ' + fmt(V.prestigeMin) + ' جنيه في الجولة دي. جمعت لحد دلوقتي ' + fmt(V.runEarned) + '.';
  $('#prestigeBtn').disabled = !V.canPrestige;

  $('#blessList').replaceChildren(
    ...V.prestigeUpgrades.map((p) =>
      h(
        'div',
        { class: 'row' },
        h(
          'div',
          { class: 'txt' },
          h('b', { text: p.name }),
          h('span', { class: 'desc', text: p.description }),
          h('small', { text: 'مستوى ' + ar(p.level) + ' من ' + ar(p.maxLevel) }),
        ),
        p.cost === null
          ? h('span', { class: 'btn off', style: 'display:grid;place-items:center', text: 'خلص' })
          : h('button', { class: 'btn', disabled: V.stars < p.cost, text: ar(p.cost) + ' نجمة', onclick: () => buyBlessing(p) }),
      ),
    ),
  );
}

async function renderRank() {
  const list = $('#rankList');
  list.replaceChildren(h('div', { class: 'card', text: 'بحمّل الترتيب...' }));
  let r;
  try {
    r = await call('/api/leaderboard');
  } catch {
    return;
  }
  if (!r.ok) return;
  const rows = r.top.map((t, i) =>
    h(
      'div',
      { class: 'row rank' + (r.me && t.name === r.me.name && t.lifetime === r.me.lifetime ? ' me' : '') },
      h('span', { class: 'pos', text: ar(i + 1) }),
      h('div', { class: 'txt' }, h('b', { text: t.name }), h('small', { text: 'إجمالي ' + fmt(t.lifetime) + ' جنيه' })),
    ),
  );
  if (r.me && r.me.rank > r.top.length) {
    rows.push(
      h(
        'div',
        { class: 'row rank me' },
        h('span', { class: 'pos', text: ar(r.me.rank) }),
        h('div', { class: 'txt' }, h('b', { text: r.me.name }), h('small', { text: 'إجمالي ' + fmt(r.me.lifetime) + ' جنيه' })),
      ),
    );
  }
  list.replaceChildren(...rows);
}

function renderTab() {
  if (!V) return;
  if (tab === 'shop') renderShop();
  else if (tab === 'upgrades') renderUpgrades();
  else if (tab === 'prestige') renderPrestige();
}

function refreshAffordable() {
  for (const b of $$('[data-cost]')) {
    b.disabled = b.dataset.locked === '1' || cash < Number(b.dataset.cost);
  }
}

// ---- Actions ------------------------------------------------------------------
async function buy(a) {
  const r = await act('/api/buy', { assetId: a.id, qty: qty === 'max' ? 'max' : qty });
  if (!r) return;
  haptic('success');
  toast(say('purchase_ok'));
  r.newlyUnlocked.forEach((name, i) => setTimeout(() => toast(say('asset_unlocked', { name })), 1300 + i * 1500));
}

async function upgrade(u) {
  const r = await act('/api/upgrade', { id: u.id });
  if (r) {
    haptic('success');
    toast(say('purchase_ok'));
  }
}

async function buyBlessing(p) {
  const r = await act('/api/prestige-buy', { id: p.id });
  if (r) {
    haptic('success');
    toast('اتفعّلت: ' + p.name);
  }
}

function confirmAsk(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(message, (ok) => resolve(!!ok));
    else resolve(window.confirm(message));
  });
}

async function doPrestige() {
  if (!V?.canPrestige) return;
  if (!(await confirmAsk(say('prestige_confirm', { stars: ar(V.prestigeGain) })))) return;
  const r = await act('/api/prestige');
  if (r) {
    haptic('success');
    toast(say('prestige_done', { stars: ar(r.starsGained) }));
  }
}

/** Placeholder for the rewarded ad (Monetag / Adsgram). Must resolve true only if the ad was completed. */
async function showRewardedAd() {
  return true;
}

async function claimBoost() {
  if (!(await showRewardedAd())) return;
  const r = await act('/api/boost');
  if (r) {
    haptic('success');
    toast(say('boost_on', { minutes: ar(r.minutes) }));
  }
}

function invite() {
  const uid = tg?.initDataUnsafe?.user?.id;
  if (!uid) return;
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
  const me = tg.initDataUnsafe.user.first_name || 'صاحبك';
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(say('invite_friend', { name: me }))}`;
  if (tg.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank');
}

// ---- Tapping ------------------------------------------------------------------
function doTap(clientX, clientY) {
  if (!V) return;
  cash += V.tapPower;
  pending++;
  tapCount++;
  haptic('light');
  if (tapCount % 75 === 0) bubble(say('tap_comments'));

  const zone = $('#tapZone');
  if (zone.querySelectorAll('.float').length < 14) {
    const rect = zone.getBoundingClientRect();
    const f = h('span', { class: 'float', text: '+' + fmt(V.tapPower) });
    f.style.left = clientX - rect.left - 14 + 'px';
    f.style.top = clientY - rect.top - 24 + 'px';
    zone.append(f);
    setTimeout(() => f.remove(), 800);
  }
}

const tapBtn = $('#tapBtn');
tapBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tapBtn.classList.add('press');
  doTap(e.clientX, e.clientY);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  tapBtn.addEventListener(ev, () => tapBtn.classList.remove('press'));
}
tapBtn.addEventListener('click', (e) => {
  if (e.detail === 0) {
    // keyboard activation (Enter / Space)
    const r = tapBtn.getBoundingClientRect();
    doTap(r.left + r.width / 2, r.top + r.height / 2);
  }
});

// ---- Navigation ----------------------------------------------------------------
function goTo(next) {
  tab = next;
  document.body.dataset.tab = next;
  $$('main > section').forEach((s) => (s.hidden = s.dataset.tab !== next));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === next));
  $('main').scrollTop = 0;
  if (next === 'rank') renderRank();
  else renderTab();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.go)));
$$('#qty button').forEach((b) =>
  b.addEventListener('click', () => {
    qty = b.dataset.qty === 'max' ? 'max' : Number(b.dataset.qty);
    renderShop();
  }),
);
$('#prestigeBtn').addEventListener('click', doPrestige);
$('#boostBtn').addEventListener('click', claimBoost);
$('#inviteBtn').addEventListener('click', invite);
$('#offlineOk').addEventListener('click', () => ($('#offline').hidden = true));

// ---- Clock ---------------------------------------------------------------------
function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return ar(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
}

function tick() {
  const now = Date.now();
  if (V) cash += (curCps() * (now - cashAt)) / 1000;
  cashAt = now;
  $('#cash').textContent = fmt(cash);
  if (!V) return;
  const boosted = serverNow() < V.boostUntil;
  $('#cps').textContent = 'دخلك ' + rate(curCps()) + ' جنيه في الثانية';
  const badge = $('#boostBadge');
  badge.hidden = !boosted;
  if (boosted) badge.textContent = 'دخل ×٢  ·  ' + mmss(V.boostUntil - serverNow());
}

async function sync(first) {
  await flushTaps();
  const r = await call('/api/sync');
  if (!r.ok) return;
  applyView(r.view);
  if (r.offline && r.offline.earned >= 1) {
    const vars = { amount: fmt(r.offline.earned), hours: ar(V.offlineCapHours) };
    $('#offlineText').textContent = r.offline.capped ? say('offline_capped', vars) : say('offline_welcome', vars);
    $('#offline').hidden = false;
  } else if (first) {
    bubble(say('greeting'));
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    flushTaps();
  } else if (hiddenAt && Date.now() - hiddenAt > 20_000) {
    sync(false).catch(() => {});
  }
});

// ---- Boot ----------------------------------------------------------------------
async function boot() {
  tg?.ready?.();
  tg?.expand?.();
  try {
    tg?.setHeaderColor?.('#0F2A2B');
    tg?.setBackgroundColor?.('#0F2A2B');
  } catch {}

  if (!initData) {
    showFatal('افتح اللعبة من تليجرام عن طريق البوت @' + BOT_USERNAME);
    return;
  }
  try {
    strings = await (await fetch('/strings.json')).json();
  } catch {}
  setInterval(tick, 100);
  setInterval(refreshAffordable, 400);
  setInterval(() => flushTaps(), 8000);
  try {
    await sync(true);
  } catch {
    showFatal('مش قادر أوصل للسيرفر، جرب تاني بعد شوية');
  }
}
boot();
