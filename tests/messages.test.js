import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const sleep=t=>new Promise(r=>setTimeout(r,t));
test('direct: somente seguidores mútuos, mensagens privadas, não lidas, leitura e persistência',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'entrelinhas-direct-'));
 const db=path.join(dir,'db.sqlite');let app=null;let base='';let logs='';
 const start=async()=>{
  const port=await freePort();base=`http://127.0.0.1:${port}`;logs='';
  app=spawn(process.execPath,['server.js'],{cwd:path.resolve(''),env:{...process.env,PORT:String(port),DB_PATH:db,INVITE_CODE:'convite-privado-8901',NODE_ENV:'test',GOOGLE_CLIENT_ID:''},stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',d=>logs+=d.toString());app.stderr.on('data',d=>logs+=d.toString());
  for(let i=0;i<80;i++){if(app.exitCode!==null)throw Error('Servidor parou: '+logs);try{if((await fetch(base+'/api/health')).ok)return;}catch{}await sleep(80);}
  throw Error('Servidor não iniciou: '+logs);
 };
 const stop=async()=>{if(app&&app.exitCode===null){const done=new Promise(resolve=>app.once('exit',resolve));app.kill('SIGTERM');await done;}app=null;};
 const req=async (url,method='GET',data,cookie)=>{
  const r=await fetch(base+url,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:method==='GET'?undefined:JSON.stringify(data||{})});
  const val=await r.json().catch(()=>({}));return {status:r.status,...val,cookie:r.headers.get('set-cookie')?.split(';')[0]};
 };
 try{
  await start();
  const reg=(name,email)=>req('/api/auth/register','POST',{name,email,password:'uma-senha-forte-12345',inviteCode:'convite-privado-8901'});
  const alice=await reg('Alice Leitora','alice@local.test'),bob=await reg('Bruno Leitor','bob@local.test'),eve=await reg('Eve Leitora','eve@local.test');
  assert.equal(alice.status,201);assert.equal(bob.status,201);assert.equal(eve.status,201);
  const a=alice.user.id,b=bob.user.id,c=eve.user.id;
  assert.equal((await req('/api/messages/contacts','GET',null,alice.cookie)).contacts.length,0);
  assert.equal((await req(`/api/messages/${b}`,'POST',{content:'oi'},alice.cookie)).status,403);
  assert.equal((await req(`/api/users/${b}/follow`,'POST',{},alice.cookie)).following,true);
  assert.equal((await req(`/api/messages/${b}`,'POST',{content:'oi'},alice.cookie)).status,403);
  assert.equal((await req(`/api/users/${a}/follow`,'POST',{},bob.cookie)).following,true);
  assert.equal((await req('/api/people','GET',null,alice.cookie)).people.find(x=>x.id===b).follows_me,1);
  assert.equal((await req(`/api/users/${b}`,'GET',null,alice.cookie)).mutual,true);
  assert.equal((await req('/api/messages/contacts','GET',null,alice.cookie)).contacts.length,1);
  assert.equal((await req(`/api/messages/${b}`,'POST',{content:' '},alice.cookie)).status,400);
  assert.equal((await req(`/api/messages/${b}`,'POST',{content:'x'.repeat(1501)},alice.cookie)).status,400);
  const msg=await req(`/api/messages/${b}`,'POST',{content:'Oi, bora ler um livro?'},alice.cookie);
  assert.equal(msg.status,201);assert.equal(msg.message.sender_id,a);assert.equal(msg.message.recipient_id,b);
  assert.equal((await req(`/api/messages/${b}`,'GET',null,alice.cookie)).messages.length,1);
  assert.equal((await req(`/api/messages/${a}`,'GET',null,eve.cookie)).status,403);
  assert.equal((await req(`/api/messages/${a}`,'POST',{content:'Espionar'},eve.cookie)).status,403);
  assert.equal((await req('/api/messages/unread','GET',null,bob.cookie)).unread,1);
  assert.equal((await req('/api/messages/contacts','GET',null,bob.cookie)).contacts[0].unread,1);
  assert.equal((await req(`/api/messages/${a}`,'POST',{},eve.cookie)).status,403);
  assert.equal((await req(`/api/messages/${a}/read`,'POST',{},bob.cookie)).status,200);
  assert.equal((await req('/api/messages/unread','GET',null,bob.cookie)).unread,0);
  const answer=await req(`/api/messages/${a}`,'POST',{content:'Vamos sim!'},bob.cookie);
  assert.equal(answer.status,201);
  const thread=await req(`/api/messages/${b}`,'GET',null,alice.cookie);
  assert.deepEqual(thread.messages.map(m=>m.content),['Oi, bora ler um livro?','Vamos sim!']);
  assert.ok(thread.messages[0].read_at);
  assert.equal((await req(`/api/messages/${a}/read`,'POST',{},eve.cookie)).status,403);
  assert.equal((await req(`/api/users/${a}/follow`,'POST',{},bob.cookie)).following,false);
  assert.equal((await req(`/api/messages/${b}`,'GET',null,alice.cookie)).status,403);
  assert.equal((await req(`/api/messages/${a}`,'POST',{content:'Sem permissão'},bob.cookie)).status,403);
  assert.equal((await req('/api/messages/unread','GET',null,alice.cookie)).unread,0);
  assert.equal((await req(`/api/users/${a}/follow`,'POST',{},bob.cookie)).following,true);
  assert.equal((await req(`/api/messages/${b}`,'GET',null,alice.cookie)).messages.length,2);
  await stop();await start();
  const freshLogin=await req('/api/auth/login','POST',{email:'alice@local.test',password:'uma-senha-forte-12345'});
  assert.equal(freshLogin.status,200);
  assert.equal((await req(`/api/messages/${b}`,'GET',null,freshLogin.cookie)).messages.length,2);
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
