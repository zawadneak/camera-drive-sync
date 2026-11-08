const captureTime=file=>Date.parse(file.capturedAt)||0;
export const visibleFiles=(files,filter,query,view='all',showImported=true)=>files
 .filter(file=>(showImported||!file.imported)&&(view==='all'||(view==='camera'?file.onCamera:file.copied||file.imported))&&(filter==='all'||file.type===filter)&&file.name.toLowerCase().includes(query.trim().toLowerCase()))
 .sort((a,b)=>Number(Boolean(a.imported))-Number(Boolean(b.imported))||captureTime(b)-captureTime(a)||b.name.localeCompare(a.name,undefined,{numeric:true})||String(a.id).localeCompare(String(b.id)));
export const removableFiles=files=>files.filter(file=>file.onCamera&&file.imported);
export function selectRange(files,anchor,id){
 const start=files.findIndex(file=>file.id===anchor),end=files.findIndex(file=>file.id===id);
 return removableFiles(start<0||end<0?files.filter(file=>file.id===id):files.slice(Math.min(start,end),Math.max(start,end)+1)).map(file=>file.id);
}
