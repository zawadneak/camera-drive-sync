import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

export function createImageWorker({python,script,inbox,cache}){
 let child=null,sequence=0;const pending=new Map(),inflight=new Map();
 function fail(error){const process=child;child=null;process?.kill();for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();}
 function start(){
  if(child)return;
  const process=spawn(python,['-u',script,'--inbox',inbox,'--cache',cache],{windowsHide:true,stdio:['pipe','pipe','ignore']});child=process;
  process.on('error',()=>{if(child===process)fail(new Error('The Python image worker is unavailable'));});
  process.on('exit',()=>{if(child===process)fail(new Error('The Python image worker stopped'));});
  process.stdin.on('error',()=>{if(child===process)fail(new Error('The Python image worker disconnected'));});
  createInterface({input:process.stdout}).on('line',line=>{
   let result;try{result=JSON.parse(line);}catch{fail(new Error('Invalid image worker response'));return;}
   const request=pending.get(result.id);if(!request)return;pending.delete(result.id);clearTimeout(request.timer);
   if(!result.ok)request.reject(new Error(result.error));else request.resolve(result);
  });
 }
 async function generate(file,profile){
  if(!['grid','detail'].includes(profile))throw new Error('Unknown preview size');
  if(pending.size>=64)throw new Error('Preview queue is busy; retry shortly');
  start();const id=++sequence;
  const result=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>fail(new Error('Image processing timed out')),120_000);timer.unref();pending.set(id,{resolve,reject,timer});
   child.stdin.write(JSON.stringify({id,path:file.archivePath,sha1:file.sha1,bytes:file.bytes,profile})+'\n');
  });
  const [base,output]=await Promise.all([realpath(cache),realpath(result.path)]);
  if(path.dirname(output)!==base||!/[a-f0-9]{64}\.jpg$/.test(path.basename(output)))throw new Error('Invalid cached preview path');
  const body=await readFile(output);if(body.length>5_000_000)throw new Error('Cached preview is too large');
  return {body,type:'image/jpeg',cached:result.cached};
 }
 return {
  preview(file,profile='grid'){
   const key=JSON.stringify([file.archivePath,file.sha1,file.bytes,file.fingerprint,profile]);
   if(inflight.has(key))return inflight.get(key);
   const promise=generate(file,profile).finally(()=>inflight.delete(key));inflight.set(key,promise);return promise;
  },
  close(){fail(new Error('Image worker closed'));}
 };
}
