# Stock quote route liquidity

Public market liquidity snapshots for Robinhood Chain WETH routes and BSC USDT routes.

GitHub Actions refreshes the snapshot every Monday at 01:00 UTC (09:00 Asia/Shanghai). Scheduled runs may be delayed by GitHub. Manual refresh is available through workflow_dispatch.

The asset universe contains publicly available token addresses. Every run rechecks all listed assets, including assets below the admission threshold. Only exact route token contracts are matched. Pools with TVL below USD 100,000 are excluded, and pool IDs are deduplicated. An asset is admitted when aggregate TVL is at least USD 900,000. XAUT is a gold RWA asset.

DEX Screener may return a limited pool set; the coverage column reports possible truncation. Aggregate TVL does not represent single-pool liquidity or executable depth. Failed or incomplete fetches preserve the previous complete snapshot.

The workflow uses a standard Ubuntu runner, no paid runner, no uploaded artifacts, no dependency cache, and no external credentials. Standard GitHub-hosted Actions runners in public repositories are free: https://docs.github.com/en/billing/concepts/product-billing/github-actions

Data source: https://docs.dexscreener.com/api/reference
