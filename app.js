'use strict';

const { opp, legal, apply, inCheck, san, key, insufficient, initialState } = Chess;

/* ------------------------------------------------------------------ helpers */
const $ = (s) => document.querySelector(s);
const NAME = { w: 'White', b: 'Black' };
const GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const glyph = (t) => GLYPH[t] + '︎'; // ︎ forces text (not emoji) rendering for the pawn
const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
const START_COUNT = { Q: 1, R: 2, B: 2, N: 2, P: 8 };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* -------------------------------------------------------------------- sound */
let audioCtx;
let muted = store.get('chess-muted') === '1';
function tone(freq, dur = 0.06, type = 'triangle', vol = 0.09, delay = 0) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + dur);
  } catch { /* audio is optional */ }
}
const sfx = {
  move: () => tone(520, 0.05),
  capture: () => { tone(300, 0.09, 'square', 0.07); tone(180, 0.1, 'triangle', 0.1, 0.02); },
  check: () => { tone(700, 0.07); tone(880, 0.1, 'triangle', 0.09, 0.08); },
  end: () => { tone(523, 0.14); tone(392, 0.14, 'triangle', 0.09, 0.15); tone(262, 0.3, 'triangle', 0.09, 0.3); },
  ping: () => { tone(880, 0.08); tone(1175, 0.12, 'triangle', 0.08, 0.09); },
};
function renderMute() { $('#muteBtn').textContent = muted ? '🔇' : '🔊'; }

/* -------------------------------------------------------------- game state */
let G = null; // the current game
const NET = {
  role: null,            // 'host' | 'guest' | null
  peer: null, conn: null,
  id: null,              // host's peer id (also the game code)
  hostId: null,          // guest: id we dial
  myColor: null,
  connected: false, everConnected: false,
  token: null, guestToken: null,
  rm: { me: false, them: false },
  drawSent: false, drawIn: false,
  leaving: false, full: false, redial: null,
};
let MODE = 'menu'; // 'menu' | 'local' | 'online'

function newGame() {
  const state = initialState();
  G = {
    state, moves: [], keys: [key(state)], result: null, legal: [], check: false,
    sel: null, targets: new Map(), flip: G ? G.flip : false,
  };
  evaluate();
}

function evaluate() {
  const s = G.state;
  G.legal = legal(s);
  G.check = inCheck(s.b, s.turn);
  if (G.result) return;
  const lastKey = G.keys[G.keys.length - 1];
  if (!G.legal.length) {
    G.result = G.check
      ? { kind: 'mate', winner: opp(s.turn), text: `Checkmate — ${NAME[opp(s.turn)]} wins` }
      : { kind: 'draw', winner: null, text: 'Stalemate — it’s a draw' };
  } else if (insufficient(s.b)) {
    G.result = { kind: 'draw', winner: null, text: 'Draw — insufficient material' };
  } else if (G.keys.filter((k) => k === lastKey).length >= 3) {
    G.result = { kind: 'draw', winner: null, text: 'Draw — threefold repetition' };
  } else if (s.half >= 100) {
    G.result = { kind: 'draw', winner: null, text: 'Draw — fifty-move rule' };
  }
}

function doMove(m) {
  const text = san(G.state, m, G.legal);
  G.state = apply(G.state, m);
  G.moves.push({ from: m.from, to: m.to, promo: m.promo || null, san: text, cap: !!m.cap });
  G.keys.push(key(G.state));
  NET.drawSent = false; NET.drawIn = false;
  evaluate();
  return m;
}

function findMove(from, to, promo) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  return G.legal.find((m) => m.from === from && m.to === to && (m.promo || null) === (promo || null)) || null;
}

function rebuild(list) {
  newGame();
  if (!Array.isArray(list)) return;
  for (const mv of list) {
    if (!Array.isArray(mv)) break;
    const m = findMove(mv[0], mv[1], mv[2]);
    if (!m) break;
    doMove(m);
  }
}

