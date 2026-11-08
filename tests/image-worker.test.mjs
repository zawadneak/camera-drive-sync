import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createImageWorker} from '../dashboard/lib/image-worker.mjs';

test('Python worker coalesces requests, serves cached JPEGs, and rejects archive escapes',{skip:!process.env.CAMERA_TEST_PYTHON},async t=>{
 const python=process.env.CAMERA_TEST_PYTHON;
 const root=await mkdtemp(path.join(os.tmpdir(),'camera-worker-bridge-'));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^camera-worker-bridge-/);await rm(root,{recursive:true,force:true});});
 const inbox=path.join(root,'inbox'),cache=path.join(root,'cache');await mkdir(inbox);
 const original=path.join(inbox,'TEST.JPG');
 await promisify(execFile)(python,['-c','from PIL import Image; import sys; Image.new("RGB",(3000,2000),"green").save(sys.argv[1],quality=95)',original],{windowsHide:true});
 const body=await readFile(original),file={archivePath:original,bytes:body.length,sha1:createHash('sha1').update(body).digest('hex')};
 const worker=createImageWorker({python,script:fileURLToPath(new URL('../dashboard/image_worker.py',import.meta.url)),inbox,cache});t.after(()=>worker.close());
 const first=worker.preview(file),second=worker.preview(file);assert.equal(first,second);
 const resized=await first;assert.equal(resized.type,'image/jpeg');assert.ok(resized.body.length<body.length);assert.equal(resized.cached,false);
 assert.equal((await worker.preview(file)).cached,true);
 worker.close();
 const restarted=createImageWorker({python,script:fileURLToPath(new URL('../dashboard/image_worker.py',import.meta.url)),inbox,cache});t.after(()=>restarted.close());
 assert.equal((await restarted.preview(file)).cached,true);
 await assert.rejects(restarted.preview({...file,archivePath:path.join(root,'missing.jpg')}));
 assert.deepEqual(await readFile(original),body);
});
