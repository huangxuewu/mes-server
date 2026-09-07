const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const ownerId='111111111111111111111111', viewerId='222222222222222222222222', documentId='aaaaaaaaaaaaaaaaaaaaaaaa';
const fixture=(options={})=>{
 const document={_id:documentId,owner:ownerId,securityVersion:0,status:'Draft',visibility:'everyone',viewerIds:[],watermark:'',watermarkText:'',watermarkLayout:'single'};
 const user={_id:ownerId,status:'Active',role:'User',permission:{module:['document']}};
 const handlers={},notifications=[];let freezes=0;
 const socket={id:'settings-socket',user,data:{userId:ownerId,sessionGeneration:1,expiresAt:Date.now()+3600000},on:(event,handler)=>{handlers[event]=handler;}};
 const access=require('../utils/documentAccess');
 const db={document:{findById:()=>({select:async()=>{await options.onRead?.();return document;}}),findOneAndUpdate:async(query,update)=>{
   await options.onSave?.();
   if(query.securityVersion!==document.securityVersion)return null;Object.assign(document,update.$set);return document;
 }},user:{countDocuments:async query=>query._id.$in.length}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../socket/event/documentSettings'),'utf8'),{module,Buffer,console,require:name=>{
  if(name==='../../models')return db;
  if(name==='../session')return{getActiveSessionUser:async()=>socket.user,JWT_SECRET:'test-key'};
  if(name==='../../utils/documentAccess')return{...access,safeDocument:async value=>{await options.onSafe?.();const {passwordHash,...safe}=value;return safe;}};
  if(name==='../collaboration')return{freezeDocument:async()=>{freezes++;return options.onFreeze?.() || null;}};
  if(name==='node:crypto' && options.afterDerive)return{...crypto,scrypt:(password,salt,length,callback)=>crypto.scrypt(password,salt,length,(error,key)=>{options.afterDerive();callback(error,key);})};
  return require(name);
 }});
 module.exports(socket,{fetchSockets:async()=>[{data:{documentSeen:new Set([documentId])},emit:(event,payload)=>notifications.push({event,payload})}]});
 const call=async(event,input={})=>{let result;await handlers[event]({documentId,...input},response=>{result=response;});return result;};
 const settings={locked:true,visibility:'selected',viewerIds:[viewerId],watermark:'custom',watermarkText:'Internal only',watermarkLayout:'repeat'};
 const switchUser=id=>{socket.user={...socket.user,_id:id};socket.data.userId=id;socket.data.sessionGeneration++;socket.data.documentGrants={};};
 return{document,socket,call,settings,notifications,switchUser,freezes:()=>freezes};
};

test('settings require owner authority and a current version, then save lock, watermark and viewers together',async()=>{
 const f=fixture();f.switchUser(viewerId);
 assert.equal((await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings})).status,'error');assert.equal(f.freezes(),0);
 f.switchUser(ownerId);
 assert.equal((await f.call('documentSettings:update',{expectedVersion:9,settings:f.settings})).status,'error');
 const saved=await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings});
 assert.equal(saved.status,'success');assert.equal(f.document.locked,true);assert.equal(f.document.watermarkLayout,'repeat');assert.equal(f.document.securityVersion,1);
 assert.equal(f.freezes(),1);assert.equal(f.notifications[0].event,'document:accessChanged');assert.equal(f.notifications[0].payload.title,undefined);
});

