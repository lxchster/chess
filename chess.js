/* Minimal, dependency-free chess rules engine.
 * Board: array of 64 entries, index 0 = a8, index 63 = h1. Pieces are 2-char strings: 'wP', 'bN', ...
 */
(function (root) {
  'use strict';

  const FILES = 'abcdefgh';
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  const rowOf = (i) => i >> 3;
  const colOf = (i) => i & 7;
  const sqName = (i) => FILES[colOf(i)] + (8 - rowOf(i));

  const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function initialState() {
    const b = Array(64).fill(null);
    const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let c = 0; c < 8; c++) {
      b[c] = 'b' + back[c];
      b[8 + c] = 'bP';
      b[48 + c] = 'wP';
      b[56 + c] = 'w' + back[c];
    }
    return { b, turn: 'w', castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0, full: 1 };
  }

  function fromFEN(fen) {
    const [place, turn, cast, ep, half, full] = fen.trim().split(/\s+/);
    const b = Array(64).fill(null);
    let i = 0;
    for (const ch of place) {
      if (ch === '/') continue;
      if (/\d/.test(ch)) { i += +ch; continue; }
      b[i++] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
    }
    let epSq = -1;
    if (ep && ep !== '-') epSq = FILES.indexOf(ep[0]) + (8 - +ep[1]) * 8;
    return {
      b, turn, ep: epSq,
      castle: { K: cast.includes('K'), Q: cast.includes('Q'), k: cast.includes('k'), q: cast.includes('q') },
      half: +(half || 0), full: +(full || 1),
    };
  }

  function attacked(b, sq, by) {
    const r = rowOf(sq), c = colOf(sq);
    const pr = by === 'w' ? r + 1 : r - 1;
    if (pr >= 0 && pr < 8) {
      for (const dc of [-1, 1]) {
        const cc = c + dc;
        if (cc >= 0 && cc < 8 && b[pr * 8 + cc] === by + 'P') return true;
      }
    }
    for (const [dr, dc] of KN) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === by + 'N') return true;
    }
    for (const [dr, dc] of KG) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === by + 'K') return true;
    }
    for (const [dr, dc] of DIAG) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p) { if (p[0] === by && (p[1] === 'B' || p[1] === 'Q')) return true; break; }
        rr += dr; cc += dc;
      }
    }
    for (const [dr, dc] of ORTH) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p) { if (p[0] === by && (p[1] === 'R' || p[1] === 'Q')) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  }

  function inCheck(b, color) {
    const k = b.indexOf(color + 'K');
    return k >= 0 && attacked(b, k, opp(color));
  }

  function pseudo(s) {
    const { b, turn } = s;
    const them = opp(turn);
    const out = [];
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p || p[0] !== turn) continue;
      const t = p[1], r = rowOf(i), c = colOf(i);

      if (t === 'P') {
        const dir = turn === 'w' ? -1 : 1;
        const start = turn === 'w' ? 6 : 1;
        const last = turn === 'w' ? 0 : 7;
        const add = (to, cap) => {
          if (rowOf(to) === last) {
            for (const pr of ['Q', 'R', 'B', 'N']) out.push({ from: i, to, piece: p, cap, promo: pr });
          } else out.push({ from: i, to, piece: p, cap });
        };
        const f = i + dir * 8;
        if (!b[f]) {
          add(f, null);
          if (r === start && !b[f + dir * 8]) out.push({ from: i, to: f + dir * 8, piece: p, cap: null, dbl: true });
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc > 7) continue;
          const to = f + dc;
          if (b[to] && b[to][0] === them) add(to, b[to]);
          else if (!b[to] && to === s.ep) out.push({ from: i, to, piece: p, cap: them + 'P', ep: true });
        }
      } else if (t === 'N' || t === 'K') {
        for (const [dr, dc] of t === 'N' ? KN : KG) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const to = rr * 8 + cc;
          if (!b[to]) out.push({ from: i, to, piece: p, cap: null });
          else if (b[to][0] === them) out.push({ from: i, to, piece: p, cap: b[to] });
        }
        if (t === 'K') {
          const base = turn === 'w' ? 56 : 0;
          if (i === base + 4 && !attacked(b, i, them)) {
            if (s.castle[turn === 'w' ? 'K' : 'k'] && b[base + 7] === turn + 'R' &&
                !b[base + 5] && !b[base + 6] &&
                !attacked(b, base + 5, them) && !attacked(b, base + 6, them)) {
              out.push({ from: i, to: base + 6, piece: p, cap: null, castle: 'K' });
            }
            if (s.castle[turn === 'w' ? 'Q' : 'q'] && b[base] === turn + 'R' &&
                !b[base + 1] && !b[base + 2] && !b[base + 3] &&
                !attacked(b, base + 3, them) && !attacked(b, base + 2, them)) {
              out.push({ from: i, to: base + 2, piece: p, cap: null, castle: 'Q' });
            }
          }
        }
      } else {
        const dirs = t === 'B' ? DIAG : t === 'R' ? ORTH : DIAG.concat(ORTH);
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            const to = rr * 8 + cc;
            if (!b[to]) out.push({ from: i, to, piece: p, cap: null });
            else {
              if (b[to][0] === them) out.push({ from: i, to, piece: p, cap: b[to] });
              break;
            }
            rr += dr; cc += dc;
          }
        }
      }
    }
    return out;
  }

  function apply(s, m) {
    const b = s.b.slice();
    const turn = s.turn;
    b[m.from] = null;
    b[m.to] = m.promo ? turn + m.promo : m.piece;
    if (m.ep) b[m.to + (turn === 'w' ? 8 : -8)] = null;
    if (m.castle) {
      const base = turn === 'w' ? 56 : 0;
      if (m.castle === 'K') { b[base + 7] = null; b[base + 5] = turn + 'R'; }
      else { b[base] = null; b[base + 3] = turn + 'R'; }
    }
    const castle = { ...s.castle };
    if (m.piece[1] === 'K') {
      if (turn === 'w') { castle.K = false; castle.Q = false; } else { castle.k = false; castle.q = false; }
    }
    for (const sq of [m.from, m.to]) {
      if (sq === 63) castle.K = false;
      if (sq === 56) castle.Q = false;
      if (sq === 7) castle.k = false;
      if (sq === 0) castle.q = false;
    }
    return {
      b, turn: opp(turn), castle,
      ep: m.dbl ? (m.from + m.to) / 2 : -1,
      half: m.piece[1] === 'P' || m.cap ? 0 : s.half + 1,
      full: s.full + (turn === 'b' ? 1 : 0),
    };
  }

  function legal(s) {
    const me = s.turn;
    return pseudo(s).filter((m) => !inCheck(apply(s, m).b, me));
  }

  function san(s, m, legalMoves) {
    let out;
    if (m.castle) out = m.castle === 'K' ? 'O-O' : 'O-O-O';
    else {
      const t = m.piece[1];
      out = '';
      if (t !== 'P') {
        out += t;
        const others = (legalMoves || legal(s)).filter((o) => o !== m && o.piece === m.piece && o.to === m.to);
        if (others.length) {
          const sameFile = others.some((o) => colOf(o.from) === colOf(m.from));
          const sameRank = others.some((o) => rowOf(o.from) === rowOf(m.from));
          if (!sameFile) out += FILES[colOf(m.from)];
          else if (!sameRank) out += 8 - rowOf(m.from);
          else out += sqName(m.from);
        }
      } else if (m.cap) out += FILES[colOf(m.from)];
      if (m.cap) out += 'x';
      out += sqName(m.to);
      if (m.promo) out += '=' + m.promo;
    }
    const n = apply(s, m);
    if (inCheck(n.b, n.turn)) out += legal(n).length ? '+' : '#';
    return out;
  }

  function key(s) {
    return s.b.map((p) => p || '-').join('') + s.turn +
      (s.castle.K ? 'K' : '') + (s.castle.Q ? 'Q' : '') + (s.castle.k ? 'k' : '') + (s.castle.q ? 'q' : '') + s.ep;
  }

  function insufficient(b) {
    const rest = [];
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (p && p[1] !== 'K') {
        if (p[1] === 'P' || p[1] === 'R' || p[1] === 'Q') return false;
        rest.push({ t: p[1], shade: (rowOf(i) + colOf(i)) % 2 });
      }
    }
    if (rest.length <= 1) return true;
    return rest.every((x) => x.t === 'B' && x.shade === rest[0].shade);
  }

  function perft(s, d) {
    const ms = legal(s);
    if (d === 1) return ms.length;
    let n = 0;
    for (const m of ms) n += perft(apply(s, m), d - 1);
    return n;
  }

  const Chess = { opp, sqName, initialState, fromFEN, attacked, inCheck, legal, apply, san, key, insufficient, perft };
  if (typeof module !== 'undefined' && module.exports) module.exports = Chess;
  else root.Chess = Chess;
})(typeof window !== 'undefined' ? window : globalThis);
