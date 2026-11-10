#![allow(dead_code)]

use anyhow::{anyhow, bail, Result};
pub use quorum_sandbox_support::AccountId;
use quorum_sandbox_support::{pools_wasm, token_wasm, Chain, Outcome};
use serde_json::{json, Value};

pub const MUSD: u128 = 1_000_000;
const MINT_CAP: u128 = 1_000 * MUSD;
const STORAGE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR; the excess is refunded

/// The deadline offset for every pool. It is long enough to cover a scenario's slow setup, so no
/// pool expires by accident; a scenario that wants a pool to expire moves the sandbox clock past
/// the deadline with `World::expire`.
pub const DEADLINE_MS: u64 = 600_000;

pub struct World {
    pub chain: Chain,
    pub token: AccountId,
    pub pools: AccountId,
}

fn amount(value: &Value) -> u128 {
    value
        .as_str()
        .expect("a decimal string")
        .parse()
        .expect("a u128")
}

/// The `data` elements of every NEP-297 event named `name` that an outcome logged, in log order.
pub fn events(out: &Outcome, name: &str) -> Vec<Value> {
    out.logs
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|body| serde_json::from_str::<Value>(body).ok())
        .filter(|event| event["event"] == name)
        .flat_map(|event| event["data"].as_array().cloned().unwrap_or_default())
        .collect()
}

impl World {
    /// Starts a sandbox, deploys the token and the pools contract (initialised in its deploy
    /// transaction), and registers the pools contract on the token.
    pub async fn new() -> Result<Self> {
        let chain = Chain::start().await?;
        let token = chain
            .deploy("musd", token_wasm()?, Some(("new", json!({}))))
            .await?;
        let pools = chain
            .deploy(
                "pools",
                pools_wasm()?,
                Some(("new", json!({ "token": token }))),
            )
            .await?;
        let world = Self {
            chain,
            token,
            pools,
        };
        world.register(&world.pools.clone()).await?;
        Ok(world)
    }

    pub async fn register(&self, who: &AccountId) -> Result<()> {
        let out = self
            .chain
            .call(
                who,
                &self.token,
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
                30,
                STORAGE_DEPOSIT,
            )
            .await?;
        if !out.ok {
            bail!("storage_deposit failed: {}", out.debug);
        }
        Ok(())
    }

    /// Removes `who` from the token, burning any balance, so that transfers to it fail.
    pub async fn unregister(&self, who: &AccountId) -> Result<()> {
        let out = self
            .chain
            .call(
                who,
                &self.token,
                "storage_unregister",
                json!({ "force": true }),
                30,
                1,
            )
            .await?;
        if !out.ok {
            bail!("storage_unregister failed: {}", out.debug);
        }
        Ok(())
    }

    /// Mints `musd` whole mUSD to a registered account, in chunks under the per-call cap.
    pub async fn mint(&self, who: &AccountId, musd: u128) -> Result<()> {
        let mut left = musd * MUSD;
        while left > 0 {
            let part = left.min(MINT_CAP);
            let out = self
                .chain
                .call(
                    who,
                    &self.token,
                    "mint",
                    json!({ "account_id": who, "amount": part.to_string() }),
                    30,
                    0,
                )
                .await?;
            if !out.ok {
                bail!("mint failed: {}", out.debug);
            }
            left -= part;
        }
        Ok(())
    }

    /// Creates `<name>.sandbox` with 10 NEAR, registers it on the token and mints it `musd` mUSD.
    pub async fn user(&self, name: &str, musd: u128) -> Result<AccountId> {
        let id = self.chain.create_account(name, 10).await?;
        self.register(&id).await?;
        self.mint(&id, musd).await?;
        Ok(id)
    }

    pub async fn balance(&self, who: &AccountId) -> Result<u128> {
        let value = self
            .chain
            .view(&self.token, "ft_balance_of", json!({ "account_id": who }))
            .await?;
        Ok(amount(&value))
    }

    pub async fn deadline_in(&self, offset_ms: u64) -> Result<u64> {
        Ok(self.chain.now_ms().await? + offset_ms)
    }

    /// `ft_transfer_call` of `amount` base units from `from` to the pools contract.
    pub async fn transfer_call(
        &self,
        from: &AccountId,
        amount: u128,
        msg: Value,
    ) -> Result<Outcome> {
        self.chain
            .call(
                from,
                &self.token,
                "ft_transfer_call",
                json!({
                    "receiver_id": self.pools,
                    "amount": amount.to_string(),
                    "msg": serde_json::to_string(&msg)?,
                }),
                100,
                1,
            )
            .await
    }

    pub async fn pool_count(&self) -> Result<usize> {
        let pools = self
            .chain
            .view(
                &self.pools,
                "list_pools",
                json!({ "from": 0, "limit": 100 }),
            )
            .await?;
        Ok(pools
            .as_array()
            .ok_or_else(|| anyhow!("not an array"))?
            .len())
    }