function playSoundFor(m) {
  if (G.result && G.result.kind !== 'draw') sfx.end();
  else if (G.result) sfx.end();
  else if (G.check) sfx.check();
  else if (m.cap) sfx.capture();
  else sfx.move();
}

function endGame(result) {
  if (G.result) return;
  G.result = result;
  clearSel();
  sfx.end();
  persistHost();
  render();
}

/* ---------------------------------------------------------------- networking */
function canMove() {
  if (!G || G.result) return false;
  if (MODE === 'local') return true;
  if (MODE !== 'online') return false;
  if (NET.role === 'guest' && !NET.connected) return false;
  return G.state.turn === NET.myColor;
}

function send(msg) {
  try { if (NET.conn && NET.conn.open) NET.conn.send(msg); } catch { /* connection may be closing */ }
}

function movesPayload() { return G.moves.map((m) => [m.from, m.to, m.promo]); }

function sendSync() {
  send({ t: 'sync', color: opp(NET.myColor), moves: movesPayload(), result: G.result });
}

function persistHost() {
  if (NET.role !== 'host' || !G) return;
  store.set('chess-host', JSON.stringify({ id: NET.id, color: NET.myColor, moves: movesPayload(), result: G.result, at: Date.now() }));
}

function peerReady() {
  if (typeof Peer === 'undefined') {
    toast('Couldn’t load the networking library. Check your internet connection and reload.', 5000);
    return false;
  }
  return true;
}

function startHost(colorChoice, saved) {
  if (!peerReady()) return;
  resetNet();
  NET.role = 'host'; MODE = 'online';
  if (saved) {
    NET.myColor = saved.color === 'b' ? 'b' : 'w';
    NET.id = saved.id;
    rebuild(saved.moves);
    if (saved.result && !G.result) G.result = saved.result;
  } else {
    NET.myColor = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice;
    NET.id = 'cf-' + rand(6);
    newGame();
  }
  showScreen('game');
  render();
  openHostPeer(!!saved, 0);
}

function openHostPeer(resuming, attempt) {
  if (NET.leaving) return;
  const peer = new Peer(NET.id);
  NET.peer = peer;
  peer.on('open', () => { persistHost(); render(); });
  peer.on('connection', (conn) => {
    conn.on('data', (m) => onData(conn, m));
    conn.on('close', () => {
      if (NET.conn === conn) { NET.connected = false; render(); toast('Your friend disconnected'); }
    });
  });
  peer.on('disconnected', () => { if (!NET.leaving && !peer.destroyed) peer.reconnect(); });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      if (resuming && attempt < 6) {
        setTimeout(() => openHostPeer(true, attempt + 1), 2000); // old registration may take a moment to expire
      } else {
        NET.id = 'cf-' + rand(6);
        persistHost();
        render();
        openHostPeer(false, 0);
      }
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      toast('Can’t reach the matchmaking server. Retrying…');
    }
  });
}

function startGuest(hostId) {
  if (!peerReady()) return;
  resetNet();
  NET.role = 'guest'; MODE = 'online';
  NET.hostId = hostId;
  NET.myColor = 'b'; // placeholder until the host's first sync
  let tok = store.get('chess-token');
  if (!tok) { tok = rand(12); store.set('chess-token', tok); }
  NET.token = tok;
  newGame();
  showScreen('game');
  render();

  const peer = new Peer();
  NET.peer = peer;
  peer.on('open', () => dial());
  peer.on('disconnected', () => { if (!NET.leaving && !peer.destroyed) peer.reconnect(); });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      toast('Waiting for the host… (is their game page still open?)', 4000);
      scheduleRedial(3000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      toast('Can’t reach the matchmaking server. Retrying…');
    }
  });
}

function scheduleRedial(ms) {
  clearTimeout(NET.redial);
  if (!NET.leaving && !NET.full) NET.redial = setTimeout(dial, ms);
}

