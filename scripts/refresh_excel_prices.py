"""Cloud-only mechanical refresh of price inputs in validated XLSX templates.

The local artifact-tool authors/validates the templates. GitHub runners do not
have that runtime; this dependency-free path preserves every formula and style.
Excel recalculates formula caches on opening instead of displaying stale prices.
"""
import argparse
import hashlib
import io
import json
import math
import posixpath
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
ET.register_namespace('r', REL)
N = lambda tag: f'{{{NS}}}{tag}'
FILES = {
    'flap': ('Flap_BSC_RWA币股_控筹模型.xlsx', 14, 36, ['P', 'Q', 'R', 'S']),
    'ponsv2': ('PonsV2_股票Quote控筹模型.xlsx', 9, 62, ['S', 'T', 'U', 'V']),
    'base': ('发射平台模型_全曲线_PonsV2.xlsx', 0, 0, []),
    'four-stock': ('FourMeme_4Stock_BNC4_控筹模型.xlsx', 0, 0, []),
}


def serial_date(value):
    date = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return (date.replace(tzinfo=None) - datetime(1899, 12, 30)).total_seconds() / 86400


def workbook_parts(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        parts = {entry.filename: archive.read(entry) for entry in archive.infolist()}
    wb = ET.fromstring(parts['xl/workbook.xml'])
    relationships = ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
    targets = {x.get('Id'): posixpath.normpath(posixpath.join('xl', x.get('Target'))) if not x.get('Target').startswith('/') else x.get('Target').lstrip('/') for x in relationships}
    sheets = {x.get('name'): targets[x.get(f'{{{REL}}}id')] for x in wb.find(N('sheets'))}
    shared = ET.fromstring(parts['xl/sharedStrings.xml']) if 'xl/sharedStrings.xml' in parts else []
    strings = [''.join(x.itertext()) for x in shared]
    return parts, wb, sheets, strings


def read_cell(cell, strings):
    if cell is None:
        return None
    if cell.get('t') == 'inlineStr':
        return ''.join(cell.find(N('is')).itertext())
    value = cell.find(N('v'))
    if value is None:
        return None
    return strings[int(value.text)] if cell.get('t') == 's' else value.text


def replace_value(cell, value):
    if cell.find(N('f')) is not None:
        raise ValueError('Cannot overwrite a formula input')
    for child in list(cell):
        if child.tag in [N('v'), N('is')]:
            cell.remove(child)
    cell.attrib.pop('t', None)
    if value is None:
        # A literal blank prevents a long source in an adjacent column from
        # overflowing into an unpriced asset's price cell.
        cell.set('t', 'inlineStr')
        ET.SubElement(ET.SubElement(cell, N('is')), N('t')).text = ''
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0:
            raise ValueError('Price/date must be finite and positive')
        ET.SubElement(cell, N('v')).text = repr(value)
    else:
        cell.set('t', 'inlineStr')
        ET.SubElement(ET.SubElement(cell, N('is')), N('t')).text = value


def refresh_workbook(raw, platform, snapshot, universe):
    parts, wb, sheets, strings = workbook_parts(raw)
    if platform in ['base', 'four-stock']:
        target = sheets['币价' if platform == 'base' else '参数与来源']
        xml = ET.fromstring(parts[target])
        cells = {x.get('r'): x for x in xml.iter(N('c'))}
        if platform == 'base':
            changes = {'B12': snapshot['tetherUsd'], 'D12': snapshot['updatedAt'], 'B13': snapshot['tetherSource']}
            for symbol, row in [('SOL', 3), ('BNB', 4), ('HYPE', 5), ('ASTER', 6), ('ETH', 7)]:
                changes[f'B{row}'] = snapshot['nativePricesUsd'][symbol]
                changes[f'C{row}'] = snapshot['updatedAt']
        else:
            changes = {'N8': snapshot['tetherUsd'], 'N9': snapshot['updatedAt'], 'N10': snapshot['tetherSource'],
                       'N12': snapshot['nativePricesUsd']['BNB'] / snapshot['tetherUsd'],
                       'N13': snapshot['updatedAt'], 'N14': snapshot['nativeSource']}
        for address, value in changes.items():
            if address not in cells:
                raise ValueError(f'{platform}/{address}: dated price input missing')
            replace_value(cells[address], value)
        parts[target] = ET.tostring(xml, encoding='utf-8', xml_declaration=True)
        return finalize_workbook(raw, parts, wb, sheets, target, set(changes))
    _, first, last, columns = FILES[platform]
    target = sheets['Quote参数']
    xml = ET.fromstring(parts[target])
    rows = {int(row.get('r')): row for row in xml.find(N('sheetData'))}
    replaced = set()
    if platform == 'flap':
        # Native BNB is not one of the RWA Quote rows. A separate dated input
        # provides Gas valuation without touching scenario or budget formulas.
        price = snapshot['nativePricesUsd']['BNB'] / snapshot['tetherUsd']
        if not math.isfinite(price) or price <= 0:
            raise ValueError('flap/BNB: invalid native price')
        native_cells = {cell.get('r'): cell for cell in rows[7]}
        for column, value in zip(columns, [price, serial_date(snapshot['updatedAt']), snapshot['nativeSource'], '随每日行情更新；仅用于原生币 Gas 折算']):
            address = f'{column}7'
            if address not in native_cells:
                raise ValueError(f'{address}: native Gas price input missing')
            replace_value(native_cells[address], value)
            replaced.add(address)
    for row_index in range(first, last + 1):
        row = rows[row_index]
        cells = {cell.get('r'): cell for cell in row}
        symbol = read_cell(cells.get(f'E{row_index}'), strings)
        key = f'{platform}-{symbol.lower()}'
        asset = universe.get(key)
        quote = snapshot['quotes'].get(key)
        if asset and asset.get('quoteAssetClass') == 'equity':
            if not quote or quote['address'] != asset['quoteAddress'].lower():
                raise ValueError(f'{key}: missing quote or CA mismatch')
            template_address = read_cell(cells.get(f'G{row_index}'), strings)
            if not template_address or template_address.replace('\u200b', '').strip().lower() != asset['quoteAddress'].lower():
                raise ValueError(f'{key}: template CA mismatch')
            price = quote['priceUsdt']
            if price is not None and (not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0):
                raise ValueError(f'{key}: invalid price')
            values = [price, serial_date(quote['fetchedAt']), quote.get('url'), '每日 Quote 代币池价；本地可手动更新' if price else '暂无合格池价；可手动输入']
        elif symbol in ['BNB', 'ETH']:
            # Dedicated workbooks include these native Quotes; use the same dated FX snapshot.
            price = snapshot['nativePricesUsd'][symbol] / snapshot['tetherUsd']
            values = [price, serial_date(snapshot['updatedAt']), snapshot['nativeSource'], '每日原生币价格；本地可手动更新']
        elif symbol == 'USD1':
            values = [1 / snapshot['tetherUsd'], serial_date(snapshot['updatedAt']), snapshot['tetherSource'], 'USD1 按 1 USD 换算；本地可手动更新']
        else:
            raise ValueError(f'{platform}/{symbol}: unmapped workbook Quote')
        for column, value in zip(columns, values):
            address = f'{column}{row_index}'
            cell = cells.get(address)
            if cell is None:
                raise ValueError(f'{address}: template cell missing')
            replace_value(cell, value)
            replaced.add(address)
    parts[target] = ET.tostring(xml, encoding='utf-8', xml_declaration=True)
    return finalize_workbook(raw, parts, wb, sheets, target, replaced)


def finalize_workbook(raw, parts, wb, sheets, target, replaced):
    for path in sheets.values():
        sheet = ET.fromstring(parts[path])
        for cell in sheet.iter(N('c')):
            if cell.find(N('f')) is not None:
                # Caches are not formula definitions. Recalculate all formulas in Excel.
                for value in list(cell):
                    if value.tag in [N('v'), N('is')]:
                        cell.remove(value)
                cell.attrib.pop('t', None)
        parts[path] = ET.tostring(sheet, encoding='utf-8', xml_declaration=True)
    calc = wb.find(N('calcPr'))
    if calc is None:
        calc = ET.SubElement(wb, N('calcPr'))
    calc.set('calcMode', 'auto')
    calc.set('fullCalcOnLoad', '1')
    calc.set('forceFullCalc', '1')
    parts['xl/workbook.xml'] = ET.tostring(wb, encoding='utf-8', xml_declaration=True)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, content in parts.items():
            archive.writestr(path, content)
    result = output.getvalue()
    validate_preservation(raw, result, target, replaced)
    return result


def validate_preservation(before, after, changed_sheet, replaced):
    original, _, sheets, _ = workbook_parts(before)
    updated, _, _, _ = workbook_parts(after)
    assert original.keys() == updated.keys(), 'Workbook parts changed'
    for path in original:
        if path == 'xl/workbook.xml':
            a, b = ET.fromstring(original[path]), ET.fromstring(updated[path])
            for x in [a, b]:
                calc = x.find(N('calcPr'))
                if calc is not None:
                    x.remove(calc)
            assert ET.tostring(a) == ET.tostring(b), 'Non-calculation workbook settings changed'
        elif path in sheets.values():
            a, b = ET.fromstring(original[path]), ET.fromstring(updated[path])
            for x in [a, b]:
                for cell in x.iter(N('c')):
                    if cell.find(N('f')) is not None:
                        for child in list(cell):
                            if child.tag in [N('v'), N('is')]:
                                cell.remove(child)
                        cell.attrib.pop('t', None)
                    elif path == changed_sheet and cell.get('r') in replaced:
                        for child in list(cell):
                            if child.tag in [N('v'), N('is')]:
                                cell.remove(child)
                        cell.attrib.pop('t', None)
            assert ET.tostring(a) == ET.tostring(b), f'{path}: unrelated cell/formula/style changed'
        else:
            assert original[path] == updated[path], f'{path}: object/style/validation changed'


def publish(templates, output, snapshot, universe):
    if snapshot['schemaVersion'] != 1 or not math.isfinite(snapshot['tetherUsd']) or snapshot['tetherUsd'] <= 0:
        raise ValueError('Invalid snapshot')
    serial_date(snapshot['updatedAt'])
    outputs = {}
    manifest = {'schemaVersion': 1, 'updatedAt': snapshot['updatedAt'], 'files': {}}
    # Build and validate all four before replacing any previous file.
    for platform, (filename, _, _, _) in FILES.items():
        raw = refresh_workbook((templates / filename).read_bytes(), platform, snapshot, universe)
        outputs[filename] = raw
        manifest['files'][platform] = {'filename': filename, 'path': f'excel/latest/{filename}', 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as staging:
        folder = Path(staging)
        for filename, raw in outputs.items():
            (folder / filename).write_bytes(raw)
        (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        for filename in [*outputs, 'manifest.json']:
            (folder / filename).replace(output / filename)
    print(json.dumps({'updatedAt': snapshot['updatedAt'], 'workbooks': len(outputs)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--templates', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, default=Path('stock-price-data.json'))
    parser.add_argument('--universe', type=Path, default=Path('asset-universe.json'))
    args = parser.parse_args()
    publish(args.templates, args.output, json.loads(args.snapshot.read_text()), json.loads(args.universe.read_text()))
