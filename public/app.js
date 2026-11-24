// El-Omda Mini App. Plain ES module, no build step.
// The server owns every game rule; this file only draws what the server sends,
// keeps the cash number ticking smoothly between requests, and batches taps.
import { formatNumber, formatRate, toArabicDigits } from './format.js';

const BOT_USERNAME = 'QaryatAlOmdaBot';
/** Asset pictures live in /img/assets/<key>.<ext>. Missing ones fall back to the drawn icon. */
const ASSET_IMAGES = true;
const ASSET_IMAGE_EXT = 'jpg';
const APP_VERSION = '0.15';

// Remember which pictures do not exist (for a day) so we do not request them again and again.
const MISS_KEY = 'omda_img_miss_v1';
let imgMiss = {};
try {
  imgMiss = JSON.parse(localStorage.getItem(MISS_KEY) || '{}');
} catch {}
const isMiss = (key) => Date.now() - (imgMiss[key] || 0) < 24 * 3600_000;
function markMiss(key) {
  imgMiss[key] = Date.now();
  try {
    localStorage.setItem(MISS_KEY, JSON.stringify(imgMiss));
  } catch {}
}
const imgReady = new Map(); // key -> loaded <img>, reused on every re-render

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
  ads_off: () => 'الإعلانات لسه ما اتفعلتش، قريب إن شاء الله',
  cooldown: () => 'استنى شوية بين كل إعلان والتاني',
  bad_ticket: () => 'الإعلان ماتحسبش، جرب تاني',
  too_early: () => 'لازم تكمل الإعلان للآخر',
  expired: () => 'الإعلان خلص وقته، جرب تاني',
  bad_name: () => 'اسم الشلة لازم يكون من ٢ لـ ٢٠ حرف',
  in_guild: () => 'انت في شلة أصلاً',
  no_guild: () => 'مفيش شلة بالكود ده',
  bad_code: () => 'الكود ٥ حروف أو أرقام',
  guild_full: () => 'الشلة اتملت (٢٠ عضو)',
  try_again: () => 'جرب تاني',
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
  // The server only looks up الواسطة on sync and claim; keep the last value in between.
  if (!view.waseta && V) view.waseta = V.waseta;
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
  $('#whoLevel').textContent = V.title + (V.prestigeLevel ? ' · توريث ' + ar(V.prestigeLevel) : '');
  $('#adminBtn').hidden = !V.isAdmin;
  const tx = V.tax;
  $('#taxCard').hidden = !tx;
  if (tx) {
    $('#taxTitle').textContent = '🧾 ' + say('tax_offer');
    $('#taxSub').textContent = 'الحصيلة عليك ' + fmt(tx.cost) + ' جنيه، وادفع تاخد شوال حظ';
    $('#taxPay').textContent = 'ادفع ' + fmt(tx.cost);
  }
  const ev = V.event;
  $('#eventBtn').hidden = !(ev && !ev.claimed);
  if (ev) {
    $('#eventTitle').textContent = '✨ ' + ev.name + ': خد جايزتك';
    $('#eventSub').textContent = ev.blurb;
  }
  const w = V.waseta;
  $('#wasetaBtn').hidden = !(w && w.count > 0);
  if (w) {
    $('#wasetaTitle').textContent = w.pending >= 1 ? 'خد واسطتك: ' + fmt(w.pending) + ' جنيه' : 'الواسطة · ' + ar(w.count) + ' من صحابك';
    $('#wasetaSub').textContent = w.pending >= 1 ? '٥٪ من اللي كسبوه' : '٥٪ من اللي بيكسبوه بتيجيلك';
  }
  $('#starsChip').textContent = fmt(V.stars) + ' نجمة';
  $('#tapInfo').textContent = fmt(V.tapPower) + ' جنيه في الضغطة  ·  أوفلاين لحد ' + ar(V.offlineCapHours) + ' ساعة';
  const dbl = $('#doubleBtn');
  dbl.hidden = !(V.ads.live && V.doubleCash > 0);
  $('#doubleSub').textContent = 'تاخد ' + fmt(V.doubleCash) + ' جنيه زيادة';
  renderBag();
  const left = V.boostClaimsLeft;
  $('#boostBtn').disabled = left <= 0;
  $('#boostSub').textContent = left > 0 ? 'نص ساعة، متبقي ' + ar(left) + ' النهاردة' : 'خلصت النهاردة، تعال بكرة';
}

