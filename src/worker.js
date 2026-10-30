// Entrelinhas V5 — Cloudflare Workers + D1. Sem Node HTTP nem arquivo SQLite efêmero.
// Não coloque códigos de convite nem senhas no repositório GitHub.
const bytesToHex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const randomHex=n=>bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
const sha=async value=>bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)))));
async function compareString(a,b){
 const ah=await sha(a),bh=await sha(b);let diff=0;for(let i=0;i<ah.length;i++)diff|=ah.charCodeAt(i)^bh.charCodeAt(i);return diff===0;
}
// Cloudflare limita PBKDF2 a 100.000 iterações. HMAC com segredo (pepper) protege
// contra força bruta offline se somente o banco D1 for comprometido.
async function derivePassword(pass,salt,pepper,iterations=100000){
 const encoder=new TextEncoder();
 const hmacKey=await crypto.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const prehash=await crypto.subtle.sign('HMAC',hmacKey,encoder.encode(pass));
 const key=await crypto.subtle.importKey('raw',prehash,'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations,hash:'SHA-512'},key,512);
 return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(pass,pepper){const salt=randomHex(16);return `peppered-pbkdf2-sha512$100000$${salt}$${await derivePassword(pass,salt,pepper)}`;}
async function passwordOK(pass,stored,pepper){
 if(typeof pass!=='string'||pass.length>128||!stored)return false;
 const parts=stored.split('$');if(parts.length!==4||parts[0]!=='peppered-pbkdf2-sha512')return false;
 const iter=Number(parts[1]);if(!Number.isInteger(iter)||iter<100000||iter>100000)return false;
 const check=await derivePassword(pass,parts[2],pepper,iter);let diff=0;
 if(parts[3].length!==check.length)return false;
 for(let i=0;i<check.length;i++)diff|=check.charCodeAt(i)^parts[3].charCodeAt(i);
 return diff===0;
}
function b64Bytes(input){const normalized=input.replace(/-/g,'+').replace(/_/g,'/');const data=atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));return Uint8Array.from(data,c=>c.charCodeAt(0));}
function atobUrl(input){return new TextDecoder().decode(b64Bytes(input));}
let jwksCache={time:0,keys:[]};
function createApi(env){
 const db=env.DB;
 const INVITE_CODE=env.INVITE_CODE||'';
 const AUTH_PEPPER=env.AUTH_PEPPER||'';
 const GOOGLE_CLIENT_ID=env.GOOGLE_CLIENT_ID||'';
 const mediaUrl=id=>/^[0-9a-f]{32}$/.test(id||'')?'/api/media/'+id:null;
 const PROD=true;
 if(INVITE_CODE.length<8||AUTH_PEPPER.length<32)throw Object.assign(new Error('Configure INVITE_CODE e AUTH_PEPPER nos segredos do Worker.'),{status:503});
 const one=async(sql,...args)=>db.prepare(sql).bind(...args).first();
 const all=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
 const run=async(sql,...args)=>{const result=await db.prepare(sql).bind(...args).run();return {lastInsertRowid:result.meta.last_row_id,changes:result.meta.changes};};
const validEmail=e=>typeof e==='string'&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const trim=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
const me=(u)=>({id:u.id,name:u.name,email:u.email,bio:u.bio,avatar:u.avatar,avatar_media_id:u.avatar_media_id||null,created_at:u.created_at});
const stats=async id=>({
 read:(await one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='lido'",id)).n,
 reading:(await one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='lendo'",id)).n,
 want:(await one("SELECT COUNT(*) AS n FROM shelves WHERE user_id=? AND status='quero_ler'",id)).n,
 reviews:(await one("SELECT COUNT(*) AS n FROM entries WHERE user_id=? AND kind='review'",id)).n,
 posts:(await one("SELECT COUNT(*) AS n FROM entries WHERE user_id=? AND kind='post'",id)).n,
 followers:(await one('SELECT COUNT(*) AS n FROM follows WHERE following_id=?',id)).n,
 following:(await one('SELECT COUNT(*) AS n FROM follows WHERE follower_id=?',id)).n
});
const cookie=(req)=>Object.fromEntries((req.headers.get('cookie')||'').split(';').map(a=>a.trim().split('=').map((v)=>v||'' )).filter(a=>a[0]));
const currentUser=async (req)=>{const token=cookie(req).el_session;if(!token||!(/^[0-9a-f]{64}$/.test(token)))return null;return await one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',await sha(token),Date.now())||null;};
const makeCookie=(token,maxAge)=>`el_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD?'; Secure':''}`;
async function login(res,user){const token=randomHex(32);const expiry=Date.now()+30*86400000;await run('DELETE FROM sessions WHERE expires_at<?',Date.now());await run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',await sha(token),user.id,expiry);res.headers.set('Set-Cookie',makeCookie(token,30*86400));}
const apiError=(status,message)=>Object.assign(new Error(message),{status});
function respond(res,code,data){return new Response(JSON.stringify(data),{status:code,headers:new Headers({...Object.fromEntries(res.headers), 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})});}
function fail(res,code,message){return respond(res,code,{error:message});}
function extractBook(b){if(!b || typeof b!=='object')throw apiError(400,'Informe o livro.');
 const title=trim(b.title,180),author=trim(b.author,180),source=trim(b.source_key,140);
 let cover=trim(b.cover_url,400);
 if(!title)throw apiError(400,'O livro precisa de título.');
 if(cover && !/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-[SML]\.jpg$/.test(cover) && !/^\/api\/media\/[0-9a-f]{32}$/.test(cover))cover='';
 return {title,author,source_key: /^\/works\/OL\d+W$/.test(source)?source:null,cover_url:cover};
}
async function getBook(b,userId){const x=extractBook(b);
 async function ownsNewCover(){
  if(!x.cover_url.startsWith('/api/media/'))return true;
  return !!await one("SELECT id FROM media_assets WHERE id=? AND owner_id=? AND kind='cover'",x.cover_url.split('/').pop(),userId);
 }
 async function withCover(book) {
  if(x.cover_url.startsWith('/api/media/') && book.cover_url!==x.cover_url){
   if(!await ownsNewCover())throw apiError(403,'Essa capa não pertence à sua conta.');
   await run('UPDATE books SET cover_url=? WHERE id=?',x.cover_url,book.id);
   book.cover_url=x.cover_url;
  }
  return book;
 }
 if(x.source_key){let old=await one('SELECT * FROM books WHERE source_key=?',x.source_key);if(old)return withCover(old);}
 else {let old=await one('SELECT * FROM books WHERE title=? COLLATE NOCASE AND author=? COLLATE NOCASE AND source_key IS NULL',x.title,x.author);if(old)return withCover(old);}
 if(!await ownsNewCover())throw apiError(403,'Essa capa não pertence à sua conta.');
 try{return await one('SELECT * FROM books WHERE id=?',Number((await run('INSERT INTO books(source_key,title,author,cover_url) VALUES(?,?,?,?)',x.source_key,x.title,x.author,x.cover_url)).lastInsertRowid));}
 catch(e){if(x.source_key){const existing=await one('SELECT * FROM books WHERE source_key=?',x.source_key);if(existing)return withCover(existing);}throw e;}
}
const entryFields=`e.id,e.kind,e.rating,e.content,e.video_note,e.video_media_id,e.created_at,e.user_id,
 u.name AS user_name,u.avatar AS user_avatar,u.avatar_media_id AS user_avatar_media_id,u.bio AS user_bio,
 b.id AS book_id,b.title AS book_title,b.author AS book_author,b.cover_url AS book_cover,
 (SELECT COUNT(*) FROM likes WHERE entry_id=e.id) AS like_count,
 (SELECT COUNT(*) FROM comments WHERE entry_id=e.id) AS comment_count,
 EXISTS(SELECT 1 FROM likes WHERE entry_id=e.id AND user_id=?) AS liked`;
const entrySQL=`SELECT ${entryFields} FROM entries e JOIN users u ON u.id=e.user_id LEFT JOIN books b ON b.id=e.book_id`;
// Apenas leitores que se seguem mutuamente podem ler e enviar mensagens.
const mutualFollow=async (a,b)=>a!==b&&!!await one(`SELECT 1 FROM follows f
 JOIN follows back ON back.follower_id=f.following_id AND back.following_id=f.follower_id
 WHERE f.follower_id=? AND f.following_id=?`,a,b);

async function checkMessageRate(userId){
 const bucket=Math.floor(Date.now()/60000),key='dm:'+userId;
 await run('INSERT INTO rate_limits(bucket,key,count) VALUES(?,?,1) ON CONFLICT(bucket,key) DO UPDATE SET count=count+1',bucket,key);
 const rec=await one('SELECT count FROM rate_limits WHERE bucket=? AND key=?',bucket,key);
 if(rec.count>30)throw apiError(429,'Limite de mensagens atingido. Aguarde um minuto.');
}
async function limited(req){
 const ip=req.headers.get('cf-connecting-ip') || 'local';
 const key='auth:'+await sha(ip+':'+new URL(req.url).pathname);
 const bucket=Math.floor(Date.now()/900000);
 await run('INSERT INTO rate_limits(bucket,key,count) VALUES(?,?,1) ON CONFLICT(bucket,key) DO UPDATE SET count=count+1',bucket,key);
 const rec=await one('SELECT count FROM rate_limits WHERE bucket=? AND key=?',bucket,key);
 return rec.count>15;
}
const MAX_BODY=18_000;
async function body(req){
 if(Number(req.headers.get('content-length')||0)>MAX_BODY)throw apiError(413,'Texto muito longo.');
 const data=await req.text();
 if(new TextEncoder().encode(data).length>MAX_BODY)throw apiError(413,'Texto muito longo.');
 try{return JSON.parse(data||'{}');}catch{throw apiError(400,'JSON inválido.');}
}
function originAllowed(req){const o=req.headers.get('origin');if(!o)return true;try{return new URL(o).origin===new URL(req.url).origin;}catch{return false;}}

async function verifyGoogleJWT(token){
 if(!GOOGLE_CLIENT_ID)throw apiError(400,'Login Google ainda não foi configurado.');
 if(typeof token!=='string'||token.length>6000)throw apiError(401,'Token Google inválido.');
 const parts=token.split('.');if(parts.length!==3)throw apiError(401,'Token Google inválido.');
 let header,payload;try{header=JSON.parse(atobUrl(parts[0]));payload=JSON.parse(atobUrl(parts[1]));}catch{throw apiError(401,'Token Google inválido.');}
 if(header.alg!=='RS256'||!header.kid||payload.aud!==GOOGLE_CLIENT_ID||!['accounts.google.com','https://accounts.google.com'].includes(payload.iss)||!payload.exp||payload.exp*1000<Date.now()||payload.iat*1000>Date.now()+60000||payload.email_verified!==true||!validEmail(payload.email)||!payload.sub)throw apiError(401,'Autenticação Google recusada.');
 if(Date.now()>jwksCache.time){const reply=await fetch('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(6500)});if(!reply.ok)throw apiError(503,'Google temporariamente indisponível.');let json=await reply.json();jwksCache={time:Date.now()+40*60000,keys:json.keys||[]};}
 const jwk=jwksCache.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!jwk)throw apiError(401,'Assinatura Google desconhecida.');
 const pub=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const ok=await crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5'},pub,b64Bytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
 if(!ok)throw apiError(401,'Assinatura Google inválida.');
 return {email:payload.email.toLowerCase(),sub:String(payload.sub),name:trim(payload.name||payload.given_name,60)||'Leitor(a)'};
}

async function handleApi(req,res,pathname,search){
 if(pathname==='/api/media/upload'&&req.method==='POST'){
   if(!originAllowed(req))throw apiError(403,'Origem não autorizada.');
   const user=await currentUser(req);if(!user)throw apiError(401,'Faça login para enviar arquivos.');
   if(!env.MEDIA)throw apiError(503,'Ative o bucket R2 no Worker para enviar mídias.');
   const purpose=req.headers.get('x-media-purpose');
   const mime=(req.headers.get('content-type')||'').split(';')[0].toLowerCase();
   const images=['image/jpeg','image/png','image/webp'];
   const videos=['video/mp4','video/webm'];
   const max=purpose==='avatar'?800000:purpose==='cover'?1500000:purpose==='video'?20000000:0;
   if(!max||!(purpose==='video'?videos:images).includes(mime))throw apiError(415,'Formato de mídia não permitido.');
   const len=Number(req.headers.get('content-length'));
   if(Number.isFinite(len)&&len>max)throw apiError(413,'Arquivo maior que o permitido.');
   const used=await one('SELECT COALESCE(SUM(bytes),0) AS total,COUNT(*) AS n FROM media_assets WHERE owner_id=?',user.id);
   if(used.total+(len||max)>200000000||used.n>=150)throw apiError(429,'Sua cota de mídias chegou ao limite.');
   const rateKey='media:'+user.id, bucket=Math.floor(Date.now()/3600000);
   await run('INSERT INTO rate_limits(bucket,key,count) VALUES(?,?,1) ON CONFLICT(bucket,key) DO UPDATE SET count=count+1',bucket,rateKey);
   const count=await one('SELECT count FROM rate_limits WHERE bucket=? AND key=?',bucket,rateKey);
   if(count.count>15)throw apiError(429,'Limite de 15 envios por hora. Aguarde um pouco.');
   const chunks=[];let size=0;
   const reader=req.body?.getReader();if(!reader)throw apiError(400,'Arquivo vazio.');
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>max){await reader.cancel();throw apiError(413,'Arquivo maior que o permitido.');}
    chunks.push(value);
   }
   if(!size)throw apiError(400,'Arquivo vazio.');
   const raw=new Uint8Array(size);let position=0;for(const chunk of chunks){raw.set(chunk,position);position+=chunk.byteLength;}
   const jpeg=raw[0]===255&&raw[1]===216&&raw[2]===255;
   const png=raw[0]===137&&raw[1]===80&&raw[2]===78&&raw[3]===71&&raw[4]===13&&raw[5]===10;
   const webp=String.fromCharCode(...raw.slice(0,4))==='RIFF'&&String.fromCharCode(...raw.slice(8,12))==='WEBP';
   const mp4=String.fromCharCode(...raw.slice(4,8))==='ftyp';
   const webm=raw[0]===26&&raw[1]===69&&raw[2]===223&&raw[3]===163;
   if(!({'image/jpeg':jpeg,'image/png':png,'image/webp':webp,'video/mp4':mp4,'video/webm':webm})[mime])throw apiError(415,'O conteúdo não corresponde ao formato do arquivo.');
   const id=randomHex(16),key=`${purpose}/${id}`;
   await env.MEDIA.put(key,raw,{httpMetadata:{contentType:mime,cacheControl:'private, max-age=300'}});
   try{await run('INSERT INTO media_assets(id,owner_id,kind,r2_key,mime,bytes) VALUES(?,?,?,?,?,?)',id,user.id,purpose,key,mime,size);}
   catch(e){await env.MEDIA.delete(key);throw e;}
   return respond(res,201,{id,url:mediaUrl(id),bytes:size,kind:purpose});
 }
 const mediaMatch=pathname.match(/^\/api\/media\/([0-9a-f]{32})$/);
 if(mediaMatch&&['GET','HEAD'].includes(req.method)){
   const user=await currentUser(req);if(!user)throw apiError(401,'Entre na sua conta para ver mídias.');
   const asset=await one('SELECT * FROM media_assets WHERE id=?',mediaMatch[1]);
   if(!asset||!env.MEDIA)throw apiError(404,'Arquivo não encontrado.');
   const range=req.headers.get('Range');
   const object=await env.MEDIA.get(asset.r2_key,range?{range}:undefined);
   if(!object)return new Response('Arquivo indisponível',{status:404});
   const headers=new Headers({'Content-Type':asset.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=120','Accept-Ranges':'bytes'});
   let status=200;
   if(range&&object.range&&typeof object.range.offset==='number'){
     status=206;
     headers.set('Content-Range',`bytes ${object.range.offset}-${object.range.offset+object.range.length-1}/${object.size}`);
     headers.set('Content-Length',String(object.range.length));
   }else headers.set('Content-Length',String(object.size));
   return new Response(req.method==='HEAD'?null:object.body,{status,headers});
 }
 if(pathname==='/api/health'&&req.method==='GET')return respond(res,200,{ok:true});
 if(pathname==='/api/config'&&req.method==='GET')return respond(res,200,{googleClientId:GOOGLE_CLIENT_ID,inviteOnly:true,mediaEnabled:!!env.MEDIA});
 const mutating=['POST','PUT','PATCH','DELETE'].includes(req.method);
 if(mutating && !originAllowed(req))throw apiError(403,'Origem não autorizada.');
 if(mutating && !(req.headers.get('content-type')||'').startsWith('application/json'))throw apiError(415,'Envie JSON.');
 if(pathname==='/api/auth/register'&&req.method==='POST'){
   if(await limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),name=trim(b.name,60),email=String(b.email||'').trim().toLowerCase(),pass=b.password||'';
   if(!await compareString(String(b.inviteCode||''),INVITE_CODE))throw apiError(403,'Código de convite incorreto.');
   if(name.length<2||!validEmail(email)||typeof pass!=='string'||pass.length<10||pass.length>128)throw apiError(400,'Use nome, e-mail válido e senha de 10 a 128 caracteres.');
   if(await one('SELECT id FROM users WHERE email=?',email))throw apiError(409,'Esse e-mail já está cadastrado.');
   const id=Number((await run('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)',name,email,await hashPassword(pass,AUTH_PEPPER))).lastInsertRowid);
   const u=await one('SELECT * FROM users WHERE id=?',id);await login(res,u);return respond(res,201,{user:me(u),stats:await stats(id)});
 }
 if(pathname==='/api/auth/login'&&req.method==='POST'){
   if(await limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=b.password||'';
   const u=await one('SELECT * FROM users WHERE email=?',email);
   if(!u || !(await passwordOK(password,u.password_hash,AUTH_PEPPER)))throw apiError(401,'E-mail ou senha incorretos.');
   await login(res,u);return respond(res,200,{user:me(u),stats:await stats(u.id)});
 }
 if(pathname==='/api/auth/google'&&req.method==='POST'){
   if(await limited(req))throw apiError(429,'Muitas tentativas. Aguarde um pouco.');
   const b=await body(req),g=await verifyGoogleJWT(b.credential);
   let u=await one('SELECT * FROM users WHERE google_sub=?',g.sub);
   if(!u){u=await one('SELECT * FROM users WHERE email=?',g.email);if(u){
     // E-mail já verificado pelo Google, pode vincular somente se não estiver ligado a outra identidade Google.
     if(u.google_sub&&u.google_sub!==g.sub)throw apiError(403,'Conta Google diferente da já vinculada.');
     await run('UPDATE users SET google_sub=? WHERE id=?',g.sub,u.id);
   } else {
     if(!await compareString(String(b.inviteCode||''),INVITE_CODE))throw apiError(403,'Para entrar na comunidade, informe o código de convite.');
     const id=Number((await run('INSERT INTO users(name,email,google_sub) VALUES(?,?,?)',g.name,g.email,g.sub)).lastInsertRowid);u=await one('SELECT * FROM users WHERE id=?',id);
   }}
   await login(res,u);return respond(res,200,{user:me(u),stats:await stats(u.id)});
 }
 const user=await currentUser(req);
 if(pathname==='/api/auth/me'&&req.method==='GET')return respond(res,200,{user:user?me(user):null,stats:user?await stats(user.id):null});
 if(pathname==='/api/auth/logout'&&req.method==='POST'){
   const tok=cookie(req).el_session;if(tok)await run('DELETE FROM sessions WHERE token_hash=?',await sha(tok));res.headers.set('Set-Cookie',makeCookie('',0));return respond(res,200,{ok:true});
 }
 if(!user)throw apiError(401,'Faça login para acessar a comunidade.');
 if(pathname==='/api/me'&&req.method==='PUT'){
   const b=await body(req),name=trim(b.name,60),bio=trim(b.bio,350),avatar=trim(b.avatar,12)||'📖';
   const avatarId=b.avatar_media_id===undefined?undefined:b.avatar_media_id===null?null:trim(b.avatar_media_id,32);
   if(avatarId && !await one("SELECT id FROM media_assets WHERE id=? AND owner_id=? AND kind='avatar'",avatarId,user.id))throw apiError(403,'Foto de perfil inválida.');
   if(name.length<2)throw apiError(400,'Informe um nome com ao menos 2 caracteres.');
   await run('UPDATE users SET name=?,bio=?,avatar=?,avatar_media_id=? WHERE id=?',name,bio,avatar,avatarId===undefined?user.avatar_media_id:avatarId,user.id);
   return respond(res,200,{user:me(await one('SELECT * FROM users WHERE id=?',user.id))});
 }
 if(pathname==='/api/people'&&req.method==='GET'){
   const users=await all(`SELECT id,name,bio,avatar,avatar_media_id,created_at,
     EXISTS(SELECT 1 FROM follows WHERE follower_id=? AND following_id=u.id) AS following,
     (SELECT COUNT(*) FROM follows WHERE following_id=u.id) AS followers,
     EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=u.id AND f.following_id=?) AS follows_me
     FROM users u WHERE id<>? ORDER BY created_at DESC LIMIT 80`,user.id,user.id,user.id);
   return respond(res,200,{people:users});
 }
 const usermatch=pathname.match(/^\/api\/users\/(\d+)$/);
 if(usermatch&&req.method==='GET'){
   const id=Number(usermatch[1]),found=await one('SELECT * FROM users WHERE id=?',id);
   if(!found)throw apiError(404,'Leitor não encontrado.');
   return respond(res,200,{user:me(found),stats:await stats(id),following:!!await one('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?',user.id,id),mutual:await mutualFollow(user.id,id)});
 }
 const followMatch=pathname.match(/^\/api\/users\/(\d+)\/follow$/);
 if(followMatch&&req.method==='POST'){
   const id=Number(followMatch[1]);if(id===user.id)throw apiError(400,'Você não pode seguir a si mesmo.');
   if(!await one('SELECT id FROM users WHERE id=?',id))throw apiError(404,'Perfil não encontrado.');
   const f=await one('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?',user.id,id);
   if(f)await run('DELETE FROM follows WHERE follower_id=? AND following_id=?',user.id,id);
   else await run('INSERT INTO follows(follower_id,following_id) VALUES(?,?)',user.id,id);
   return respond(res,200,{following:!f});
 }
 // Direct privado: contatos aparecem apenas quando ambos se seguem.
 if(pathname==='/api/messages/contacts'&&req.method==='GET'){
   const contacts=await all(`SELECT u.id,u.name,u.avatar,u.avatar_media_id,u.bio,
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
   const unread=(await one(`SELECT COUNT(*) AS n FROM direct_messages m
     WHERE m.recipient_id=? AND m.read_at IS NULL
       AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=m.sender_id)
       AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=m.sender_id AND f.following_id=?)`,user.id,user.id,user.id)).n;
   return respond(res,200,{unread});
 }
 const dmMatch=pathname.match(/^\/api\/messages\/(\d+)(?:\/(read))?$/);
 if(dmMatch){
   const peerId=Number(dmMatch[1]),markRead=!!dmMatch[2];
   if(!Number.isSafeInteger(peerId)||peerId<=0||peerId===user.id)throw apiError(400,'Destinatário inválido.');
   if(!await one('SELECT id FROM users WHERE id=?',peerId))throw apiError(404,'Leitor não encontrado.');
   if(!await mutualFollow(user.id,peerId))throw apiError(403,'O Direct é permitido somente entre leitores que se seguem mutuamente.');
   if(markRead&&req.method==='POST'){
     await run('UPDATE direct_messages SET read_at=CURRENT_TIMESTAMP WHERE sender_id=? AND recipient_id=? AND read_at IS NULL',peerId,user.id);
     return respond(res,200,{ok:true});
   }
   if(!markRead&&req.method==='GET'){
     const messages=await all(`SELECT * FROM (SELECT id,sender_id,recipient_id,content,created_at,read_at
       FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)
       ORDER BY id DESC LIMIT 100) ORDER BY id ASC`,user.id,peerId,peerId,user.id);
     return respond(res,200,{messages});
   }
   if(!markRead&&req.method==='POST'){
     const b=await body(req),content=trim(b.content,1501);
     if(!content||content.length>1500)throw apiError(400,'Escreva uma mensagem com até 1.500 caracteres.');
     await checkMessageRate(user.id);
     const id=Number((await run('INSERT INTO direct_messages(sender_id,recipient_id,content) VALUES(?,?,?)',user.id,peerId,content)).lastInsertRowid);
     return respond(res,201,{message:await one('SELECT id,sender_id,recipient_id,content,created_at,read_at FROM direct_messages WHERE id=?',id)});
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
 const coverMatch=pathname.match(/^\/api\/books\/(\d+)\/cover$/);
 if(coverMatch && req.method==='PUT'){
  const bookId=Number(coverMatch[1]),b=await body(req),id=trim(b.media_id,32);
  if(!await one('SELECT 1 FROM shelves WHERE book_id=? AND user_id=?',bookId,user.id))throw apiError(403,'Adicione o livro à sua estante antes de trocar a capa.');
  if(!await one("SELECT id FROM media_assets WHERE id=? AND owner_id=? AND kind='cover'",id,user.id))throw apiError(403,'Capa não autorizada.');
  await run('UPDATE books SET cover_url=? WHERE id=?',mediaUrl(id),bookId);
  return respond(res,200,{ok:true,cover_url:mediaUrl(id)});
 }
 if(pathname==='/api/entries'&&req.method==='GET'){
   const profile=Number(search.get('user_id')||0),filter=trim(search.get('kind'),20),where=[],args=[user.id];
   if(profile){where.push('e.user_id=?');args.push(profile);}
   if(filter==='review'||filter==='post'){where.push('e.kind=?');args.push(filter);}
   if(search.get('has_video')==='1')where.push('e.video_media_id IS NOT NULL');
   const entries=await all(`${entrySQL} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY e.id DESC LIMIT 100`,...args);
   return respond(res,200,{entries});
 }
 if(pathname==='/api/entries'&&req.method==='POST'){
   const b=await body(req),kind=b.kind==='review'?'review':b.kind==='post'?'post':null,content=trim(b.content,4000);
   const videoId=trim(b.video_media_id,32),videoNote=trim(b.video_note,250);
   if(videoId && kind!=='review')throw apiError(400,'Os vídeos são permitidos em resenhas.');
   if(videoId && !await one("SELECT id FROM media_assets WHERE id=? AND owner_id=? AND kind='video'",videoId,user.id))throw apiError(403,'Vídeo inválido.');
   if(!kind||content.length<2)throw apiError(400,'Escreva pelo menos dois caracteres.');
   let bookId=null,rating=null;
   if(kind==='review'){
     const book=await getBook(b.book,user.id);bookId=book.id;rating=Number(b.rating);
     if(!Number.isInteger(rating)||rating<1||rating>5)throw apiError(400,'Escolha de 1 a 5 estrelas.');
     if(await one("SELECT id FROM entries WHERE user_id=? AND kind='review' AND book_id=?",user.id,bookId))throw apiError(409,'Você já avaliou esse livro. Apague sua resenha anterior para escrever outra.');
   }
   const id=Number((await run('INSERT INTO entries(user_id,kind,book_id,rating,content,video_media_id,video_note) VALUES(?,?,?,?,?,?,?)',user.id,kind,bookId,rating,content,videoId||null,videoNote)).lastInsertRowid);
   return respond(res,201,{entry:await one(`${entrySQL} WHERE e.id=?`,user.id,id)});
 }
 const entryMatch=pathname.match(/^\/api\/entries\/(\d+)$/);
 if(entryMatch&&req.method==='DELETE'){
   const id=Number(entryMatch[1]);const e=await one('SELECT user_id FROM entries WHERE id=?',id);
   if(!e)throw apiError(404,'Publicação não encontrada.');if(e.user_id!==user.id)throw apiError(403,'Você só pode apagar suas publicações.');
   await run('DELETE FROM entries WHERE id=?',id);return respond(res,200,{ok:true});
 }
 const likeMatch=pathname.match(/^\/api\/entries\/(\d+)\/like$/);
 if(likeMatch&&req.method==='POST'){
   const id=Number(likeMatch[1]);if(!await one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   const e=await one('SELECT 1 FROM likes WHERE user_id=? AND entry_id=?',user.id,id);
   if(e)await run('DELETE FROM likes WHERE user_id=? AND entry_id=?',user.id,id);
   else await run('INSERT INTO likes(user_id,entry_id) VALUES(?,?)',user.id,id);
   return respond(res,200,{liked:!e});
 }
 const commentsMatch=pathname.match(/^\/api\/entries\/(\d+)\/comments$/);
 if(commentsMatch&&req.method==='GET'){
   const id=Number(commentsMatch[1]);if(!await one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   return respond(res,200,{comments:await all('SELECT c.id,c.content,c.created_at,u.id AS user_id,u.name AS user_name,u.avatar AS user_avatar,u.avatar_media_id AS user_avatar_media_id FROM comments c JOIN users u ON u.id=c.user_id WHERE c.entry_id=? ORDER BY c.id ASC LIMIT 200',id)});
 }
 if(commentsMatch&&req.method==='POST'){
   const id=Number(commentsMatch[1]),b=await body(req),content=trim(b.content,1000);
   if(!await one('SELECT id FROM entries WHERE id=?',id))throw apiError(404,'Publicação não encontrada.');
   if(!content)throw apiError(400,'Escreva um comentário.');
   await run('INSERT INTO comments(user_id,entry_id,content) VALUES(?,?,?)',user.id,id,content);
   return respond(res,201,{ok:true});
 }
 const deleteComment=pathname.match(/^\/api\/comments\/(\d+)$/);
 if(deleteComment&&req.method==='DELETE'){
   const id=Number(deleteComment[1]),comment=await one('SELECT user_id FROM comments WHERE id=?',id);
   if(!comment)throw apiError(404,'Comentário não encontrado.');
   if(comment.user_id!==user.id)throw apiError(403,'Você só pode apagar seus comentários.');
   await run('DELETE FROM comments WHERE id=?',id);return respond(res,200,{ok:true});
 }
 if(pathname==='/api/shelf'&&req.method==='GET'){
   const owner=Number(search.get('user_id')||user.id);
   if(!await one('SELECT id FROM users WHERE id=?',owner))throw apiError(404,'Leitor não encontrado.');
   return respond(res,200,{shelf:await all('SELECT b.*,s.status,s.updated_at FROM shelves s JOIN books b ON b.id=s.book_id WHERE s.user_id=? ORDER BY s.updated_at DESC,b.id DESC',owner)});
 }
 if(pathname==='/api/shelf'&&req.method==='PUT'){
   const b=await body(req),status=b.status;
   if(!['lido','lendo','quero_ler'].includes(status))throw apiError(400,'Status inválido.');
   const book=await getBook(b.book,user.id);
   await run('INSERT INTO shelves(user_id,book_id,status,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,book_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP',user.id,book.id,status);
   return respond(res,200,{book,status,stats:await stats(user.id)});
 }
 const delShelf=pathname.match(/^\/api\/shelf\/(\d+)$/);
 if(delShelf&&req.method==='DELETE'){
   await run('DELETE FROM shelves WHERE user_id=? AND book_id=?',user.id,Number(delShelf[1]));return respond(res,200,{ok:true,stats:await stats(user.id)});
 }
 throw apiError(404,'Rota não encontrada.');
}

return handleApi;
}
const securityHeaders={
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'strict-origin-when-cross-origin',
 'X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; img-src 'self' https://covers.openlibrary.org https://*.googleusercontent.com data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'self'; object-src 'none'; form-action 'self'"
};
export default {
 async fetch(req,env){
  let response;
  try{
   const url=new URL(req.url);
   if(url.pathname.startsWith('/api/')){
    if(!env.DB)throw Object.assign(new Error('D1 não configurado'),{status:503});
    const res={headers:new Headers()};
    response=await createApi(env)(req,res,url.pathname,url.searchParams);
   }else{
    if(!['GET','HEAD'].includes(req.method))response=new Response('Método não permitido',{status:405});
    else if(!['/','/index.html','/app.js','/style.css'].includes(url.pathname))response=new Response('Não encontrado',{status:404});
    else response=await env.ASSETS.fetch(req);
   }
  }catch(e){
   const code=e.status||500;
   if(code>=500)console.error(e);
   response=new Response(JSON.stringify({error:code>=500?'Erro no servidor.':e.message}),{status:code,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
  const headers=new Headers(response.headers);
  for(const [key,value] of Object.entries(securityHeaders))headers.set(key,value);
  return new Response(response.body,{status:response.status,headers});
 }
};
