import {visibleFiles,removableFiles,selectRange} from './gallery.js';
import {importProgress} from './import-progress.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,csrf='',filter='all',view='camera',selection=new Set(),signature='',modalBusy=false,plan=null,returnFocus=null,preparation=0,anchor=null;
const bytes=n=>n>=1e9?(n/1e9).toFixed(1)+' GB':n>=1e6?(n/1e6).toFixed(1)+' MB':Math.round(n/1e3)+' KB';
const date=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'Date unavailable':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});};
const time=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'':d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});};
let toastTimer;
let page=0,refreshing=false;
const pageSize=12;
const previewUrl=(file,size='grid')=>`/api/files/${file.id}/thumbnail?size=${size}&v=${encodeURIComponent(file.previewVersion||'')}`;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
async function api(url,body){
 const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');return result;
}
function selectedFiles(){return state?.files.filter(file=>selection.has(file.id))??[];}
function shownFiles(){return visibleFiles(state?.files??[],filter,$('search').value,view,$('show-imported').checked);}
function pageFiles(){return shownFiles().slice(page*pageSize,(page+1)*pageSize);}
const syncMarkup=file=>`<span class="sync-badge ${esc(file.sync.kind)}">${file.sync.kind==='success'?'✓':file.sync.kind==='attention'?'!':file.sync.kind==='active'?'↻':'◷'} ${esc(file.sync.label)}</span><p>${esc(file.sync.detail)}</p>${file.sync.stage==='needs-date'?`<button class="review-date-link" data-review-date="${file.id}" aria-label="Review date for ${esc(file.name)}">Review date</button>`:''}`;
const previewMessage=file=>file.imported?'Preview unavailable':file.sync.kind==='attention'?file.sync.label:'Preview after import';
function updateFileStatuses(rows){
 const cards=new Map([...$('gallery').querySelectorAll('.photo-card')].map(card=>[card.dataset.id,card]));
 for(const file of rows){
  const card=cards.get(file.id);if(!card)continue;
  const status=card.querySelector('.file-sync');
  if(status.dataset.stage!==file.sync.stage){status.innerHTML=syncMarkup(file);status.dataset.stage=file.sync.stage;card.querySelector('.photo-image').dataset.previewMessage=previewMessage(file);}
  const image=card.querySelector('img');
  if(image?.dataset.retryAt&&Date.now()>=Number(image.dataset.retryAt)){delete image.dataset.retryAt;const url=new URL(image.src);url.searchParams.set('retry',Date.now());image.src=url.href;}
 }
}
function selectFiles(files){
 const ids=removableFiles(files).map(file=>file.id),next=new Set([...selection,...ids]);
 if(next.size>state.selectionLimit){toast(`Select up to ${state.selectionLimit.toLocaleString()} files per batch. Use the search or file filters to narrow your selection.`);return;}
 selection=next;updateSelection();
}
function updateSelection(){
 const count=selection.size,total=selectedFiles().reduce((sum,file)=>sum+file.bytes,0),all=removableFiles(state?.files??[]),shown=removableFiles(pageFiles());
 $('selected-label').textContent=count?`${count} file${count===1?'':'s'} selected`:'No files selected';
 $('review-delete').disabled=!count||!state?.camera.connected;
 $('review-delete').textContent=count?`Delete ${count} from camera…`:'Review camera deletion';
 $('delete-summary').textContent=count?`${count} selected · ${bytes(total)} to free`:'Make space, when you’re ready.';
 const visibleIds=new Set(pageFiles().map(file=>file.id)),hidden=selectedFiles().filter(file=>!visibleIds.has(file.id)).length;
 $('delete-hint').textContent=count?(hidden?`${hidden} selected outside this filter. PC and Immich copies stay.`:'PC and Immich copies stay. Review before removal.'):'Select imported camera files individually or all at once.';
 document.querySelector('.delete-bar').classList.toggle('has-selection',count>0);
 document.querySelectorAll('.photo-card').forEach(card=>{const checked=selection.has(card.dataset.id);card.classList.toggle('selected',checked);card.querySelector('.file-check').checked=checked;});
 $('select-imported').textContent=`Select all imported${all.length?` (${all.length})`:''}`;
 $('select-imported').disabled=!all.length||all.every(file=>selection.has(file.id));
 $('select-shown').textContent=`Select shown${shown.length?` (${shown.length})`:''}`;
 $('select-shown').disabled=!shown.length||shown.every(file=>selection.has(file.id));
 $('clear-selection').disabled=!count;
}
function renderFiles(){
 if(!state)return;
 const query=$('search').value.trim().toLowerCase();
 const allRows=shownFiles();page=Math.max(0,Math.min(page,Math.ceil(allRows.length/pageSize)-1));
 const rows=allRows.slice(page*pageSize,(page+1)*pageSize);
 $('page-label').textContent=allRows.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,allRows.length)} of ${allRows.length}`:'No files';
 $('page-prev').disabled=page===0;$('page-next').disabled=(page+1)*pageSize>=allRows.length;
 $('file-total').textContent=view==='camera'&&!state.camera.connected?'—':allRows.length;
 const next=JSON.stringify([rows.map(({sync,...file})=>file),filter,query,view,state.camera.connected]);
 if(next===signature){updateFileStatuses(rows);updateSelection();return;}
 signature=next;
 $('gallery').innerHTML=rows.length?rows.map(file=>`<article class="photo-card${selection.has(file.id)?' selected':''}" data-id="${file.id}">
  <div class="photo-image${file.hasPreview?'':' preview-error'}" data-preview-message="${esc(previewMessage(file))}">
   <input class="file-check" type="checkbox" aria-label="Select ${esc(file.name)}" ${file.onCamera&&file.imported?'':'disabled'} ${selection.has(file.id)?'checked':''}>
   ${file.hasPreview?`<img src="${previewUrl(file)}" alt="Preview of ${esc(file.name)}" loading="lazy" decoding="async">`:''}
   <span class="file-type">${file.type==='video'?'VIDEO':esc(file.name.split('.').pop().toUpperCase())}</span>${file.type==='video'?'<span class="video-symbol" aria-label="Video">▶</span>':''}
  </div>
  <div class="file-info"><div class="file-info-top"><span class="file-name" title="${esc(file.name)}">${esc(file.name)}</span></div><div class="file-meta"><span>${esc(date(file.capturedAt))}</span><span>${bytes(file.bytes)}</span></div><div class="file-sync" data-stage="${esc(file.sync.stage)}">${syncMarkup(file)}</div>${view==='archive'?`<div class="archive-note">${file.onCamera?'Also on the connected camera':state.camera.connected?'PC copy · no longer on camera':'PC copy · camera disconnected'}</div>`:''}</div>
 </article>`).join(''):`<div class="empty"><h3>${view==='camera'&&!state.camera.connected?'Camera disconnected':'No files in this view'}</h3><p>${view==='camera'&&!state.camera.connected?'Connect your camera to check its card, or choose PC archive to browse saved copies.':'Try another filter or file location. Removed camera copies are kept in PC archive.'}</p></div>`;
 if(!rows.length&&!$('show-imported').checked&&(view!=='camera'||state.camera.connected)&&visibleFiles(state.files,filter,$('search').value,view,true).length){
  $('gallery').innerHTML='<div class="empty"><h3>Imported files are hidden</h3><p>Everything matching this view is already imported. Turn on Show imported to browse or select those files.</p></div>';
 }
 $('gallery').querySelectorAll('img').forEach(img=>{img.addEventListener('error',()=>{img.parentElement.classList.add('preview-error');const retries=Number(img.dataset.retries||0);if(retries<2){img.dataset.retries=retries+1;img.dataset.retryAt=Date.now()+15_000;}});img.addEventListener('load',()=>{img.parentElement.classList.remove('preview-error');delete img.dataset.retryAt;});});
 $('gallery').querySelectorAll('.file-check').forEach(input=>input.addEventListener('click',event=>{
  const id=input.closest('.photo-card').dataset.id,ids=event.shiftKey&&anchor?selectRange(shownFiles(),anchor,id):[id];
  if(input.checked)selectFiles(state.files.filter(file=>ids.includes(file.id)));else ids.forEach(value=>selection.delete(value));
  anchor=id;updateSelection();
 }));
 updateSelection();
}
function render(){
 const overall=importProgress(state.files,state.camera,state.importer);
 $('import-percent').textContent=overall.total?`${overall.percent}%`:'No files';$('import-progress').value=overall.percent;
 $('import-counts').textContent=`${overall.done} of ${overall.total} files imported · ${overall.pending} remaining${overall.attention?` · ${overall.attention} need attention`:''}`;
 $('import-bytes').textContent=`${overall.copied} files verified on PC · ${bytes(overall.copiedBytes)} of ${bytes(overall.totalBytes)} copied · ${overall.scope}`;
 const stageLabels={'reading-camera':'Reading camera',copying:'Copying to PC','verifying-copy':'Verifying copy',checking:'Checking Immich',uploading:'Uploading','adding-to-album':'Adding to album'};
 $('import-current').textContent=overall.current?`${stageLabels[overall.stage]||overall.stage}: ${overall.current}`:overall.pending?(state.importer?.state||'Waiting for the next import step'):'Everything is imported. Watching for new files.';
 const onCamera=state.files.filter(file=>file.onCamera),imported=state.files.filter(file=>file.imported);
 $('camera-count').textContent=state.camera.connected?onCamera.length:'—';$('nav-count').textContent=state.camera.connected?onCamera.length:'—';
 const storage=state.camera.connected?state.camera.storage:null;
 $('storage-percent').textContent=storage?`${storage.usedPercent}%`:'—';
 $('storage-meter').hidden=!storage;
 if(storage){$('storage-meter').value=storage.usedPercent;$('storage-meter').setAttribute('aria-valuetext',`${storage.usedPercent}% used, ${bytes(storage.freeBytes)} free`);}
 $('storage-detail').textContent=storage?`${bytes(storage.usedBytes)} of ${bytes(storage.totalBytes)} used`:state.camera.connected?'Card capacity unavailable':'Connect camera to check the card';
 $('storage-free').textContent=storage?`${bytes(storage.freeBytes)} free on the whole card`:'';
 $('imported-count').textContent=imported.length;$('pending-count').textContent=state.camera.connected?onCamera.filter(file=>!file.imported).length:'—';
 const attention=state.files.filter(file=>!file.imported&&file.sync.kind==='attention').length;
 const dateHolds=state.files.filter(file=>file.sync.stage==='needs-date');
 $('date-review-banner').hidden=!dateHolds.length;
 $('date-review-count').textContent=`${dateHolds.length} photo${dateHolds.length===1?' needs':'s need'} date review`;
 $('review-dates').textContent=`Review all ${dateHolds.length} dates`;
 $('pending-note').textContent=attention?`${attention} file${attention===1?' needs':'s need'} attention · see status on each card`:!state.camera.connected?'Check PC archive for pending imports':state.importer?.errors?'Some files need attention':onCamera.some(file=>!file.imported)?'Kept on camera until imported':'Everything is up to date';
 $('gallery-title').textContent=view==='camera'?'Camera files':'PC archive';
 $('gallery-hint').textContent=view==='archive'?'Saved PC copies stay here after camera removal. Each card shows its Immich sync status.':state.camera.connected?'Only files currently on the card. Each card shows its sync status.':'Connect your camera to check its card. Saved copies are in PC archive.';
 $('imported-note').textContent=state.album.name+' album';
 $('camera-name').textContent=state.camera.name;$('camera-detail').textContent=state.camera.connected?'USB storage · ready to import':'Connect via USB and turn the camera on';
 $('connection-badge').textContent=state.camera.connected?'● Connected':'Disconnected';$('connection-badge').classList.toggle('neutral',!state.camera.connected);
 $('device-dot').classList.toggle('offline',!state.camera.connected);$('connection-note').textContent=state.camera.connected?'Automatic importing is on':'Your imported files remain available';
 $('last-checked').textContent='Updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
 $('immich-link').href=state.album.url;
 const events=[...state.activity].reverse().filter(event=>event.file).slice(0,5);
 const labels={'uploaded':'Imported','copied-from-camera':'Copied','existing-duplicate':'Already in library','retry-later':'Retrying','camera-clock-needs-review':'Date needs review'};
 $('activity-list').innerHTML=events.length?events.map(event=>`<div class="activity-item${event.level==='error'?' error':''}"><span class="activity-dot"></span><div><div class="activity-title">${esc(labels[event.event]??event.event)} <strong>${esc(event.file)}</strong></div><div class="activity-time">${esc(time(event.time))}</div></div></div>`).join(''):'<p class="muted">New imports will appear here.</p>';
 const eligible=new Set(state.files.filter(file=>file.onCamera&&file.imported).map(file=>file.id));selection=new Set([...selection].filter(id=>eligible.has(id)));
 renderFiles();
}
async function refresh(force=false){
 if(refreshing)return;refreshing=true;
 try{state=await api('/api/state'+(force?'?refresh=1':''));csrf=state.csrfToken;$('error-banner').hidden=true;render();}
 catch(error){$('error-banner').textContent=error.message;$('error-banner').hidden=false;}
 finally{refreshing=false;}
}
function closeModal(){if(modalBusy)return;preparation++;$('modal').hidden=true;plan=null;returnFocus?.focus();}
function showModal(html){returnFocus=document.activeElement;$('modal-content').innerHTML=html;$('modal').hidden=false;$('modal-close').disabled=modalBusy;}
function reviewDates(files){
 const chosen=[...files].sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));if(!chosen.length)return;
 modalBusy=false;
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const stamp=value=>new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'medium'});
 let viewing=chosen[0].id;
 showModal(`<div class="modal-icon">◷</div><h2 id="modal-title">Review ${chosen.length===1?'recording date':`${chosen.length} recording dates`}</h2><p>These originals are saved on your PC. Confirm when ${chosen.length===1?'this photo':`the first photo, ${esc(chosen[0].name)},`} was taken, then resume importing.</p>
  <figure class="date-photo"><div id="review-preview" class="review-preview"><img id="review-photo" alt=""><span id="review-photo-error" hidden>Photo preview unavailable.</span></div><figcaption><strong id="review-photo-name"></strong><a id="review-photo-open" target="_blank" rel="noreferrer">Open photo larger ↗</a></figcaption></figure>
  <label class="confirmation-label" for="capture-date">Actual date and time for ${esc(chosen[0].name)} · ${esc(zone)}</label><input id="capture-date" class="confirmation-input" type="datetime-local" step="1" required>
  ${chosen.length>1?'<label class="gap-option"><input id="preserve-gaps" type="checkbox" checked> Keep the original time gaps between these photos</label>':''}
  <div class="date-plan" id="date-plan"></div><p class="muted">Only these exact saved originals get the confirmed dates. Camera files and embedded metadata stay unchanged.</p><p id="date-error" class="date-error" hidden></p>
  <div class="modal-actions"><button id="cancel-date" class="button ghost">Cancel</button><button id="apply-dates" class="button primary" disabled>Save dates & import</button></div>`);
 const showPhoto=id=>{
  const file=chosen.find(file=>file.id===id);if(!file)return;
  viewing=id;const image=$('review-photo'),url=previewUrl(file,'detail');
  $('review-photo-name').textContent='Viewing '+file.name;
  $('review-photo-open').hidden=!file.hasPreview;$('review-photo-open').href=url;
  if(image.dataset.id!==id){image.dataset.id=id;image.alt='Full photo '+file.name;image.hidden=!file.hasPreview;$('review-photo-error').hidden=!!file.hasPreview;if(file.hasPreview)image.src=url;else image.removeAttribute('src');}
  $('date-plan').querySelectorAll('[data-review-photo]').forEach(button=>{const active=button.dataset.reviewPhoto===id;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
 };
 $('review-photo').addEventListener('error',()=>{$('review-photo').hidden=true;$('review-photo-error').hidden=false;});
 $('review-photo').addEventListener('load',()=>{$('review-photo').hidden=false;$('review-photo-error').hidden=true;});
 $('date-plan').addEventListener('click',event=>{const button=event.target.closest('[data-review-photo]');if(button)showPhoto(button.dataset.reviewPhoto);});
 $('date-plan').innerHTML=chosen.map(file=>`<div class="date-plan-row"><button class="date-photo-picker" data-review-photo="${file.id}" aria-label="View ${esc(file.name)}">${file.hasPreview?`<img src="/api/files/${file.id}/thumbnail" alt="" loading="lazy">`:'Photo'}</button><div><strong>${esc(file.name)}</strong><span>Camera: ${esc(stamp(file.capturedAt))}</span><span data-date-proposed="${file.id}"></span></div></div>`).join('');
 const updatePreview=()=>{
  const target=new Date($('capture-date').value).valueOf(),valid=Number.isFinite(target),preserve=chosen.length===1||$('preserve-gaps').checked,first=Date.parse(chosen[0].capturedAt);
  $('apply-dates').disabled=!valid;
  for(const file of chosen)$('date-plan').querySelector(`[data-date-proposed="${file.id}"]`).textContent=valid?`New: ${stamp(target+(preserve?Date.parse(file.capturedAt)-first:0))}`:'Choose the actual recording time above.';
 };
 $('capture-date').addEventListener('input',updatePreview);$('preserve-gaps')?.addEventListener('change',updatePreview);updatePreview();showPhoto(viewing);
 $('cancel-date').addEventListener('click',closeModal);
 $('apply-dates').addEventListener('click',async()=>{
  const takenAt=new Date($('capture-date').value);if(!Number.isFinite(takenAt.valueOf()))return;
  modalBusy=true;$('apply-dates').disabled=true;$('cancel-date').disabled=true;$('modal-close').disabled=true;$('apply-dates').textContent='Verifying & saving…';$('date-error').hidden=true;
  try{
   const result=await api('/api/dates/apply',{ids:chosen.map(file=>file.id),takenAt:takenAt.toISOString(),preserveGaps:chosen.length===1||$('preserve-gaps').checked});
   modalBusy=false;closeModal();await refresh(true);toast(`${result.updated} recording date${result.updated===1?'':'s'} saved. ${result.importRequested?'Import scan requested.':'Use Sync now to resume importing.'}`);
  }catch(error){modalBusy=false;$('apply-dates').disabled=false;$('cancel-date').disabled=false;$('modal-close').disabled=false;$('apply-dates').textContent='Save dates & import';$('date-error').textContent=error.message;$('date-error').hidden=false;}
 });
 $('capture-date').focus();
}
async function reviewDeletion(){
 const chosen=selectedFiles();if(!chosen.length)return;
 const attempt=++preparation;modalBusy=false;
 showModal('<span class="spinner"></span><h2 id="modal-title">Checking your originals</h2><p>Verifying the local archive and downloading the matching originals from Immich. Larger videos may take a little longer.</p><p>Nothing is being deleted.</p>');
 try{
  const prepared=await api('/api/delete/prepare',{ids:chosen.map(file=>file.id)});
  if(attempt!==preparation||$('modal').hidden)return;
  plan=prepared;modalBusy=false;
  $('modal-content').innerHTML=`<div class="modal-icon">♧</div><h2 id="modal-title">Make room on your camera?</h2><p>This permanently removes <strong>${plan.files.length} selected file${plan.files.length===1?'':'s'}</strong> from the connected camera. Your PC archive and Immich originals stay in place.</p>
   <div class="verified-box">✓ Local archive matches each original<br>✓ Immich originals downloaded and verified<br><strong>${bytes(plan.files.reduce((sum,file)=>sum+file.bytes,0))} to free on the camera</strong></div>
   <div class="delete-files">${plan.files.map(file=>`<div class="delete-file"><span>${esc(file.name)}</span><span>${bytes(file.bytes)}</span></div>`).join('')}</div>
   <p class="modal-warning">The PC archive and Immich library are on the same drive. A separate backup protects against that drive failing.</p>
   <label class="confirmation-label" for="confirm-input">Type DELETE to confirm camera-only removal</label><input class="confirmation-input" id="confirm-input" placeholder="DELETE" autocomplete="off" spellcheck="false">
   <div class="modal-actions"><button id="cancel-delete" class="button ghost">Keep on camera</button><button id="confirm-delete" class="button danger" disabled>Delete ${plan.files.length} from camera</button></div>`;
  $('modal-close').disabled=false;$('confirm-input').addEventListener('input',()=>$('confirm-delete').disabled=$('confirm-input').value!=='DELETE');
  $('cancel-delete').addEventListener('click',closeModal);$('confirm-delete').addEventListener('click',executeDeletion);$('confirm-input').focus();
 }catch(error){if(attempt!==preparation||$('modal').hidden)return;modalBusy=false;$('modal-close').disabled=false;$('modal-content').innerHTML=`<div class="modal-icon">!</div><h2 id="modal-title">Files kept on your camera</h2><p>${esc(error.message)}</p><p>Camera removal is blocked until every selected original can be verified.</p><div class="modal-actions"><button id="close-error" class="button ghost">Got it</button></div>`;$('close-error').addEventListener('click',closeModal);$('close-error').focus();}
}
async function executeDeletion(){
 if(!plan||$('confirm-input').value!=='DELETE')return;
 modalBusy=true;$('confirm-delete').disabled=true;$('cancel-delete').disabled=true;$('modal-close').disabled=true;$('confirm-delete').textContent='Verifying & removing…';
 try{
  const result=await api('/api/delete/execute',{token:plan.token,confirmation:'DELETE'});
  const deleted=result.results.filter(file=>file.deleted).length,failures=result.results.filter(file=>!file.deleted);
  modalBusy=false;closeModal();selection.clear();signature='';await refresh(true);
  const message=failures.length?`${deleted} removed · ${bytes(result.freedBytes)} freed; ${failures.length} kept on camera. ${failures[0].error}`:`${deleted} file${deleted===1?'':'s'} removed · ${bytes(result.freedBytes)} freed on the camera. PC and Immich originals are kept.`;
  $('deletion-result').textContent=message;$('deletion-result').hidden=false;toast(message);
 }catch(error){modalBusy=false;closeModal();toast(error.message);await refresh(true);}
}
$('refresh').addEventListener('click',()=>refresh(true));
$('page-prev').addEventListener('click',()=>{page--;renderFiles();});
$('page-next').addEventListener('click',()=>{page++;renderFiles();});
$('search').addEventListener('input',renderFiles);
try{$('show-imported').checked=localStorage.getItem('camera-desk-show-imported')==='true';}catch{}
$('show-imported').addEventListener('change',()=>{page=0;anchor=null;try{localStorage.setItem('camera-desk-show-imported',String($('show-imported').checked));}catch{}renderFiles();});
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));renderFiles();}));
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;selection.clear();anchor=null;document.querySelectorAll('[data-view]').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button));});render();}));
document.querySelectorAll('[data-nav]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-nav]').forEach(item=>item.classList.toggle('active',item===button));$(button.dataset.nav).scrollIntoView({behavior:'smooth',block:'start'});}));
$('select-imported').addEventListener('click',()=>selectFiles(state.files));
$('select-shown').addEventListener('click',()=>selectFiles(pageFiles()));
$('clear-selection').addEventListener('click',()=>{selection.clear();anchor=null;updateSelection();});
$('review-delete').addEventListener('click',reviewDeletion);
$('review-dates').addEventListener('click',()=>reviewDates(state.files.filter(file=>file.sync.stage==='needs-date')));
$('gallery').addEventListener('click',event=>{const button=event.target.closest('[data-review-date]');if(button){const file=state.files.find(file=>file.id===button.dataset.reviewDate);if(file?.sync.stage==='needs-date')reviewDates([file]);}});
$('sync').addEventListener('click',async()=>{try{await api('/api/sync',{});toast('Import scan requested. New files will appear shortly.');await refresh(true);}catch(error){toast(error.message);}});
$('modal-close').addEventListener('click',closeModal);
$('modal').addEventListener('click',event=>{if(event.target===$('modal'))closeModal();});
document.addEventListener('keydown',event=>{
 if($('modal').hidden)return;
 if(event.key==='Escape'){closeModal();return;}
 if(event.key==='Tab'){
  const items=[...$('modal').querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')];if(!items.length)return;
  if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
 }
});
await refresh();setInterval(()=>{if($('modal').hidden&&!document.hidden)refresh();},5_000);
