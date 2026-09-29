import fs from 'fs';
import { args,database,required } from './finance-cli';
import { getSourceProfileByCode } from '../src/modules/finance-import/source-profile.service';
import { getMappingVersion } from '../src/modules/finance-import/mapping/mapping.service';
import { convertFinanceActuals } from '../src/modules/finance-import/conversion/convert.service';

async function main(){const a=args(),db=database(a),profile=getSourceProfileByCode(db,required(a,'profile')),mapping=getMappingVersion(db,Number(required(a,'mapping-version')));const result=await convertFinanceActuals(db,{balance:fs.readFileSync(required(a,'balance')),profit:fs.readFileSync(required(a,'profit')),journal:a.journal?fs.readFileSync(a.journal):undefined,year:Number(required(a,'year')),snapshotDate:required(a,'snapshot-date'),profile,mappingVersion:mapping});if(!result.report.passed||!result.output){console.error(JSON.stringify(result.report,null,2));process.exitCode=2;}else{fs.writeFileSync(required(a,'output'),result.output);console.log(JSON.stringify(result.report,null,2));}db.close();}
main().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