function dial() {
  if (NET.leaving || NET.full || !NET.peer || NET.peer.destroyed) return;
  if (!NET.peer.open) return scheduleRedial(1000);
  try { if (NET.conn) NET.conn.close(); } catch { /* ignore */ }
  const conn = NET.peer.connect(NET.hostId, { reliable: true });
  NET.conn = conn;
  conn.on('open', () => conn.send({ t: 'hello', token: NET.token }));
  conn.on('data', (m) => onData(conn, m));
  conn.on('close', () => {
    if (NET.conn !== conn) return;
    NET.connected = false;
    render();
    if (!NET.leaving && !NET.full) { toast('Disconnected — trying to reconnect…'); scheduleRedial(2500); }
  });
  // If nothing happens (host offline), try again.
  setTimeout(() => { if (NET.conn === conn && !conn.open && !NET.connected) scheduleRedial(0); }, 8000);
}

function hostHello(conn, msg) {
  const tok = String(msg.token || '').slice(0, 64);
  if (NET.guestToken && NET.guestToken !== tok) {
    send2(conn, { t: 'full' });
    setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 400);
    return;
  }
  NET.guestToken = tok;
  const old = NET.conn;
  NET.conn = conn;
  if (old && old !== conn) { try { old.close(); } catch { /* ignore */ } }
  NET.connected = true; NET.everConnected = true;
  sendSync();
  render();
  toast('Your friend joined!');
  sfx.ping();
}

function send2(conn, msg) { try { conn.send(msg); } catch { /* ignore */ } }

function onData(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (NET.role === 'host') {
    if (msg.t === 'hello') return hostHello(conn, msg);
    if (conn !== NET.conn) return;
  }
  switch (msg.t) {
    case 'sync': return applySync(msg);
    case 'resync': if (NET.role === 'host') sendSync(); return;
    case 'full':
      NET.full = true;
      toast('This game already has two players.', 6000);
      return;
    case 'move': {
      if (G.result || G.state.turn === NET.myColor) return;
      const m = findMove(msg.from, msg.to, msg.promo || null);
      if (!m) { if (NET.role === 'host') sendSync(); else send({ t: 'resync' }); return; }
      doMove(m);
      playSoundFor(m);
      persistHost();
      render();
      if (document.hidden && !G.result) document.title = '● Your move — Friendly Chess';
      return;
    }
    case 'resign':
      endGame({ kind: 'resign', winner: NET.myColor, text: `${NAME[opp(NET.myColor)]} resigned — ${NAME[NET.myColor]} wins` });
      return;
    case 'draw-offer':
      if (G.result) return;
      NET.drawIn = true; sfx.ping(); render();
      return;
    case 'draw-accept':
      if (NET.drawSent) endGame({ kind: 'draw', winner: null, text: 'Draw agreed' });
      return;
    case 'draw-decline':
      NET.drawSent = false; toast('Your friend declined the draw'); render();
      return;
    case 'rematch':
      NET.rm.them = true; sfx.ping(); maybeStartRematch(); render();
      return;
    case 'chat':
      addChat('them', String(msg.text || '').slice(0, 300));
      sfx.ping();
      if (document.hidden) document.title = '💬 New message — Friendly Chess';
      return;
    default:
  }
}

function applySync(msg) {
  if (NET.role !== 'guest') return;
  NET.myColor = msg.color === 'w' ? 'w' : 'b';
  NET.connected = true; NET.everConnected = true;
  rebuild(msg.moves);
  if (msg.result && !G.result && typeof msg.result.text === 'string') {
    G.result = { kind: String(msg.result.kind || 'draw'), winner: msg.result.winner === 'w' || msg.result.winner === 'b' ? msg.result.winner : null, text: msg.result.text.slice(0, 100) };
  }
  if (!G.moves.length && !G.result) { NET.rm = { me: false, them: false }; NET.drawSent = false; NET.drawIn = false; }
  render();
}

function maybeStartRematch() {
  if (!(NET.rm.me && NET.rm.them) || NET.role !== 'host') return;
  NET.rm = { me: false, them: false };
  NET.myColor = opp(NET.myColor);
  newGame();
  sendSync();
  persistHost();
  toast('Rematch — you swapped colors');
}

