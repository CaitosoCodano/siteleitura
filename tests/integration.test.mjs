import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';
const schema=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
function mockedD1(sqlite){return {prepare(sql){return {bind(...args){const stmt=sqlite.prepare(sql);return {
 async first(){return stmt.get(...args)||null;},
 async all(){return {results:stmt.all(...args)};},
 async run(){const meta=stmt.run(...args);return {meta:{last_row_id:Number(meta.lastInsertRowid),changes:meta.changes}};}
};}};}};}
const envFor=sqlite=>({DB:mockedD1(sqlite),INVITE_CODE:'este-codigo-e-secreto-99841',AUTH_PEPPER:'local-teste-pepper-longo-para-cryptografia-com-mais-de-32-caracteres',GOOGLE_CLIENT_ID:'',ASSETS:{fetch:async req=>new Response('OK!',{status:200,headers:{'Content-Type':'text/html'}})}});
const base='https://entrelinhas.example';
function requester(env){return async function req(path,method='GET',body,cookie){const r=await worker.fetch(new Request(base+path,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json','Origin':base}:{}),...(cookie?{cookie}:{})},body:method==='GET'?undefined:JSON.stringify(body||{})}),env);return {...await r.json(),httpStatus:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]};};}
test('Entrelinhas V5: cadastro, login, persistência, estante, posts e Direct privado D1',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(readFileSync(new URL('../migrations/0002_media.sql',import.meta.url),'utf8'));
 const env=envFor(db);const req=requester(env);
 const auth=(name,email)=>req('/api/auth/register','POST',{name,email,password:'SenhaDeTesteBemForte!23',inviteCode:env.INVITE_CODE});
 try{
   assert.equal((await req('/api/health')).ok,true);
   assert.equal((await req('/api/auth/me')).user,null);
   const wrong=await req('/api/auth/register','POST',{name:'A',email:'x@example.com',password:'zzzzzzzzzz',inviteCode:'errado'});assert.equal(wrong.httpStatus,403);
   const alice=await auth('Alice Leitora','alice@leitura.local');assert.equal(alice.httpStatus,201,JSON.stringify(alice));
   const bob=await auth('Bruno Leitor','bruno@leitura.local');assert.equal(bob.httpStatus,201,JSON.stringify(bob));
   const eve=await auth('Eve Leitora','eve@leitura.local');assert.equal(eve.httpStatus,201,JSON.stringify(eve));
   assert.equal((await req('/api/auth/login','POST',{email:'alice@leitura.local',password:'Errada!1212312'})).httpStatus,401);
   assert.equal((await req('/api/auth/login','POST',{email:'alice@leitura.local',password:'SenhaDeTesteBemForte!23'})).httpStatus,200);
   assert.equal((await req('/api/auth/me','GET',undefined,alice.cookie)).user.name,'Alice Leitora');
   assert.equal((await req('/api/people','GET',undefined,alice.cookie)).people.length,2);
   const book={title:'O Livro Autêntico',author:'Autora Real'};
   const shelf=await req('/api/shelf','PUT',{book,status:'lido'},alice.cookie);assert.equal(shelf.httpStatus,200,JSON.stringify(shelf));assert.equal(shelf.stats.read,1);
   const post=await req('/api/entries','POST',{kind:'post',content:'Minha primeira publicação'},alice.cookie);assert.equal(post.httpStatus,201,JSON.stringify(post));
   const review=await req('/api/entries','POST',{kind:'review',content:'Uma excelente leitura para reflexão',book,rating:5},alice.cookie);assert.equal(review.httpStatus,201,JSON.stringify(review));
   assert.equal((await req('/api/entries','GET',undefined,bob.cookie)).entries.length,2);
   assert.equal((await req('/api/entries/'+post.entry.id+'/like','POST',{},bob.cookie)).liked,true);
   assert.equal((await req('/api/entries/'+post.entry.id+'/comments','POST',{content:'Que legal!'},bob.cookie)).httpStatus,201);
   const a=alice.user.id,b=bob.user.id,c=eve.user.id;
   assert.equal((await req('/api/messages/'+b,'POST',{content:'sem follow'},alice.cookie)).httpStatus,403);
   assert.equal((await req('/api/users/'+b+'/follow','POST',{},alice.cookie)).following,true);
   assert.equal((await req('/api/users/'+a+'/follow','POST',{},bob.cookie)).following,true);
   assert.equal((await req('/api/messages/contacts','GET',undefined,alice.cookie)).contacts.length,1);
   const msg=await req('/api/messages/'+b,'POST',{content:'Oi, tudo bem?'},alice.cookie);assert.equal(msg.httpStatus,201,JSON.stringify(msg));
   assert.equal((await req('/api/messages/'+a,'GET',undefined,bob.cookie)).messages.length,1);
   assert.equal((await req('/api/messages/'+b,'GET',undefined,eve.cookie)).httpStatus,403);
   assert.equal((await req('/api/messages/'+a+'/read','POST',{},bob.cookie)).httpStatus,200);
   assert.equal((await req('/api/messages/unread','GET',undefined,bob.cookie)).unread,0);
   assert.equal((await req('/api/users/'+a+'/follow','POST',{},bob.cookie)).following,false);
   assert.equal((await req('/api/messages/'+b,'GET',undefined,alice.cookie)).httpStatus,403);
   // Novo objeto Worker com mesma DB, imitando redeploy: usuários e posts continuam.
   const newClient=requester(envFor(db));
   assert.equal((await newClient('/api/auth/login','POST',{email:'alice@leitura.local',password:'SenhaDeTesteBemForte!23'})).httpStatus,200);
   assert.equal((await newClient('/api/entries','GET',undefined,alice.cookie)).entries.length,2);
 }finally{db.close();}
});
