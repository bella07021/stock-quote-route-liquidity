# Stock quote route liquidity

The daily price workflow also publishes the Flap and Pons XLSX downloads under `excel/latest`. Both workbooks use the exact same price snapshot and are committed together with the JSON only after validation succeeds. Cloud runners do not have the local artifact-tool runtime: the dependency-free updater mechanically replaces only the four dated price/provenance columns in locally authored templates, verifies all unrelated inputs, formulas, styles, objects and workbook parts remain unchanged, clears stale formula caches and enables full automatic recalculation on opening in Excel. Missing pool coverage remains blank. On failure, the previously committed pair stays available. `manifest.json` records the price timestamp, byte lengths and SHA-256; the website checks the manifest before downloading and shows the price date. Files already saved on a user's computer are not changed.

Stock Quote prices refresh daily at 01:30 UTC (09:30 Asia/Shanghai), independently of weekly liquidity admission. DEX Screener prices come from the deepest directly matched stock/WETH (Robinhood) or stock/USDT (BSC) pool with at least USD 100,000 liquidity. These are token prices, not original listed-share quotes. BSC uses the direct USDT quote; Robinhood USD prices convert using CoinGecko USDT/USD. Missing coverage stays null; failed requests or missing prices in qualifying pools preserve the previous complete snapshot. GitHub may delay scheduled runs.

Public market liquidity snapshots for Robinhood Chain WETH routes and BSC USDT routes.

GitHub Actions refreshes the snapshot every Monday at 01:00 UTC (09:00 Asia/Shanghai). Scheduled runs may be delayed by GitHub. Manual refresh is available through workflow_dispatch.

The asset universe contains publicly available token addresses. Every run rechecks all listed assets, including assets below the admission threshold. Only exact route token contracts are matched. Pools with TVL below USD 100,000 are excluded, and pool IDs are deduplicated. An asset is admitted when aggregate TVL is at least USD 900,000. XAUT is a gold RWA asset.

DEX Screener may return a limited pool set; the coverage column reports possible truncation. Aggregate TVL does not represent single-pool liquidity or executable depth. Failed or incomplete fetches preserve the previous complete snapshot.

The workflow uses a standard Ubuntu runner, no paid runner, no uploaded artifacts, no dependency cache, and no external credentials. Standard GitHub-hosted Actions runners in public repositories are free: https://docs.github.com/en/billing/concepts/product-billing/github-actions

Data source: https://docs.dexscreener.com/api/reference
