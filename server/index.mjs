import http from 'node:http';
import { randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { upgrade } from './websocket.mjs';
import { TRACKS, DEFAULT_HIT, DEFAULT_QUIZ, sanitiseConfig, hitBlow, validNumber, filteredTracks, graphemes, normalizeAnswer, makeOptions, makeRoomCode, randomToken } from './engine.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const rooms = new Map();
const peers = new Set();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const now = () => Date.now();
const cleanName = name => String(name || '').trim().slice(0, 16).replace(/[<>]/g, '') || 'プレイヤー';
const safe = (peer, payload) => peer.send(payload);
const fail = (peer, message) => safe(peer, { type:'error', message });
const other = i => 1 - i;
function publish(room) {
  room.updated = now();
  for (let i = 0; i < 2; i++) if (room.players[i]?.peer) room.players[i].peer.send({ type:'state', room: stateFor(room, i) });
}
function stateFor(room, seat) {
  const g = room.game;
  let game = null;
  if (g?.type === 'hit') {
    game = { type:'hit', phase:g.phase, secretSet:g.secrets.map(Boolean), turn:g.turn, round:g.round,
      guesses:g.guesses.map((items,i)=>items.map(it=>i !== seat && it.hits===3 && g.phase!=='ended'?{...it,value:'●●●'}:it)), hints:g.hints.map((h,i)=>i===seat?h:null), deadline:g.deadline, winner:g.winner,
      revealSecrets:g.phase === 'ended' ? g.secrets : undefined };
  } else if (g?.type === 'quiz') {
    const track = g.current;
    game = { type:'quiz', phase:g.phase, scores:g.scores, questionNo:g.questionNo,
      totalQuestions:g.queue.length + g.questionNo, revealed:g.revealed, cursor:g.cursor,
      textLength: track ? graphemes(track.text).length : 0,
      answerer:g.answerer, progress:g.progress, options:g.phase === 'answering' && g.answerer === seat && room.config.quiz.inputMethod === 'choices' ? g.options : undefined,
      answerLength: track ? graphemes(track.title).filter(ch => !/[\s\p{P}\p{S}]/u.test(ch)).length : 0,
      deadline:g.deadline, intermissionUntil:g.intermissionUntil,
      lastAnswer:g.lastAnswer, winner:g.winner, attempted:g.attempted,
      buzzWinner:g.buzzWinner };
  }
  return { code:room.code, me:seat, host:room.host, chosen:room.chosen, ready:room.ready,
    config:room.config, rematch:room.rematch, players:room.players.map(p => p ? ({ name:p.name, online:!!p.peer }) : null),
    game, paused:!!room.pausedAt, history:room.history.slice(-10).reverse() };
}
function inRoom(peer) {
  if (!peer.room || peer.seat === undefined || peer.room.players[peer.seat]?.peer !== peer) throw Error('ルームに参加していません。');
  return peer.room;
}
function isHost(peer, room) { if (peer.seat !== room.host) throw Error('ルーム作成者のみ操作できます。'); }
function isLobby(room) { if (room.game) throw Error('試合中は変更できません。'); }
function ensureActive(room, kind) { if (!room.game || room.game.type !== kind || room.game.phase === 'ended') throw Error('この操作は現在できません。'); if (room.pausedAt) throw Error('相手の再接続を待っています。'); return room.game; }
function attach(peer, room, seat, name, token) {
  if (peer.room) detach(peer, true);
  const old = room.players[seat];
  if (old?.peer && old.peer !== peer) {
    old.peer.room = null; old.peer.seat = undefined; old.peer.send({ type:'kicked', message:'別の端末で同じプレイヤーとして接続しました。' }); old.peer.terminate();
  }
  room.players[seat] = { token, name: old ? old.name : cleanName(name), peer, rtt: old?.rtt || 70, probe: null };
  peer.room = room; peer.seat = seat;
  if (room.pausedAt && room.players.every(p => p?.peer)) {
    const elapsed = now() - room.pausedAt;
    const g = room.game;
    if (g) {
      for (const key of ['deadline','intermissionUntil','arbitrationUntil','fullAt']) if (g[key]) g[key] += elapsed;
      if (g.phase === 'revealing') g.revealAt += elapsed;
    }
    room.pausedAt = 0;
  }
  safe(peer, { type:'joined', code:room.code });
  publish(room);
}
function detach(peer, unbind = false) {
  const room = peer.room;
  if (!room) return;
  const p = room.players[peer.seat];
  if (p?.peer === peer) {
    p.peer = null;
    if (unbind) {
      room.players[peer.seat] = null;
      room.game = null;
      room.ready = [false,false];
      const remaining = room.players.findIndex(Boolean);
      if (remaining === -1) rooms.delete(room.code); else room.host = remaining;
    } else if (room.game && room.game.phase !== 'ended' && !room.pausedAt) room.pausedAt = now();
  }
  peer.room = null; peer.seat = undefined;
  if (rooms.has(room.code)) publish(room);
}
function startGame(room) {
  room.ready = [false,false]; room.rematch = [false,false]; room.pausedAt = 0;
  if (room.chosen === 'hit') {
    const starter = room.nextHitStart ?? randomIntTwo();
    room.nextHitStart = other(starter);
    room.game = { type:'hit', phase:'secrets', starter, secrets:[null,null], guesses:[[],[]], hints:[null,null], turn:starter, round:1, deadline:0, winner:null };
  } else {
    const queue = filteredTracks(room.config.quiz);
    if (!queue.length) throw Error('指定条件に一致する曲がありません。難易度か年代を変更してください。');
    room.game = { type:'quiz', phase:'intermission', scores:[0,0], queue, current:null, questionNo:0, revealed:'', cursor:0, revealAt:0, deadline:0, intermissionUntil:now() + 1000,
      attempted:[false,false], answerer:null, buzzWinner:null, progress:[], options:[], candidates:[], arbitrationUntil:0, winner:null, lastAnswer:null, fullAt:0 };
  }
  publish(room);
}
function randomIntTwo() { return Math.random() < .5 ? 0 : 1; }
function nextHit(room, guessedCorrect) {
  const g = room.game;
  if (g.turn === g.starter) {
    g.turn = other(g.starter); // second always gets an equal attempt in this round
  } else {
    const a = g.guesses[g.starter].at(-1)?.hits === 3;
    const b = g.guesses[other(g.starter)].at(-1)?.hits === 3;
    if (a || b) return finish(room, a && b ? null : a ? g.starter : other(g.starter));
    g.round++;
    g.turn = g.starter;
  }
  g.deadline = room.config.hit.turnSeconds ? now() + room.config.hit.turnSeconds * 1000 : 0;
  publish(room);
}
function finish(room, winner) {
  const g = room.game;
  g.phase = 'ended'; g.winner = winner; g.deadline = 0;
  room.history.push({ game:g.type, at:now(), winner: winner === null ? 'draw' : room.players[winner]?.name,
    summary:g.type === 'hit' ? `${g.round}ラウンド` : `${g.scores[0]} - ${g.scores[1]}` });
  if (room.history.length > 30) room.history.shift();
  publish(room);
}
function nextQuiz(room) {
  const g = room.game;
  if (!g.queue.length) return finish(room, g.scores[0] === g.scores[1] ? null : g.scores[0] > g.scores[1] ? 0 : 1);
  g.current = g.queue.shift(); g.questionNo++;
  g.phase = 'revealing'; g.revealed = ''; g.cursor = 0;
  g.revealAt = now(); g.lastAnswer = null; g.attempted = [false,false];
  g.answerer = null; g.buzzWinner = null; g.progress = []; g.options = []; g.deadline = 0; g.fullAt = 0;
  publish(room);
}
function beginAnswer(room, seat) {
  const g = room.game;
  g.phase = 'answering'; g.buzzWinner = seat; g.answerer = seat;
  g.progress = []; g.attempted[seat] = true;
  g.options = makeOptions(graphemes(g.current.title).filter(ch => !/[\s\p{P}\p{S}]/u.test(ch))[0], TRACKS.map(t => t.title));
  g.deadline = now() + room.config.quiz.answerSeconds * 1000;
  publish(room);
}
function completeQuestion(room, outcome) {
  const g = room.game;
  g.lastAnswer = { title:g.current.title, artist:g.current.artist, outcome, source:g.current.source };
  g.phase = 'intermission'; g.intermissionUntil = now() + 2300; g.deadline = 0;
  g.answerer = null; g.options = [];
  if (g.scores.some(v => v >= room.config.quiz.target)) {
    const winner = g.scores[0] === g.scores[1] ? null : g.scores[0] > g.scores[1] ? 0 : 1;
    return finish(room, winner);
  }
  publish(room);
}
function wrongAnswer(room, seat) {
  const g = room.game;
  g.scores[seat] += room.config.quiz.penalty;
  const policy = room.config.quiz.wrongMode;
  g.answerer = null; g.options = []; g.deadline = 0;
  if (policy === 'opponent' && (room.config.quiz.allowRepeat || !g.attempted[other(seat)])) return beginAnswer(room, other(seat));
  if (policy === 'resume' && (room.config.quiz.allowRepeat || g.attempted.some(x => !x))) {
    g.phase = 'revealing'; g.revealAt = now() - (g.cursor - 1) * room.config.quiz.speedMs;
    if (g.cursor >= graphemes(g.current.text).length) g.fullAt = now();
    return publish(room);
  }
  completeQuestion(room, 'wrong');
}
function handle(peer, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const type = msg.type;
  try {
    if (type === 'create') {
      if (!/^[0-9a-f]{40}$/.test(msg.token || '')) throw Error('セッションIDが不正です。');
      if (peer.room) detach(peer, true);
      const code = makeRoomCode(rooms);
      const room = { code, host:0, players:[null,null], ready:[false,false], chosen:'quiz',
        config:{ hit:{ ...DEFAULT_HIT }, quiz:{ ...DEFAULT_QUIZ } }, game:null, history:[], updated:now(), pausedAt:0, nextHitStart:undefined, rematch:[false,false] };
      rooms.set(code, room); attach(peer, room, 0, msg.name, msg.token);
      return;
    }
    if (type === 'join') {
      if (!/^[0-9a-f]{40}$/.test(msg.token || '')) throw Error('セッションIDが不正です。');
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw Error('ルームが見つかりません。コードを確認してください。');
      let seat = room.players.findIndex(p => p?.token === msg.token);
      if (seat < 0) seat = room.players.findIndex(p => !p);
      if (seat < 0) throw Error('このルームは2人で満員です。');
      attach(peer, room, seat, msg.name, msg.token);
      return;
    }
    if (type === 'leave') { detach(peer, true); safe(peer, { type:'left' }); return; }
    const room = inRoom(peer);
    if (type === 'select') {
      isHost(peer, room); isLobby(room);
      if (!['hit','quiz'].includes(msg.game)) throw Error('このゲームは後日追加予定です。');
      room.chosen = msg.game; room.ready = [false,false]; publish(room); return;
    }
    if (type === 'config') {
      isHost(peer, room); isLobby(room);
      room.config[room.chosen] = sanitiseConfig(room.chosen, msg.config);
      room.ready = [false,false]; publish(room); return;
    }
    if (type === 'ready') {
      isLobby(room); if (!room.players.every(Boolean)) throw Error('2人揃ってから準備できます。');
      room.ready[peer.seat] = !!msg.value;
      if (room.ready.every(Boolean)) { startGame(room); } else publish(room);
      return;
    }
    if (type === 'backLobby') {
      isHost(peer, room);
      if (room.game?.phase !== 'ended') throw Error('対戦終了後に操作できます。');
      room.game = null; room.ready = [false,false]; room.rematch = [false,false]; publish(room); return;
    }
    if (type === 'rematch') {
      if (room.game?.phase !== 'ended') throw Error('試合終了後に操作できます。');
      room.rematch[peer.seat] = true;
      if (room.rematch.every(Boolean)) startGame(room); else publish(room);
      return;
    }
    if (type === 'setSecret') {
      const g = ensureActive(room,'hit');
      if (g.phase !== 'secrets' || g.secrets[peer.seat]) throw Error('数字はすでに登録されています。');
      if (!validNumber(msg.value, room.config.hit.allowZero)) throw Error('重複のない3桁を入力してください。');
      g.secrets[peer.seat] = msg.value;
      if (g.secrets.every(Boolean)) { g.phase = 'playing'; g.deadline = room.config.hit.turnSeconds ? now() + room.config.hit.turnSeconds * 1000 : 0; }
      publish(room); return;
    }
    if (type === 'guess') {
      const g = ensureActive(room,'hit');
      if (g.phase !== 'playing' || g.turn !== peer.seat) throw Error('今はあなたの手番ではありません。');
      if (!validNumber(msg.value, room.config.hit.allowZero)) throw Error('異なる数字3つを入力してください。');
      if (g.deadline && now() > g.deadline) throw Error('制限時間が切れました。');
      const result = hitBlow(g.secrets[other(peer.seat)], msg.value);
      g.guesses[peer.seat].push({ value:msg.value, ...result, round:g.round });
      nextHit(room, result.hits === 3); return;
    }
    if (type === 'hint') {
      const g = ensureActive(room,'hit');
      if (!room.config.hit.hints || g.hints[peer.seat] || g.phase !== 'playing') throw Error('ヒントは利用できません。');
      const value = g.secrets[other(peer.seat)].split('').filter(v => Number(v) % 2 === 0).length;
      g.hints[peer.seat] = `相手の数字に偶数は ${value} 個あります`;
      publish(room); return;
    }
    if (type === 'buzz' || type === 'buzzContend') {
      const g = ensureActive(room,'quiz');
      if (g.phase === 'arbitrating' && now() <= g.arbitrationUntil) {
        if (!g.candidates.some(x => x.seat === peer.seat) && (room.config.quiz.allowRepeat || !g.attempted[peer.seat])) g.candidates.push({ seat:peer.seat, received:now(), rtt:room.players[peer.seat].rtt });
        return;
      }
      if (g.phase !== 'revealing') return;
      if (!room.config.quiz.allowRepeat && g.attempted[peer.seat]) return;
      g.phase = 'arbitrating'; g.candidates = [{ seat:peer.seat, received:now(), rtt:room.players[peer.seat].rtt }];
      g.arbitrationUntil = now() + 160; publish(room); return;
    }
    if (type === 'buzzContend') {
      const g = ensureActive(room, 'quiz');
      if (g.phase !== 'arbitrating' || now() > g.arbitrationUntil) return;
      if (g.candidates.some(x => x.seat === peer.seat)) return;
      if (!room.config.quiz.allowRepeat && g.attempted[peer.seat]) return;
      g.candidates.push({ seat:peer.seat, received:now(), rtt:room.players[peer.seat].rtt }); return;
    }
    if (type === 'choice') {
      const g = ensureActive(room,'quiz');
      if (g.phase !== 'answering' || g.answerer !== peer.seat || room.config.quiz.inputMethod !== 'choices') return;
      if (g.deadline && now() > g.deadline) return;
      if (typeof msg.value !== 'string' || !g.options.includes(msg.value)) return;
      const titleLetters = graphemes(g.current.title).filter(ch => !/[\s\p{P}\p{S}]/u.test(ch));
      const expected = titleLetters[g.progress.length];
      if (msg.value !== expected) return wrongAnswer(room, peer.seat);
      g.progress.push(msg.value);
      if (g.progress.length === titleLetters.length) {
        g.scores[peer.seat] += room.config.quiz.points;
        return completeQuestion(room, 'correct');
      }
      g.options = makeOptions(titleLetters[g.progress.length], TRACKS.map(t => t.title));
      publish(room); return;
    }
    if (type === 'answer') {
      const g = ensureActive(room,'quiz');
      if (g.phase !== 'answering' || g.answerer !== peer.seat || room.config.quiz.inputMethod !== 'keyboard') return;
      if (typeof msg.value !== 'string' || msg.value.length > 100) return;
      if (normalizeAnswer(msg.value) === normalizeAnswer(g.current.title)) {
        g.scores[peer.seat] += room.config.quiz.points; return completeQuestion(room, 'correct');
      }
      return wrongAnswer(room, peer.seat);
    }
    if (type === 'skip') {
      isHost(peer,room);
      const g = ensureActive(room,'quiz');
      if (g.phase === 'revealing' || g.phase === 'arbitrating') completeQuestion(room, 'skipped');
      return;
    }
    if (type === 'probeAck') {
      const p = room.players[peer.seat];
      if (p.probe && msg.nonce === p.probe.nonce) {
        const measured = Math.max(1, Math.min(2000, now() - p.probe.at));
        p.rtt = Math.round(p.rtt * .8 + measured * .2); p.probe = null;
      }
      return;
    }
  } catch (e) { fail(peer, e.message || 'エラーが発生しました。'); }
}
function tick() {
  const time = now();
  for (const room of rooms.values()) {
    if (time - room.updated > 4 * 3600000) { rooms.delete(room.code); for (const p of room.players) p?.peer?.send({ type:'expired' }); continue; }
    if (room.pausedAt || !room.game || room.game.phase === 'ended') continue;
    const g = room.game;
    if (g.type === 'hit') {
      if (g.phase === 'playing' && g.deadline && time >= g.deadline) {
        g.guesses[g.turn].push({ value:'---', hits:0, blows:0, round:g.round, timeout:true });
        nextHit(room, false);
      }
    } else if (g.type === 'quiz') {
      if (g.phase === 'intermission' && time >= g.intermissionUntil) nextQuiz(room);
      else if (g.phase === 'revealing') {
        const letters = graphemes(g.current.text);
        const count = Math.min(letters.length, Math.max(1, 1 + Math.floor((time - g.revealAt) / room.config.quiz.speedMs)));
        if (count !== g.cursor) {
          g.cursor = count; g.revealed = letters.slice(0,count).join('');
          for (const p of room.players) p?.peer?.send({ type:'reveal', text:g.revealed, cursor:count });
        }
        if (count >= letters.length) {
          if (!g.fullAt) g.fullAt = time;
          if (time - g.fullAt > 12000) completeQuestion(room, 'timeup');
        }
      } else if (g.phase === 'arbitrating' && time >= g.arbitrationUntil) {
        // Arrival-time race with a bounded compensation for measured one-way latency.
        // Order is always decided server-side, not from forgeable client timestamps.
        const ranked = g.candidates.map(c => ({ ...c, adjusted:c.received - Math.min(75, c.rtt / 2) })).sort((a,b) => a.adjusted - b.adjusted);
        const selected = ranked.length > 1 && Math.abs(ranked[0].adjusted - ranked[1].adjusted) < 5 ? ranked[randomInt(2)] : ranked[0];
        beginAnswer(room, selected.seat);
      } else if (g.phase === 'answering' && time >= g.deadline) wrongAnswer(room, g.answerer);
    }
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok',rooms:rooms.size})); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/invite/')) pathname = '/index.html';
    const file = path.resolve(PUBLIC, '.' + pathname);
    if (!file.startsWith(PUBLIC + path.sep) && file !== path.resolve(PUBLIC,'index.html')) { res.writeHead(403); res.end(); return; }
    if (file.includes('/.')) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control':pathname === '/sw.js' || pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'same-origin' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); }
});
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  // Same-origin browser clients only; local Node tests have no Origin header.
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) { socket.destroy(); return; } } catch { socket.destroy(); return; } }
  upgrade(req, socket, head, peer => {
    peers.add(peer);
    peer.on('message', msg => handle(peer,msg));
    peer.on('close', () => { peers.delete(peer); detach(peer); });
    peer.send({ type:'hello' });
  });
});
setInterval(tick, 70).unref();
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players) if (p?.peer && !p.probe) {
      p.probe = { nonce:randomToken().slice(0,10), at:now() };
      p.peer.send({ type:'probe', nonce:p.probe.nonce });
    }
    for (const p of room.players) if (p?.probe && now() - p.probe.at > 10000) p.probe = null;
  }
}, 5000).unref();
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`DUO ARENA http://localhost:${port}`));
export { server, rooms };
