# Drip — pay by the second on BOT Chain

**Live on BOT Chain mainnet:** [`0x7871Ab41736fe76b6030a7e02AB8b78dBdBc4e8c`](https://scan.botchain.ai/address/0x7871Ab41736fe76b6030a7e02AB8b78dBdBc4e8c)
(deploy tx [`0x551e84d4…`](https://scan.botchain.ai/tx/0x551e84d4b1c2a4fca726592fac5594cf732a0cc76e2acc65d023ad4f74276943))

Stream BOT or any ERC-20 token to someone. The amount flows evenly every second
between a start and end time; the recipient withdraws whatever has flowed, whenever
they like. Either side can stop a stream: the recipient keeps what has already flowed
and the sender gets the rest back in the same transaction.

Good for salaries, contractor retainers, grants, subscriptions and paying AI agents.

- Start now or schedule up to a year ahead; run for up to 5 years
- A 0.25% fee is charged **on top** at creation (hard-capped at 1%), so recipients always get exactly the amount set
- Fees accrue per token and anyone can push them to the treasury with `collectFees(token)`

## What the contract owner can and can't do
The owner can set the fee (≤ 1%), set the treasury and pause **new** streams.
No function moves anyone's streamed or unstreamed funds; a test checks the full list
of state-changing functions.

## Security properties (covered by tests)
- Exact payment required; fee-on-transfer tokens rejected so streams are always fully backed
- Stopping never takes back what already flowed, and nothing flows after a stop
- ReentrancyGuard on create/withdraw/cancel/collect; SafeERC20; two-step ownership
- Pause never blocks withdraw or cancel
- Solvency: contract balance == fees + every stream's deposit minus withdrawn, per token
- Not supported: rebasing tokens

## Run
```bash
npm install
npx hardhat test               # if the solc CDN is blocked: USE_SOLCJS=1 npx hardhat test
cp .env.example .env           # PRIVATE_KEY, BOT_RPC_URL, OWNER_ADDRESS, TREASURY_ADDRESS
npx hardhat run scripts/deploy.js --network botMainnet
```
Then put the printed address in `docs/index.html` → `CONFIG.contract` and deploy `docs/` to Vercel
(Framework Preset: Other).

BOT Chain mainnet: chain ID 677, gas token BOT, explorer https://scan.botchain.ai.