function resetNet() {
  NET.leaving = true;
  clearTimeout(NET.redial);
  try { if (NET.conn) NET.conn.close(); } catch { /* ignore */ }
  try { if (NET.peer) NET.peer.destroy(); } catch { /* ignore */ }
  Object.assign(NET, {
    role: null, peer: null, conn: null, id: null, hostId: null, myColor: null, connected: false, everConnected: false,
    guestToken: null, rm: { me: false, them: false }, drawSent: false, drawIn: false, leaving: false, full: false, redial: null,
  });
}

/* ---------------------------------------------------------------- UI: board */
const boardEl = $('#board');
let drag = null;

const isFlipped = () => ((MODE === 'online' && NET.myColor === 'b') !== G.flip);

function select(i) {
  G.sel = i;
  G.targets = new Map();
  for (const m of G.legal) if (m.from === i) G.targets.set(m.to, !!m.cap);
}
function clearSel() { G.sel = null; G.targets = new Map(); }

function renderBoard() {
  cancelDrag();
  const flipped = isFlipped();
  const last = G.moves[G.moves.length - 1];
  const kingSq = G.check ? G.state.b.indexOf(G.state.turn + 'K') : -1;
  const pickable = canMove();
  boardEl.classList.toggle('mine', pickable);
  let html = '';
  for (let d = 0; d < 64; d++) {
    const i = flipped ? 63 - d : d;
    const r = i >> 3, c = i & 7;
    const p = G.state.b[i];
    const cls = ['sq', (r + c) % 2 ? 'dark' : 'light'];
    if (last && (i === last.from || i === last.to)) cls.push('last');
    if (G.sel === i) cls.push('sel');
    if (G.targets.has(i)) cls.push(G.targets.get(i) ? 'cap' : 'dot');
    if (i === kingSq) cls.push('check');
    if (pickable && p && p[0] === G.state.turn) cls.push('canpick');
    html += `<div class="${cls.join(' ')}" data-i="${i}">`;
    if (p) html += `<span class="pc ${p[0]}">${glyph(p[1])}</span>`;
    if ((d & 7) === 0) html += `<i class="rank">${8 - r}</i>`;
    if (d >= 56) html += `<i class="file">${'abcdefgh'[c]}</i>`;
    html += '</div>';
  }
  boardEl.innerHTML = html;
}

boardEl.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || !G) return;
  const el = e.target.closest('.sq');
  if (!el || !canMove()) return;
  const i = +el.dataset.i;
  if (G.sel !== null && G.targets.has(i)) { attempt(G.sel, i); return; }
  const p = G.state.b[i];
  if (p && p[0] === G.state.turn) {
    select(i);
    renderBoard();
    startDrag(i, e);
  } else {
    clearSel();
    renderBoard();
  }
});

function startDrag(i, e) {
  const sqEl = boardEl.querySelector(`.sq[data-i="${i}"]`);
  const pc = sqEl && sqEl.querySelector('.pc');
  if (!pc) return;
  const size = sqEl.getBoundingClientRect().width;
  const ghost = document.createElement('div');
  ghost.className = 'dragghost ' + G.state.b[i][0];
  ghost.textContent = glyph(G.state.b[i][1]);
  ghost.style.width = ghost.style.height = size + 'px';
  ghost.style.fontSize = size * 0.84 + 'px';
  document.body.appendChild(ghost);
  pc.classList.add('ghosting');
  drag = { from: i, ghost, size, moved: false, sx: e.clientX, sy: e.clientY };
  moveGhost(e);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', cancelDrag);
}
function moveGhost(e) {
  if (!drag) return;
  drag.ghost.style.left = e.clientX - drag.size / 2 + 'px';
  drag.ghost.style.top = e.clientY - drag.size / 2 + 'px';
}
function onDragMove(e) {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 6) drag.moved = true;
  moveGhost(e);
}
function onDragEnd(e) {
  if (!drag) return;
  const { from, moved } = drag;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const sqEl = under && under.closest && under.closest('.sq');
  teardownDrag();
  const to = sqEl ? +sqEl.dataset.i : null;
  if (moved && to !== null && to !== from && G.targets.has(to)) attempt(from, to);
  else renderBoard();
}
function teardownDrag() {
  if (!drag) return;
  drag.ghost.remove();
  drag = null;
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', cancelDrag);
}
function cancelDrag() { teardownDrag(); }

