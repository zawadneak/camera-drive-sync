import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {canPreviewLocally,localPreview} from '../dashboard/lib/local-preview.mjs';
const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);
const sha1=body=>createHash('sha1').update(body).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'camera-preview-test-')),inbox=path.join(root,'inbox');await mkdir(inbox);
 t.after(async()=>{const absolute=path.resolve(root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^camera-preview-test-/);await rm(absolute,{recursive:true,force:true});});
 const file={name:'TEST.JPG',archivePath:path.join(inbox,'TEST.JPG'),copied:true,bytes:jpeg.length,sha1:sha1(jpeg)};await writeFile(file.archivePath,jpeg);return {root,inbox,file};
}
test('an unimported but saved JPEG can be previewed without Immich',async t=>{const f=await fixture(t),result=await localPreview(f.inbox,f.file);assert.equal(result.type,'image/jpeg');assert.deepEqual(result.body,jpeg);});
test('unverified copies and unsupported active content are excluded',()=>{assert.equal(canPreviewLocally({copied:false,name:'TEST.JPG',archivePath:'file',sha1:sha1(jpeg)}),false);assert.equal(canPreviewLocally({copied:true,name:'TEST.SVG',archivePath:'file',sha1:sha1(jpeg)}),false);});
test('a path outside the configured inbox cannot be served',async t=>{const f=await fixture(t);f.file.archivePath=path.join(f.root,'outside.jpg');await writeFile(f.file.archivePath,jpeg);await assert.rejects(localPreview(f.inbox,f.file),/outside/);});
test('junctions or symlinks cannot escape the inbox',async t=>{const f=await fixture(t),outside=path.join(f.root,'other');await mkdir(outside);await writeFile(path.join(outside,'TEST.JPG'),jpeg);await symlink(outside,path.join(f.inbox,'escape'),process.platform==='win32'?'junction':'dir');f.file.archivePath=path.join(f.inbox,'escape','TEST.JPG');await assert.rejects(localPreview(f.inbox,f.file),/outside/);});
test('changed photo bytes are rejected even when the size is unchanged',async t=>{const f=await fixture(t);await writeFile(f.file.archivePath,Buffer.alloc(jpeg.length));await assert.rejects(localPreview(f.inbox,f.file),/changed/);});
test('a false image extension cannot serve other file content',async t=>{const f=await fixture(t),body=Buffer.from('<html>not a photo</html>');await writeFile(f.file.archivePath,body);Object.assign(f.file,{bytes:body.length,sha1:sha1(body)});await assert.rejects(localPreview(f.inbox,f.file),/supported photo/);});