test('passwords are salted hashes, wrong attempts fail, correct viewers receive a time-bounded grant, and removal is explicit',async()=>{
 const f=fixture();const saved=await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings,passwordChange:{action:'set',value:'a strong fixture password'}});
 assert.equal(saved.status,'success');assert.equal(saved.payload.document.passwordHash,undefined);
 assert.equal(f.document.hasPassword,true);assert.ok(!f.document.passwordHash.includes('fixture'));
 const [salt,hash]=f.document.passwordHash.split(':');assert.equal(crypto.scryptSync('a strong fixture password',salt,64).toString('hex'),hash);
 f.switchUser(viewerId);
 assert.equal((await f.call('documentAccess:unlock',{password:'incorrect'})).status,'error');
 const unlocked=await f.call('documentAccess:unlock',{password:'a strong fixture password'});assert.equal(unlocked.status,'success');
 const grant=require('jsonwebtoken').verify(unlocked.payload.token,'test-key',{audience:'document-access'});assert.equal(grant.userId,viewerId);assert.equal(grant.version,1);assert.ok(grant.exp-grant.iat<=3600);
 f.switchUser(ownerId);
 await f.call('documentSettings:update',{expectedVersion:1,settings:f.settings,passwordChange:{action:'remove'}});
 assert.equal(f.document.hasPassword,false);assert.equal(f.document.passwordHash,'');
});

test('five wrong passwords rate-limit further guesses without changing the document',async()=>{
 const f=fixture();await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings,passwordChange:{action:'set',value:'fixture password'}});
 f.switchUser(viewerId);
 for(let i=0;i<5;i++)assert.equal((await f.call('documentAccess:unlock',{password:'wrong'})).status,'error');
 const response=await f.call('documentAccess:unlock',{password:'fixture password'});assert.match(response.message,/Too many attempts/);assert.equal(f.document.securityVersion,1);
});


for (const event of ['documentSettings:get', 'documentSettings:update', 'documentAccess:unlock']) {
 for (const replacement of [ownerId, viewerId]) test(`${event} rejects a queued request after switching sessions to ${replacement}`, async () => {
  const f=fixture();
  const release=await require('../utils/documentAccess').acquireDocument(documentId);
  let pending;
  try {
   pending=f.call(event,{expectedVersion:0,settings:f.settings});
   await new Promise(resolve=>setImmediate(resolve));
   f.switchUser(replacement);
  } finally { release(); }
  const result=await pending;
  assert.equal(result.status,'error');assert.match(result.message,/Session changed/);
  assert.equal(result.payload,undefined);assert.equal(f.document.securityVersion,0);
  assert.equal(f.freezes(),0);assert.deepEqual(f.socket.data.documentGrants,{});
 });
}

test('changing accounts during password hashing cannot save settings or issue a grant', async () => {
 let f=fixture({afterDerive:()=>f.switchUser(viewerId)});
 const result=await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings,passwordChange:{action:'set',value:'fixture password'}});
 assert.equal(result.status,'error');assert.equal(f.document.securityVersion,0);assert.equal(f.freezes(),0);
 const salt='fixture-salt';
 f=fixture({afterDerive:()=>f.switchUser(ownerId)});
 f.document.hasPassword=true;f.document.passwordHash=salt+':'+crypto.scryptSync('fixture password',salt,64).toString('hex');
 f.switchUser(viewerId);
 const unlocked=await f.call('documentAccess:unlock',{password:'fixture password'});
 assert.equal(unlocked.status,'error');assert.equal(unlocked.payload,undefined);assert.deepEqual(f.socket.data.documentGrants,{});
});

for (const boundary of ['onSave','onSafe']) test(`a session change during ${boundary} never returns the old owner's document`, async () => {
 const f=fixture({[boundary]:()=>f.switchUser(viewerId)});
 const result=await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings});
 assert.equal(result.status,'error');assert.equal(result.payload,undefined);
});

test('failed settings persistence rolls back the freeze, and a retry commits only after saving', async () => {
 const events=[];let fail=true;
 const f=fixture({onFreeze:()=>({snapshot:{plainText:'Latest edits'},commit:async()=>events.push('commit'),rollback:()=>events.push('rollback')}),
  onSave:()=>{events.push('save');if(fail)throw Error('Database unavailable');}});
 assert.equal((await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings})).status,'error');
 assert.deepEqual(events,['save','rollback']);assert.equal(f.document.securityVersion,0);
 fail=false;events.length=0;
 assert.equal((await f.call('documentSettings:update',{expectedVersion:0,settings:f.settings})).status,'success');
 assert.deepEqual(events,['save','commit']);assert.equal(f.document.plainText,'Latest edits');
});
