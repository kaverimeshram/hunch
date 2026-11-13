use near_sdk::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Command, sync::OnceLock};

fn wasm() -> &'static Vec<u8> {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let out = root.join("target-wasm");
        let status = Command::new("cargo")
            .args(["near", "build", "non-reproducible-wasm", "--manifest-path"])
            .arg(root.join("contract/Cargo.toml"))
            .arg("--out-dir")
            .arg(&out)
            .status()
            .expect("cargo near must be installed on the remote build host");
        assert!(status.success(), "cargo near build failed");
        std::fs::read(out.join("hunch_contract.wasm")).unwrap()
    })
}

async fn deploy() -> (near_workspaces::Worker<near_workspaces::network::Sandbox>, Account, Account, Contract) {
    let worker = near_workspaces::sandbox().await.unwrap();
    let root = worker.root_account().unwrap();
    let arbiter = root.create_subaccount("arbiter").initial_balance(NearToken::from_near(10)).transact().await.unwrap().unwrap();
    let account = root.create_subaccount("hunch").initial_balance(NearToken::from_near(30)).transact().await.unwrap().unwrap();
    let contract = account.deploy(wasm()).await.unwrap().unwrap();
    contract.call("new").args_json(json!({"arbiter":arbiter.id(),"registry":"sworn-reg7-1113.testnet","model_id":"Qwen/Qwen3.6-35B-A3B-FP8"})).transact().await.unwrap().into_result().unwrap();
    (worker, root, arbiter, contract)
}

async fn view<T: serde::de::DeserializeOwned>(contract: &Contract, method: &str, args: Value) -> T {
    contract.view(method).args_json(args).await.unwrap().json().unwrap()
}

fn sha(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

#[tokio::test]
async fn sandbox_stakes_change_live_odds_inputs() {
    let (worker, root, _, contract) = deploy().await;
    let now = worker.view_block().await.unwrap().timestamp() / 1_000_000;
    root.call(contract.id(), "create_fact")
        .args_json(json!({"id":"market-one","claim":"The Patoshi miner was Satoshi Nakamoto","resolve_after":now+60_000}))
        .deposit(NearToken::from_millinear(100)).transact().await.unwrap().into_result().unwrap();
    root.call(contract.id(), "add_source").args_json(json!({"id":"market-one","source":"https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/"})).transact().await.unwrap().into_result().unwrap();
    root.call(contract.id(), "stake").args_json(json!({"id":"market-one","side":"Yes"})).deposit(NearToken::from_millinear(2)).transact().await.unwrap().into_result().unwrap();
    let fact: Value = view(&contract, "get_fact", json!({"id":"market-one"})).await;
    assert_eq!(fact["yes_pool"], "2000000000000000000000");
    assert_eq!(fact["no_pool"], "0");
    assert_eq!(fact["stakers"], 1);
}

#[tokio::test]
async fn sandbox_refuses_a_resolution_without_a_matching_signed_response_hash() {
    let (worker, root, arbiter, contract) = deploy().await;
    let now = worker.view_block().await.unwrap().timestamp() / 1_000_000;
    root.call(contract.id(), "create_fact")
        .args_json(json!({"id":"tamper-check","claim":"The Patoshi miner was Satoshi Nakamoto","resolve_after":now+1}))
        .deposit(NearToken::from_millinear(100)).transact().await.unwrap().into_result().unwrap();
    root.call(contract.id(), "stake").args_json(json!({"id":"tamper-check","side":"Yes"})).deposit(NearToken::from_millinear(1)).transact().await.unwrap().into_result().unwrap();
    worker.fast_forward(10).await.unwrap();
    let prompt: String = view(&contract, "get_arbiter_prompt", json!({"id":"tamper-check"})).await;
    let request_body = json!({"model":"Qwen/Qwen3.6-35B-A3B-FP8","messages":[{"role":"user","content":prompt}],"max_tokens":128,"stream":false}).to_string();
    let response_body = "{}".to_string();
    let result = arbiter.call(contract.id(), "resolve")
        .args_json(json!({"id":"tamper-check","outcome":"Yes","evidence":{
            "public_key":"00","model_id":"Qwen/Qwen3.6-35B-A3B-FP8","request_sha256":sha(request_body.as_bytes()),
            "response_sha256":"00".repeat(32),"signature":"00","request_body":request_body,"response_body":response_body
        }})).transact().await.unwrap();
    assert!(format!("{:?}", result.into_result().unwrap_err()).contains("response hash mismatch"));
    let fact: Value = view(&contract, "get_fact", json!({"id":"tamper-check"})).await;
    assert_eq!(fact["status"], "Open");
}