function assetIcon(a) {
  const box = h('div', { class: 'ico' });
  box.style.background = COLORS[a.category];
  box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[a.category]}</svg>`;
  if (ASSET_IMAGES && !isMiss(a.key)) {
    const ready = imgReady.get(a.key);
    if (ready) {
      box.replaceChildren(ready.cloneNode(true));
    } else {
      const img = new Image();
      img.alt = '';
      img.onload = () => {
        imgReady.set(a.key, img);
        box.replaceChildren(img);
      };
      img.onerror = () => markMiss(a.key);
      img.src = `/img/assets/${a.key}.${ASSET_IMAGE_EXT}`;
    }
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

let rankMode = 'p';
function setRankMode(m) {
  rankMode = m;
  $('#segP').classList.toggle('on', m === 'p');
  $('#segG').classList.toggle('on', m === 'g');
  $('#rankList').hidden = m !== 'p';
  $('#guildBox').hidden = m !== 'g';
  renderRank();
}
$('#segP').addEventListener('click', () => setRankMode('p'));
$('#segG').addEventListener('click', () => setRankMode('g'));

async function renderGuild() {
  const box = $('#guildBox');
  box.replaceChildren(h('div', { class: 'card', text: 'بحمّل الشلل...' }));
  let r;
  try {
    r = await call('/api/guild/info');
  } catch {
    return;
  }
  if (!r.ok) return;
  const g = r.guild;
  const topRows = r.top.map((t, i) =>
    h(
      'div',
      { class: 'row rank' + (g && t.id === g.id ? ' me' : '') },
      h('span', { class: 'pos', text: ar(i + 1) }),
      h('div', { class: 'txt' }, h('b', { text: t.name }), h('small', { text: ar(t.pts) + ' نقطة الأسبوع ده' })),
    ),
  );
  const topBlock = [h('h3', { class: 'sub', text: 'أحسن الشلل الأسبوع ده' }), ...(topRows.length ? topRows : [h('div', { class: 'card', text: 'لسه مفيش شلة اتحركت الأسبوع ده، كن أول واحد.' })])];
  if (!g) {
    const nameIn = h('input', { class: 'inp', maxlength: '20', placeholder: 'اسم الشلة' });
    const codeIn = h('input', { class: 'inp', maxlength: '5', placeholder: 'كود الشلة', style: 'text-transform:uppercase;direction:ltr' });
    box.replaceChildren(
      h('div', { class: 'card' }, h('b', { text: 'اعمل شلتك' }), h('small', { text: 'كل عضو بيزود دخل الكل ٢٪ (لحد ٢٠٪). لحد ٢٠ عضو.' }), nameIn,
        h('button', { class: 'btn', text: 'اعمل شلة', onclick: async () => { const x = await act('/api/guild/create', { name: nameIn.value }); if (x) { toast('الشلة اتعملت! كودها ' + x.code); renderGuild(); } } })),
      h('div', { class: 'card' }, h('b', { text: 'عندك كود؟' }), codeIn,
        h('button', { class: 'btn', text: 'انضم', onclick: async () => { const x = await act('/api/guild/join', { code: codeIn.value }); if (x) { toast('نورت الشلة 🤝'); renderGuild(); } } })),
      ...topBlock,
    );
    return;
  }
  const share = () => {
    const uid = tg?.initDataUnsafe?.user?.id;
    const link = `https://t.me/${BOT_USERNAME}` + (uid ? `?start=ref_${uid}` : '');
    const text = `انضم لشلتي "${g.name}" في العمدة 👑 اكتب الكود ده في تاب الترتيب > الشلل: ${g.id}`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  };
  box.replaceChildren(
    h('div', { class: 'card' },
      h('b', { text: g.name }),
      h('small', { text: 'الكود: ' + g.id + ' · ' + ar(g.size) + '/' + ar(g.max) + ' عضو · +' + ar(Math.round(g.perk * 100)) + '٪ دخل' }),
      h('small', { text: 'ترتيبكم الأسبوع ده: ' + ar(g.rank) + ' · نقطك: ' + ar(g.mine) + ' · نقط الشلة: ' + ar(g.pts) }),
      h('div', { class: 'taxbtns' },
        h('button', { class: 'primary', text: 'ادعو صحابك', onclick: share }),
        h('button', { text: 'اخرج', onclick: async () => { if (confirm('تخرج من الشلة؟')) { const x = await act('/api/guild/leave', {}); if (x) renderGuild(); } } }))),
    h('h3', { class: 'sub', text: 'الأعضاء' }),
    ...g.members.map((m, i) => h('div', { class: 'row rank' }, h('span', { class: 'pos', text: ar(i + 1) }), h('div', { class: 'txt' }, h('b', { text: m.name }), h('small', { text: ar(m.pts) + ' نقطة' })))),
    ...topBlock,
    h('small', { class: 'hint', text: 'النقط من الضغط والشراء والمهام والإعلانات. الأسبوع بيبدأ كل اتنين.' }),
  );
}

