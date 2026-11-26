Apply these changes with Edit, exactly:

1. In `src/pricing.ts`: set `TAX_RATE` to `0.2`, and change `price` to take a second parameter `currency: 'EUR' | 'USD'` and return `{ amount: number; currency: 'EUR' | 'USD' }` with the rounded amount and the currency passed in.
2. In `docs/release-notes.md`: change the release date to `2026-12-05`.
