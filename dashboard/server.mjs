import http from 'node:http';
import {readFile,appendFile,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createCsrfToken,checkRequest,readJson} from './lib/security.mjs';
import {createDeletionService} from './lib/deletion.mjs';
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
 csrfToken,camera:{connected:state.camera.connected,name:state.camera.name,drive:state.camera.drive},
 importer:state.importer,album:{...state.album,url:config.server+'/albums/'+state.album.id},
 files:state.files.map(({id,name,bytes,type,capturedAt,onCamera,imported,assetId})=>({id,name,bytes,type,capturedAt,onCamera,imported,hasPreview:!!assetId})),
 activity:state.activity.map(({time,level,event,file})=>({time,level,event,file}))
};}
async function immich(url){
 const response=await fetch(config.server+url,{headers:{'x-api-key':key},redirect:'error',signal:AbortSignal.timeout(300_000)});
 if(!response.ok){await response.body?.cancel();throw new Error(response.status===403?'The importer key needs permission to download originals. Run the dashboard installer.':`Immich returned HTTP ${response.status}`);}
 return response;
}
async function digest(stream){const hash=createHash('sha1');for await(const chunk of stream)hash.update(chunk);return hash.digest('hex');}
async function verifyCopies(file){
 if(!file.onCamera||!file.cameraPath)throw new Error('The selected file is not on the connected camera');
 const cameraInfo=await stat(file.cameraPath);
 if(!cameraInfo.isFile()||cameraInfo.size!==file.bytes||await digest(createReadStream(file.cameraPath))!==file.sha1)throw new Error(`The camera file ${file.name} changed. Nothing was deleted.`);
 const inbox=await realpath(config.inbox);
 const archive=await realpath(file.archivePath);
 const relative=path.relative(inbox,archive);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('The archive is outside the configured inbox');
 const info=await stat(archive);
 if(!info.isFile()||info.size!==file.bytes||await digest(createReadStream(archive))!==file.sha1)throw new Error(`The local archive for ${file.name} could not be verified`);
 const details=await (await immich('/api/assets/'+encodeURIComponent(file.assetId))).json();
 if(details.isTrashed||details.deletedAt)throw new Error(`${file.name} is in Immich trash. Restore it before removing the camera copy.`);
 const original=await immich('/api/assets/'+encodeURIComponent(file.assetId)+'/original');
 if(await digest(Readable.fromWeb(original.body))!==file.sha1)throw new Error(`The Immich original for ${file.name} does not match the camera backup`);
}
const deletions=createDeletionService({snapshot,verify:verifyCopies,remove:async plan=>{
 let result;
 try{result=await bridge('Delete',{device:plan.device,files:plan.files.map(({id,name,relativePath,sha1,bytes,assetId})=>({id,name,relativePath,sha1,bytes,assetId}))});}
 catch(error){await appendFile(path.join(root,'dashboard-deletions.jsonl'),JSON.stringify({time:new Date().toISOString(),event:'camera-delete-interrupted',selected:plan.files.map(file=>file.name),outcome:'Refresh camera contents to determine completed removals'})+'\n');throw error;}
 await appendFile(path.join(root,'dashboard-deletions.jsonl'),JSON.stringify({time:new Date().toISOString(),event:'camera-delete-confirmed',results:result.results})+'\n');
 cacheTime=0;return result;
}});
const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.css',['app.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']]]);
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
 const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 try{
  checkRequest(req,port,csrfToken);
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  if(req.method==='GET'&&files.has(url.pathname)){const [name,type]=files.get(url.pathname);res.writeHead(200,{'Content-Type':type});res.end(await readFile(path.join(here,'public',name)));return;}
  if(req.method==='GET'&&url.pathname==='/api/state'){json(200,publicState(await snapshot(url.searchParams.has('refresh'))));return;}
  const preview=url.pathname.match(/^\/api\/files\/([a-f0-9]{64})\/thumbnail$/);
  if(req.method==='GET'&&preview){
   const file=(await snapshot()).files.find(item=>item.id===preview[1]);
   if(!file?.assetId){json(404,{error:'Preview is still processing'});return;}
   const response=await immich('/api/assets/'+file.assetId+'/thumbnail?size=preview');
   const type=response.headers.get('content-type');if(!type?.startsWith('image/'))throw new Error('Immich did not return an image');
   res.writeHead(200,{'Content-Type':type});res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.method==='POST'&&url.pathname==='/api/sync'){await readJson(req);json(200,await bridge('Wake'));cacheTime=0;return;}
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
