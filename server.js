import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual, createPublicKey, verify } from 'node:crypto';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
// Configuração local simples, sem bibliotecas ou segredos no Git.
if (existsSync(path.join(ROOT,'.env'))) {
  for(const line of readFileSync(path.join(ROOT,'.env'),'utf8').split(/\r?\n/)) {
    const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if(m && process.env[m[1]]===undefined) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
  }
}
const PROD=process.env.NODE_ENV==='production';
const PORT=Number(process.env.PORT||3000);
const DB_PATH=process.env.DB_PATH || path.join(ROOT,'data','entrelinhas.sqlite');
const INVITE_CODE=process.env.INVITE_CODE||'';
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
if (!INVITE_CODE || INVITE_CODE.length<8) { console.error('Configure INVITE_CODE com no mínimo 8 caracteres.'); process.exit(1); }
mkdirSync(path.dirname(DB_PATH),{recursive:true});
const db=new DatabaseSync(DB_PATH);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT,
 google_sub TEXT UNIQUE, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
 avatar TEXT NOT NULL DEFAULT '📖', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS books (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, title TEXT NOT NULL,
 author TEXT NOT NULL DEFAULT '', cover_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS shelves (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('lido','lendo','quero_ler')),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('post','review')), book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
 rating INTEGER CHECK(rating BETWEEN 1 AND 5), content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS likes (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, PRIMARY KEY(user_id,entry_id));
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS follows (
 follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(follower_id,following_id), CHECK(follower_id != following_id));
CREATE TABLE IF NOT EXISTS direct_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1500),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 read_at TEXT,
 CHECK(sender_id != recipient_id));
CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id,recipient_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages(recipient_id,read_at,sender_id);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_id);
CREATE INDEX IF NOT EXISTS idx_shelves_status ON shelves(user_id,status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);`);
const stmt=(sql)=>db.prepare(sql);
const one=(sql,...args)=>stmt(sql).get(...args);
const all=(sql,...args)=>stmt(sql).all(...args);
const run=(sql,...args)=>stmt(sql).run(...args);
const sha=x=>createHash('sha256').update(x).digest('hex');
const compareString=(a,b)=>{const ah=Buffer.from(sha(a),'hex'),bh=Buffer.from(sha(b),'hex');return timingSafeEqual(ah,bh);};
const hashPassword=pass=>{const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${scryptSync(pass,salt,64).toString('hex')}`;};
const passwordOK=(pass,stored)=>{if(!stored || !stored.startsWith('scrypt$'))return false;const [,salt,digest]=stored.split('$');try {const value=scryptSync(pass,salt,64);return timingSafeEqual(value,Buffer.from(digest,'hex'));}catch{return false;}};
const validEmail=e=>typeof e==='string'&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const trim=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
const me=(u)=>({id:u.id,name:u.name,email:u.email,bio:u.bio,avatar:u.avatar,created_at:u.created_at});
const stats=id=>({
 read:one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='lido'",id).n,
 reading:one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='lendo'",id).n,
 want:one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='quero_ler'",id).n,
 reviews:one("SELECT COUNT(*) AS n FROM entries WHERE user_id=? AND kind='review'",id).n,
 posts:one("SELECT COUNT(*) AS n FROM entries WHERE user_id=? AND kind='post'",id).n,
 followers:one('SELECT COUNT(*) AS n FROM follows WHERE following_id=?',id).n,
 following:one('SELECT COUNT(*) AS n FROM follows WHERE follower_id=?',id).n
});
const cookie=(req)=>Object.fromEntries((req.headers.cookie||'').split(';').map(a=>a.trim().split('=').map((v)=>v||'' )).filter(a=>a[0]));
const currentUser=(req)=>{const token=cookie(req).el_session;if(!token||!(/^[0-9a-f]{64}$/.test(token)))return null;return one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',sha(token),Date.now())||null;};
const makeCookie=(token,maxAge)=>`el_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD?'; Secure':''}`;
function login(res,user){const token=randomBytes(32).toString('hex');const expiry=Date.now()+30*86400000;run('DELETE FROM sessions WHERE expires_at<?',Date.now());run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',sha(token),user.id,expiry);res.setHeader('Set-Cookie',makeCookie(token,30*86400));}
const apiError=(status,message)=>Object.assign(new Error(message),{status});
function respond(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function fail(res,code,message){respond(res,code,{error:message});}
function extractBook(b){if(!b || typeof b!=='object')throw apiError(400,'Informe o livro.');
 const title=trim(b.title,180),author=trim(b.author,180),source=trim(b.source_key,140);
 let cover=trim(b.cover_url,400);
 if(!title)throw apiError(400,'O livro precisa de título.');
 if(cover && !/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-[SML]\.jpg$/.test(cover))cover='';
 return {title,author,source_key: /^\/works\/OL\d+W$/.test(source)?source:null,cover_url:cover};
}
function getBook(b){const x=extractBook(b);
 if(x.source_key){let old=one('SELECT * FROM books WHERE source_key=?',x.source_key);if(old)return old;}
 else {let old=one('SELECT * FROM books WHERE title=? AND author=? AND source_key IS NULL COLLATE NOCASE',x.title,x.author);if(old)return old;}
 try{return one('SELECT * FROM books WHERE id=?',Number(run('INSERT INTO books(source_key,title,author,cover_url) VALUES(?,?,?,?)',x.source_key,x.title,x.author,x.cover_url).lastInsertRowid));}
 catch(e){if(x.source_key){const existing=one('SELECT * FROM books WHERE source_key=?',x.source_key);if(existing)return existing;}throw e;}
}
const entryFields=`e.id,e.kind,e.rating,e.content,e.created_at,e.user_id,
 u.name AS user_name,u.avatar AS user_avatar,u.bio AS user_bio,
 b.id AS book_id,b.title AS book_title,b.author AS book_author,b.cover_url AS book_cover,
 (SELECT COUNT(*) FROM likes WHERE entry_id=e.id) AS like_count,
 (SELECT COUNT(*) FROM comments WHERE entry_id=e.id) AS comment_count,
 EXISTS(SELECT 1 FROM likes WHERE entry_id=e.id AND user_id=?) AS liked`;
const entrySQL=`SELECT ${entryFields} FROM entries e JOIN users u ON u.id=e.user_id LEFT JOIN books b ON b.id=e.book_id`;
// Apenas leitores que se seguem mutuamente podem ler e enviar mensagens.
const mutualFollow=(a,b)=>a!==b&&!!one(`SELECT 1 FROM follows f
 JOIN follows back ON back.follower_id=f.following_id AND back.following_id=f.follower_id
 WHERE f.follower_id=? AND f.following_id=?`,a,b);
const messageRate=new Map();
function checkMessageRate(userId){
 const now=Date.now();let rec=messageRate.get(userId);
 if(!rec||now>rec.until)rec={until:now+60_000,count:0};
 rec.count++;messageRate.set(userId,rec);
 if(rec.count>30)throw apiError(429,'Limite de mensagens atingido. Aguarde um minuto.');
}
const rateBucket=new Map();
function limited(req){let key=(req.socket.remoteAddress||'')+':' + (req.url||'');const t=Date.now();const rec=rateBucket.get(key)||{count:0,until:t+15*60000};if(rec.until<t){rec.count=0;rec.until=t+15*60000;}rec.count++;rateBucket.set(key,rec);return rec.count>15;}
const MAX_BODY=18_000;
async function body(req){let chunks=[],n=0;for await(const c of req){n+=c.length;if(n>MAX_BODY)throw apiError(413,'Texto muito longo.');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw apiError(400,'JSON inválido.');}}
function originAllowed(req){const o=req.headers.origin;if(!o)return true;try{return new URL(o).host===req.headers.host;}catch{return false;}}
let jwksCache={time:0,keys:[]};
async function verifyGoogleJWT(token){if(!GOOGLE_CLIENT_ID)throw apiError(400,'Login Google ainda não foi configurado.');
 if(typeof token!=='string'||token.length>6000)throw apiError(401,'Token Google inválido.');
 const parts=token.split('.');if(parts.length!==3)throw apiError(401,'Token Google inválido.');
 let header,payload;try {header=JSON.parse(Buffer.from(parts[0],'base64url'));payload=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw apiError(401,'Token Google inválido.');}
 if(header.alg!=='RS256'||!header.kid||payload.aud!==GOOGLE_CLIENT_ID||!['accounts.google.com','https://accounts.google.com'].includes(payload.iss)||!payload.exp||payload.exp*1000<Date.now()||payload.iat*1000>Date.now()+60000||payload.email_verified!==true||!validEmail(payload.email)||!payload.sub)throw apiError(401,'Autenticação Google recusada.');
 if(Date.now()>jwksCache.time){const reply=await fetch('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(6500)});if(!reply.ok)throw apiError(503,'Google temporariamente indisponível.');let json=await reply.json();jwksCache={time:Date.now()+40*60000,keys:json.keys||[]};}
 const jwk=jwksCache.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!jwk)throw apiError(401,'Assinatura Google desconhecida.');
 const pub=createPublicKey({key:jwk,format:'jwk'});if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),pub,Buffer.from(parts[2],'base64url')))throw apiError(401,'Assinatura Google inválida.');
 return {email:payload.email.toLowerCase(),sub:String(payload.sub),name:trim(payload.name||payload.given_name,60)||'Leitor(a)'};
}
async function handleApi(req,res,pathname,search){
 if(pathname==='/api/health'&&req.method==='GET')return respond(res,200,{ok:true});
 if(pathname==='/api/config'&&req.method==='GET')return respond(res,200,{googleClientId:GOOGLE_CLIENT_ID,inviteOnly:true});
 const mutating=['POST','PUT','PATCH','DELETE'].includes(req.method);
 if(mutating && !originAllowed(req))throw apiError(403,'Origem não autorizada.');
 if(mutating && !(req.headers['content-type']||'').startsWith('application/json'))throw apiError(415,'Envie JSON.');
 if(pathname==='/api/auth/register'&&req.method==='POST'){
   if(limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),name=trim(b.name,60),email=String(b.email||'').trim().toLowerCase(),pass=b.password||'';
   if(!compareString(String(b.inviteCode||''),INVITE_CODE))throw apiError(403,'Código de convite incorreto.');
   if(name.length<2||!validEmail(email)||typeof pass!=='string'||pass.length<10||pass.length>128)throw apiError(400,'Use nome, e-mail válido e senha de 10 a 128 caracteres.');
   if(one('SELECT id FROM users WHERE email=?',email))throw apiError(409,'Esse e-mail já está cadastrado.');
   const id=Number(run('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)',name,email,hashPassword(pass)).lastInsertRowid);
   const u=one('SELECT * FROM users WHERE id=?',id);login(res,u);return respond(res,201,{user:me(u),stats:stats(id)});
 }
 if(pathname==='/api/auth/login'&&req.method==='POST'){
   if(limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=b.password||'';
   const u=one('SELECT * FROM users WHERE email=?',email);
   if(!u || !passwordOK(password,u.password_hash))throw apiError(401,'E-mail ou senha incorretos.');
   login(res,u);return respond(res,200,{user:me(u),stats:stats(u.id)});
 }
 if(pathname==='/api/auth/google'&&req.method==='POST'){
   if(limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),g=await verifyGoogleJWT(b.credential);
   let u=one('SELECT * FROM users WHERE google_sub=?',g.sub);
   if(!u){u=one('SELECT * FROM users WHERE email=?',g.email);if(u){
     // E-mail já verificado pelo Google, pode vincular somente se não estiver ligado a outra identidade Google.
     if(u.google_sub&&u.google_sub!==g.sub)throw apiError(403,'Conta Google diferente da já vinculada.');
     run('UPDATE users SET google_sub=? WHERE id=?',g.sub,u.id);
   } else {
     if(!compareString(String(b.inviteCode||''),INVITE_CODE))throw apiError(403,'Para entrar na comunidade, informe o código de convite.');
     const id=Number(run('INSERT INTO users(name,email,google_sub) VALUES(?,?,?)',g.name,g.email,g.sub).lastInsertRowid);u=one('SELECT * FROM users WHERE id=?',id);
   }}
   login(res,u);return respond(res,200,{user:me(u),stats:stats(u.id)});
 }
 const user=currentUser(req);
 if(pathname==='/api/auth/me'&&req.method==='GET')return respond(res,200,{user:user?me(user):null,stats:user?stats(user.id):null});
 if(pathname==='/api/auth/logout'&&req.method==='POST'){
   const tok=cookie(req).el_session;if(tok)run('DELETE FROM sessions WHERE token_hash=?',sha(tok));res.setHeader('Set-Cookie',makeCookie('',0));return respond(res,200,{ok:true});
 }
 if(!user)throw apiError(401,'Faça login para acessar a comunidade.');
 if(pathname==='/api/me'&&req.method==='PUT'){
   const b=await body(req),name=trim(b.name,60),bio=trim(b.bio,350),avatar=trim(b.avatar,12)||'📖';
   if(name.length<2)throw apiError(400,'Informe um nome com ao menos 2 caracteres.');
   run('UPDATE users SET name=?,bio=?,avatar=? WHERE id=?',name,bio,avatar,user.id);
   return respond(res,200,{user:me(one('SELECT * FROM users WHERE id=?',user.id))});
 }
 if(pathname==='/api/people'&&req.method==='GET'){
   const users=all(`SELECT id,name,bio,avatar,created_at,
     EXISTS(SELECT 1 FROM follows WHERE follower_id=? AND following_id=u.id) AS following,
     (SELECT COUNT(*) FROM follows WHERE following_id=u.id) AS followers,
     EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=u.id AND f.following_id=?) AS follows_me
     FROM users u WHERE id<>? ORDER BY created_at DESC LIMIT 80`,user.id,user.id,user.id);
   return respond(res,200,{people:users});
 }
 const usermatch=pathname.match(/^\/api\/users\/(\d+)$/);
 if(usermatch&&req.method==='GET'){
   const id=Number(usermatch[1]),found=one('SELECT * FROM users WHERE id=?',id);
   if(!found)throw apiError(404,'Leitor não encontrado.');
   return respond(res,200,{user:me(found),stats:stats(id),following:!!one('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?',user.id,id),mutual:mutualFollow(user.id,id)});
 }
 const followMatch=pathname.match(/^\/api\/users\/(\d+)\/follow$/);
 if(followMatch&&req.method==='POST'){
   const id=Number(followMatch[1]);if(id===user.id)throw apiError(400,'Você não pode seguir a si mesmo.');
   if(!one('SELECT id FROM users WHERE id=?',id))throw apiError(404,'Perfil não encontrado.');
   const f=one('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?',user.id,id);
   if(f)run('DELETE FROM follows WHERE follower_id=? AND following_id=?',user.id,id);
   else run('INSERT INTO follows(follower_id,following_id) VALUES(?,?)',user.id,id);
   return respond(res,200,{following:!f});
 }
 // Direct privado: contatos aparecem apenas quando ambos se seguem.
 if(pathname==='/api/messages/contacts'&&req.method==='GET'){
   const contacts=all(`SELECT u.id,u.name,u.avatar,u.bio,
     (SELECT m.content FROM direct_messages m WHERE
       (m.sender_id=u.id AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=u.id)
       ORDER BY m.id DESC LIMIT 1) AS last_message,
     (SELECT m.created_at FROM direct_messages m WHERE
       (m.sender_id=u.id AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=u.id)
       ORDER BY m.id DESC LIMIT 1) AS last_at,
     (SELECT COUNT(*) FROM direct_messages m WHERE m.sender_id=u.id AND m.recipient_id=? AND m.read_at IS NULL) AS unread
     FROM users u
     WHERE u.id<>? AND EXISTS(SELECT 1 FROM follows a WHERE a.follower_id=? AND a.following_id=u.id)
       AND EXISTS(SELECT 1 FROM follows b WHERE b.follower_id=u.id AND b.following_id=?)
     ORDER BY last_at DESC, u.name COLLATE NOCASE ASC LIMIT 100`,user.id,user.id,user.id,user.id,user.id,user.id,user.id,user.id);
   return respond(res,200,{contacts});
 }
 if(pathname==='/api/messages/unread'&&req.method==='GET'){
   const unread=one(`SELECT COUNT(*) AS n FROM direct_messages m
     WHERE m.recipient_id=? AND m.read_at IS NULL
       AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=m.sender_id)
       AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=m.sender_id AND f.following_id=?)`,user.id,user.id,user.id).n;
   return respond(res,200,{unread});
 }
 const dmMatch=pathname.match(/^\/api\/messages\/(\d+)(?:\/(read))?$/);
 if(dmMatch){
   const peerId=Number(dmMatch[1]),markRead=!!dmMatch[2];
   if(!Number.isSafeInteger(peerId)||peerId<=0||peerId===user.id)throw apiError(400,'Destinatário inválido.');
   if(!one('SELECT id FROM users WHERE id=?',peerId))throw apiError(404,'Leitor não encontrado.');
   if(!mutualFollow(user.id,peerId))throw apiError(403,'O Direct é permitido somente entre leitores que se seguem mutuamente.');
   if(markRead&&req.method==='POST'){
     run('UPDATE direct_messages SET read_at=CURRENT_TIMESTAMP WHERE sender_id=? AND recipient_id=? AND read_at IS NULL',peerId,user.id);
     return respond(res,200,{ok:true});
   }
   if(!markRead&&req.method==='GET'){
     const messages=all(`SELECT * FROM (SELECT id,sender_id,recipient_id,content,created_at,read_at
       FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)
       ORDER BY id DESC LIMIT 100) ORDER BY id ASC`,user.id,peerId,peerId,user.id);
     return respond(res,200,{messages});
   }
   if(!markRead&&req.method==='POST'){
     const b=await body(req),content=trim(b.content,1501);
     if(!content||content.length>1500)throw apiError(400,'Escreva uma mensagem com até 1.500 caracteres.');
     checkMessageRate(user.id);
     const id=Number(run('INSERT INTO direct_messages(sender_id,recipient_id,content) VALUES(?,?,?)',user.id,peerId,content).lastInsertRowid);
     return respond(res,201,{message:one('SELECT id,sender_id,recipient_id,content,created_at,read_at FROM direct_messages WHERE id=?',id)});
   }
 }
 if(pathname==='/api/books/search'&&req.method==='GET'){
   const q=trim(search.get('q'),80);if(q.length<2) return respond(res,200,{books:[]});
   try {
     const url='https://openlibrary.org/search.json?q='+encodeURIComponent(q)+'&limit=12&fields=key,title,author_name,cover_i';
     const open=await fetch(url,{signal:AbortSignal.timeout(7000),headers:{'User-Agent':'EntrelinhasPrivate/3.0 (book-search)'}});
     if(!open.ok)throw new Error('OpenLibrary HTTP '+open.status);
     const data=await open.json();
     return respond(res,200,{books:(data.docs||[]).slice(0,12).filter(b=>b.title).map(b=>({source_key:b.key,title:b.title,author:(b.author_name||[])[0]||'Autor desconhecido',cover_url:b.cover_i?`https://covers.openlibrary.org/b/id/${Number(b.cover_i)}-M.jpg`:''}))});
   }catch{return respond(res,200,{books:[],unavailable:true});}
 }
 if(pathname==='/api/entries'&&req.method==='GET'){
   const profile=Number(search.get('user_id')||0),filter=trim(search.get('kind'),20),where=[],args=[user.id];
   if(profile){where.push('e.user_id=?');args.push(profile);}
   if(filter==='review'||filter==='post'){where.push('e.kind=?');args.push(filter);}
   const entries=all(`${entrySQL} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY e.id DESC LIMIT 100`,...args);
   return respond(res,200,{entries});
 }
 if(pathname==='/api/entries'&&req.method==='POST'){
   const b=await body(req),kind=b.kind==='review'?'review':b.kind==='post'?'post':null,content=trim(b.content,4000);
   if(!kind||content.length<2)throw apiError(400,'Escreva pelo menos dois caracteres.');
   let bookId=null,rating=null;
   if(kind==='review'){
     const book=getBook(b.book);bookId=book.id;rating=Number(b.rating);
     if(!Number.isInteger(rating)||rating<1||rating>5)throw apiError(400,'Escolha de 1 a 5 estrelas.');
     if(one("SELECT id FROM entries WHERE user_id=? AND kind='review' AND book_id=?",user.id,bookId))throw apiError(409,'Você já avaliou esse livro. Apague sua resenha anterior para escrever outra.');
   }
   const id=Number(run('INSERT INTO entries(user_id,kind,book_id,rating,content) VALUES(?,?,?,?,?)',user.id,kind,bookId,rating,content).lastInsertRowid);
   return respond(res,201,{entry:one(`${entrySQL} WHERE e.id=?`,user.id,id)});
 }
 const entryMatch=pathname.match(/^\/api\/entries\/(\d+)$/);
 if(entryMatch&&req.method==='DELETE'){
   const id=Number(entryMatch[1]);const e=one('SELECT user_id FROM entries WHERE id=?',id);
   if(!e)throw apiError(404,'Publicação não encontrada.');if(e.user_id!==user.id)throw apiError(403,'Você só pode apagar suas publicações.');
   run('DELETE FROM entries WHERE id=?',id);return respond(res,200,{ok:true});
 }
 const likeMatch=pathname.match(/^\/api\/entries\/(\d+)\/like$/);
 if(likeMatch&&req.method==='POST'){
   const id=Number(likeMatch[1]);if(!one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   const e=one('SELECT 1 FROM likes WHERE user_id=? AND entry_id=?',user.id,id);
   if(e)run('DELETE FROM likes WHERE user_id=? AND entry_id=?',user.id,id);
   else run('INSERT INTO likes(user_id,entry_id) VALUES(?,?)',user.id,id);
   return respond(res,200,{liked:!e});
 }
 const commentsMatch=pathname.match(/^\/api\/entries\/(\d+)\/comments$/);
 if(commentsMatch&&req.method==='GET'){
   const id=Number(commentsMatch[1]);if(!one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   return respond(res,200,{comments:all('SELECT c.id,c.content,c.created_at,u.id AS user_id,u.name AS user_name,u.avatar AS user_avatar FROM comments c JOIN users u ON u.id=c.user_id WHERE c.entry_id=? ORDER BY c.id ASC LIMIT 200',id)});
 }
 if(commentsMatch&&req.method==='POST'){
   const id=Number(commentsMatch[1]),b=await body(req),content=trim(b.content,1000);
   if(!one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   if(!content)throw apiError(400,'Escreva um comentário.');
   run('INSERT INTO comments(user_id,entry_id,content) VALUES(?,?,?)',user.id,id,content);
   return respond(res,201,{ok:true});
 }
 const deleteComment=pathname.match(/^\/api\/comments\/(\d+)$/);
 if(deleteComment&&req.method==='DELETE'){
   const id=Number(deleteComment[1]),comment=one('SELECT user_id FROM comments WHERE id=?',id);
   if(!comment)throw apiError(404,'Comentário não encontrado.');
   if(comment.user_id!==user.id)throw apiError(403,'Você só pode apagar seus comentários.');
   run('DELETE FROM comments WHERE id=?',id);return respond(res,200,{ok:true});
 }
 if(pathname==='/api/shelf'&&req.method==='GET'){
   const owner=Number(search.get('user_id')||user.id);
   if(!one('SELECT id FROM users WHERE id=?',owner))throw apiError(404,'Leitor não encontrado.');
   return respond(res,200,{shelf:all('SELECT b.*,s.status,s.updated_at FROM shelves s JOIN books b ON b.id=s.book_id WHERE s.user_id=? ORDER BY s.updated_at DESC,b.id DESC',owner)});
 }
 if(pathname==='/api/shelf'&&req.method==='PUT'){
   const b=await body(req),status=b.status;
   if(!['lido','lendo','quero_ler'].includes(status))throw apiError(400,'Status inválido.');
   const book=getBook(b.book);
   run('INSERT INTO shelves(user_id,book_id,status,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,book_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP',user.id,book.id,status);
   return respond(res,200,{book,status,stats:stats(user.id)});
 }
 const delShelf=pathname.match(/^\/api\/shelf\/(\d+)$/);
 if(delShelf&&req.method==='DELETE'){
   run('DELETE FROM shelves WHERE user_id=? AND book_id=?',user.id,Number(delShelf[1]));return respond(res,200,{ok:true,stats:stats(user.id)});
 }
 throw apiError(404,'Rota não encontrada.');
}
const FILES={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
const MIME={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; img-src 'self' https://covers.openlibrary.org https://*.googleusercontent.com data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'self'; object-src 'none'; form-action 'self'");
 try{
   const u=new URL(req.url,'http://localhost');
   if(u.pathname.startsWith('/api/'))return await handleApi(req,res,u.pathname,u.searchParams);
   if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405,'Método não permitido.');
   const file=FILES[u.pathname];if(!file)return fail(res,404,'Não encontrado.');
   const data=readFileSync(path.join(ROOT,'public',file));
   res.writeHead(200,{'Content-Type':MIME[file.split('.').at(-1)],'Cache-Control':'no-cache'});
   if(req.method==='HEAD')res.end();else res.end(data);
 }catch(e){const status=e.status||500;if(status>=500)console.error(e);if(!res.headersSent)fail(res,status,status===500?'Erro no servidor.':e.message);else res.end();}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Entrelinhas em http://localhost:${PORT} | Banco: ${DB_PATH} | Google ${GOOGLE_CLIENT_ID?'configurado':'opcional/desativado'}`));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
