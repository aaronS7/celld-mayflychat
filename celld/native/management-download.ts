// USTAR has no ZIP32 entry-count/archive-size ceiling. Objects are verified by
// the caller before streaming; each object is bounded by the backup chunk size.
export type BackupEntry = {name: string; size: number; read: () => Promise<Uint8Array>};
function header(entry: BackupEntry) {
  const bytes=new Uint8Array(512), write=(at: number,value: string)=>bytes.set(new TextEncoder().encode(value),at);
  if (!/^[a-z0-9./-]+$/.test(entry.name) || entry.name.length>100 || entry.name.includes('..') || !Number.isSafeInteger(entry.size) || entry.size<0 || entry.size>=8**11) throw new Error('Invalid backup entry');
  write(0,entry.name);write(100,'0000600\0');write(108,'0000000\0');write(116,'0000000\0');write(124,entry.size.toString(8).padStart(11,'0')+'\0');write(136,'00000000000\0');write(148,'        ');write(156,'0');write(257,'ustar\0');write(263,'00');
  write(148,bytes.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');
  return bytes;
}
export async function* backupTar(entries: BackupEntry[],check: () => void) {
  for (const entry of entries) {
    check(); const bytes=await entry.read();
    if (bytes.length!==entry.size) throw new Error('Backup length changed');
    check(); yield header(entry); yield bytes;
    if (bytes.length%512) yield new Uint8Array(512-bytes.length%512);
  }
  yield new Uint8Array(1024);
}
