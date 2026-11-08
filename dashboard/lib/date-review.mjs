import {validateSelection} from './security.mjs';
export function planDateReview(files,ids,takenAt,preserveGaps){
 validateSelection(ids);
 if(typeof takenAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(takenAt)||!Number.isFinite(Date.parse(takenAt)))throw new Error('Enter the actual recording date and time');
 if(typeof preserveGaps!=='boolean')throw new Error('Choose whether to preserve the time gaps');
 const chosen=ids.map(id=>files.find(file=>file.id===id));
 if(chosen.some(file=>!file?.copied||file.imported||!file.needsDateReview||!/^[a-f0-9]{40}$/.test(file.sha1??'')))throw new Error('Choose saved photos that still need date review');
 const times=chosen.map(file=>Date.parse(file.capturedAt));
 if(times.some(value=>!Number.isFinite(value)))throw new Error('An original timestamp could not be read');
 const first=Math.min(...times),target=Date.parse(takenAt);
 return chosen.map((file,i)=>({...file,takenAt:new Date(target+(preserveGaps?times[i]-first:0)).toISOString()}));
}
export function createDateReviewService({snapshot,verifyArchive,save,wake}){
 let busy=false;
 return {async apply({ids,takenAt,preserveGaps}){
  if(busy)throw new Error('Another date review is being saved');
  busy=true;
  try{
   const plan=planDateReview((await snapshot(true)).files,ids,takenAt,preserveGaps);
   for(const file of plan)await verifyArchive(file);
   await save(plan);
   // Date overrides are durable even if starting the importer fails.
   let importRequested=true;try{await wake();}catch{importRequested=false;}
   return {updated:plan.length,importRequested};
  }finally{busy=false;}
 }};
}
