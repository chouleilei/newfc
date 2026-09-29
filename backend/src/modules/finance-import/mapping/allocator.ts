import { FINANCE_WEIGHT_SCALE } from '../finance.types';

/** 最大余数法；同余数按目标编码稳定排序，负数与正数遵循完全相同的绝对值分配。 */
export function allocateFixedRatio(amountCents:number, targets:{targetCode:string;weight:number}[]):number[] {
  if(targets.length===0 || targets.reduce((s,t)=>s+t.weight,0)!==FINANCE_WEIGHT_SCALE) throw new Error('固定比例权重之和必须等于 1000000');
  const sign=amountCents<0?-1:1, absolute=Math.abs(amountCents);
  // BigInt 精确相乘:absolute×weight 在约 9007 万元×满权重处越过 2^53,Number 乘法会让 floor/余数低位失真,
  // 尾差可能分给错误接收方;余数 < FINANCE_WEIGHT_SCALE、商 ≤ absolute,均可安全回落 Number。
  const scale=BigInt(FINANCE_WEIGHT_SCALE);
  const parts=targets.map((t,index)=>{const numerator=BigInt(absolute)*BigInt(t.weight); return {index,targetCode:t.targetCode,value:Number(numerator/scale),remainder:Number(numerator%scale)};});
  let remaining=absolute-parts.reduce((s,p)=>s+p.value,0);
  const ranked=[...parts].sort((a,b)=>b.remainder-a.remainder||a.targetCode.localeCompare(b.targetCode));
  for(let i=0;i<remaining;i++) ranked[i%ranked.length].value++;
  return parts.sort((a,b)=>a.index-b.index).map((p)=>p.value*sign);
}
