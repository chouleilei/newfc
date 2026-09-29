import fs from 'fs';
import path from 'path';
import { args,database,required } from './finance-cli';
import { createParallelTrial,parallelTrialReport } from '../src/modules/finance-import/conversion/parallel-trial.service';

async function main(){const a=args(),db=database(a);try{const manualPath=required(a,'manual'),trial=await createParallelTrial(db,{conversionId:Number(required(a,'conversion')),manualName:path.basename(manualPath),manual:fs.readFileSync(manualPath),actor:a.actor??'cli'});if(a.output)fs.writeFileSync(a.output,await parallelTrialReport(db,trial.id));console.log(JSON.stringify({trialId:trial.id,status:trial.status,comparison:trial.comparison,report:a.output??null},null,2));if(trial.comparison.mismatchCount>0)process.exitCode=2;}finally{db.close();}}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});
