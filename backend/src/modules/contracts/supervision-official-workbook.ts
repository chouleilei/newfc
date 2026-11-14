import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import headers from './supervision-official-headers.json';

const specs = headers as Record<string, { headerRows: number; cells: Record<string, string | number>; validations: { range: string; type: string; allowBlank: boolean; formulae: string[] }[] }>;
export function officialSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const spec = specs[name];
  if (!spec) throw new Error(`未登记官方模板 ${name}`);
  const ws = wb.addWorksheet(name);
  for (const [address, value] of Object.entries(spec.cells)) ws.getCell(address).value = value;
  return ws;
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 直接写入原模板 sqref，避免 ExcelJS 把百万行校验展开为百万个 JS 对象。 */
export async function writeOfficialWorkbook(wb: ExcelJS.Workbook): Promise<Buffer> {
  const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  for (const [i, ws] of wb.worksheets.entries()) {
    const spec = specs[ws.name];
    const path = `xl/worksheets/sheet${i + 1}.xml`;
    const source = await zip.file(path)!.async('string');
    const dv = `<dataValidations count="${spec.validations.length}">${spec.validations.map(v =>
      `<dataValidation type="${v.type}" allowBlank="${v.allowBlank ? '1' : '0'}" sqref="${xml(v.range)}">${v.formulae.map((f, n) => `<formula${n + 1}>${xml(f)}</formula${n + 1}>`).join('')}</dataValidation>`).join('')}</dataValidations>`;
    zip.file(path, source.replace(/<dataValidations\b[\s\S]*?<\/dataValidations>/g, '').replace('</worksheet>', `${dv}</worksheet>`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
