import http from 'node:http';
import {readFile,appendFile,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createCsrfToken,checkRequest,readJson,selectionLimit} from './lib/security.mjs';
import {createDeletionService} from './lib/deletion.mjs';
import {syncState} from './public/sync-state.js';
import {createDateReviewService} from './lib/date-review.mjs';
import {canPreviewLocally,localPreview} from './lib/local-preview.mjs';
import {createImageWorker} from './lib/image-worker.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
if(args.includes('--supervised')){
 await new Promise((resolve,reject)=>{
  let input='',started=false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{input+=chunk;if(input.length>32&&!started)reject(new Error('Invalid supervisor handshake'));if(!started&&input.includes('\n')){started=true;if(input.trim()==='START')resolve();else reject(new Error('Invalid supervisor handshake'));}});
  process.stdin.on('end',()=>{if(!started)reject(new Error('Supervisor ended before startup'));});
 });
}
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const root=option('--root','D:\\CameraSync');
const port=Number(option('--port','18474'));
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid dashboard port');
const config=JSON.parse((await readFile(path.join(root,'config.json'),'utf8')).replace(/^\uFEFF/,''));
const dashboardSettings=JSON.parse((await readFile(path.join(root,'dashboard-settings.json'),'utf8').catch(()=>'{}')).replace(/^\uFEFF/,''));
const imageWorker=dashboardSettings.imagePython?createImageWorker({python:dashboardSettings.imagePython,script:path.join(here,'image_worker.py'),inbox:config.inbox,cache:path.join(root,'private','preview-cache')}):null;
process.once('exit',()=>imageWorker?.close());
if(config.server!=='http://127.0.0.1:2283')throw new Error('Only the local Immich server is supported');
const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function bridge(action,input){
 return new Promise((resolve,reject)=>{
  const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'CameraBridge.ps1'),'-Action',action,'-Root',root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='';const timer=setTimeout(()=>{child.kill();reject(new Error('Camera operation timed out. Refresh to check the current camera contents.'));},180_000);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>30_000_000){child.kill();reject(new Error('Camera inventory is too large'));}});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(action==='Secret'?'Unable to read the protected importer credential':errors.trim()||'Camera operation failed'));try{resolve(JSON.parse(output.replace(/^\uFEFF/,'')));}catch{reject(new Error('Invalid response from the camera helper'));}});
  child.stdin.on('error',()=>{});child.stdin.end(input?JSON.stringify(input):'');
 });
}
let {secret:key}=await bridge('Secret');
const csrfToken=createCsrfToken();
let cache=null,cacheTime=0,inflight=null;
async function snapshot(force=false){
 if(!force&&cache&&Date.now()-cacheTime<10_000)return cache;
 if(inflight)return inflight;
 inflight=bridge('Snapshot').then(result=>{cache=result;cacheTime=Date.now();return result;}).finally(()=>{inflight=null;});
 return inflight;
}
function publicState(state){return {
 csrfToken,selectionLimit,camera:{connected:state.camera.connected,name:state.camera.name,drive:state.camera.drive,storage:state.camera.storage??null},
 importer:state.importer,album:{...state.album,url:config.server+'/albums/'+state.album.id},
 files:state.files.map(file=>{const {id,name,bytes,type,capturedAt,onCamera,imported,copied,assetId}=file;return {id,name,bytes,type,capturedAt,onCamera,imported,copied,previewVersion:file.sha1||'',hasPreview:!!assetId||canPreviewLocally(file),sync:syncState(file,state.importer)};}),
 activity:state.activity.map(({time,level,event,file})=>({time,level,event,file}))
};}
async function immich(url){
 const response=await fetch(config.server+url,{headers:{'x-api-key':key},redirect:'error',signal:AbortSignal.timeout(300_000)});
 if(!response.ok){await response.body?.cancel();throw new Error(response.status===403?'The importer key needs permission to download originals. Run the dashboard installer.':`Immich returned HTTP ${response.status}`);}
 return response;
}
async function digest(stream){const hash=createHash('sha1');for await(const chunk of stream)hash.update(chunk);return hash.digest('hex');}
let cardRead=Promise.resolve();
async function verifyCopies(file){
 const previous=cardRead;let release;cardRead=new Promise(resolve=>{release=resolve;});await previous;
 try{
 if(!file.onCamera||!file.cameraPath)throw new Error('The selected file is not on the connected camera');
 const cameraInfo=await stat(file.cameraPath);
 if(!cameraInfo.isFile()||cameraInfo.size!==file.bytes||await digest(createReadStream(file.cameraPath))!==file.sha1)throw new Error(`The camera file ${file.name} changed. Nothing was deleted.`);
 }finally{release();}
 await verifyArchive(file);
 const details=await (await immich('/api/assets/'+encodeURIComponent(file.assetId))).json();
 if(details.isTrashed||details.deletedAt)throw new Error(`${file.name} is in Immich trash. Restore it before removing the camera copy.`);
 const original=await immich('/api/assets/'+encodeURIComponent(file.assetId)+'/original');
 if(await digest(Readable.fromWeb(original.body))!==file.sha1)throw new Error(`The Immich original for ${file.name} does not match the camera backup`);
}
async function verifyArchive(file){
 const inbox=await realpath(config.inbox);
 const archive=await realpath(file.archivePath);
 const relative=path.relative(inbox,archive);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('The archive is outside the configured inbox');
 const info=await stat(archive);
 if(!info.isFile()||info.size!==file.bytes||await digest(createReadStream(archive))!==file.sha1)throw new Error(`The local archive for ${file.name} could not be verified`);
}
const dateReviews=createDateReviewService({snapshot,verifyArchive,save:async plan=>{await bridge('SetDates',{files:plan.map(({sha1,archivePath,fingerprint,takenAt})=>({sha1,archivePath,fingerprint,takenAt}))});cacheTime=0;},wake:()=>bridge('Wake')});
const deletions=createDeletionService({snapshot,verify:verifyCopies,remove:async plan=>{
 const results=[];
 for(let offset=0;offset<plan.files.length;offset+=25){
  const batch=plan.files.slice(offset,offset+25);
  let result;
  try{result=await bridge('Delete',{device:plan.device,files:batch.map(({id,name,relativePath,sha1,bytes,assetId})=>({id,name,relativePath,sha1,bytes,assetId}))});}
  catch(error){cacheTime=0;await appendFile(path.join(root,'dashboard-deletions.jsonl'),JSON.stringify({time:new Date().toISOString(),event:'camera-delete-interrupted',selected:batch.map(file=>file.name),outcome:'Refresh camera contents to determine completed removals'})+'\n');throw error;}
  result.results=result.results.map(file=>({...file,bytes:batch.find(selected=>selected.id===file.id)?.bytes??0}));
  results.push(...result.results);cacheTime=0;
  await appendFile(path.join(root,'dashboard-deletions.jsonl'),JSON.stringify({time:new Date().toISOString(),event:'camera-delete-confirmed',results:result.results})+'\n');
 }
 return {results};
}});
const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.css',['app.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/gallery.js',['gallery.js','text/javascript; charset=utf-8']],['/import-progress.js',['import-progress.js','text/javascript; charset=utf-8']]]);
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
 const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 try{
  checkRequest(req,port,csrfToken);
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  if(req.method==='GET'&&files.has(url.pathname)){const [name,type]=files.get(url.pathname);res.writeHead(200,{'Content-Type':type});res.end(await readFile(path.join(here,'public',name)));return;}
  if(req.method==='GET'&&url.pathname==='/api/state'){
   const state=await snapshot(url.searchParams.has('refresh'));
   let importer=state.importer;try{importer=JSON.parse((await readFile(path.join(root,'status.json'),'utf8')).replace(/^\uFEFF/,''));}catch{}
   json(200,publicState({...state,importer}));return;
  }
  const preview=url.pathname.match(/^\/api\/files\/([a-f0-9]{64})\/thumbnail$/);
  if(req.method==='GET'&&preview){
   const file=(await snapshot()).files.find(item=>item.id===preview[1]);
   if(!file){json(404,{error:'Photo not found'});return;}
   const profile=url.searchParams.get('size')==='detail'?'detail':'grid';
   if(imageWorker&&canPreviewLocally(file)){
    try{
     const {body,type,cached}=await imageWorker.preview(file,profile);
     if(file.sha1&&url.searchParams.get('v')===file.sha1)res.setHeader('Cache-Control','private, max-age=86400, immutable');
     res.writeHead(200,{'Content-Type':type,'X-Preview-Worker':'python','X-Preview-Cache':cached?'hit':'miss'});res.end(body);return;
    }catch(error){if(!file.assetId)throw error;}
   }
   if(file.assetId){
    try{
     const response=await immich('/api/assets/'+file.assetId+'/thumbnail?size='+(profile==='detail'?'preview':'thumbnail'));
     const type=response.headers.get('content-type');if(!type?.startsWith('image/'))throw new Error('Immich did not return an image');
     const body=Buffer.from(await response.arrayBuffer());if(file.sha1&&url.searchParams.get('v')===file.sha1)res.setHeader('Cache-Control','private, max-age=86400, immutable');res.writeHead(200,{'Content-Type':type});res.end(body);return;
    }catch(error){if(imageWorker||!canPreviewLocally(file))throw error;}
   }
   if(!canPreviewLocally(file)){json(404,{error:'Preview is not available for this file yet'});return;}
   const {body,type}=await localPreview(config.inbox,file);
   if(file.sha1&&url.searchParams.get('v')===file.sha1)res.setHeader('Cache-Control','private, max-age=86400, immutable');
   res.writeHead(200,{'Content-Type':type});res.end(body);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/sync'){await readJson(req);json(200,await bridge('Wake'));cacheTime=0;return;}
  if(req.method==='POST'&&url.pathname==='/api/dates/apply'){json(200,await dateReviews.apply(await readJson(req)));return;}
  if(req.method==='POST'&&url.pathname==='/api/delete/prepare'){const body=await readJson(req);json(200,await deletions.prepare(body.ids));return;}
  if(req.method==='POST'&&url.pathname==='/api/delete/execute'){
   const body=await readJson(req);if(body.confirmation!=='DELETE')throw new Error('Type DELETE to confirm camera removal');
   json(200,await deletions.execute(body.token));return;
  }
  json(404,{error:'Not found'});
 }catch(error){if(!res.headersSent)json(error.status??400,{error:error.message});else res.destroy();}
});
server.requestTimeout=30_000;server.headersTimeout=15_000;
server.listen(port,'127.0.0.1',()=>console.log(`Camera dashboard: http://127.0.0.1:${port}`));
function shutdown(){key=null;server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
