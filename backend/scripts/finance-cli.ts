import path from 'path';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';

export function args(argv=process.argv.slice(2)):Record<string,string>{const out:Record<string,string>={};for(let i=0;i<argv.length;i++){const item=argv[i];if(!item.startsWith('--'))continue;const key=item.slice(2);const value=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:'true';out[key]=value;}return out;}
export function required(values:Record<string,string>,key:string):string{if(!values[key])throw new Error(`缺少 --${key}`);return values[key];}
export function database(values:Record<string,string>){const dbPath=values.db??path.join(process.env.NEWFC_DATA_DIR??path.join(process.cwd(),'data'),'newfc.sqlite');const db=openDatabase(dbPath);applyMigrations(db);return db;}
