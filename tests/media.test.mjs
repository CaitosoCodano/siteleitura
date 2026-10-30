import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
const base='https://entrelinhas.example';
const schema=['0001_init.sql','0002_media.sql'].map(name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
function d1(sqlite){return {prepare(sql){return {bind(...args){const stmt=sqlite.prepare(sql);return {
 async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){const meta=stmt.run(...args);return {meta:{last_row_id:Number(meta.lastInsertRowid),changes:meta.changes}};}
};}};}};}
function fakeR2(){const files=new Map();return {files,async put(key,data,opts){files.set(key,{data:new Uint8Array(data),type:opts.httpMetadata.contentType});},async get(key,options){const f=files.get(key);if(!f)return null;const size=f.data.length;let start=0,end=size-1;
 if(options?.range){const m=/^bytes=(\d+)-(\d*)$/.exec(options.range);if(m){start=+m[1];end=m[2]?+m[2]:size-1;}}
 const selected=f.data.slice(start,end+1);return {body:new Blob([selected]).stream(),size,range:options?.range?{offset:start,length:selected.length}:undefined};
},async delete(key){files.delete(key);}};}
test('mídia V5.2: autenticação, upload, assinatura, capas, vídeos e privacidade',async()=>{
 const db=new DatabaseSync(':memory:');for(const sql of schema)db.exec(sql);
 const env={DB:d1(db),INVITE_CODE:'convite-secreto-123',AUTH_PEPPER:'chave-local-de-teste-super-forte-12345678',MEDIA:fakeR2(),GOOGLE_CLIENT_ID:''};
 const req=async(path,method='GET',body=null,cookie='',headers={})=>worker.fetch(new Request(base+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'&&method!=='HEAD'?{'Origin':base}:{}),...headers},body}),env);
 const json=async(path,method='GET',data,cookie='')=>req(path,method,method==='GET'?null:JSON.stringify(data||{}),cookie,method==='GET'?{}:{'Content-Type':'application/json'});
 try{
  const reg=await json('/api/auth/register','POST',{name:'Alice',email:'alice@livros.test',password:'SenhaForteDoLivro2026',inviteCode:env.INVITE_CODE});assert.equal(reg.status,201);
  const cookie=reg.headers.get('set-cookie').split(';')[0];
  const jpeg=Uint8Array.of(255,216,255,224,10,20,30,40,50,255,217);
  assert.equal((await req('/api/media/upload','POST',jpeg,'',{'Content-Type':'image/jpeg','X-Media-Purpose':'avatar'})).status,401);
  const bad=await req('/api/media/upload','POST',new Uint8Array([3,2,1,4]),cookie,{'Content-Type':'image/jpeg','X-Media-Purpose':'avatar'});assert.equal(bad.status,415);
  const upload=await req('/api/media/upload','POST',jpeg,cookie,{'Content-Type':'image/jpeg','X-Media-Purpose':'avatar'});assert.equal(upload.status,201,await upload.clone().text());const media=await upload.json();
  const me=await json('/api/me','PUT',{name:'Alice Nova',bio:'Leitora 📚',avatar:'📖',avatar_media_id:media.id},cookie);assert.equal(me.status,200);assert.equal((await me.json()).user.avatar_media_id,media.id);
  assert.equal((await req(media.url)).status,401);
  const photo=await req(media.url,'GET',null,cookie);assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');
  const videoData=new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
  const vid=await req('/api/media/upload','POST',videoData,cookie,{'Content-Type':'video/mp4','X-Media-Purpose':'video'});assert.equal(vid.status,201);const video=await vid.json();
  const range=await req(video.url,'GET',null,cookie,{'Range':'bytes=0-7'});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
  const book={title:'O Livro de Testes',author:'Autor Teste'};
  const review=await json('/api/entries','POST',{kind:'review',book,rating:5,content:'Adorei essa leitura 📖✨',video_media_id:video.id,video_note:'Meu pensamento sobre o final'},cookie);assert.equal(review.status,201,await review.clone().text());
  const r=await json('/api/entries?has_video=1','GET',null,cookie);const entries=(await r.json()).entries;assert.equal(entries.length,1);assert.equal(entries[0].video_media_id,video.id);
  const jpg=await req('/api/media/upload','POST',jpeg,cookie,{'Content-Type':'image/jpeg','X-Media-Purpose':'cover'});const cover=await jpg.json();
  const shelf=await json('/api/shelf','PUT',{book,status:'lido'},cookie);const bookid=(await shelf.json()).book.id;
  const change=await json('/api/books/'+bookid+'/cover','PUT',{media_id:cover.id},cookie);assert.equal(change.status,200);assert.equal((await json('/api/shelf','GET',null,cookie).then(x=>x.json())).shelf[0].cover_url,cover.url);
  const bobRegistration=await json('/api/auth/register','POST',{name:'Bruno',email:'bruno@livros.test',password:'SenhaForteDeBruno2026',inviteCode:env.INVITE_CODE});
  const bobCookie=bobRegistration.headers.get('set-cookie').split(';')[0];
  const sharedBook={...book,cover_url:cover.url};
  const bobShelf=await json('/api/shelf','PUT',{book:sharedBook,status:'quero_ler'},bobCookie);
  assert.equal(bobShelf.status,200,'outros leitores podem usar uma capa compartilhada já atribuída ao livro');
  const unauthorized=await json('/api/shelf','PUT',{book:{title:'Livro Falso',author:'Bruno',cover_url:cover.url},status:'lendo'},bobCookie);
  assert.equal(unauthorized.status,403,'um leitor não pode reivindicar upload alheio para livro diferente');
  const missing=await req('/api/media/'+('a'.repeat(32)),'GET',null,cookie);assert.equal(missing.status,404);
 }finally{db.close();}
});
