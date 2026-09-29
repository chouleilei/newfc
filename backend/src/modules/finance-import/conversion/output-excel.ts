import ExcelJS from 'exceljs';
import { centsToYuanString } from '../../../core/money';
import type { ConvertedRow } from '../finance.types';

export async function buildActualImportExcel(rows:ConvertedRow[],meta:{conversionBatchId?:number;mappingVersionId:number;balanceSha256:string;profitSha256:string}):Promise<Buffer>{
  const wb=new ExcelJS.Workbook();wb.creator='预算系统财务实际数转换';wb.created=new Date();const sheet=wb.addWorksheet('实际数导入');
  sheet.addRow(['年度','截止日期','组织编码','科目编码','累计金额(元)','累计数量','备注']);sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];
  for(const r of rows)sheet.addRow([r.year,r.snapshotDate,r.orgCode,r.accountCode,centsToYuanString(r.displayCents),'',`财务转换${meta.conversionBatchId?` #${meta.conversionBatchId}`:''}`]);
  sheet.columns=[12,16,18,18,18,14,28].map(width=>({width}));
  const trace=wb.addWorksheet('转换追溯');trace.addRows([['映射版本ID',meta.mappingVersionId],['余额表SHA-256',meta.balanceSha256],['利润表SHA-256',meta.profitSha256],['转换批次ID',meta.conversionBatchId??'待创建']]);trace.state='veryHidden';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
