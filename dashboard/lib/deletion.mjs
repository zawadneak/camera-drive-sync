import {randomBytes} from 'node:crypto';
import {validateSelection} from './security.mjs';
export function createDeletionService({snapshot,verify,remove,now=Date.now}){
 const plans=new Map();let busy=false;
 async function prepare(ids){
  validateSelection(ids);
  const state=await snapshot(true);
  if(!state.camera.connected)throw new Error('Connect the camera before deleting files');
  const files=ids.map(id=>state.files.find(file=>file.id===id));
  if(files.some(file=>!file?.onCamera||!file.imported||!file.sha1||!file.assetId))throw new Error('Every selected file must be imported and still on this camera');
  for(const file of files)await verify(file);
  const token=randomBytes(32).toString('hex');
  for(const [key,plan] of plans)if(plan.expires<now())plans.delete(key);
  if(plans.size>=20)plans.delete(plans.keys().next().value);
  const plan={files,device:state.camera.identity,expires:now()+120_000};plans.set(token,plan);
  return {token,expires:plan.expires,files:files.map(({id,name,bytes})=>({id,name,bytes}))};
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
    await verify(current);
   }
   return await remove(plan);
  }finally{busy=false;}
 }
 return {prepare,execute};
}