async function renderRank() {
  if (rankMode === 'g') return renderGuild();
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
  if (r.me && (r.me.hidden || r.me.rank > r.top.length)) {
    rows.push(
      h(
        'div',
        { class: 'row rank me' },
        h('span', { class: 'pos', text: ar(r.me.rank) }),
        h('div', { class: 'txt' }, h('b', { text: r.me.name }), h('small', { text: (r.me.hidden ? 'مخفي عن الباقي · ' : '') + 'إجمالي ' + fmt(r.me.lifetime) + ' جنيه' })),
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
  else if (tab === 'tasks') renderTasks();
  else if (tab === 'admin') renderAdmin();
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

// ---- Rewarded ads (Monetag rewarded interstitial) -----------------------------
let sdkZone = '';
function loadAdSdk(zone) {
  return new Promise((resolve) => {
    const fn = 'show_' + zone;
    if (typeof window[fn] === 'function') return resolve(window[fn]);
    if (sdkZone !== zone) {
      sdkZone = zone;
      const sc = document.createElement('script');
      sc.src = '//libtl.com/sdk.js';
      sc.dataset.zone = zone;
      sc.dataset.sdk = fn;
      document.head.append(sc);
    }
    let tries = 0;
    const t = setInterval(() => {
      if (typeof window[fn] === 'function') (clearInterval(t), resolve(window[fn]));
      else if (++tries > 40) (clearInterval(t), resolve(null));
    }, 250);
  });
}

/** Shows an ad. Resolves true only if the network says it was completed. With no ad zone there is nothing to show. */
async function showRewardedAd(ymid) {
  const zone = V?.ads?.zone;
  if (!zone) return true;
  const show = await loadAdSdk(zone);
  if (!show) {
    toast('سكريبت الإعلانات ماتحملش (النت أو حاجب إعلانات؟)');
    return false;
  }
  try {
    await show({ ymid });
    return true;
  } catch (e) {
    const why = typeof e === 'string' ? e : e?.message || e?.error || (e && JSON.stringify(e)) || '';
    toast('Monetag: ' + String(why).slice(0, 80) || 'مفيش إعلان متاح دلوقتي');
    return false;
  }
}

let adBusy = false;
/** start ticket -> show ad -> claim. The ymid ties Monetag's paid impression to this player. */
async function watchAd(kind) {
  if (adBusy) return null;
  adBusy = true;
  try {
    const st = await act('/api/ad/start', { kind });
    if (!st) return null;
    const uid = tg?.initDataUnsafe?.user?.id ?? 0;
    if (!(await showRewardedAd((kind === 'boost' ? 'b_' : 'd_') + uid + '_' + st.ticket))) {
      toast('الإعلان ماكملش، جرب تاني');
      return null;
    }
    return await act('/api/ad/claim', { ticket: st.ticket });
  } finally {
    adBusy = false;
  }
}

async function claimBoost() {
  const r = await watchAd('boost');
  if (r) {
    haptic('success');
    toast(say('boost_on', { minutes: ar(30) }));
  }
}

async function doubleReward() {
  const r = await watchAd('double');
  if (r) {
    haptic('success');
    toast('اتضاعفت! +' + fmt(r.bonus) + ' جنيه');
  }
}

// ---- Lucky money bag ------------------------------------------------------------
function renderBag() {
  const bag = $('#bag');
  const was = !bag.hidden;
  bag.hidden = !V.bagReady;
  if (V.bagReady && !was) {
    bag.style.left = 6 + Math.random() * 62 + '%';
    bag.style.top = 4 + Math.random() * 60 + '%';
  }
}

async function takeBag() {
  const r = await act('/api/bag');
  if (r) {
    haptic('success');
    toast('شوال فلوس! +' + fmt(r.cash) + ' جنيه');
  }
}

// ---- Admin (only for the owner; the server checks ADMIN_IDS) -----------------
let adminData = null;

async function loadAdmin() {
  await flushTaps();
  try {
    adminData = await call('/api/admin/overview');
  } catch {
    return toast('النت واقف، جرب تاني');
  }
  renderAdmin();
}

function renderAdmin() {
  const d = adminData;
  const box = $('#adminBox');
  if (!d || !d.ok) return box.replaceChildren(h('div', { class: 'card', text: 'مش مسموح' }));
  const s = d.stats;
  const stat = (label, value) => h('div', { class: 'card stat' }, h('small', { text: label }), h('b', { text: value }));
  box.replaceChildren(
    h(
      'div',
      { class: 'stats' },
      stat('لاعبين', ar(s.players)),
      stat('إعلانات اتشافت', ar(s.lifetimeAds)),
      stat('أحداث Monetag', ar(s.adEvents)),
      stat('إيراد تقديري ($)', ar(s.revenueUsd.toFixed(4))),
    ),
    h('div', { class: 'card', text: 'الإيراد ده تقدير من Monetag، والرصيد النهائي بتشوفه في حسابك عندهم.' }),
    h('h3', { class: 'section-title', text: 'اختبار' }),
    h('button', {
      class: 'btn off big',
      text: 'ابدأ اللعبة من الأول (حسابي بس)',
      onclick: async () => {
        if (!(await confirmAsk('هتبدأ اللعبة من الصفر (الفلوس والنجوم والبركات). متأكد؟'))) return;
        const r = await act('/api/admin/reset-me');
        if (r) {
          toast('اتعمل إعادة ضبط');
          goTo('home');
        }
      },
    }),
  );
}

// ---- Daily tasks (streak + quests) -----------------------------------------------
const QUEST_TEXT = {
  tap: 'دوس على العمدة',
  buy: 'اشتري ١٠ مستويات أو ترقيات',
  ad: 'اتفرج على إعلان واحد',
  bag: 'خد شوال الفلوس',
};

function renderTasks() {
  const st = V.streak;
  const days = st.rewards.map((m, i) => {
    const n = i + 1;
    const done = n < st.day || (n === st.day && st.claimedToday);
    return h('div', { class: 'day' + (done ? ' done' : '') + (n === 7 ? ' big' : '') }, h('b', { text: ar(n) }), h('small', { text: ar(m) + ' د' }));
  });
  const nextDay = st.claimedToday ? st.day : st.day === 7 || st.day === 0 ? 1 : st.day + 1;
  $('#taskBox').replaceChildren(
    h(
      'div',
      { class: 'card streak' },
      h('b', { text: 'مكافأة الدخول اليومي' }),
      h('small', { text: 'ادخل كل يوم من غير ما تفوّت. اليوم السابع فيه ساعة دخل ×٢' }),
      h('div', { class: 'days' }, days),
      h('button', {
        class: 'btn big',
        text: st.claimedToday ? 'خدتها النهاردة، تعال بكرة' : 'خد مكافأة اليوم ' + ar(nextDay),
        disabled: st.claimedToday,
        onclick: claimStreak,
      }),
    ),
    h('h3', { class: 'section-title', text: 'مهام النهاردة' }),
    h(
      'div',
      { class: 'list' },
      V.quests.map((q) => {
        const ready = q.progress >= q.target && !q.claimed;
        return h(
          'div',
          { class: 'row' },
          h(
            'div',
            { class: 'txt' },
            h('b', { text: QUEST_TEXT[q.id] }),
            h('small', { text: q.claimed ? 'خلصت' : ar(Math.min(q.progress, q.target)) + ' / ' + ar(q.target) }),
            h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.min(100, (q.progress / q.target) * 100) + '%' })),
          ),
          h('button', { class: 'btn' + (ready ? '' : ' off'), text: q.claimed ? 'تم' : 'خد', disabled: !ready, onclick: () => claimQuest(q.id) }),
        );
      }),
    ),
    h(
      'div',
      { class: 'card chest' },
      h('b', { text: 'صندوق العمدة' }),
      h('small', { text: 'خلّص المهام كلها وخد ساعة دخل ونص ساعة ×٢' }),
      h('button', {
        class: 'btn big',
        text: V.questChest === 'claimed' ? 'اتفتح النهاردة' : V.questChest === 'ready' ? 'افتح الصندوق' : 'لسه مقفول',
        disabled: V.questChest !== 'ready',
        onclick: () => claimQuest('chest'),
      }),
    ),
  );
}

async function claimStreak() {
  const r = await act('/api/streak');
  if (r) {
    haptic('success');
    toast('اليوم ' + ar(r.day) + '! +' + fmt(r.cash) + ' جنيه' + (r.boostMinutes ? ' وساعة ×٢' : ''));
  }
}

async function claimQuest(id) {
  const r = await act('/api/quest/claim', { id });
  if (r) {
    haptic('success');
    toast('+' + fmt(r.cash) + ' جنيه' + (r.boostMinutes ? ' ونص ساعة ×٢' : ''));
  }
}

async function claimWaseta() {
  if (V.waseta && V.waseta.pending >= 1) {
    const r = await act('/api/waseta', {});
    if (r) {
      haptic('success');
      toast('الواسطة جابتلك ' + fmt(r.cash) + ' جنيه');
    }
  } else {
    invite();
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

// The mayor's picture replaces the drawn tarboosh on the tap button, if /img/assets/mayor.jpg exists.
function loadMayor() {
  if (!ASSET_IMAGES) return;
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    tapBtn.replaceChildren(img);
    tapBtn.classList.add('photo');
  };
  img.src = `/img/assets/mayor.${ASSET_IMAGE_EXT}`;
}

// ---- First-time intro -----------------------------------------------------------
const INTRO_KEY = 'omda_intro_v1';
const SLIDES = [
  {
    icon: '<svg viewBox="0 0 120 120"><path d="M30 92 L40 38 Q60 28 80 38 L90 92 Z" fill="#B3261E"/><rect x="26" y="88" width="68" height="12" rx="4" fill="#7A1713"/><path d="M60 33 Q76 28 82 46" stroke="#0F2A2B" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="83" cy="52" r="5" fill="#0F2A2B"/></svg>',
    title: 'دوس على الطربوش',
    text: 'كل ضغطة بتجيب فلوس. ابدأ بالضغط لحد ما تجمع ١٥ جنيه، وتشتري أول توك توك.',
  },
  {
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#0F2A2B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 12H6z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
    title: 'اشتري أصول والفلوس تيجي لوحدها',
    text: 'توك توك، عربية فول، عمارة، مصنع... كل أصل بيجيب فلوس كل ثانية، حتى وانت قافل اللعبة (لحد ساعتين في الأول). ارجع كل شوية واستلم فلوسك.',
  },
  {
    icon: '<svg viewBox="0 0 24 24" fill="#0F2A2B"><path d="M12 2l3 6.5 7 .9-5.2 4.8 1.4 7L12 17.8 5.8 21.2l1.4-7L2 9.4l7-.9z"/></svg>',
    title: 'ورّث وكبّر لحد القصر الجمهوري',
    text: 'لما تجمع مليار جنيه، ورّث الكرسي للولد وابدأ من جديد بنجوم تقوّيك للأبد. وادعُ صاحبك: انت وهو تاخدوا ساعة دخل مضاعف.',
  },
];
let slide = 0;

function renderSlide() {
  const s = SLIDES[slide];
  const last = slide === SLIDES.length - 1;
  $('#introIcon').innerHTML = s.icon;
  $('#introTitle').textContent = s.title;
  $('#introText').textContent = s.text;
  $('#introDots').replaceChildren(...SLIDES.map((_, i) => h('i', { class: i === slide ? 'on' : '' })));
  $('#introNext').textContent = last ? 'يلا نبدأ' : 'التالي';
  $('#introSkip').hidden = last;
}
function showIntro() {
  slide = 0;
  renderSlide();
  $('#intro').hidden = false;
  $('#introNext').focus();
}
function closeIntro() {
  $('#intro').hidden = true;
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {}
}
function introSeen() {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}
$('#introNext').addEventListener('click', () => {
  if (slide < SLIDES.length - 1) {
    slide++;
    renderSlide();
  } else closeIntro();
});
$('#introSkip').addEventListener('click', closeIntro);
$('#helpBtn').addEventListener('click', showIntro);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#intro').hidden) closeIntro();
});

