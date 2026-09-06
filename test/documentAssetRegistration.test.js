const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const mongoose = require('mongoose');

const source = fs.readFileSync(path.join(__dirname, '../socket/event/document.js'), 'utf8');
const registration = source.match(/socket\.on\("documentAsset:upload",[\s\S]*?\n    \}\);/)[0];
const fixture = () => {
    const record = {_id:'a'.repeat(24),title:'Procedure',status:'Draft',isTemplate:false,attachments:[]};
    const calls = [], controls = {};
    let handler;
    const copy = value => JSON.parse(JSON.stringify(value));
    vm.runInNewContext(registration, {
        socket:{on:(name,callback)=>handler=callback},safeCallback:callback=>callback,
        requireUser:async()=>({_id:'b'.repeat(24)}),requireAccess:()=>true,mongoose,Buffer,URL,
        normalizePathPart:value=>value,serializeDocument:value=>value,DOCUMENT_POPULATE:[],
        uploadDocumentFile:async()=>{throw new Error('Registration must reuse the uploaded file');},
        io:{emit:(name,payload)=>calls.push({event:name,payload})},
        db:{document:{
            findOne:async()=>record.status==='Archived'?null:{...copy(record),save:async function(){Object.assign(record,copy(this));}},
            updateOne:async(filter,update,options)=>{
                calls.push({event:'atomic-update',filter,update,options});
                if(controls.beforeUpdate)controls.beforeUpdate();
                if(record.status==='Archived'||record.attachments.some(asset=>asset.storagePath===filter['attachments.storagePath'].$ne))return {matchedCount:0};
                record.attachments.push({...copy(update.$push.attachments),_id:'asset-'+(record.attachments.length+1)});
                return {matchedCount:1};
            },
            findById:()=>({populate(){return this;},lean:async()=>copy(record)}),
        }},
    });
    const input={documentId:record._id,kind:'attachment',fileName:'evidence.pdf',mimeType:'application/pdf',size:128,
        storagePath:`/DH MES/document/${record._id}/assets/unique-evidence.pdf`,url:'https://www.dropbox.com/evidence.pdf'};
    return {record,calls,controls,input,run:async(overrides={})=>{let result;await handler({...input,...overrides},value=>result=value);return result;}};
};

test('repeating registration after a lost acknowledgement returns the original attachment without appending a duplicate',async()=>{
    const state=fixture();
    const first=await state.run(),second=await state.run();
    assert.equal(first.status,'success');assert.equal(second.status,'success');
    assert.equal(state.record.attachments.length,1);
    assert.deepEqual(second.payload.asset,first.payload.asset);
    const update=state.calls.find(call=>call.event==='atomic-update');
    assert.equal(update.filter['attachments.storagePath'].$ne,state.input.storagePath);
    assert.equal(update.options.runValidators,true);
});

test('concurrent retries share one registered asset and different paths retain both assets',async()=>{
    const state=fixture();
    const results=await Promise.all([state.run(),state.run()]);
    assert.equal(state.record.attachments.length,1);
    assert.equal(results[0].payload.asset._id,results[1].payload.asset._id);
    await state.run({storagePath:state.input.storagePath.replace('unique-','second-')});
    assert.equal(state.record.attachments.length,2);
});

test('archive during registration cannot report an unregistered asset as successful',async()=>{
    const state=fixture();state.controls.beforeUpdate=()=>state.record.status='Archived';
    const response=await state.run();
    assert.equal(response.status,'error');
    assert.equal(state.record.attachments.length,0);
    assert.ok(!state.calls.some(call=>call.event==='document:updated'));
});

test('retries still validate the file location before attempting registration',async()=>{
    const state=fixture();
    const response=await state.run({url:'https://example.test/evidence.pdf'});
    assert.equal(response.status,'error');
    assert.equal(state.calls.length,0);
});