function attempt(from, to) {
  const options = G.legal.filter((m) => m.from === from && m.to === to);
  if (!options.length) { clearSel(); renderBoard(); return; }
  if (options[0].promo) {
    askPromotion(G.state.turn, (choice) => {
      if (!choice) { renderBoard(); return; }
      commit(findMove(from, to, choice));
    });
  } else commit(options[0]);
}

function commit(m) {
  if (!m) return;
  clearSel();
  doMove(m);
  playSoundFor(m);
  if (MODE === 'online') send({ t: 'move', from: m.from, to: m.to, promo: m.promo || null });
  persistHost();
  render();
}

function askPromotion(color, cb) {
  const box = $('#promoBox');
  box.innerHTML = ['Q', 'R', 'B', 'N'].map((t) => `<button data-t="${t}" class="pcb ${color}" aria-label="Promote to ${t}">${glyph(t)}</button>`).join('');
  const overlay = $('#promo');
  overlay.hidden = false;
  const done = (v) => { overlay.hidden = true; overlay.onclick = null; document.removeEventListener('keydown', onKey); cb(v); };
  const onKey = (e) => { if (e.key === 'Escape') done(null); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => {
    const b = e.target.closest('button[data-t]');
    if (b) done(b.dataset.t);
    else if (e.target === overlay) done(null);
  };
}

/* ------------------------------------------------------------- UI: the rest */
function pieceCounts(color) {
  const n = { Q: 0, R: 0, B: 0, N: 0, P: 0 };
  for (const p of G.state.b) if (p && p[0] === color && p[1] !== 'K') n[p[1]]++;
  return n;
}
const material = (color) => { const n = pieceCounts(color); return Object.keys(n).reduce((s, t) => s + n[t] * VAL[t], 0); };

function fillBar(el, color) {
  const online = MODE === 'online';
  const mine = online && color === NET.myColor;
  const name = online ? (mine ? 'You' : 'Friend') : NAME[color];
  const enemy = pieceCounts(opp(color));
  let took = '';
  for (const t of ['Q', 'R', 'B', 'N', 'P']) {
    const lost = Math.max(0, START_COUNT[t] - enemy[t]);
    took += `<span class="pc ${opp(color)}">${glyph(t)}</span>`.repeat(lost);
  }
  const adv = material(color) - material(opp(color));
  const presence = online && !mine
    ? `<span class="presence ${NET.connected ? 'on' : ''}" title="${NET.connected ? 'Connected' : 'Not connected'}"></span>` : '';
  el.classList.toggle('turn', !G.result && G.state.turn === color);
  el.innerHTML = `${presence}<span class="swatch ${color}"></span><b>${name}</b><span class="role">${NAME[color]}</span>` +
    `<span class="took">${took}</span><span class="adv">${adv > 0 ? '+' + adv : ''}</span>`;
}

function renderMoves() {
  const el = $('#moves');
  let h = '';
  const lastIdx = G.moves.length - 1;
  for (let i = 0; i < G.moves.length; i += 2) {
    const a = G.moves[i], b = G.moves[i + 1];
    h += `<div class="mv"><span class="n">${i / 2 + 1}.</span>` +
      `<span class="m${i === lastIdx ? ' latest' : ''}">${a.san}</span>` +
      `<span class="m${i + 1 === lastIdx ? ' latest' : ''}">${b ? b.san : ''}</span></div>`;
  }
  el.innerHTML = h || '<p class="empty">No moves yet</p>';
  el.scrollTop = el.scrollHeight;
}

function statusText() {
  if (G.result) return G.result.text;
  const s = G.state;
  const chk = G.check ? ' — check!' : '';
  if (MODE === 'local') return `${NAME[s.turn]} to move${chk}`;
  if (NET.role === 'guest' && !NET.connected) return NET.full ? 'This game is full' : 'Connecting to your friend…';
  if (NET.role === 'host' && !NET.connected && !NET.everConnected) return 'Waiting for your friend to join…';
  if (NET.role === 'host' && !NET.connected) return 'Friend disconnected — waiting for them to return';
  return (s.turn === NET.myColor ? `Your move (${NAME[s.turn]})` : `Friend’s move (${NAME[s.turn]})`) + chk;
}

function renderPanel() {
  const online = MODE === 'online';
  const st = $('#status');
  st.textContent = statusText();
  st.classList.toggle('over', !!G.result);

  // invite card (host, nobody connected)
  const invite = online && NET.role === 'host' && !NET.connected && !G.moves.length;
  $('#invite').hidden = !invite;
  if (invite) {
    const link = inviteLink();
    if ($('#inviteLink').value !== link) $('#inviteLink').value = link;
    $('#fileWarn').hidden = location.protocol !== 'file:';
    $('#shareBtn').hidden = !navigator.share;
  }

  // notice (incoming draw offer)
  const notice = $('#notice');
  if (online && NET.drawIn && !G.result) {
    notice.hidden = false;
    notice.innerHTML = '<span>Your friend offers a draw.</span><button class="primary" data-a="draw-yes">Accept</button><button data-a="draw-no">Decline</button>';
  } else notice.hidden = true;

  // result card
  const rc = $('#resultCard');
  if (G.result) {
    rc.hidden = false;
    let buttons;
    if (online) {
      const label = NET.rm.me ? 'Waiting for friend…' : NET.rm.them ? 'Accept rematch' : 'Rematch';
      buttons = `<button class="primary" data-a="rematch" ${NET.rm.me ? 'disabled' : ''}>${label}</button>`;
    } else buttons = '<button class="primary" data-a="new">New game</button>';
    rc.innerHTML = `<h2>${G.result.text}</h2>${online && NET.rm.them && !NET.rm.me ? '<p class="muted">Your friend wants a rematch (colors swap).</p>' : ''}<div class="row">${buttons}</div>`;
  } else rc.hidden = true;

  // controls
  const over = !!G.result;
  $('#drawBtn').hidden = !online;
  $('#resignBtn').hidden = !online;
  $('#undoBtn').hidden = MODE !== 'local';
  $('#chat').hidden = !online;
  $('#drawBtn').disabled = over || !NET.connected || !G.moves.length || NET.drawSent;
  $('#drawBtn').textContent = NET.drawSent ? 'Draw offered…' : 'Offer draw';
  $('#resignBtn').disabled = over || !NET.connected || !G.moves.length;
  $('#undoBtn').disabled = !G.moves.length;
}

function render() {
  if (!G || MODE === 'menu') return;
  renderBoard();
  const bottom = isFlipped() ? 'b' : 'w';
  fillBar($('#botbar'), bottom);
  fillBar($('#topbar'), opp(bottom));
  renderMoves();
  renderPanel();
}

function inviteLink() {
  const base = location.href.split('#')[0].split('?')[0];
  return `${base}?join=${NET.id}`;
}

function addChat(who, text) {
  const log = $('#chatlog');
  const p = document.createElement('p');
  p.className = who;
  p.textContent = who === 'sys' ? text : (who === 'me' ? 'You: ' : 'Friend: ') + text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------------------ screens */
function showScreen(name) {
  $('#menu').hidden = name !== 'menu';
  $('#game').hidden = name !== 'game';
  if (name === 'menu') MODE = 'menu';
}

function leave(confirmFirst = true) {
  const inProgress = G && !G.result && G.moves.length > 0 && MODE === 'online';
  if (confirmFirst && inProgress && !confirm('Leave this game? Your friend will be disconnected.')) return;
  if (NET.role === 'host') store.del('chess-host');
  resetNet();
  MODE = 'menu';
  G = null;
  $('#chatlog').innerHTML = '';
  history.replaceState(null, '', location.pathname);
  showScreen('menu');
  refreshResume();
}

function refreshResume() {
  let saved = null;
  try { saved = JSON.parse(store.get('chess-host') || 'null'); } catch { saved = null; }
  const ok = saved && saved.id && Array.isArray(saved.moves) && !(saved.result) && Date.now() - (saved.at || 0) < 6 * 3600 * 1000;
  $('#resumeCard').hidden = !ok;
  if (ok) $('#resumeInfo').textContent = `${saved.moves.length} moves played · you were ${saved.color === 'b' ? 'Black' : 'White'}`;
  return ok ? saved : null;
}

/* ------------------------------------------------------------------- events */
$('#createBtn').onclick = () => {
  const choice = document.querySelector('input[name=color]:checked').value;
  startHost(choice, null);
};
$('#localBtn').onclick = () => { resetNet(); MODE = 'local'; G = null; newGame(); showScreen('game'); render(); };
$('#resumeBtn').onclick = () => { const s = refreshResume(); if (s) startHost(null, s); };
$('#discardBtn').onclick = () => { store.del('chess-host'); refreshResume(); };

function parseJoin(v) {
  v = v.trim();
  try { const j = new URL(v).searchParams.get('join'); if (j) return j; } catch { /* not a URL */ }
  return v.replace(/[^a-z0-9-]/gi, '');
}
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const id = parseJoin($('#joinInput').value);
  if (!id) { toast('Paste the link or code your friend sent you'); return; }
  history.replaceState(null, '', `${location.pathname}?join=${encodeURIComponent(id)}`);
  startGuest(id);
};

$('#copyBtn').onclick = async () => {
  const link = $('#inviteLink').value;
  try { await navigator.clipboard.writeText(link); toast('Link copied — send it to your friend'); }
  catch { $('#inviteLink').select(); document.execCommand && document.execCommand('copy'); toast('Link copied'); }
};
$('#shareBtn').onclick = () => navigator.share({ title: 'Chess?', text: 'Play chess with me:', url: $('#inviteLink').value }).catch(() => {});
$('#inviteLink').onfocus = (e) => e.target.select();

$('#flipBtn').onclick = () => { G.flip = !G.flip; render(); };
$('#leaveBtn').onclick = () => leave(true);
$('#muteBtn').onclick = () => { muted = !muted; store.set('chess-muted', muted ? '1' : '0'); renderMute(); if (!muted) sfx.move(); };

$('#undoBtn').onclick = () => {
  if (MODE !== 'local' || !G.moves.length) return;
  const list = movesPayload().slice(0, -1);
  rebuild(list);
  render();
};

$('#resignBtn').onclick = () => {
  if (!confirm('Resign this game?')) return;
  send({ t: 'resign' });
  endGame({ kind: 'resign', winner: opp(NET.myColor), text: `${NAME[NET.myColor]} resigned — ${NAME[opp(NET.myColor)]} wins` });
};
$('#drawBtn').onclick = () => { NET.drawSent = true; send({ t: 'draw-offer' }); toast('Draw offered'); render(); };

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  switch (b.dataset.a) {
    case 'draw-yes':
      send({ t: 'draw-accept' }); NET.drawIn = false;
      endGame({ kind: 'draw', winner: null, text: 'Draw agreed' });
      break;
    case 'draw-no':
      send({ t: 'draw-decline' }); NET.drawIn = false; render();
      break;
    case 'rematch':
      NET.rm.me = true; send({ t: 'rematch' });
      maybeStartRematch(); render();
      break;
    case 'new':
      newGame(); render();
      break;
    default:
  }
});

$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim().slice(0, 300);
  if (!text) return;
  send({ t: 'chat', text });
  addChat('me', text);
  input.value = '';
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Friendly Chess'; });
window.addEventListener('resize', () => { if (drag) cancelDrag(); });

/* --------------------------------------------------------------------- boot */
renderMute();
(function boot() {
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  if (join) {
    const id = parseJoin(join);
    if (id) {
      // Don't let someone join their own game from the same tab after a refresh of the host page.
      startGuest(id);
      return;
    }
  }
  showScreen('menu');
  refreshResume();
})();
