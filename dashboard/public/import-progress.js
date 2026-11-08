export function importProgress(files,camera,importer={}){
 const scope=files.filter(file=>camera.connected?file.onCamera||!file.imported:file.copied||!file.imported);
 const total=scope.length,done=scope.filter(file=>file.imported).length,copied=scope.filter(file=>file.copied).length;
 const totalBytes=scope.reduce((n,f)=>n+f.bytes,0),verifiedBytes=scope.filter(f=>f.copied).reduce((n,f)=>n+f.bytes,0);
 const attention=scope.filter(f=>!f.imported&&f.sync?.kind==='attention').length;
 const active=scope.find(f=>f.sync?.kind==='active');
 const inFlight=importer.stage==='copying'&&active?.sync.stage==='copying'?Math.min(active.bytes,Math.max(0,Number(importer.currentBytes)||0)):0;
 return {total,done,copied,pending:total-done,attention,totalBytes,copiedBytes:Math.min(totalBytes,verifiedBytes+inFlight),percent:total?Math.floor(100*done/total):0,current:importer.currentFile||active?.name||'',stage:importer.currentFile?importer.stage:active?.sync.stage||'idle',scope:camera.connected?'Connected camera and pending imports':'PC archive'};
}
