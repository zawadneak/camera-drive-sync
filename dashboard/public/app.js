const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,csrf='',filter='all',selection=new Set(),signature='',modalBusy=false,plan=null,returnFocus=null,preparation=0;
const bytes=n=>n>=1e9?(n/1e9).toFixed(1)+' GB':n>=1e6?(n/1e6).toFixed(1)+' MB':Math.round(n/1e3)+' KB';
const date=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'Date unavailable':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});};
const time=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'':d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});};
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
async function api(url,body){
 const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');return result;
}
function selectedFiles(){return state?.files.filter(file=>selection.has(file.id))??[];}
function updateSelection(){
 const count=selection.size;
 $('selected-label').textContent=count?`${count} file${count===1?'':'s'} selected`:'No files selected';
 $('review-delete').disabled=!count||!state?.camera.connected;
 $('review-delete').textContent=count?`Review deletion (${count})`:'Review camera deletion';
 $('delete-summary').textContent=count?`${count} camera cop${count===1?'y':'ies'} selected.`:'Make space, when you’re ready.';
 document.querySelectorAll('.photo-card').forEach(card=>{const checked=selection.has(card.dataset.id);card.classList.toggle('selected',checked);card.querySelector('.file-check').checked=checked;});
 $('select-imported').textContent=count?'Clear selection':'Select imported on camera';
 $('select-imported').disabled=!state?.files.some(file=>file.onCamera&&file.imported);
}
function renderFiles(){
 if(!state)return;
 const query=$('search').value.trim().toLowerCase();
 const rows=state.files.filter(file=>(filter==='all'||file.type===filter)&&file.name.toLowerCase().includes(query));
 const next=JSON.stringify([rows,filter,query,state.camera.connected]);
 if(next===signature&&!$('gallery').querySelector('.preview-error')){updateSelection();return;}
 signature=next;
 $('gallery').innerHTML=rows.length?rows.map(file=>`<article class="photo-card${selection.has(file.id)?' selected':''}" data-id="${file.id}">
  <div class="photo-image${file.hasPreview?'':' preview-error'}">
   <input class="file-check" type="checkbox" aria-label="Select ${esc(file.name)}" ${file.onCamera&&file.imported?'':'disabled'} ${selection.has(file.id)?'checked':''}>
   ${file.hasPreview?`<img src="/api/files/${file.id}/thumbnail" alt="Preview of ${esc(file.name)}" loading="lazy">`:''}
   <span class="file-type">${file.type==='video'?'VIDEO':esc(file.name.split('.').pop().toUpperCase())}</span>${file.type==='video'?'<span class="video-symbol" aria-label="Video">▶</span>':''}
  </div>
  <div class="file-info"><div class="file-info-top"><span class="file-name" title="${esc(file.name)}">${esc(file.name)}</span><span class="imported-mark${file.imported?'':' pending'}">${file.imported?'✓ Imported':'◷ Waiting'}</span></div><div class="file-meta"><span>${esc(date(file.capturedAt))}</span><span>${bytes(file.bytes)}</span></div>${file.onCamera?'':`<div class="archive-note">${state.camera.connected?'In your archive · no longer on camera':'In your archive · camera disconnected'}</div>`}</div>
 </article>`).join(''):'<div class="empty"><h3>No files here yet</h3><p>Connect your camera, or choose another file filter.</p></div>';
 $('gallery').querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.parentElement.classList.add('preview-error'),{once:true}));
 $('gallery').querySelectorAll('.file-check').forEach(input=>input.addEventListener('change',()=>{const id=input.closest('.photo-card').dataset.id;if(input.checked)selection.add(id);else selection.delete(id);updateSelection();}));
 updateSelection();
}
function render(){
 const onCamera=state.files.filter(file=>file.onCamera),imported=state.files.filter(file=>file.imported);
 $('camera-count').textContent=state.camera.connected?onCamera.length:'—';$('nav-count').textContent=state.camera.connected?onCamera.length:'—';
 $('imported-count').textContent=imported.length;$('pending-count').textContent=state.camera.connected?onCamera.filter(file=>!file.imported).length:'—';
 $('pending-note').textContent=!state.camera.connected?'Connect camera to check for new files':state.importer?.errors?'Some files need attention':onCamera.some(file=>!file.imported)?'New files will import automatically':'Everything is up to date';
 $('gallery-title').textContent=state.camera.connected?'Camera files':'Imported files';
 $('gallery-hint').textContent=state.camera.connected?'Choose imported files to review for camera removal.':'Connect your camera to manage its card. Your imported files are here.';
 $('imported-note').textContent=state.album.name+' album';$('file-total').textContent=state.files.length;
 $('camera-name').textContent=state.camera.name;$('camera-detail').textContent=state.camera.connected?'USB storage · ready to import':'Connect via USB and turn the camera on';
 $('connection-badge').textContent=state.camera.connected?'● Connected':'Disconnected';$('connection-badge').classList.toggle('neutral',!state.camera.connected);
 $('device-dot').classList.toggle('offline',!state.camera.connected);$('connection-note').textContent=state.camera.connected?'Automatic importing is on':'Your imported files remain available';
 $('last-checked').textContent='Updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
 $('immich-link').href=state.album.url;
 const events=[...state.activity].reverse().filter(event=>event.file).slice(0,5);
 const labels={'uploaded':'Imported','copied-from-camera':'Copied','existing-duplicate':'Already in library','retry-later':'Retrying','camera-clock-needs-review':'Date needs review'};
 $('activity-list').innerHTML=events.length?events.map(event=>`<div class="activity-item${event.level==='error'?' error':''}"><span class="activity-dot"></span><div><div class="activity-title">${esc(labels[event.event]??event.event)} <strong>${esc(event.file)}</strong></div><div class="activity-time">${esc(time(event.time))}</div></div></div>`).join(''):'<p class="muted">New imports will appear here.</p>';
 selection=new Set([...selection].filter(id=>state.files.some(file=>file.id===id&&file.onCamera&&file.imported)));
 renderFiles();
}
async function refresh(force=false){
 try{state=await api('/api/state'+(force?'?refresh=1':''));csrf=state.csrfToken;$('error-banner').hidden=true;render();}
 catch(error){$('error-banner').textContent=error.message;$('error-banner').hidden=false;}
}
function closeModal(){if(modalBusy)return;preparation++;$('modal').hidden=true;plan=null;returnFocus?.focus();}
function showModal(html){returnFocus=document.activeElement;$('modal-content').innerHTML=html;$('modal').hidden=false;$('modal-close').disabled=modalBusy;}
async function reviewDeletion(){
 const chosen=selectedFiles();if(!chosen.length)return;
 const attempt=++preparation;modalBusy=false;
 showModal('<span class="spinner"></span><h2 id="modal-title">Checking your originals</h2><p>Verifying the local archive and downloading the matching originals from Immich. Larger videos may take a little longer.</p><p>Nothing is being deleted.</p>');
 try{
  const prepared=await api('/api/delete/prepare',{ids:chosen.map(file=>file.id)});
  if(attempt!==preparation||$('modal').hidden)return;
  plan=prepared;modalBusy=false;
  $('modal-content').innerHTML=`<div class="modal-icon">♧</div><h2 id="modal-title">Make room on your camera?</h2><p>This permanently removes <strong>${plan.files.length} selected file${plan.files.length===1?'':'s'}</strong> from the connected camera. Your PC archive and Immich originals stay in place.</p>
   <div class="verified-box">✓ Local archive matches each original<br>✓ Immich originals downloaded and verified</div>
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
  toast(failures.length?`${deleted} removed; ${failures.length} kept on camera. ${failures[0].error}`:`${deleted} file${deleted===1?'':'s'} removed from the camera. Your imported originals are kept.`);
 }catch(error){modalBusy=false;closeModal();toast(error.message);await refresh(true);}
}
$('refresh').addEventListener('click',()=>refresh(true));
$('search').addEventListener('input',renderFiles);
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));renderFiles();}));
document.querySelectorAll('[data-nav]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-nav]').forEach(item=>item.classList.toggle('active',item===button));$(button.dataset.nav).scrollIntoView({behavior:'smooth',block:'start'});}));
$('select-imported').addEventListener('click',()=>{if(selection.size)selection.clear();else state.files.filter(file=>file.onCamera&&file.imported).slice(0,100).forEach(file=>selection.add(file.id));updateSelection();});
$('review-delete').addEventListener('click',reviewDeletion);
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
await refresh();setInterval(()=>{if($('modal').hidden)refresh();},15_000);
