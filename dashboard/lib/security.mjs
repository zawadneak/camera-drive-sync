import {randomBytes,timingSafeEqual} from 'node:crypto';
export function createCsrfToken(){return randomBytes(32).toString('hex');}
export function checkRequest(req,port,token){
 const host=req.headers.host;
 if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)throw Object.assign(new Error('Invalid dashboard host'),{status:403});
 const origin=`http://${host}`;
 if(req.headers.origin&&req.headers.origin!==origin)throw Object.assign(new Error('Cross-origin requests are not allowed'),{status:403});
 if(!['GET','HEAD'].includes(req.method)){
  if(req.headers.origin!==origin)throw Object.assign(new Error('A same-origin request is required'),{status:403});
  const supplied=req.headers['x-csrf-token'];
  if(typeof supplied!=='string'||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))throw Object.assign(new Error('Refresh the dashboard before trying again'),{status:403});
 }
}
export function validateSelection(ids){
 if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||new Set(ids).size!==ids.length)throw Object.assign(new Error('Select between 1 and 100 different files'),{status:400});
 return ids;
}
export async function readJson(req){
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>16_384)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Invalid JSON request'),{status:400});}
}