// ---- Navigation ----------------------------------------------------------------
function goTo(next) {
  tab = next;
  document.body.dataset.tab = next;
  $$('main > section').forEach((s) => (s.hidden = s.dataset.tab !== next));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === next));
  $('main').scrollTop = 0;
  if (next === 'rank') renderRank();
  else if (next === 'admin') loadAdmin();
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
$('#doubleBtn').addEventListener('click', doubleReward);
$('#bag').addEventListener('click', takeBag);
$('#adminBtn').addEventListener('click', () => goTo('admin'));
$('#inviteBtn').addEventListener('click', invite);
$('#wasetaBtn').addEventListener('click', claimWaseta);
$('#taxPay').addEventListener('click', async () => {
  const r = await act('/api/tax/pay', {});
  if (r) {
    haptic(r.mult >= 5 ? 'success' : 'light');
    toast(say(r.mult >= 5 ? 'tax_jackpot' : 'tax_paid', { bag: fmt(r.bag), mult: ar(r.mult) }));
  }
});
$('#taxDodge').addEventListener('click', async () => {
  const r = await act('/api/tax/dodge', {});
  if (r) toast(say('tax_dodged'));
});
$('#eventBtn').addEventListener('click', async () => {
  const r = await act('/api/event/claim', {});
  if (r) {
    haptic('success');
    toast(r.name + ': +' + fmt(r.cash) + ' جنيه' + (r.boostMinutes ? ' وساعة ×٢' : ''));
  }
});
$('#offlineOk').addEventListener('click', () => ($('#offline').hidden = true));

