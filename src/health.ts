import {readFileSync} from 'node:fs';
import type {Request,Response} from 'express';

/** A build-time file, not a runtime environment value, identifies the serving bundle. */
export function readBuildCommit(read:()=>string=()=>readFileSync(new URL('./build-commit.txt',import.meta.url),'utf8')):string{
  try{const sha=read().trim();return /^[a-f0-9]{40}$/.test(sha)?sha:'unknown';}catch{return 'unknown';}
}

export function healthHandler(version:string){
  return (_req:Request,res:Response)=>res.json({status:'ok',version,commit:readBuildCommit()});
}
