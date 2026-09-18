import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('refresh_excel', ROOT / 'scripts/refresh_excel_prices.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PriceRefreshTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.templates = ROOT / 'excel/templates'
        cls.universe = json.loads((ROOT / 'asset-universe.json').read_text())
        cls.snapshot = json.loads((ROOT / 'stock-price-data.json').read_text())
        # Stable test inputs; no network involved.
        cls.snapshot['nativePricesUsd'] = {'ETH': 2000.0, 'BNB': 600.0, 'SOL': 100.0, 'HYPE': 50.0, 'ASTER': 1.0}
        cls.snapshot['nativeSource'] = 'https://api.coingecko.com/api/v3/simple/price'

    def test_two_tab_layout_and_single_quote_price_override(self):
        for platform, (filename, _, _, _) in module.FILES.items():
            if platform not in ['flap', 'ponsv2']:
                continue
            parts, _, sheets, strings = module.workbook_parts((self.templates / filename).read_bytes())
            self.assertEqual(list(sheets), ['控筹模型', 'Quote参数'])
            control = module.ET.fromstring(parts[sheets['控筹模型']])
            cells = {x.get('r'): x for x in control.iter(module.N('c'))}
            for address, title in [('C5', '一、可编辑参数'), ('C17', '二、测算结果'), ('C39', '三、模型信息与计算口径（默认折叠，点左侧 + 展开）'), ('C57', '内盘曲线')]:
                self.assertEqual(module.read_cell(cells[address], strings), title)
            self.assertEqual(module.read_cell(cells['F12'], strings), '资金预留 / Quote')
            for address, value in [('G7', 2), ('G8', 20), ('G9', 30), ('G10', 150)]:
                self.assertEqual(float(module.read_cell(cells[address], strings)), value)
            reserve_formula = cells['G12'].find(module.N('f')).text
            self.assertIn('ROUNDUP($G$56/$D$55,0)', reserve_formula)
            self.assertIn('ISNUMBER($D$55)', reserve_formula)
            self.assertEqual(float(module.read_cell(cells['G56'], strings)), 10000)
            self.assertFalse(module.read_cell(cells.get('D10'), strings))
            self.assertIn('$G$12', cells['D25'].find(module.N('f')).text)
            rows = {int(x.get('r')): x for x in control.find(module.N('sheetData'))}
            self.assertEqual(rows[39].get('collapsed'), '1')
            self.assertEqual(control.find(module.N('sheetPr')).find(module.N('outlinePr')).get('summaryBelow'), '0')
            for row in range(40, 57):
                self.assertEqual(rows[row].get('hidden'), '1')
                self.assertEqual(rows[row].get('outlineLevel'), '1')
            for row in [7, 12, 18, 26, 27, 28, 29, 39, 57, 59]:
                self.assertNotEqual(rows[row].get('hidden'), '1', 'Inputs, fee summaries, checks and curves remain visible')
            self.assertEqual(float(rows[7].get('ht')), 20)
            for address, expression in [('J23', '$G$41'), ('J28', '$G$42'), ('J24', '$G$41+$J$7'), ('J29', '$G$42+$J$7'), ('D27', '$D$8*$J$54')]:
                self.assertEqual(cells[address].find(module.N('f')).text, expression)
            self.assertEqual(cells['J30'].find(module.N('f')).text, '$G$42+$J$8' if platform == 'flap' else '$G$42+$J$7')
            retention = cells['J54'].find(module.N('f')).text
            self.assertEqual(retention, '(1-$J$7)*(1-$J$8)*(1-$G$42)^2' if platform == 'flap' else '1')
            self.assertIn('$D$26', cells['D18'].find(module.N('f')).text)
            self.assertIn('SUM(D19,G19)', cells['J18'].find(module.N('f')).text)
            self.assertIsNone(cells['D9'].find(module.N('f')), 'Manual override must be independent of the automatic lookup')
            for row in range(30, 36):
                for column in 'CDEFGH':
                    cell = cells.get(f'{column}{row}')
                    self.assertFalse(module.read_cell(cell, strings), 'Removed metadata is absent from results')
                    if cell is not None:
                        self.assertIsNone(cell.find(module.N('f')))
            for row in range(31, 36):
                self.assertEqual(rows[row].get('hidden'), '1', 'Empty metadata rows must not leave a gap')
            for address in ['D51', 'D52', 'D53', 'D54', 'D55', 'D56', 'G54', 'G55']:
                self.assertIsNotNone(cells[address].find(module.N('f')), 'Needed dependencies remain in collapsed information block')
            formula = cells['D55'].find(module.N('f')).text
            self.assertIn('$D$9', formula)
            self.assertIn("'Quote参数'!", formula)
            self.assertIn('$D$55', cells['D19'].find(module.N('f')).text)
            self.assertEqual(module.read_cell(cells['F18'], strings), '原生币 Gas 储备')
            for path in sheets.values():
                for cell in module.ET.fromstring(parts[path]).iter(module.N('c')):
                    f = cell.find(module.N('f'))
                    if f is not None:
                        for old_sheet in ['单币测算', '选中Quote曲线', '全Quote预算', '全RWA预算']:
                            self.assertNotIn(old_sheet, f.text)

    def test_both_workbooks_price_and_provenance_only(self):
        for platform, (filename, first, last, columns) in module.FILES.items():
            if platform not in ['flap', 'ponsv2']:
                continue
            original = (self.templates / filename).read_bytes()
            raw = module.refresh_workbook(original, platform, self.snapshot, self.universe)
            parts, wb, sheets, strings = module.workbook_parts(raw)
            sheet = module.ET.fromstring(parts[sheets['Quote参数']])
            cells = {x.get('r'): x for x in sheet.iter(module.N('c'))}
            if platform == 'flap':
                self.assertAlmostEqual(float(module.read_cell(cells['P7'], strings)), 600.0 / self.snapshot['tetherUsd'])
                self.assertEqual(module.read_cell(cells['R7'], strings), self.snapshot['nativeSource'])
            for row in range(first, last + 1):
                symbol = module.read_cell(cells[f'E{row}'], strings)
                quote = self.snapshot['quotes'].get(f'{platform}-{symbol.lower()}')
                actual = module.read_cell(cells[f'{columns[0]}{row}'], strings)
                if quote:
                    self.assertEqual(None if not actual else float(actual), quote['priceUsdt'])
                    self.assertEqual(module.read_cell(cells[f'{columns[2]}{row}'], strings) or None, quote.get('url'))
            self.assertEqual(wb.find(module.N('calcPr')).get('fullCalcOnLoad'), '1')
            for path in sheets.values():
                for cell in module.ET.fromstring(parts[path]).iter(module.N('c')):
                    if cell.find(module.N('f')) is not None:
                        self.assertIsNone(cell.find(module.N('v')), 'Old formula cache must not be displayed')

    def test_publish_manifest_has_exact_checksums(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            module.publish(self.templates, output, self.snapshot, self.universe)
            manifest = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(set(manifest['files']), {'flap', 'ponsv2', 'base', 'four-stock'})
            self.assertEqual(manifest['updatedAt'], self.snapshot['updatedAt'])
            for entry in manifest['files'].values():
                raw = (output / entry['filename']).read_bytes()
                self.assertEqual(len(raw), entry['bytes'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), entry['sha256'])

    def test_base_and_four_stock_share_daily_prices_and_reserve_rule(self):
        for platform in ['base', 'four-stock']:
            filename = module.FILES[platform][0]
            raw = module.refresh_workbook((self.templates / filename).read_bytes(), platform, self.snapshot, self.universe)
            parts, _, sheets, strings = module.workbook_parts(raw)
            target = '币价' if platform == 'base' else '参数与来源'
            inputs = {x.get('r'): x for x in module.ET.fromstring(parts[sheets[target]]).iter(module.N('c'))}
            self.assertEqual(float(module.read_cell(inputs['B12' if platform == 'base' else 'N8'], strings)), self.snapshot['tetherUsd'])
            if platform == 'base':
                for symbol, row in [('SOL', 3), ('BNB', 4), ('HYPE', 5), ('ASTER', 6), ('ETH', 7)]:
                    self.assertEqual(float(module.read_cell(inputs[f'B{row}'], strings)), self.snapshot['nativePricesUsd'][symbol])
                for name in ['Pump_SOL', 'Bonk_USD1', 'Four_USD1', 'Four_BNB', 'Four_ASTER', 'Hyper_HYPE', 'Flap_BNB', 'Flap_USD1', 'PonsV2_ETH']:
                    cells = {x.get('r'): x for x in module.ET.fromstring(parts[sheets[name]]).iter(module.N('c'))}
                    for address, value in [('H7', 20), ('H8', 2), ('J3', 30), ('J4', 150)]:
                        self.assertEqual(float(module.read_cell(cells[address], strings)), value)
                    self.assertIn('ROUNDUP', cells['H5'].find(module.N('f')).text)
            else:
                self.assertAlmostEqual(float(module.read_cell(inputs['N12'], strings)), 600 / self.snapshot['tetherUsd'])
                cells = {x.get('r'): x for x in module.ET.fromstring(parts[sheets['控筹模型']]).iter(module.N('c'))}
                self.assertIn('ISNUMBER($L$14)', cells['H8'].find(module.N('f')).text)
                self.assertIn('ROUNDUP', cells['H8'].find(module.N('f')).text)
                self.assertFalse(module.read_cell(cells.get('L14'), strings), 'Never invent a BNC4 price')

    def test_second_workbook_error_preserves_all_previous_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            module.publish(self.templates, output, self.snapshot, self.universe)
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            broken = copy.deepcopy(self.snapshot)
            key = next(k for k in broken['quotes'] if k.startswith('ponsv2-'))
            broken['quotes'][key]['address'] = '0xwrong'
            with self.assertRaisesRegex(ValueError, 'CA mismatch'):
                module.publish(self.templates, output, broken, self.universe)
            self.assertEqual(before, {p.name: p.read_bytes() for p in output.iterdir()})

    def test_invalid_price_and_missing_quote_rejected(self):
        filename = module.FILES['flap'][0]
        raw = (self.templates / filename).read_bytes()
        for value in [0, -1, float('nan'), float('inf')]:
            broken = copy.deepcopy(self.snapshot)
            broken['quotes']['flap-spcxb']['priceUsdt'] = value
            with self.assertRaisesRegex(ValueError, 'invalid price'):
                module.refresh_workbook(raw, 'flap', broken, self.universe)
        broken = copy.deepcopy(self.snapshot)
        del broken['quotes']['flap-spcxb']
        with self.assertRaisesRegex(ValueError, 'missing quote'):
            module.refresh_workbook(raw, 'flap', broken, self.universe)

    def test_invalid_native_price_rejected(self):
        raw = (self.templates / module.FILES['flap'][0]).read_bytes()
        for value in [0, -1, float('nan'), float('inf')]:
            broken = copy.deepcopy(self.snapshot)
            broken['nativePricesUsd']['BNB'] = value
            with self.assertRaisesRegex(ValueError, 'invalid native price'):
                module.refresh_workbook(raw, 'flap', broken, self.universe)


if __name__ == '__main__':
    unittest.main()
