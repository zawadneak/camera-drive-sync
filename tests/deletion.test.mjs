import test from 'node:test';import assert from 'node:assert/strict';
import {createDeletionService} from '../dashboard/lib/deletion.mjs';
function fixture(){
 const file={id:'a'.repeat(64),name:'TEST.JPG',bytes:100,fingerprint:'100:1',sha1:'b'.repeat(40),assetId:'asset-1',onCamera:true,imported:true};
 const state={camera:{connected:true,identity:'camera-card-1'},files:[file]};
 let removed=0,verified=0,clock=0,failVerification=false;
 const service=createDeletionService({snapshot:async()=>structuredClone(state),verify:async()=>{verified++;if(failVerification)throw new Error('Original missing');},remove:async()=>{removed++;return {ok:true};},now:()=>clock});
 return {service,file,state,get removed(){return removed;},get verified(){return verified;},set clock(value){clock=value;},set failVerification(value){failVerification=value;}};
}
test('preparing a confirmation verifies copies without deleting',async()=>{const f=fixture();await f.service.prepare([f.file.id]);assert.equal(f.verified,1);assert.equal(f.removed,0);});
test('deletion requires fresh verification and a one-use confirmation',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);await f.service.execute(p.token);assert.equal(f.verified,2);assert.equal(f.removed,1);await assert.rejects(f.service.execute(p.token),/expired/);assert.equal(f.removed,1);});
test('unimported camera files cannot be selected',async()=>{const f=fixture();f.file.imported=false;await assert.rejects(f.service.prepare([f.file.id]),/imported/);assert.equal(f.removed,0);});
test('expired confirmation cannot remove anything',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);f.clock=120001;await assert.rejects(f.service.execute(p.token),/expired/);assert.equal(f.removed,0);});
test('changing the camera/card invalidates confirmation',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);f.state.camera.identity='another-card';await assert.rejects(f.service.execute(p.token),/changed/);assert.equal(f.removed,0);});
test('file changes invalidate confirmation',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);f.file.fingerprint='100:2';await assert.rejects(f.service.execute(p.token),/changed/);assert.equal(f.removed,0);});
test('loss of either backup blocks execution',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);f.failVerification=true;await assert.rejects(f.service.execute(p.token),/Original missing/);assert.equal(f.removed,0);});
test('disconnecting before confirmation keeps originals',async()=>{const f=fixture(),p=await f.service.prepare([f.file.id]);f.state.camera.connected=false;await assert.rejects(f.service.execute(p.token),/changed/);assert.equal(f.removed,0);});
