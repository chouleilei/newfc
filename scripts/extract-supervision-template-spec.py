#!/usr/bin/env python3
"""离线固化官方模板的表头、说明与下拉规则；只读取前5/4行，绝不复制样本业务行。"""
import argparse
import json
import pathlib
import posixpath
import zipfile
import xml.etree.ElementTree as ET

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

def extract(root):
    result = {}
    for file in sorted(root.rglob('*.xlsx')):
        with zipfile.ZipFile(file) as z:
            shared = []
            if 'xl/sharedStrings.xml' in z.namelist():
                shared = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
            rels = {r.attrib['Id']: posixpath.normpath(posixpath.join('xl', r.attrib['Target'])).lstrip('/') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
            wb = ET.fromstring(z.read('xl/workbook.xml'))
            for sheet in wb.find('s:sheets', NS):
                name = sheet.attrib['name']
                path = rels[sheet.attrib[REL]]
                if path.startswith('xl/xl/'): path = path[3:]
                xml = ET.fromstring(z.read(path))
                header_rows = 4 if name.startswith('实际') else 5
                cells = {}
                for row in xml.findall('s:sheetData/s:row', NS):
                    if int(row.attrib['r']) > header_rows: continue
                    for c in row:
                        v = c.find('s:v', NS)
                        text = v.text if v is not None else ''
                        if c.attrib.get('t') == 's': text = shared[int(text)] if text else ''
                        elif c.attrib.get('t') == 'inlineStr': text = ''.join(c.find('s:is', NS).itertext())
                        elif text and c.attrib.get('t') != 'str': text = int(text) if text.isdigit() else text
                        if text != '': cells[c.attrib['r']] = text
                validations = []
                for dv in xml.findall('s:dataValidations/s:dataValidation', NS):
                    validations.append({'range': dv.attrib['sqref'], 'type': dv.attrib.get('type', 'list'), 'allowBlank': dv.attrib.get('allowBlank') == '1', 'formulae': [c.text or '' for c in dv]})
                result[name] = {'headerRows': header_rows, 'cells': cells, 'validations': validations}
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('template_directory', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(extract(args.template_directory), ensure_ascii=False, indent=2) + '\n')
