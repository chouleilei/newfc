import { describe, expect, it } from 'vitest';
import { compileIssuanceSourceAttachments, type IssuanceSourceDocument } from '../src/modules/plan-execution/issuance-source-attachments';

describe('AC-T14-05 正式公文附表受控编译', () => {
  const manifest = [{unit_code:'UNIT_A',doc_filename:'notice.doc',attachment_no:'1',attachment_title:'合成年度附表',target_sheet_code:'five_expenses',unit_of_measure:'万元',column_schema:'序号|项目|预算金额',leaf_row_count:'1',reported_total_yuan:'1060000.00',recomputed_leaf_sum_yuan:'1060000.00'}];
  const doc: IssuanceSourceDocument = {status:'ok',channel:'doc_converted',text:'',findings:[],stats:{},sha256:'a'.repeat(64),paragraphs:[
    ...['序号','项目','预算金额'].map((text,i)=>({index:i+1,page:1,heading:'',table:1,row:1,cell:i+1,text})),
    ...['1','合成费用','106.00'].map((text,i)=>({index:i+4,page:1,heading:'',table:1,row:2,cell:i+1,text})),
  ]};
  it('保留源值、原文摘要和完整明细，万元不会二次换算', () => {
    const out=compileIssuanceSourceAttachments(manifest,{'notice.doc':doc});
    expect(out.unitAttachments.UNIT_A[0]).toMatchObject({issuedTotalAmount:'1060000.00',rows:[{itemName:'合成费用',amountOrValue:'106.00',unit:'万元'}]});
    expect(out.sourceDocuments[0]).toMatchObject({sha256:doc.sha256,tableCount:1});
    expect(out.unitMetrics.UNIT_A).toMatchObject({fiveExpensesExact:'1060000.00',fiveExpensesIssued:'1060000.00'});
    expect(Object.keys(compileIssuanceSourceAttachments(manifest,{'notice.doc':doc},{UNIT_A:12}).unitAttachments)).toEqual(['12']);
    expect(()=>compileIssuanceSourceAttachments(manifest,{'notice.doc':doc},{})).toThrow(/显式映射/);
  });
  it('缺原件、逻辑表数不符或附表编号不连续时拒绝，不补空表', () => {
    expect(()=>compileIssuanceSourceAttachments(manifest,{})).toThrow(/缺失/);
    expect(()=>compileIssuanceSourceAttachments([{...manifest[0],attachment_no:'2'}],{'notice.doc':doc})).toThrow(/表数或附表编号/);
    expect(()=>compileIssuanceSourceAttachments(manifest,{'notice.doc':{...doc,paragraphs:[]}})).toThrow(/表数或附表编号/);
  });
});
