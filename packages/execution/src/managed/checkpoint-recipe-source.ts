/**
 * Fixed Node program, executed only inside SRT. Input contains hashes/paths, never JavaScript.
 * The journal is fsynced before each destructive step. Originals remain reachable by inode.
 * Identities are compared with ones recorded by managedIdentity, so \`enc\` repeats the canonical
 * bigint encoding of core/file-identity.ts (decimal up to 2^53 - 1, otherwise 0x-hex).
 */
export const CHECKPOINT_OPERATION_SOURCE = String.raw`
async function checkpointOperation(input, authorized=async()=>{}) {
const fs=await import('node:fs/promises');
const {constants}=await import('node:fs');
const path=await import('node:path');
const {createHash}=await import('node:crypto');
const limit=/\.(docx|xlsx|pptx)$/i.test(input.target)?104857600:5242880;
const acceptable=current=>equal(current,input.after)||(input.after?.alternatives??[]).some(v=>equal(current,v));
const hash=b=>createHash('sha256').update(b).digest('hex');
const missing=e=>e&&e.code==='ENOENT';
const enc=x=>x<=BigInt(Number.MAX_SAFE_INTEGER)?x.toString():'0x'+x.toString(16);
const identity=async p=>{const s=await fs.lstat(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('boundary');return {device:enc(s.dev),inode:enc(s.ino)}};
const same=(a,b)=>a.device===b.device&&a.inode===b.inode;
const check=async()=>{await authorized();if(!same(await identity(input.root.path),input.root))throw Error('boundary');for(const p of input.parents)if(!same(await identity(p.path),p))throw Error('boundary');await authorized()};
const image=async p=>{
 let s;try{s=await fs.lstat(p,{bigint:true})}catch(e){if(missing(e))return null;throw e}
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(limit))throw Error('conflict');
 const f=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const a=await f.stat({bigint:true});if(a.dev!==s.dev||a.ino!==s.ino||a.nlink!==1n||a.size>BigInt(limit))throw Error('conflict');const buffer=Buffer.alloc(Number(a.size)+1);let used=0;while(used<buffer.length){const r=await f.read(buffer,used,buffer.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead}const bytes=buffer.subarray(0,used);const b=await f.stat({bigint:true});const n=await fs.lstat(p,{bigint:true});if(bytes.length>limit||b.dev!==a.dev||b.ino!==a.ino||b.size!==BigInt(bytes.length)||b.mtimeNs!==a.mtimeNs||b.ctimeNs!==a.ctimeNs||n.dev!==a.dev||n.ino!==a.ino||n.nlink!==1n)throw Error('conflict');return {hash:hash(bytes),mode:Number(b.mode&511n),device:enc(b.dev),inode:enc(b.ino)}}finally{await f.close()}
};
const equal=(a,b)=>a===null?b===null:b!==null&&a.hash===b.hash&&a.mode===b.mode;
const journal=async value=>{const f=await fs.open(input.journal,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync()}finally{await f.close()}};
let destructive=false;
try{
 await check();
 const original=path.join(input.recovery,'original');const stage=path.join(input.recovery,'stage');
 let state='intent',records=[];
 try{const info=await fs.lstat(input.journal);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>32768)throw Error('interrupted');records=(await fs.readFile(input.journal,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);state=records.at(-1)?.phase??'intent'}catch(e){if(!missing(e))throw e}
 // Reconciliation never replays a move that may already have happened. It only reports evidence.
 if(input.reconcile){const current=await image(input.target);const retained=await image(original);const moving=records.find(v=>v.phase==='moving');const proven=equal(current,input.before)&&((!moving&&records.some(v=>v.phase==='restored'))||(moving&&(input.after===null?retained===null:retained!==null&&moving.original&&same(retained,moving.original))));return {state:proven?'restored':'interrupted',retained:retained!==null}}
 else{
  if(input.resume&&state!=='intent'){
   const moving=records.find(v=>v.phase==='moving'),retained=await image(original),current=await image(input.target);
   if(retained!==null)destructive=true;
   if(!retained&&current&&moving?.original&&same(current,moving.original)&&acceptable(current)){state='intent'}
   else {
   if(!moving||!moving.original||!retained||!same(retained,moving.original)||!acceptable(retained))throw Error('conflict');
   if(equal(current,input.before)){await journal({phase:'restored'});return {state:'restored',retained:true}}
   if(current!==null)throw Error('conflict');
   if(input.before&&!equal(await image(stage),input.before))throw Error('conflict');
   await check();await journal({phase:'resuming'});
   if(input.before){await fs.link(stage,input.target);await fs.unlink(stage)}
   await check();if(!equal(await image(input.target),input.before))throw Error('conflict');
   await journal({phase:'restored'});return {state:'restored',retained:true}
   }
  }
  if(state!=='intent')throw Error('interrupted');
  const current=await image(input.target);if(equal(current,input.before)){await journal({phase:'restored'});return {state:'restored',retained:false}}if(!acceptable(current))throw Error('conflict');
  if(input.before){const existing=await image(stage);if(existing&&(!input.resume||!equal(existing,input.before)))throw Error('conflict');if(!existing){const b=await fs.open(input.blob,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let blob;try{const a=await b.stat();if(!a.isFile()||a.nlink!==1||a.size>limit)throw Error('conflict');const buffer=Buffer.alloc(Number(a.size)+1);let used=0;while(used<buffer.length){const r=await b.read(buffer,used,buffer.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead}blob=buffer.subarray(0,used)}finally{await b.close()}if(blob.length>limit||hash(blob)!==input.before.hash)throw Error('conflict');const f=await fs.open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,input.before.mode);try{await f.writeFile(blob);await f.chmod(input.before.mode);await f.sync()}finally{await f.close()}}}
  await check();if(!equal(await image(input.target),current))throw Error('conflict');
  if(await image(original)!==null)throw Error('conflict');
  await journal({phase:'moving',original:current});
  if(current){await fs.rename(input.target,original);destructive=true;const moved=await image(original);if(!equal(moved,current)||!same(moved,current))throw Error('conflict')}
  await check();await journal({phase:'moved'});
  if(input.before){await fs.link(stage,input.target);await fs.unlink(stage)}
  await check();if(!equal(await image(input.target),input.before))throw Error('conflict');
  await journal({phase:'restored'});return {state:'restored',retained:current!==null};
 }
}catch(e){const reason=e&&e.message==='conflict'&&!destructive?'conflict':'interrupted';if(!input.reconcile){try{await journal({phase:reason})}catch{}}return {state:reason,reason:(e?.code==='EBUSY'||(input.platform==='win32'&&['EPERM','EACCES'].includes(e?.code)))?'file_in_use':e&&e.message==='conflict'?'file_changed':e&&e.message==='boundary'?'unsafe_path':'recovery_interrupted'}}
}
`;

export const CHECKPOINT_RECIPE_SOURCE = `${CHECKPOINT_OPERATION_SOURCE}
const input=JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));
process.stdout.write(JSON.stringify(await checkpointOperation(input))+'\\n');
`;
