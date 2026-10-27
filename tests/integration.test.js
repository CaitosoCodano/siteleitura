import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
test('entrelinhas: real database, invite-only, private entries and social interactions',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'entrelinhas-test-'));
 const port=await freePort();
 const db=path.join(dir,'db.sqlite');
 const app=spawn(process.execPath,['server.js'],{cwd:path.resolve(''),env:{...process.env,PORT:String(port),DB_PATH:db,INVITE_CODE:'codigo-muito-secreto-999',NODE_ENV:'test',GOOGLE_CLIENT_ID:''},stdio:['ignore','pipe','pipe']});
 let logs='';app.stdout.on('data',d=>logs+=d.toString());app.stderr.on('data',d=>logs+=d.toString());
 const base=`http://127.0.0.1:${port}`;
 async function req(route,method='GET',data,cookie){const r=await fetch(base+route,{method,headers:{... (method!=='GET'?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:method==='GET'?undefined:JSON.stringify(data||{})});const x=await r.json().catch(()=>({}));return {status:r.status,...x,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
   let ready=false;for(let i=0;i<60;i++){if(app.exitCode!==null)throw new Error('Server failed: '+logs);try{const r=await req('/api/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
   assert.ok(ready,logs);
   assert.equal((await req('/api/entries')).status,401);
   assert.equal((await req('/api/auth/register','POST',{name:'Laura',email:'laura@teste.com',password:'testesenha123',inviteCode:'codigo-errado'})).status,403);
   const a=await req('/api/auth/register','POST',{name:'Laura Leitora',email:'Laura@teste.com',password:'testesenha123',inviteCode:'codigo-muito-secreto-999'});
   assert.equal(a.status,201);assert.ok(a.cookie);assert.equal(a.stats.read,0);
   const b=await req('/api/auth/register','POST',{name:'Pedro dos Livros',email:'pedro@teste.com',password:'pedrosenha12345',inviteCode:'codigo-muito-secreto-999'});
   assert.equal(b.status,201);assert.ok(b.cookie);
   assert.equal((await req('/api/people','GET',null,a.cookie)).people.length,1);
   const book={title:'Livro Real da Laura',author:'Autor A'};
   const shelf=await req('/api/shelf','PUT',{book,status:'lido'},a.cookie);assert.equal(shelf.stats.read,1);
   const review=await req('/api/entries','POST',{kind:'review',book,rating:5,content:'Uma história que realmente adorei.'},a.cookie);assert.equal(review.status,201);
   assert.equal((await req('/api/entries','POST',{kind:'review',book,rating:4,content:'Repetição não permitida'},a.cookie)).status,409);
   const post=await req('/api/entries','POST',{kind:'post',content:'Hoje terminei minha leitura.'},b.cookie);assert.equal(post.status,201);
   const timeline=await req('/api/entries','GET',null,b.cookie);assert.equal(timeline.entries.length,2);
   assert.equal((await req('/api/entries/'+review.entry.id+'/like','POST',{},b.cookie)).liked,true);
   assert.equal((await req('/api/entries/'+review.entry.id+'/comments','POST',{content:'Que ótima indicação!'},b.cookie)).status,201);
   assert.equal((await req('/api/entries/'+review.entry.id+'/comments','GET',null,a.cookie)).comments.length,1);
   assert.equal((await req('/api/users/'+a.user.id+'/follow','POST',{},b.cookie)).following,true);
   const profile=await req('/api/users/'+a.user.id,'GET',null,b.cookie);assert.equal(profile.stats.read,1);assert.equal(profile.stats.followers,1);
   assert.equal((await req('/api/entries/'+review.entry.id,'DELETE',{},b.cookie)).status,403);
   assert.equal((await req('/api/auth/login','POST',{email:'laura@teste.com',password:'testesenha123'})).status,200);
   assert.equal((await req('/api/auth/logout','POST',{},a.cookie)).status,200);
   assert.equal((await req('/api/shelf','GET',null,a.cookie)).status,401);
   assert.equal(existsSync(db),true);
 }finally{app.kill('SIGTERM');await new Promise(resolve=>app.once('exit',resolve));rmSync(dir,{recursive:true,force:true});}
});
