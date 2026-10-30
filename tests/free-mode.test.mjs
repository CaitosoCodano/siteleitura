import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';

const read=file=>readFileSync(new URL(file,import.meta.url),'utf8');

test('V5.3: deploy sem R2, dependência opcional e interface sem upload obrigatório',async()=>{
 const cfg=JSON.parse(read('../wrangler.jsonc'));
 assert.equal(cfg.name,'entrelinhas-siteleitura');
 assert.ok(cfg.d1_databases.some(db=>db.binding==='DB'));
 assert.equal(Object.hasOwn(cfg,'r2_buckets'),false);
 const app=read('../public/app.js');
 assert.ok(app.includes('renderFeedEntries()'));
 assert.ok(app.includes('renderCommunityPeople()'));
 assert.ok(app.includes('state.mediaEnabled?'));
 assert.equal(app.includes('data-upload-cover="${b.id}"'),false);
 const env={
   INVITE_CODE:'convite-seguro-longo',AUTH_PEPPER:'pepper-test-local-muito-longo-com-mais-de-32-characters',
   GOOGLE_CLIENT_ID:'',
   DB:{prepare(){throw new Error('A rota /api/config não deveria consultar o D1');}},
   ASSETS:{fetch:async()=>new Response('ok')}
 };
 const response=await worker.fetch(new Request('https://entrelinhas.example/api/config'),env);
 assert.equal(response.status,200);
 assert.equal((await response.json()).mediaEnabled,false);
});
