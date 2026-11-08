import {randomBytes} from 'node:crypto';
import {validateSelection} from './security.mjs';
export function createDeletionService({snapshot,verify,remove,now=Date.now,concurrency=3}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Verification concurrency must be between 1 and 4');
 const plans=new Map();let busy=false;
 async function verifyAll(files){
  let next=0,failure;
  await Promise.all(Array.from({length:Math.min(concurrency,files.length)},async()=>{
   while(!failure&&next<files.length){const file=files[next++];try{await verify(file);}catch(error){failure??=error;}}
  }));
  if(failure)throw failure;
 }
 async function prepare(ids){
  if(busy)throw new Error('Another camera verification or deletion is still running');
  busy=true;try{
  validateSelection(ids);
  const state=await snapshot(true);
  if(!state.camera.connected)throw new Error('Connect the camera before deleting files');
  const files=ids.map(id=>state.files.find(file=>file.id===id));
  if(files.some(file=>!file?.onCamera||!file.imported||!file.sha1||!file.assetId))throw new Error('Every selected file must be imported and still on this camera');
  await verifyAll(files);
  const token=randomBytes(32).toString('hex');
  for(const [key,plan] of plans)if(plan.expires<now())plans.delete(key);
  if(plans.size>=20)plans.delete(plans.keys().next().value);
  const plan={files,device:state.camera.identity,expires:now()+120_000};plans.set(token,plan);
  return {token,expires:plan.expires,files:files.map(({id,name,bytes})=>({id,name,bytes}))};
  }finally{busy=false;}
 }
 async function execute(token){
  if(busy)throw new Error('Another camera deletion is still running');
  const plan=plans.get(token);plans.delete(token);
  if(!plan||plan.expires<now())throw new Error('This confirmation expired. Select the files again.');
  busy=true;
  try{
   const state=await snapshot(true);
   if(!state.camera.connected||state.camera.identity!==plan.device)throw new Error('The camera or card changed. Select the files again.');
   for(const file of plan.files){
    const current=state.files.find(item=>item.id===file.id);
    if(!current?.onCamera||current.bytes!==file.bytes||current.fingerprint!==file.fingerprint||current.sha1!==file.sha1||current.assetId!==file.assetId)throw new Error('A selected file changed. Nothing was deleted.');
   }
   await verifyAll(plan.files);
   const result=await remove(plan);
   const removedIds=new Set(result.results.filter(file=>file.deleted===true).map(file=>file.id));
   return {...result,freedBytes:plan.files.filter(file=>removedIds.has(file.id)).reduce((sum,file)=>sum+file.bytes,0),selectedBytes:plan.files.reduce((sum,file)=>sum+file.bytes,0)};
  }finally{busy=false;}
 }
 return {prepare,execute};
}
