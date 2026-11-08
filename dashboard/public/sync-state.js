const stages={
 queued:['Queued','Waiting for the next import scan.','pending'],
 settling:['Waiting for file','Waiting for the file to finish being written.','pending'],
 'reading-camera':['Reading camera','Checking the camera original before copying.','active'],
 copying:['Copying to PC','Saving the camera original to your PC archive.','active'],
 'verifying-copy':['Verifying PC copy','Checking that the PC copy matches the camera original.','active'],
 copied:['Saved on PC','Queued for import into Immich.','pending'],
 checking:['Checking Immich','Checking the original and looking for an existing match.','active'],
 uploading:['Uploading','Sending the original to Immich.','active'],
 'adding-to-album':['Adding to album','The original is in Immich; finishing album membership.','active'],
 'needs-date':['Date review needed','Saved on PC. Confirm its recording date before import.','attention'],
 'in-trash':['In Immich trash','Restore the existing original in Immich to continue.','attention'],
 retry:['Retry scheduled','The last attempt failed. The importer will try again.','attention'],
 paused:['Waiting for importer','The previous import was interrupted. It will resume when the importer runs.','pending'],
 'waiting-server':['Waiting for Immich','Saved on PC. Import resumes when Immich is available.','pending'],
 imported:['Imported','Original saved in Immich and added to the camera album.','success'],
 duplicate:['Already in Immich','An existing matching original was added to the camera album.','success']
};
const transient=new Set(['settling','reading-camera','copying','verifying-copy','checking','uploading','adding-to-album']);
export function syncState(file,importer={}){
 let stage;
 if(file.imported)stage=file.outcome==='existing-duplicate'?'duplicate':'imported';
 else if(file.copied&&file.needsDateReview)stage='needs-date';
 else if(file.job&&transient.has(file.job.stage))stage=file.job.active?file.job.stage:'paused';
 else if(file.job&&['in-trash','retry'].includes(file.job.stage))stage=file.job.stage;
 else if(file.copied&&importer?.state==='Waiting for Immich')stage='waiting-server';
 else stage=file.copied?'copied':'queued';
 const [label,detail,kind]=stages[stage];
 return {stage,label,detail,kind,updatedAt:file.job?.updatedAt??null};
}
