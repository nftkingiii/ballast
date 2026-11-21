# Ballast Telegram bot text

## About (short description, max 120)
Hash or curtail, hour by hour, for a Bitcoin mining site. Paid, receipted Telegraph data. Testnet, advice only.

## Description ("What can this bot do?", max 512)
Ballast decides, hour by hour, whether a Bitcoin mining site should hash or curtail.

Ask "Should we hash or curtail tonight?" and it buys ERCOT power prices, hashprice and a weather check through Telegraph, cross-checks each one against public data, and answers RUN, CURTAIL or HOLD for every hour with the margin, the provider and the receipt.

If a check is missing or two sources disagree, it holds and names the check instead of guessing.

Testnet (Sepolia test USDC). Recommendations only.