// ---- Clock ---------------------------------------------------------------------
function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return ar(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
}

// "How far to the next purchase": the next new asset to buy.
function etaText(sec) {
  if (sec < 60) return 'أقل من دقيقة';
  if (sec < 3600) return ar(Math.ceil(sec / 60)) + ' دقيقة';
  if (sec < 86400) return ar(Math.ceil(sec / 3600)) + ' ساعة';
  return 'أكتر من يوم';
}
function updateGoal() {
  const box = $('#goal');
  const open = V.assets.filter((a) => a.unlocked);
  if (!open.length) {
    box.hidden = true;
    return;
  }
  // Goal = the cheapest unlocked asset not bought yet (the thing that was just unlocked);
  // when everything open is already owned, the cheapest upgrade of those.
  const fresh = open.filter((a) => !a.level);
  const next = (fresh.length ? fresh : open).reduce((m, a) => (a.cost < m.cost ? a : m));
  box.hidden = false;
  $('#goalFill').style.width = Math.min(100, (cash / next.cost) * 100).toFixed(1) + '%';
  const cps = curCps();
  $('#goalText').textContent =
    cash >= next.cost
      ? 'تقدر تشتري ' + next.name + ' دلوقتي'
      : 'فاضل ' + fmt(next.cost - cash) + ' على ' + next.name + (cps > 0 ? '  ·  حوالي ' + etaText((next.cost - cash) / cps) : '');
}

function tick() {
  const now = Date.now();
  if (V) cash += (curCps() * (now - cashAt)) / 1000;
  cashAt = now;
  $('#cash').textContent = fmt(cash);
  if (!V) return;
  const boosted = serverNow() < V.boostUntil;
  updateGoal();
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
    const vars = { amount: fmt(r.offline.earned), hours: V.offlineCapHours === 1 ? 'ساعة' : V.offlineCapHours === 2 ? 'ساعتين' : ar(V.offlineCapHours) + ' ساعات' };
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
  $('#ver').textContent = 'نسخة ' + ar(APP_VERSION);
  loadMayor();
  setInterval(tick, 100);
  setInterval(refreshAffordable, 400);
  setInterval(() => flushTaps(), 8000);
  try {
    await sync(true);
    if (!introSeen()) showIntro();
  } catch {
    showFatal('مش قادر أوصل للسيرفر، جرب تاني بعد شوية');
  }
}
boot();
