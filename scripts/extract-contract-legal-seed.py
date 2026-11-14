#!/usr/bin/env python3
"""Offline extraction only. Convert the two controlled .doc sources to UTF-8 text
with LibreOffice in an isolated profile, then pass --text-dir. No runtime reads.
Output contains selected formal provisions and generic cleaned clauses only.
"""
import argparse, pathlib, re, json, zipfile, xml.etree.ElementTree as E
p=argparse.ArgumentParser();p.add_argument('--text-dir',required=True);p.add_argument('--output',default='deploy/contract-legal-seed-v1.json');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];private=root/'docs/private/contract-legal-review';td=pathlib.Path(a.text_dir)
def numbered(text,number):
 m=re.search(r'^'+re.escape(number)+r'\s*(.+?)(?=^\d+(?:\.\d+)*\s|\Z)',text,re.M|re.S)
 if not m:raise ValueError(number)
 return (number+' '+m[1]).strip()
contract=next(td.glob('*17号*txt')).read_text();procurement=next(td.glob('*20号*txt')).read_text();law=next((private/'04_补充资料/03_法律事务制度2025').glob('*摘录.md')).read_text()
def pol(code,title,no,date,clauses):
 return dict(code=code,version=1,title=title,docNo=no,effectiveFrom=date,sourceNote='从本地受控制度原件及2025制度汇编摘录离线核对提取；不含项目历史参数',clauses=clauses)
def cl(no,title,text,tags):return dict(clauseNo=no,chapterTitle=title,clauseText=text,ruleTags=tags)
cs=[]
for no,title,tags in [('4.2.2','文本审查',['elements']),('5.1','采购签订依据',['signing']),('5.2','非采购签订依据',['signing']),('5.3','销售签订依据',['signing']),('6.3','谈判与法审',['important']),('7.1','审签权限',['signing']),('7.2','合同编号',['number']),('7.3','重要合同',['important']),('8.1','履行前置',['effective']),('10.4','解除及善后',['termination'])]:
 if no=='7.1':text='\n'.join(numbered(contract,n) for n in ['7.1','7.1.1','7.1.2'])
 else:text=numbered(contract,no)
 cs.append(cl(no,title,text,tags))
start=contract.index('附件3\n《合同编号说明》');end=contract.index('附件4',start);cs.append(cl('附件3','合同编号说明',contract[start:end].strip(),['number']))
# Chapter 9 has detailed subclauses: preserve it as one frozen source excerpt.
m=re.search(r'^9\s+.*?(?=^10\s)',contract,re.M|re.S);cs.append(cl('9','合同变更索赔',m[0].strip(),['change']))
ps=[pol('L-QJ03-04-2026','澧水公司合同管理办法','湘澧制〔2026〕17号','2026-06-25',cs)]
pcs=[cl(n,'采购分级/审批/方式',numbered(procurement,n),['procurement']) for n in ['4.1.1','4.1.2','4.1.3','5.1.1','5.1.2','5.1.3','6.1.3','6.2.1','6.2.2','6.2.4','8.1.7']]
ps.append(pol('L-QJ02-04-2026','澧水公司采购管理办法','湘澧制〔2026〕20号','2026-06-30',pcs))
ps.append(pol('XLZ-2025-03','澧水公司法律事务工作管理办法','湘澧制〔2025〕3号','2025-04-06',[cl(n,'合同法律审查',numbered(law,n),['elements','important']) for n in ['4.1','4.2','4.3','8.3','11.2']]))
ts=[];ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
for file,code,category in [('01_设备物资采购合同_清理稿.docx','TPL-GOODS-2026','goods_procurement'),('02_小型维修改造施工合同_清理稿.docx','TPL-SMALL-CONST-2026','small_construction'),('03_大坝安全鉴定技术服务合同_清理稿.docx','TPL-DAM-TECH-2026','tech_service')]:
 x=E.fromstring(zipfile.ZipFile(private/'02_范本清理稿'/file).read('word/document.xml'));paragraphs=[''.join(n.text or '' for n in q.findall('.//w:t',ns)) for q in x.findall('.//w:p',ns)];clauses=[];heading='项目要素'
 for i,t in enumerate(paragraphs[2:]):
  if not t.strip():continue
  if re.match('^第.+条',t):heading=t;continue
  placeholders=re.findall('【(.*?)】',t);tier='default_ref' if any('默认' in v for v in placeholders) else 'placeholder' if placeholders else 'fixed'
  clauses.append(dict(clauseKey=f'p{i+1}',clauseNo=heading,title=heading,tier=tier,standardText=t,defaultValueNote='原清理稿参考值，待主管部门核定' if tier=='default_ref' else '',placeholderKeys=placeholders))
 ts.append(dict(code=code,version=1,name=file[3:-5],legalCategory=category,approvalStatus='candidate',notes='项目合同清理稿，尚未经主管部门核定；不得作为公司正式统一范本。技术服务范本仅供试验。',clauses=clauses))
output=root/a.output;output.write_text(json.dumps(dict(policies=ps,templates=ts),ensure_ascii=False,indent=2)+'\n');print(f'{output}: {len(ps)} policies, {len(ts)} candidate templates')
