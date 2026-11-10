//! A local NEAR sandbox with the few operations the contract tests need. Everything that depends on
//! `near-sandbox` and `near-api` lives here, so the tests use only this file's interface.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
pub use near_api::AccountId;
use near_api::{Account, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use serde_json::{json, Value};

/// A running sandbox. Every account it creates uses the sandbox's default key, so one signer signs
/// for all of them.
pub struct Chain {
    pub sandbox: Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
}

/// The result of a function call: did the transaction succeed, what it logged, and its debug text
/// (which includes any receipt failure message).
pub struct Outcome {
    pub ok: bool,
    pub logs: Vec<String>,
    pub debug: String,
}

impl Chain {
    pub async fn start() -> Result<Self> {
        let sandbox = Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
                .parse()
                .map_err(|_| anyhow!("bad sandbox key"))?,
        )?;
        Ok(Self {
            sandbox,
            network,
            signer,
        })
    }

    pub async fn create_account(&self, name: &str, near: u128) -> Result<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
        Ok(id)
    }

    /// Creates `<name>.sandbox` with 20 NEAR, deploys `wasm`, and runs `init` in the same
    /// transaction when given.
    pub async fn deploy(
        &self,
        name: &str,
        wasm: Vec<u8>,
        init: Option<(&str, Value)>,
    ) -> Result<AccountId> {
        let id = self.create_account(name, 20).await?;
        let deploy = Contract::deploy(id.clone()).use_code(wasm);
        let result = match init {
            Some((method, args)) => {
                deploy
                    .with_init_call(method, args)?
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
            None => {
                deploy
                    .without_init_call()
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
        };
        result.assert_success();
        Ok(id)
    }

    pub async fn call(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        tgas: u64,
        deposit_yocto: u128,
    ) -> Result<Outcome> {
        let result = Account(contract.clone())
            .as_contract()
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(tgas))
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .with_signer(caller.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?;
        Ok(Outcome {
            ok: result.is_success(),
            logs: result.logs().iter().map(|line| line.to_string()).collect(),
            debug: format!("{result:?}"),
        })
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        let data: Value = Account(contract.clone())
            .as_contract()
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await?
            .data;
        Ok(data)
    }

    pub async fn fast_forward(&self, blocks: u64) -> Result<()> {
        self.sandbox.fast_forward(blocks).await?;
        Ok(())
    }

    /// Block time of the latest final block, in milliseconds, read over plain JSON-RPC.
    pub async fn now_ms(&self) -> Result<u64> {
        let body = json!({
            "jsonrpc": "2.0", "id": "t", "method": "block", "params": { "finality": "final" }
        });
        let reply: Value = reqwest::Client::new()
            .post(&self.sandbox.rpc_addr)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        let nanos = reply["result"]["header"]["timestamp"]
            .as_u64()
            .ok_or_else(|| anyhow!("no block timestamp in {reply}"))?;
        Ok(nanos / 1_000_000)
    }

    /// Moves the chain forward until block time is at or past `deadline_ms`.
    pub async fn wait_past(&self, deadline_ms: u64) -> Result<()> {
        for _ in 0..120 {
            if self.now_ms().await? >= deadline_ms {
                return Ok(());
            }
            self.fast_forward(500).await?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        bail!("block time did not reach {deadline_ms}")
    }
}

/// Builds a contract to wasm. The ABI steps and the lockfile check are switched off: they slow the
/// build and are not needed for tests. If the builder rejects one of those three option names, drop
/// that option; it only affects speed.
fn build_wasm(manifest_relative_to_workspace: &str) -> Result<Vec<u8>> {
    let manifest = format!(
        "{}/../../{}",
        env!("CARGO_MANIFEST_DIR"),
        manifest_relative_to_workspace
    );
    let path = cargo_near_build::build_with_cli(
        cargo_near_build::BuildOpts::builder()
            .manifest_path(manifest)
            .no_abi(true)
            .no_embed_abi(true)
            .no_locked(true)
            .build(),
    )
    .map_err(|error| anyhow!("building {manifest_relative_to_workspace}: {error:?}"))?;
    Ok(std::fs::read(path)?)
}

/// Tests in one binary run on parallel threads and every one deploys the wasm. Building once, under
/// a lock, keeps them from rebuilding (and from reading a file another build is writing).
static BUILD_LOCK: Mutex<()> = Mutex::new(());
static TOKEN_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static POOLS_WASM: OnceLock<Vec<u8>> = OnceLock::new();

fn build_once(cell: &'static OnceLock<Vec<u8>>, manifest: &str) -> Result<Vec<u8>> {
    let _guard = BUILD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(wasm) = cell.get() {
        return Ok(wasm.clone());
    }
    let wasm = build_wasm(manifest)?;
    let _ = cell.set(wasm.clone());
    Ok(wasm)
}

pub fn token_wasm() -> Result<Vec<u8>> {
    build_once(&TOKEN_WASM, "contracts/mock-usd/Cargo.toml")
}

pub fn pools_wasm() -> Result<Vec<u8>> {
    build_once(&POOLS_WASM, "contracts/pools/Cargo.toml")
}