    /// Opens a pool by sending `bonus` with an `open` message. Fails if the contract refused it.
    /// The invariants are checked right after the call, whether or not it opened a pool.
    pub async fn open(
        &self,
        seller: &AccountId,
        bonus: u128,
        price: u128,
        target: u32,
        deadline_ms: u64,
        cap: Option<u32>,
    ) -> Result<u64> {
        let before = self.pool_count().await?;
        let msg = json!({ "open": {
            "seat_price": price.to_string(), "target": target, "deadline_ms": deadline_ms,
            "max_seats_per_buyer": cap, "terms": "test block",
        }});
        let out = self.transfer_call(seller, bonus, msg).await?;
        self.check_invariants().await?;
        if !out.ok || self.pool_count().await? != before + 1 {
            bail!("the pool was not opened: {}", out.debug);
        }
        Ok(before as u64)
    }

    pub async fn commit(
        &self,
        buyer: &AccountId,
        pool_id: u64,
        seats: u32,
        price: u128,
    ) -> Result<Outcome> {
        let msg = json!({ "commit": { "pool_id": pool_id, "seats": seats } });
        let out = self
            .transfer_call(buyer, u128::from(seats) * price, msg)
            .await?;
        self.check_invariants().await?;
        Ok(out)
    }

    pub async fn settle(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome> {
        let out = self
            .chain
            .call(
                caller,
                &self.pools,
                "settle",
                json!({ "pool_id": pool_id }),
                100,
                0,
            )
            .await?;
        self.check_invariants().await?;
        Ok(out)
    }

    pub async fn refund(
        &self,
        caller: &AccountId,
        pool_id: u64,
        limit: u32,
        tgas: u64,
    ) -> Result<Outcome> {
        let out = self
            .chain
            .call(
                caller,
                &self.pools,
                "refund",
                json!({ "pool_id": pool_id, "limit": limit }),
                tgas,
                0,
            )
            .await?;
        self.check_invariants().await?;
        Ok(out)
    }

    pub async fn claim(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome> {
        let out = self
            .chain
            .call(
                caller,
                &self.pools,
                "claim_refund",
                json!({ "pool_id": pool_id }),
                100,
                0,
            )
            .await?;
        self.check_invariants().await?;
        Ok(out)
    }

    pub async fn pool(&self, pool_id: u64) -> Result<Value> {
        let value = self
            .chain
            .view(&self.pools, "get_pool", json!({ "pool_id": pool_id }))
            .await?;
        if value.is_null() {
            bail!("pool {pool_id} does not exist");
        }
        Ok(value)
    }

    pub async fn seats(&self, pool_id: u64) -> Result<Value> {
        self.chain
            .view(
                &self.pools,
                "get_seats",
                json!({ "pool_id": pool_id, "from": 0, "limit": 100 }),
            )
            .await
    }

    /// Moves the sandbox clock past a pool's deadline.
    pub async fn expire(&self, pool_id: u64) -> Result<()> {
        let deadline = self.pool(pool_id).await?["deadline_ms"]
            .as_u64()
            .ok_or_else(|| anyhow!("no deadline"))?;
        self.chain.wait_past(deadline).await
    }

    /// Checks invariants 1, 2 and 4 of the spec's section 5.5 over every pool:
    /// 1. the contract's token balance covers everything it still owes;
    /// 2. no pool has more seats taken than its target;
    /// 4. for a pool that expired, buyer refunds plus the dust equal what the pool took in.
    ///
    /// Invariants 3 (a pool's money leaves in exactly one way) and 5 (a buyer is paid at most once)
    /// are covered by the balance assertions in the scenarios, which compare every buyer's and the
    /// seller's balance after each payout. The rule that a pool only fills before its deadline is
    /// covered by the commit unit tests and by the settle-after-deadline scenario.
    pub async fn check_invariants(&self) -> Result<()> {
        let pools = self
            .chain
            .view(
                &self.pools,
                "list_pools",
                json!({ "from": 0, "limit": 100 }),
            )
            .await?;
        let mut owed: u128 = 0;
        for p in pools.as_array().ok_or_else(|| anyhow!("not an array"))? {
            let id = p["id"].as_u64().unwrap();
            let price = amount(&p["seat_price"]);
            let bonus = amount(&p["bonus"]);
            let per_seat = amount(&p["bonus_per_seat"]);
            let taken = u128::from(p["taken"].as_u64().unwrap());
            let target = u128::from(p["target"].as_u64().unwrap());
            if taken > target {
                bail!("pool {id}: {taken} seats taken, target {target}");
            }
            match p["status"].as_str().unwrap() {
                "open" | "filled" => owed += taken * price + bonus,
                "settled" => {}
                "expired" | "refunded" => {
                    let rows = self.seats(id).await?;
                    let mut all_refunds = 0u128;
                    let mut still_owed = 0u128;
                    for row in rows.as_array().unwrap() {
                        let n = u128::from(row["seats"].as_u64().unwrap());
                        let refund = n * (price + per_seat);
                        all_refunds += refund;
                        if matches!(row["state"].as_str().unwrap(), "committed" | "claimable") {
                            still_owed += refund;
                        }
                    }
                    let dust = bonus - per_seat * taken;
                    if all_refunds + dust != taken * price + bonus {
                        bail!(
                            "pool {id}: refunds {all_refunds} + dust {dust} != {}",
                            taken * price + bonus
                        );
                    }
                    owed += still_owed;
                    if !p["dust_sent"].as_bool().unwrap() {
                        owed += dust;
                    }
                }
                other => bail!("pool {id}: unknown status {other}"),
            }
        }
        let held = self.balance(&self.pools).await?;
        if held < owed {
            bail!("the contract holds {held} but owes {owed}");
        }
        Ok(())
    }
}
