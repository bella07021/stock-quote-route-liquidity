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
        cls.snapshot['nativePricesUsd'] = {'ETH': 2000.0, 'BNB': 600.0}
        cls.snapshot['nativeSource'] = 'https://api.coingecko.com/api/v3/simple/price'

    def test_both_workbooks_price_and_provenance_only(self):
        for platform, (filename, first, last, columns) in module.FILES.items():
            original = (self.templates / filename).read_bytes()
            raw = module.refresh_workbook(original, platform, self.snapshot, self.universe)
            parts, wb, sheets, strings = module.workbook_parts(raw)
            sheet = module.ET.fromstring(parts[sheets['Quote参数']])
            cells = {x.get('r'): x for x in sheet.iter(module.N('c'))}
            for row in range(first, last + 1):
                symbol = module.read_cell(cells[f'E{row}'], strings)
                quote = self.snapshot['quotes'].get(f'{platform}-{symbol.lower()}')
                actual = module.read_cell(cells[f'{columns[0]}{row}'], strings)
                if quote:
                    self.assertEqual(None if actual is None else float(actual), quote['priceUsdt'])
                    self.assertEqual(module.read_cell(cells[f'{columns[2]}{row}'], strings), quote.get('url'))
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
            self.assertEqual(manifest['updatedAt'], self.snapshot['updatedAt'])
            for entry in manifest['files'].values():
                raw = (output / entry['filename']).read_bytes()
                self.assertEqual(len(raw), entry['bytes'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), entry['sha256'])

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


if __name__ == '__main__':
    unittest.main()
