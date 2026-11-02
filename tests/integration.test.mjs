import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { graphemes } from '../server/engine.mjs';

process.env.PORT = '0';
const {server, rooms} = await import('../server/index.mjs');
if (!server.listening) await once(server,'listening');
const port=server.address().port;
const url=`ws://127.0.0.1:${port}/ws`;
let clients=[];
const connect = async () => {
  const ws = new WebSocket(url);
  const queue=[];const waiters=[];
  ws.addEventListener('message', ({data}) => {
    const message=JSON.parse(data);
    queue.push(message);
    for (const waiting of [...waiters]) if (waiting.pred(message)) {waiters.splice(waiters.indexOf(waiting),1);clearTimeout(waiting.timer);waiting.resolve(message);}
  });
  await new Promise((resolve,reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject,{once:true}); });
  const client = {
    ws,queue,
    send(type,payload={}){ws.send(JSON.stringify({type,...payload}));},
    wait(pred, timeout=6000) {
      const found=queue.findLast(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve,reject)=>{const waiting={pred,resolve,timer:null};waiting.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiting),1);reject(new Error('Message timeout: '+JSON.stringify(queue.slice(-3))));},timeout);waiters.push(waiting);});
    },
    clear(){queue.length=0;}
  };
  clients.push(client);return client;
};
const tok=()=>randomBytes(20).toString('hex');
async function createTwo() {
  const a=await connect(), b=await connect();
  const tokenA=tok(), tokenB=tok();
  a.send('create',{name:'Alice',token:tokenA});
  const joined=await a.wait(x=>x.type==='joined');const code=joined.code;
  b.send('join',{code,name:'Bob',token:tokenB});
  await b.wait(x=>x.type==='state'&&x.room.players.every(p=>p?.online));
  return {a,b,code,room:rooms.get(code),tokenA,tokenB};
}
test.after(async()=>{for(const c of clients)c.ws.close();await new Promise(res=>server.close(res));});

test('real WebSocket handshake, room sync, hidden secrets, same-round draw, rematch',async()=>{
  const {a,b,code,room}=await createTwo();
  a.send('select',{game:'hit'});await b.wait(x=>x.type==='state'&&x.room.chosen==='hit');
  a.send('config',{config:{allowZero:true,turnSeconds:0,hints:true}});
  await a.wait(x=>x.type==='state'&&x.room.config.hit.turnSeconds===0);
  a.send('ready',{value:true});b.send('ready',{value:true});
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='secrets');
  a.send('setSecret',{value:'012'});b.send('setSecret',{value:'345'});
  await b.wait(x=>x.type==='state'&&x.room.game?.phase==='playing');
  assert.equal(room.game.secrets[0],'012');
  const view=a.queue.filter(x=>x.type==='state').at(-1).room;
  assert.equal(JSON.stringify(view).includes('"012"'),false, 'secrets must never be broadcast during match');
  const starter=room.game.starter;
  (starter===0?a:b).send('guess',{value:starter===0?'345':'012'});
  await a.wait(x=>x.type==='state'&&x.room.game?.guesses[starter].length===1);
  (starter===0?b:a).send('guess',{value:starter===0?'012':'345'});
  await b.wait(x=>x.type==='state'&&x.room.game?.phase==='ended');
  assert.equal(room.game.winner,null);
  assert.equal(room.history.length,1);
  assert.deepEqual(room.game.guesses.map(g=>g[0].hits),[3,3]);
  a.clear(); b.clear();
  a.send('rematch');b.send('rematch');
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='secrets');
  assert.notEqual(room.game.starter,starter,'rematch reverses first turn');
  assert.equal(code.length,6);
});

