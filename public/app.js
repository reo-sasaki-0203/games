/* DUO ARENA client: DOM-only modular PWA. All authoritative state is on the server. */
const $ = selector => document.querySelector(selector);
const app = $('#app');
const STORAGE = { token:'duo.token', room:'duo.room', name:'duo.name' };
const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
const put = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} };
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titleFor = id => ({hit:'HIT & BLOW',quiz:'歌詞早押しクイズ',trivia:'早押し雑学',reflex:'反射神経バトル'}[id] || id);
const token = (() => { let value = get(STORAGE.token); if (!/^[0-9a-f]{40}$/.test(value || '')) { value = [...crypto.getRandomValues(new Uint8Array(20))].map(x => x.toString(16).padStart(2,'0')).join(''); put(STORAGE.token,value); } return value; })();
let socket, connected = false, room = null, advanced = false, hitDigits = '', optimisticBuzz = false, lastPhase = '', wasInRoom = !!get(STORAGE.room), toastTimeout;
let soundEnabled = get('duo.sound') !== 'off';
let audioContext;
function playSound(kind='tap') {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume().catch(()=>{});
    const osc=audioContext.createOscillator(), volume=audioContext.createGain();
    const t=audioContext.currentTime, freq=kind==='buzz'?380:kind==='correct'?660:kind==='wrong'?210:510;
    osc.type=kind==='buzz'?'sawtooth':'sine';
    osc.frequency.setValueAtTime(freq,t); osc.frequency.exponentialRampToValueAtTime(kind==='buzz'?520:Math.max(130,freq*1.18),t+.09);
    volume.gain.setValueAtTime(.0001,t); volume.gain.exponentialRampToValueAtTime(.045,t+.012);
    volume.gain.exponentialRampToValueAtTime(.0001,t+.16);
    osc.connect(volume);volume.connect(audioContext.destination);osc.start(t);osc.stop(t+.17);
  } catch {}
}
const inviteCode = new URLSearchParams(location.search).get('room') || location.pathname.match(/^\/invite\/([A-Z0-9]{6})/i)?.[1] || '';
const info = (message) => { const el=$('#toast'); el.textContent=message; el.classList.add('visible'); clearTimeout(toastTimeout); toastTimeout=setTimeout(() => el.classList.remove('visible'), 3400); };
const send = (type, payload={}) => { if (!connected) { info('通信が切れています。再接続してください。'); return; } socket.send(JSON.stringify({type,...payload})); };
function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => {
    connected = true;
    const code = get(STORAGE.room);
    if (code) send('join', {code,token,name:get(STORAGE.name)});
    render();
  };
  socket.onclose = () => {
    connected = false; render(); setTimeout(connect, 1600);
  };
  socket.onerror = () => {};
  socket.onmessage = ({data}) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'hello') return;
    if (msg.type === 'probe') { send('probeAck', {nonce:msg.nonce}); return; }
    if (msg.type === 'joined') { put(STORAGE.room,msg.code); wasInRoom = true; history.replaceState(null,'', location.pathname === '/' ? '/?room='+msg.code : '/?room='+msg.code); return; }
    if (msg.type === 'state') {
      const previous = room?.game?.phase;
      const previousKind = room?.game?.type;
      const oldScores = room?.game?.type === 'quiz' ? [...room.game.scores] : null;
      room = msg.room;
      if (oldScores && room.game?.type==='quiz' && room.game.scores.some((x,i)=>x!==oldScores[i])) playSound(room.game.scores.some((x,i)=>x>oldScores[i])?'correct':'wrong');
      if (room.game?.phase !== previous || room.game?.type !== previousKind) { optimisticBuzz = false; hitDigits = ''; }
      lastPhase = room.game?.phase || '';
      render(); return;
    }
    if (msg.type === 'reveal') {
      if (room?.game?.phase === 'revealing') {
        room.game.revealed = msg.text; room.game.cursor = msg.cursor;
        const target = $('#question-text');
        if (target && !optimisticBuzz) target.innerHTML = `${escapeHTML(msg.text)}<span class="caret"></span>`;
        const bar = $('#reveal-bar'); if (bar) bar.style.width = `${Math.max(1,(msg.cursor / Math.max(1,room.game.textLength))*100)}%`;
      }
      return;
    }
    if (msg.type === 'error') {
      info(msg.message);
      if (!room && wasInRoom && /見つかりません/.test(msg.message)) { put(STORAGE.room,null); wasInRoom=false; render(); }
      return;
    }
    if (msg.type === 'left' || msg.type === 'expired' || msg.type === 'kicked') {
      if (msg.type === 'kicked') info(msg.message); else if (msg.type === 'expired') info('ルームの有効期限が切れました。');
      put(STORAGE.room,null); wasInRoom=false; room=null; history.replaceState(null,'','/'); render();
    }
  };
}
function header() {
  return `<header class="app-head"><div class="brand"><div class="logo">✦</div> DUO <span style="color:#b3a3ff">ARENA</span></div>
    <div class="flex" style="gap:10px"><button class="sound-toggle" data-action="sound" aria-label="効果音の切り替え" title="効果音">${soundEnabled?'♫':'♪̸'}</button><div class="conn"><span class="dot ${connected?'online':''}"></span>${connected?'オンライン':'再接続中…'}</div></div></header>`;
}
function footer() { return `<p class="code-foot">2 PLAYERS · 1 ARENA · HAVE FUN</p>`; }
function home() {
  const code = escapeHTML((inviteCode || '').toUpperCase());
  return `${header()}<section class="hero"><div class="eyebrow">A LITTLE COMPETITION, A LOT OF FUN</div><h1>ふたりなら、<br><span class="gradient-text">もっと熱くなる。</span></h1><p class="sub">2台のスマホで、いつでも対戦。<br>登録不要。ルームを作って、招待するだけ。</p></section>
    <div class="panel glass"><div class="panel-title"><span class="num">01</span> ルームを作る</div>
      <div class="field"><label for="name">あなたの名前</label><input id="name" maxlength="16" autocomplete="nickname" placeholder="ニックネーム" value="${escapeHTML(get(STORAGE.name) || '')}" /></div>
      <button class="btn primary wide" data-action="create" ${!connected?'disabled':''}>✦　新しいルームを作成</button></div>
    <div class="divider">または</div>
    <div class="panel"><div class="panel-title"><span class="num">02</span> ルームに参加</div>
      <div class="field"><label for="join-code">6桁のルームコード</label><input id="join-code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="例：AB3K9P" value="${code}" /></div>
      <button class="btn cyan wide" data-action="join" ${!connected?'disabled':''}>ルームに参加する →</button></div>
    <div class="flex wrap" style="justify-content:center;gap:8px;margin-top:24px"><span class="tag">◎ アカウント不要</span><span class="tag">⌁ リアルタイム</span><span class="tag">◈ iPhone / Android</span></div>${footer()}`;
}
function playerRow(p,i) {
  const me = i === room.me;
  const ready = room.ready[i];
  return `<div class="player-row"><div class="avatar ${i===1?'second':''}">${p ? escapeHTML(p.name[0]) : '?'}</div>
    <div class="player-meta"><div class="player-name">${p?escapeHTML(p.name):'参加を待っています'} ${me?'<span class="tag gray">あなた</span>':''}</div>
    <div class="status-text">${p ? (p.online?'● 接続中':'○ オフライン') : '招待URLを送ろう'}</div></div>
    <span class="tag ${ready?'active':'gray'}">${!p?'空席':ready?'準備OK':'待機中'}</span></div>`;
}
function gameCard(id, icon, desc, color, disabled = false) {
  const active = room.chosen === id;
  const host = room.me === room.host;
  return `<button class="game-card ${active?'active':''} ${disabled?'disabled':''}" style="width:100%;text-align:left;color:inherit" data-action="select" data-game="${id}" ${disabled || !host?'disabled':''}>
    <div class="game-symbol ${color}">${icon}</div><div class="game-details"><div class="game-name">${titleFor(id)} ${disabled?'<span class="tag gray">COMING SOON</span>':''}</div><div class="game-desc">${desc}</div></div>${!disabled?'<div class="radio-circle"></div>':''}</button>`;
}
function fieldSelect(label,key,options) {
  const cfg = room.config[room.chosen];
  return `<div class="setting-row"><label for="cfg-${key}">${label}</label><select id="cfg-${key}" data-config="${key}">${options.map(([v,t])=>`<option value="${escapeHTML(v)}" ${String(cfg[key])===String(v)?'selected':''}>${escapeHTML(t)}</option>`).join('')}</select></div>`;
}
function fieldNum(label,key,min,max) {
  return `<div class="setting-row"><label for="cfg-${key}">${label}</label><input type="number" min="${min}" max="${max}" step="1" id="cfg-${key}" data-config="${key}" value="${room.config[room.chosen][key]}" /></div>`;
}
function fieldCheck(label,key) {
  return `<div class="setting-row"><label for="cfg-${key}">${label}</label><input type="checkbox" id="cfg-${key}" data-config="${key}" ${room.config[room.chosen][key]?'checked':''}/></div>`;
}
function settings() {
  const isHost = room.me === room.host;
  const quiz = room.chosen === 'quiz';
  let fields = quiz ? [
    fieldSelect('先取点数','target',[[3,'3点'],[5,'5点'],[10,'10点'],[15,'15点'],[20,'20点']]),
    fieldSelect('表示スピード','speedMs',[[120,'速い · 0.12秒'],[250,'普通 · 0.25秒'],[450,'遅い · 0.45秒'],[700,'ゆっくり · 0.7秒']]),
    fieldSelect('難易度','difficulty',[['mix','ミックス'],['easy','かんたん'],['medium','ふつう'],['hard','むずかしい']]),
    fieldSelect('年代','era',[['mix','ミックス'],['昭和','昭和'],['平成','平成'],['令和','令和']])
  ] : [
    fieldSelect('1ターンの時間','turnSeconds',[[0,'制限なし'],[10,'10秒'],[15,'15秒'],[20,'20秒'],[30,'30秒'],[45,'45秒'],[60,'60秒'],[90,'90秒']]),
    fieldCheck('先頭の0を許可','allowZero')
  ];
  const more = quiz ? [
    fieldSelect('正解の得点','points',[[1,'+1点'],[2,'+2点']]),
    fieldSelect('誤答のペナルティ','penalty',[[0,'なし'],[-1,'−1点'],[-2,'−2点']]),
    fieldSelect('誤答後の扱い','wrongMode',[['resume','続きを表示'],['opponent','相手に回答権'],['end','問題を終了']]),
    fieldCheck('再回答を許可','allowRepeat'),
    fieldSelect('回答制限時間','answerSeconds',[[5,'5秒'],[10,'10秒'],[12,'12秒'],[15,'15秒'],[20,'20秒'],[30,'30秒']]),
    fieldSelect('回答方法','inputMethod',[['choices','1文字ずつ4択'],['keyboard','キーボード入力']]),
    fieldNum('表示間隔（ms）','speedMs',100,1500),
    fieldNum('先取点数（自由設定）','target',1,100),
    fieldNum('回答秒数（自由設定）','answerSeconds',3,60)
  ] : [fieldCheck('ヒントを許可','hints')];
  return `<div class="panel"><div class="flex between"><h3 class="panel-title mb0">⚙ 対戦ルール</h3><span class="tag">${isHost?'編集可能':'ホストが設定'}</span></div>
    <div ${isHost?'':'style="opacity:.75;pointer-events:none"'}>${fields.join('')}
    <button class="expander" data-action="advanced">${advanced?'− 詳細設定を閉じる':'＋ 詳細設定を開く'}</button>
    ${advanced?`<div class="advanced">${more.join('')}</div>`:''}</div>
    ${quiz?'<div class="muted-panel">ⓘ 出題文は開発用のオリジナル文章です。実際の楽曲の歌詞ではありません。</div>':'<div class="muted-panel">ⓘ 秘密の数字は相手に送信されません。双方1回ずつ回答してから勝敗を判定します。</div>'}</div>`;
}
function lobby() {
  const host = room.me === room.host, both = room.players.every(Boolean), ready=room.ready[room.me];
  const invite = `${location.origin}/?room=${room.code}`;
  return `${header()}<div class="eyebrow">PRIVATE MATCH · ROOM ${room.code}</div>
    <div class="flex between"><h1 style="margin:0;font-size:25px">対戦ルーム</h1><button class="btn tiny ghost" data-action="leave">退出</button></div>
    <div class="panel glass"><div class="small text-center">ルームコード</div><div class="room-code">${room.code}</div>
      <div class="flex mt12"><div class="invite grow" id="invite-url">${escapeHTML(invite)}</div><button class="btn tiny primary" data-action="copy">コピー</button></div>
      <p class="hint text-center mb0">友達にURLかルームコードを送ろう</p></div>
    <div class="panel"><h3 class="panel-title">◉ プレイヤー <span class="tag active">${room.players.filter(Boolean).length} / 2</span></h3>${room.players.map(playerRow).join('')}</div>
    <div class="section"><h2>ゲームを選ぶ</h2><span class="tag">4 GAMES</span></div>
    ${gameCard('quiz','♫','歌のタイトルを誰より早く当てろ','orange')}
    ${gameCard('hit','123','相手の秘密の3桁を見破ろう','teal')}
    ${gameCard('trivia','?','あとから追加するゲーム用の枠','gray',true)}
    ${gameCard('reflex','⚡','あとから追加するゲーム用の枠','gray',true)}
    ${settings()}
    <div class="panel glass"><div class="flex between"><div><div style="font-size:17px;font-weight:900">${ready?'準備完了！':'準備はいい？'}</div><div class="small mt8">${room.ready.filter(Boolean).length} / 2 人が準備完了</div></div><span style="font-size:29px">${ready?'✓':'✦'}</span></div>
    <button class="btn ${ready?'ghost':'primary'} wide mt12" data-action="ready" data-value="${ready?'false':'true'}" ${!both?'disabled':''}>${ready?'準備を取り消す':'準備OK！'}</button>
    ${!both?'<p class="hint text-center">2人揃うと準備できます</p>':'<p class="hint text-center">両方が準備完了すると自動で始まります</p>'}</div>
    ${room.history.length?`<div class="panel"><h3 class="panel-title">↺ 対戦履歴</h3>${room.history.map(h=>`<div class="game-history-item"><span>${titleFor(h.game)}<br><span class="hint">${escapeHTML(new Date(h.at).toLocaleString('ja-JP'))}</span></span><span style="text-align:right">${h.winner==='draw'?'引き分け':escapeHTML(h.winner)+' の勝ち'}<br><span class="hint">${escapeHTML(h.summary)}</span></span></div>`).join('')}</div>`:''}
    ${footer()}`;
}
function matchHeader(name) {
  return `${header()}<div class="game-header"><div><div class="eyebrow">LIVE MATCH · ${room.code}</div><div class="title">${name}</div></div><span class="tag active">● LIVE</span></div>`;
}
function timeLabel(ts) { return ts ? `<span class="timer" data-until="${ts}">--</span>` : ''; }
function scoreCards(scores, subtitle='点') {
  return `<div class="scores">${[0,1].map(i=>`<div class="score-card ${i===room.me?'me':'enemy'}"><div class="who">${i===room.me?'YOU':'OPPONENT'} · ${escapeHTML(room.players[i].name)}</div><div class="score">${scores[i]}<small>${subtitle}</small></div></div>`).join('')}</div>`;
}
function pauseBanner() { return room.paused ? `<div class="notice warning">相手の接続が切れました。再接続までタイマーを停止しています。復帰すると自動再開します。</div>` : ''; }
function digitDisplay() { return `<div class="number-display">${[0,1,2].map(i=>`<div class="digit ${!hitDigits[i]?'blank':''}">${escapeHTML(hitDigits[i] || '·')}</div>`).join('')}</div>`; }
function keypad() { return `<div class="keypad">${['1','2','3','4','5','6','7','8','9','','0','⌫'].map(x=>x?`<button class="key ${x==='⌫'?'delete':''}" data-action="key" data-value="${x}">${x}</button>`:'<div class="key empty"></div>').join('')}</div>`; }
function guessesPanel(g) {
  return `<div class="section"><h2>推測履歴</h2><span class="tag">${g.round} ROUND</span></div><div class="history-columns">${[0,1].map(i=>`<div class="history-panel"><div class="history-head">${i===room.me?'あなた':'相手'}の推測</div>
    ${g.guesses[i].length ? g.guesses[i].map(it=>`<div class="history-item ${it.hits===3?'hit':''}"><span class="val">${escapeHTML(it.value)}</span><span class="hb">${it.timeout?'時間切れ':it.hits+'H '+it.blows+'B'}</span></div>`).join(''):'<p class="hint text-center">まだ回答がありません</p>'}</div>`).join('')}</div>`;
}
function hitPage(g) {
  const me = room.me, set=g.secretSet[me], playing=g.phase==='playing', myTurn=g.turn===me;
  let controls;
  if (g.phase === 'secrets') {
    controls = `<div class="panel"><div class="text-center"><span class="tag">STEP 01</span><h2>${set?'数字を登録しました':'秘密の3桁を決めよう'}</h2><p class="small">${set?'相手の登録を待っています…':'0〜9の異なる3つの数字を選んでください。'}</p></div>
      ${!set?`${digitDisplay()}${keypad()}<button class="btn primary wide" data-action="secret" ${hitDigits.length!==3?'disabled':''}>この数字で確定する</button>`:'<div class="status-banner teal">✓ 登録済み · 相手には非公開</div>'}
    </div><div class="panel"><h3 class="panel-title">登録状況</h3>${[0,1].map(i=>`<div class="flex between mt8"><span>${escapeHTML(room.players[i].name)}</span><span class="tag ${g.secretSet[i]?'active':'gray'}">${g.secretSet[i]?'登録済み':'入力待ち'}</span></div>`).join('')}</div>`;
  } else {
    controls = `<div class="flex between"><div class="round-badge">ROUND ${g.round}</div><div class="round-badge">${timeLabel(g.deadline)}</div></div>
      <div class="status-banner ${myTurn?'teal':'orange'}">${myTurn?'あなたのターン！相手の数字を予想':'相手のターンです · 回答を待とう'}</div>
      ${myTurn?`<div class="panel"><p class="text-center small">相手の数字を推測</p>${digitDisplay()}${keypad()}<button class="btn primary wide" data-action="guess" ${hitDigits.length!==3?'disabled':''}>この数字で回答する →</button></div>`:'<div class="panel text-center"><div style="font-size:46px;padding:24px 0">⌛</div><p class="sub">相手が考え中です…</p></div>'}
      ${room.config.hit.hints?`<div class="flex between mt12"><span class="small">${g.hints[me]||'ヒントを1回だけ使えます'}</span><button class="btn tiny ghost" data-action="hint" ${g.hints[me]?'disabled':''}>ヒント</button></div>`:''}
      ${guessesPanel(g)}`;
  }
  return `${matchHeader('HIT & BLOW')}${pauseBanner()}${controls}${footer()}`;
}
function progressText(g) { return g.progress.map(x => escapeHTML(x)).join('') + '<span style="color:#726b93">' + '·'.repeat(Math.max(0,g.answerLength-g.progress.length)) + '</span>'; }
function quizPage(g) {
  const cfg=room.config.quiz, me=room.me, answering=g.phase==='answering', mine=answering&&g.answerer===me;
  const canBuzz=g.phase==='revealing' && (cfg.allowRepeat || !g.attempted[me]);
  let content = '';
  if (g.phase==='intermission') {
    content = g.lastAnswer ? `<div class="panel text-center"><div class="eyebrow">QUESTION ${g.questionNo} / RESULTS</div><div style="font-size:44px;margin-bottom:12px">${g.lastAnswer.outcome==='correct'?'✦':'♫'}</div>
      <div class="reveal-ended"><strong>${escapeHTML(g.lastAnswer.title)}</strong><br>${escapeHTML(g.lastAnswer.artist)}</div>
      <p class="small">${g.lastAnswer.outcome==='correct'?'正解！':g.lastAnswer.outcome==='timeup'?'時間切れ':g.lastAnswer.outcome==='skipped'?'スキップ':'不正解'}</p><div class="status-banner">次の問題へ ${timeLabel(g.intermissionUntil)}</div></div>`:
      `<div class="panel text-center"><div style="font-size:65px;margin:27px 0">♫</div><h2>まもなくスタート！</h2><p class="small">画面下のボタンで早押し</p><div>${timeLabel(g.intermissionUntil)}</div></div>`;
  } else {
    const stopped = g.phase!=='revealing';
    content = `<div class="flex between mt12"><div class="tag">QUESTION ${g.questionNo}</div><div class="small">${g.phase==='revealing'?'歌詞が少しずつ表示されます':'表示停止中'}</div></div>
      <div class="question-block"><div class="question-label">♫ LYRIC REVEAL · デモ文章</div><div class="question-text" id="question-text">${escapeHTML(g.revealed||'')}<span class="caret" ${stopped?'style="visibility:hidden"':''}></span></div><div class="reveal-progress"><div id="reveal-bar" style="width:${Math.max(1,Math.round(g.cursor/Math.max(1,g.textLength)*100))}%"></div></div></div>`;
    if (g.phase==='arbitrating') content += `<div class="status-banner orange pulse">早押し判定中…</div>`;
    if (answering) {
      content += `<div class="status-banner ${mine?'teal':'orange'}">${mine?'あなたが回答権を獲得！':'回答権：'+escapeHTML(room.players[g.answerer]?.name||'相手')}</div>`;
      if (mine) {
        content += `<div class="answerbox"><div class="flex between"><div class="small">曲名を完成させよう</div><div>${timeLabel(g.deadline)}</div></div>
        ${cfg.inputMethod==='choices'?`<div class="answer-display">${progressText(g)}</div><div class="choice-grid">${(g.options || []).map(ch=>`<button class="choice" data-action="choice" data-value="${escapeHTML(ch)}">${escapeHTML(ch)}</button>`).join('')}</div>`:
          `<form id="answer-form"><input id="answer-input" name="answer" placeholder="曲名を入力" maxlength="80" autocomplete="off" autocapitalize="off" /><button class="btn primary wide mt12" type="submit">この曲名で回答する</button></form>`}
        <div class="hint text-center mt12">${cfg.inputMethod==='choices'?'間違った文字を押すと即誤答になります':'全角・半角・大文字小文字の違いは吸収します'}</div></div>`;
      } else content += `<div class="panel text-center"><p class="small">相手が回答中です</p><div class="answer-display">${progressText(g)}</div>${timeLabel(g.deadline)}</div>`;
    } else if (g.phase==='revealing') {
      content += `<div class="buzz-wrap"><button id="buzz" class="buzz ${optimisticBuzz?'pressed':''}" data-action="buzz" ${!canBuzz || optimisticBuzz?'disabled':''}>早押し！</button>
        <div class="buzz-sub">${!canBuzz?'この問題は再回答できません':'ひらめいたら、すぐに押そう'}</div></div>`;
    }
    if (room.me===room.host && (g.phase==='revealing'||g.phase==='arbitrating')) content += `<div class="text-center mt20"><button class="btn tiny ghost" data-action="skip">この問題をスキップ</button></div>`;
  }
  return `${matchHeader('歌詞早押しクイズ')}${pauseBanner()}${scoreCards(g.scores)}${content}<div class="quiz-answer">※ このデモの文章はオリジナルの例文で、実際の楽曲の歌詞ではありません。</div>${footer()}`;
}
function result() {
  const g=room.game, winner=g.winner, myself=winner===room.me, draw=winner==null;
  const title=draw?'引き分け！':myself?'YOU WIN!':'YOU LOSE';
  return `${header()}<div class="eyebrow">MATCH FINISHED</div><div class="panel glass text-center" style="padding:25px 18px"><div class="result-medal">${draw?'🤝':myself?'🏆':'🎮'}</div>
    <div class="result-winner">${title}</div><div class="sub">${draw?'互角の勝負でした':escapeHTML(room.players[winner].name)+' の勝利！'}</div>
    ${g.type==='quiz'?`<div class="mt20">${scoreCards(g.scores)}</div>`:
      `<div class="mt20"><div class="status-banner">${g.round} ラウンドで決着</div><div class="small">正解：${g.revealSecrets?.map((x,i)=>escapeHTML(room.players[i].name)+' = '+escapeHTML(x)).join(' / ') || ''}</div></div>`}
    </div>
    <div class="panel"><h3 class="panel-title">次はどうする？</h3>
      <button class="btn primary wide" data-action="rematch" ${room.rematch[room.me]?'disabled':''}>${room.rematch[room.me]?'相手の再戦希望を待機中…':'↺ もう一度対戦する'}</button>
      ${room.me===room.host?'<button class="btn ghost wide mt12" data-action="backLobby">別のゲームを選ぶ</button>':'<div class="small text-center mt12">ゲームの変更はルーム作成者が行えます</div>'}
      <button class="btn tiny ghost wide mt12" data-action="leave">ルームを退出する</button></div>
    ${g.type==='hit'?guessesPanel(g):g.lastAnswer?`<div class="panel"><h3 class="panel-title">最後の問題</h3><div class="reveal-ended">${escapeHTML(g.lastAnswer.title)} · ${escapeHTML(g.lastAnswer.artist)}</div></div>`:''}${footer()}`;
}
function render() {
  const before = app.scrollTop;
  if (!room) { app.innerHTML = wasInRoom ? `${header()}<div class="loading"><h2>ルームに接続しています…</h2><p>再接続できない場合は下のボタンを押してください。</p><button class="btn ghost mt12" data-action="forget">ホームに戻る</button></div>` : home(); return; }
  if (!room.game) app.innerHTML = lobby();
  else if (room.game.phase==='ended') app.innerHTML = result();
  else if (room.game.type==='hit') app.innerHTML = hitPage(room.game);
  else app.innerHTML = quizPage(room.game);
  updateTimers();
}
function updateTimers() {
  document.querySelectorAll('[data-until]').forEach(el => {
    const remaining = Math.max(0,Number(el.dataset.until) - Date.now());
    el.textContent = room?.paused ? '一時停止' : `${(remaining / 1000).toFixed(1)}s`;
    el.classList.toggle('urgent',remaining < 5000);
  });
}
setInterval(updateTimers,100);
function updateHitDigits(value) { if (!room || room.game?.type!=='hit') return; if (value==='⌫') hitDigits=hitDigits.slice(0,-1); else if (hitDigits.length<3 && !hitDigits.includes(value)) hitDigits+=value; render(); }
function settingValue(input) {
  if (!room || room.me!==room.host || room.game) return;
  const value = input.type==='checkbox' ? input.checked : (/^-?\d+$/.test(input.value) ? Number(input.value) : input.value);
  const config={...room.config[room.chosen],[input.dataset.config]:value};
  send('config',{config});
}
app.addEventListener('change',e=>{ if (e.target.matches('[data-config]')) settingValue(e.target); });
app.addEventListener('submit', e=>{ if (e.target.id==='answer-form') { e.preventDefault(); send('answer',{value:$('#answer-input')?.value||''}); } });
app.addEventListener('click', async e => {
  const button = e.target.closest('button[data-action]'); if (!button) return;
  const a=button.dataset.action;
  if (a==='sound') { soundEnabled=!soundEnabled;put('duo.sound',soundEnabled?'on':'off');if(soundEnabled)playSound('tap');render(); }
  else if (a==='create' || a==='join') {
    const raw = $('#name')?.value.trim() || get(STORAGE.name) || 'プレイヤー';
    put(STORAGE.name,raw.slice(0,16));
    if (a==='create') { wasInRoom=true; send('create',{name:raw,token}); }
    else { const code=($('#join-code')?.value||'').trim().toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(code)) { info('6文字のルームコードを入力してください。'); return; } wasInRoom=true; send('join',{code,token,name:raw}); }
  } else if(a==='forget'){put(STORAGE.room,null);wasInRoom=false;room=null;history.replaceState(null,'','/');render();}
  else if(a==='leave'){send('leave');}
  else if(a==='copy'){
    const url=`${location.origin}/?room=${room.code}`;
    try { await navigator.clipboard.writeText(url); info('招待URLをコピーしました！'); } catch { info(url); }
  } else if(a==='advanced'){advanced=!advanced;render();}
  else if(a==='select'){send('select',{game:button.dataset.game});}
  else if(a==='ready'){send('ready',{value:button.dataset.value==='true'});}
  else if(a==='key'){updateHitDigits(button.dataset.value);}
  else if(a==='secret'){if(hitDigits.length===3){playSound('tap');send('setSecret',{value:hitDigits});hitDigits='';}}
  else if(a==='guess'){if(hitDigits.length===3){playSound('tap');send('guess',{value:hitDigits});hitDigits='';}}
  else if(a==='hint'){send('hint');}
  else if(a==='buzz'){
    playSound('buzz'); navigator.vibrate?.(25); optimisticBuzz = true; button.classList.add('pressed');button.disabled=true;
    $('#question-text .caret')?.remove();send('buzz');
  } else if(a==='choice') { playSound('tap'); button.disabled=true; send('choice',{value:button.dataset.value}); }
  else if(a==='skip'){send('skip');}
  else if(a==='rematch'){send('rematch');}
  else if(a==='backLobby'){send('backLobby');}
});
window.addEventListener('online',connect);
window.addEventListener('pageshow',()=>{if(!connected)connect();});
if ('serviceWorker' in navigator && location.protocol==='https:' || location.hostname==='localhost') {
  navigator.serviceWorker?.register('/sw.js').catch(()=>{});
}
connect(); render();
