import path from 'node:path';
import {realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const types=new Map([['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png']]);
export function canPreviewLocally(file){return !!(file?.copied&&file.archivePath&&types.has(path.extname(file.name??'').toLowerCase())&&/^[a-f0-9]{40}$/.test(file.sha1??''));}
export async function localPreview(inbox,file){
 if(!canPreviewLocally(file))throw new Error('This saved file has no browser-compatible photo preview');
 let base,archive;
 try{[base,archive]=await Promise.all([realpath(inbox),realpath(file.archivePath)]);}catch{throw new Error('The saved PC copy is unavailable');}
 const relative=path.relative(base,archive);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('The saved photo is outside the configured archive');
 let body;try{body=await readFile(archive);}catch{throw new Error('The saved PC copy could not be read');}
 if(body.length!==file.bytes||createHash('sha1').update(body).digest('hex')!==file.sha1)throw new Error('The saved photo changed and cannot be previewed');
 const type=types.get(path.extname(file.name).toLowerCase());
 const valid=type==='image/jpeg'?body[0]===0xff&&body[1]===0xd8&&body[2]===0xff:body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(!valid)throw new Error('The saved file does not contain a supported photo');
 return {body,type};
}