test('quiz reveals incrementally, arbitration and four-choice answers score on server',async()=>{
  const {a,b,room}=await createTwo();
  a.send('config',{config:{target:1,points:2,penalty:-1,wrongMode:'end',allowRepeat:false,speedMs:100,answerSeconds:20,difficulty:'mix',era:'mix',inputMethod:'choices'}});
  await b.wait(x=>x.type==='state'&&x.room.config.quiz.speedMs===100);
  a.send('ready',{value:true});b.send('ready',{value:true});
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='revealing',5000);
  const reveal=await a.wait(x=>x.type==='reveal'&&x.text?.length>=2,5000);
  assert.equal(typeof reveal.text,'string');
  assert.ok(reveal.text.length < room.game.current.text.length);
  a.send('buzz');b.send('buzz');
  await b.wait(x=>x.type==='state'&&x.room.game?.phase==='answering');
  const seat=room.game.answerer;
  assert.ok([0,1].includes(seat));
  const winner=seat===0?a:b;
  const title=room.game.current.title;
  const letters=graphemes(title).filter(ch=>!/[\s\p{P}\p{S}]/u.test(ch));
  for (let i=0;i<letters.length;i++) {
    const options=room.game.options;
    assert.ok(options.includes(letters[i]),`option ${i} missing`);
    winner.send('choice',{value:letters[i]});
    if (i<letters.length-1) await winner.wait(x=>x.type==='state'&&x.room.game?.progress?.length===i+1);
  }
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='ended');
  assert.equal(room.game.scores[seat],2);
  assert.equal(room.game.winner,seat);
});


test('connection loss pauses match; identity token restores seat and timer', async () => {
  const {a,b,code,room,tokenA}=await createTwo();
  a.send('select',{game:'hit'});
  await a.wait(x=>x.type==='state'&&x.room.chosen==='hit');
  a.send('ready',{value:true});b.send('ready',{value:true});
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='secrets');
  a.send('setSecret',{value:'123'});b.send('setSecret',{value:'456'});
  await b.wait(x=>x.type==='state'&&x.room.game?.phase==='playing');
  a.ws.close();
  await b.wait(x=>x.type==='state'&&x.room.paused===true);
  assert.equal(!!room.pausedAt,true);
  const reconnect=await connect();
  reconnect.send('join',{code,name:'Alice',token:tokenA});
  const resumed=await b.wait(x=>x.type==='state'&&x.room.paused===false&&x.room.players.every(p=>p.online));
  assert.equal(resumed.room.players[0].name,'Alice');
  assert.equal(room.game.phase,'playing');
});

test('wrong four-choice response applies penalty and grants opponent answer right',async()=>{
  const {a,b,room}=await createTwo();
  a.send('config',{config:{target:1,points:1,penalty:-2,wrongMode:'opponent',allowRepeat:false,speedMs:100,answerSeconds:20,difficulty:'mix',era:'mix',inputMethod:'choices'}});
  await a.wait(x=>x.type==='state'&&x.room.config.quiz.penalty===-2);
  a.send('ready',{value:true});b.send('ready',{value:true});
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='revealing',5000);
  a.send('buzz');
  await a.wait(x=>x.type==='state'&&x.room.game?.phase==='answering');
  assert.equal(room.game.answerer,0);
  const correct=graphemes(room.game.current.title).filter(ch=>!/[\s\p{P}\p{S}]/u.test(ch))[0];
  const wrong=room.game.options.find(x=>x!==correct);
  a.send('choice',{value:wrong});
  await a.wait(x=>x.type==='state'&&x.room.game?.answerer===1&&x.room.game?.phase==='answering');
  assert.equal(room.game.scores[0],-2);
  const letters=graphemes(room.game.current.title).filter(ch=>!/[\s\p{P}\p{S}]/u.test(ch));
  for(let i=0;i<letters.length;i++){
    b.send('choice',{value:letters[i]});
    if(i<letters.length-1) await b.wait(x=>x.type==='state'&&x.room.game?.progress?.length===i+1);
  }
  await b.wait(x=>x.type==='state'&&x.room.game?.phase==='ended');
  assert.deepEqual(room.game.scores,[-2,1]);
  assert.equal(room.game.winner,1);
});
