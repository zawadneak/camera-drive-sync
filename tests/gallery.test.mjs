import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleFiles,removableFiles,selectRange} from '../dashboard/public/gallery.js';
const files=[
 {id:'1',name:'DSC001.JPG',type:'photo',onCamera:true,imported:true},
 {id:'2',name:'DSC002.JPG',type:'photo',onCamera:true,imported:false},
 {id:'3',name:'C0001.MP4',type:'video',onCamera:true,imported:true},
 {id:'4',name:'DSC003.JPG',type:'photo',onCamera:false,imported:true}
];
test('select all includes imported camera files only',()=>assert.deepEqual(removableFiles(files).map(f=>f.id),['1','3']));
test('select shown respects type and case-insensitive filename search',()=>assert.deepEqual(removableFiles(visibleFiles(files,'photo',' dsc ')).map(f=>f.id),['1']));
test('shift ranges skip unimported and archived files in either direction',()=>{assert.deepEqual(selectRange(files,'4','1'),['1','3']);assert.deepEqual(selectRange(files,'1','4'),['1','3']);});
test('a filtered-out anchor selects only the clicked row',()=>assert.deepEqual(selectRange(visibleFiles(files,'video',''),'1','3'),['3']));
test('camera removal hides the camera card but retains the saved archive copy',()=>{const rows=structuredClone(files);rows[0].onCamera=false;assert.equal(visibleFiles(rows,'all','','camera').some(f=>f.id==='1'),false);assert.equal(visibleFiles(rows,'all','','archive').some(f=>f.id==='1'),true);});
test('pending copies remain visible in the archive before they are uploaded',()=>{const rows=[{id:'pending',name:'NEW.JPG',type:'photo',copied:true,imported:false,onCamera:false}];assert.equal(visibleFiles(rows,'all','','archive').length,1);assert.equal(visibleFiles(rows,'all','','camera').length,0);});
test('hiding imported keeps pending files and preserves the original inventory',()=>{
 const before=structuredClone(files);
 assert.deepEqual(visibleFiles(files,'all','','camera',false).map(f=>f.id),['2']);
 assert.deepEqual(files,before);
});
test('pending files precede imported files and both groups show newest first',()=>{
 const rows=[
  {id:'old',name:'OLD.JPG',capturedAt:'2026-11-01T12:00:00Z',imported:false},
  {id:'done-new',name:'DONE-NEW.JPG',capturedAt:'2026-11-08T12:00:00Z',imported:true},
  {id:'new',name:'NEW.JPG',capturedAt:'2026-11-07T12:00:00Z',imported:false},
  {id:'done-old',name:'DONE-OLD.JPG',capturedAt:'2026-11-02T12:00:00Z',imported:true}
 ];
 assert.deepEqual(visibleFiles(rows,'all','','all',true).map(f=>f.id),['new','old','done-new','done-old']);
 assert.deepEqual(visibleFiles(rows,'all','','all',false).map(f=>f.id),['new','old']);
});
