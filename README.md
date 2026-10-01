# Memeder

A swipe-based Solana memecoin discovery app. The attached flame mascot is used in the interface.

## Run

Requires Node.js 20+ and `curl`.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` to use another port.

## How it works

- The server loads boosted Solana token profiles and pair data from the [DEX Screener API](https://docs.dexscreener.com/api/reference). “Growing” orders the pool by short-term price movement and volume; “Popular” orders it by 24-hour volume. Boosted listings are paid promotions, so these tabs are app-specific rankings, not DEX Screener's official trending list.
- Swipe right, press the right arrow, or select **Make a pick** to save a token. Swipe left, press the left arrow, or select **Pass** to skip it.
- **Undo swipe** restores the most recent passed or picked coin to the deck. Undoing a pick also removes its awarded points.
- The **i** button on a coin opens Coin Intel with the token mint, price, market activity, links, and a copy action. Saved picks can be searched and sorted by date or points.
- A pick earns 10 points immediately, plus 15 when its market cap is under $1 million. Points do not imply future token performance. Swiping does not buy anything.
- **Connect Wallet** discovers Solana Wallet Standard wallets in the browser. The app reads the public address; private keys remain in the wallet. The **Buy** button on a coin or pick opens a separate SOL-to-token flow. A live [Jupiter Swap API V2](https://developers.jup.ag/docs/swap/order-and-execute.md) order shows estimated tokens and fees, then the wallet signs the exact transaction the user reviewed. Jupiter handles submission and confirmation. No trade is sent until the wallet signs it.
- Profiles, swipes, and the leaderboard are stored in `data/hunters.json` on this server. The browser keeps a local profile ID. This is a local prototype: it has no account authentication, so it should not be used as a public competitive leaderboard without adding authentication and abuse controls.

Market prices and token images come from a third party and may be delayed or unavailable. The app keeps the last successful feed in memory during a temporary API failure.

## Trading setup

The app uses Solana mainnet. Install a Wallet Standard compatible Solana browser wallet, then connect it in the top bar. The browser must support wallet injection; some in-app browsers do not. Quotes can be requested without an API key for prototyping. Set `JUPITER_API_KEY` in the server environment for more reliable throughput in deployment. Keep the key on the server.

Each quote expires after 60 seconds. The server compares the signed transaction message with the reviewed order before sending it to Jupiter. Swaps can fail or receive fewer tokens than the displayed estimate as markets move. This local prototype is not hardened for public deployment: add authentication, rate limits, monitoring, and a deliberate production review before opening it to others.
