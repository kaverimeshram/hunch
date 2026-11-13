use near_sdk::{
    borsh::{BorshDeserialize, BorshSerialize},
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use uint::construct_uint;

construct_uint! { pub struct U256(4); }

const REGISTRY_GAS: Gas = Gas::from_tgas(30);
const RESOLVE_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const FACT_BOND: u128 = 100_000_000_000_000_000_000_000;
const MAX_FACTS: u32 = 100;
const MAX_STAKERS: u32 = 64;
const MAX_CLAIM_BYTES: usize = 1024;
const MAX_SOURCE_BYTES: usize = 1024;
const MAX_RECEIPT_BYTES: usize = 16_384;

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Side { Yes, No }

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Status { Open, Pending, Resolved }

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Fact {
    pub id: String,
    pub claim: String,
    pub resolve_after: u64,
    #[serde(with = "u128_string")]
    #[schemars(with = "String")]
    pub yes_pool: u128,
    #[serde(with = "u128_string")]
    #[schemars(with = "String")]
    pub no_pool: u128,
    pub status: Status,
    pub outcome: Option<Side>,
    pub reasoning: Option<String>,
    pub sources: Vec<String>,
    #[schemars(with = "String")]
    pub creator: AccountId,
    pub stakers: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Receipt {
    pub public_key: String,
    pub model_id: String,
    pub request_sha256: String,
    pub response_sha256: String,
    pub signature: String,
    pub request_body: String,
    pub response_body: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
struct Verdict { ok: bool, reason: String }

#[ext_contract(ext_sworn)]
trait SwornRegistry {
    fn check(
        &self, public_key: String, model_id: String, request_sha256: String,
        response_sha256: String, signature: String, required_platform: Option<String>,
        required_app_id: Option<String>,
    ) -> Verdict;
}

#[ext_contract(ext_self)]
trait ResolutionCallback {
    fn finish_resolution(&mut self, id: String) -> bool;
    fn finish_claim(&mut self, id: String, account: AccountId) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hunch {
    arbiter: AccountId,
    registry: AccountId,
    model_id: String,
    facts: near_sdk::store::LookupMap<String, Fact>,
    stakes: near_sdk::store::LookupMap<String, u128>,
    claimed: near_sdk::store::LookupMap<String, bool>,
    evidence: near_sdk::store::LookupMap<String, Receipt>,
    fact_count: u32,
}

#[near]
impl Hunch {
    #[init]
    pub fn new(arbiter: AccountId, registry: AccountId, model_id: String) -> Self {
        require!(!model_id.is_empty() && model_id.len() <= 256, "invalid model id");
        Self {
            arbiter, registry, model_id,
            facts: near_sdk::store::LookupMap::new(b"f"),
            stakes: near_sdk::store::LookupMap::new(b"s"),
            claimed: near_sdk::store::LookupMap::new(b"c"),
            evidence: near_sdk::store::LookupMap::new(b"e"),
            fact_count: 0,
        }
    }

    #[payable]
    pub fn create_fact(&mut self, id: String, claim: String, resolve_after: u64) {
        require!(env::attached_deposit().as_yoctonear() >= FACT_BOND, "attach 0.1 NEAR fact storage bond");
        require!(!id.is_empty() && id.len() <= 64, "invalid fact id");
        require!(!claim.trim().is_empty() && claim.len() <= MAX_CLAIM_BYTES, "invalid claim");
        require!(resolve_after > env::block_timestamp_ms(), "resolution time must be in the future");
        require!(self.fact_count < MAX_FACTS, "fact capacity reached");
        require!(self.facts.get(&id).is_none(), "fact already exists");
        self.facts.insert(id.clone(), Fact {
            id, claim, resolve_after, yes_pool: 0, no_pool: 0, status: Status::Open,
            outcome: None, reasoning: None, sources: Vec::new(),
            creator: env::predecessor_account_id(), stakers: 0,
        });
        self.fact_count += 1;
    }

    pub fn add_source(&mut self, id: String, source: String) {
        let mut fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(env::predecessor_account_id() == fact.creator, "only creator can add sources");
        require!(fact.status == Status::Open && env::block_timestamp_ms() < fact.resolve_after, "fact is closed");
        require!(source.starts_with("https://") && source.len() <= MAX_SOURCE_BYTES, "source must be an https URL");
        require!(fact.sources.len() < 8 && !fact.sources.contains(&source), "source limit reached or duplicate");
        fact.sources.push(source);
        self.facts.insert(id, fact);
    }

    #[payable]
    pub fn stake(&mut self, id: String, side: Side) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "stake must be positive");
        let mut fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() < fact.resolve_after, "staking is closed");
        let account = env::predecessor_account_id();
        let yes_key = stake_key(&id, &account, &Side::Yes);
        let no_key = stake_key(&id, &account, &Side::No);
        if self.stakes.get(&yes_key).is_none() && self.stakes.get(&no_key).is_none() {
            require!(fact.stakers < MAX_STAKERS, "fact reached its staker limit");
            fact.stakers += 1;
        }
        let key = stake_key(&id, &account, &side);
        match side { Side::Yes => fact.yes_pool += amount, Side::No => fact.no_pool += amount }
        self.stakes.insert(key.clone(), self.stakes.get(&key).copied().unwrap_or(0) + amount);
        self.facts.insert(id, fact);
    }

    pub fn get_arbiter_prompt(&self, id: String) -> String {
        let fact = self.facts.get(&id).expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() >= fact.resolve_after, "fact is not ready to resolve");
        prompt(fact)
    }

    pub fn resolve(&mut self, id: String, outcome: Side, evidence: Receipt) -> PromiseOrValue<bool> {
        require!(env::predecessor_account_id() == self.arbiter, "only arbiter can resolve");
        let mut fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() >= fact.resolve_after, "fact is not ready to resolve");
        require!(evidence.model_id == self.model_id, "model is not configured");
        require!(match outcome { Side::Yes => fact.yes_pool > 0, Side::No => fact.no_pool > 0 }, "winning side has no stake");
        require!(evidence.request_body.len() <= MAX_RECEIPT_BYTES && evidence.response_body.len() <= MAX_RECEIPT_BYTES, "receipt too large");
        require!(sha256_hex(evidence.request_body.as_bytes()) == evidence.request_sha256, "request hash mismatch");
        require!(sha256_hex(evidence.response_body.as_bytes()) == evidence.response_sha256, "response hash mismatch");
        let request: serde_json::Value = serde_json::from_str(&evidence.request_body).expect("invalid request JSON");
        require!(request.get("model").and_then(|v| v.as_str()) == Some(self.model_id.as_str()), "request model mismatch");
        let content = request.get("messages").and_then(|v| v.as_array()).and_then(|m| m.first())
            .and_then(|m| m.get("content")).and_then(|v| v.as_str()).expect("request has no user prompt");
        require!(content == prompt(&fact), "request does not match the current claim, odds, and sources");
        let response: serde_json::Value = serde_json::from_str(&evidence.response_body).expect("invalid response JSON");
        let content = response.get("choices").and_then(|v| v.as_array()).and_then(|m| m.first())
            .and_then(|m| m.get("message")).and_then(|m| m.get("content")).and_then(|v| v.as_str()).expect("response has no signed answer");
        let answer: serde_json::Value = serde_json::from_str(content).expect("signed answer is not JSON");
        let expected = match outcome { Side::Yes => "yes", Side::No => "no" };
        require!(answer.get("outcome").and_then(|v| v.as_str()) == Some(expected), "signed answer outcome mismatch");
        let reasoning = answer.get("reasoning").and_then(|v| v.as_str()).expect("signed answer has no reasoning");
        require!(!reasoning.trim().is_empty() && reasoning.len() <= 4096, "invalid reasoning");
        fact.status = Status::Pending;
        self.facts.insert(id.clone(), fact);
        self.evidence.insert(id.clone(), evidence.clone());
        ext_sworn::ext(self.registry.clone())
            .with_static_gas(REGISTRY_GAS)
            .check(evidence.public_key, evidence.model_id, evidence.request_sha256,
                evidence.response_sha256, evidence.signature, None, None)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(RESOLVE_CALLBACK_GAS).finish_resolution(id))
            .into()
    }

    #[private]
    pub fn finish_resolution(&mut self, id: String, #[callback_result] result: Result<Verdict, PromiseError>) -> bool {
        let mut fact = match self.facts.get(&id).cloned() { Some(f) if f.status == Status::Pending => f, _ => return false };
        let verdict = match result { Ok(v) => v, Err(_) => { fact.status = Status::Open; self.evidence.remove(&id); self.facts.insert(id, fact); return false; } };
        if !verdict.ok {
            fact.status = Status::Open;
            self.evidence.remove(&id);
            self.facts.insert(id, fact);
            return false;
        }
        let evidence = self.evidence.get(&id).expect("pending receipt missing");
        let body: serde_json::Value = serde_json::from_str(&evidence.response_body).expect("validated response missing");
        let answer: serde_json::Value = serde_json::from_str(body["choices"][0]["message"]["content"].as_str().expect("validated answer missing")).expect("validated answer invalid");
        fact.outcome = Some(if answer["outcome"] == "yes" { Side::Yes } else { Side::No });
        fact.reasoning = answer["reasoning"].as_str().map(str::to_owned);
        fact.status = Status::Resolved;
        self.evidence.remove(&id);
        self.facts.insert(id, fact);
        true
    }

    #[private]
    pub fn finish_claim(&mut self, id: String, account: AccountId, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let key = account_key(&id, &account);
        if result.is_err() { self.claimed.remove(&key); return false; }
        true
    }

    pub fn claim(&mut self, id: String) -> PromiseOrValue<bool> {
        let fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(fact.status == Status::Resolved, "fact is not resolved");
        let side = fact.outcome.expect("resolved outcome missing");
        let account = env::predecessor_account_id();
        let key = account_key(&id, &account);
        require!(!self.claimed.get(&key).copied().unwrap_or(false), "winnings already claimed");
        let stake = self.stakes.get(&stake_key(&id, &account, &side)).copied().unwrap_or(0);
        require!(stake > 0, "no winning stake");
        let winning = match side { Side::Yes => fact.yes_pool, Side::No => fact.no_pool };
        let total = fact.yes_pool + fact.no_pool;
        require!(winning > 0, "winning side has no stakes");
        let payout = (U256::from(stake) * U256::from(total) / U256::from(winning)).as_u128();
        self.claimed.insert(key, true);
        Promise::new(account.clone())
            .transfer(NearToken::from_yoctonear(payout))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).finish_claim(id, account))
            .into()
    }

    pub fn get_fact(&self, id: String) -> Option<Fact> { self.facts.get(&id).cloned() }

    pub fn get_stake(&self, id: String, account: AccountId, side: Side) -> near_sdk::json_types::U128 {
        require!(self.facts.get(&id).is_some(), "unknown fact");
        near_sdk::json_types::U128(self.stakes.get(&stake_key(&id, &account, &side)).copied().unwrap_or(0))
    }
}

mod u128_string {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        String::deserialize(deserializer)?.parse().map_err(D::Error::custom)
    }
}

fn prompt(fact: &Fact) -> String {
    format!("Evaluate this claim using only the cited sources. Cite source URLs in the reasoning. Return JSON with outcome (yes or no) and concise reasoning.\nClaim: {}\nYES pool: {} yoctoNEAR\nNO pool: {} yoctoNEAR\nSources:\n{}", fact.claim, fact.yes_pool, fact.no_pool, fact.sources.join("\n"))
}

fn stake_key(id: &str, account: &AccountId, side: &Side) -> String { format!("{id}:{account}:{side:?}") }
fn account_key(id: &str, account: &AccountId) -> String { format!("{id}:{account}") }

fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};

    fn account(s: &str) -> AccountId { s.parse().unwrap() }
    fn setup(who: &str, now: u64, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(account(who)).block_timestamp(now).attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    #[test]
    fn fact_market_records_stakes_and_odds_inputs() {
        setup("alice.testnet", 1_000_000_000, FACT_BOND);
        let mut c = Hunch::new(account("arbiter.testnet"), account("sworn.testnet"), "Qwen/Qwen3.8-27B".into());
        c.create_fact("f".into(), "Claim".into(), 2_000);
        c.add_source("f".into(), "https://example.com/source".into());
        setup("alice.testnet", 1_100_000_000, 10);
        c.stake("f".into(), Side::Yes);
        setup("bob.testnet", 1_200_000_000, 30);
        c.stake("f".into(), Side::No);
        let fact = c.get_fact("f".into()).unwrap();
        assert_eq!((fact.yes_pool, fact.no_pool, fact.stakers), (10, 30, 2));
        setup("bob.testnet", 2_000_000_000, 0);
        assert!(c.get_arbiter_prompt("f".into()).contains("YES pool: 10 yoctoNEAR"));
        assert!(c.get_arbiter_prompt("f".into()).contains("https://example.com/source"));
    }

    #[test]
    #[should_panic(expected = "only arbiter can resolve")]
    fn resolve_without_arbiter_is_refused() {
        setup("alice.testnet", 3_000_000_000, FACT_BOND);
        let mut c = Hunch::new(account("arbiter.testnet"), account("sworn.testnet"), "Qwen/Qwen3.8-27B".into());
        c.create_fact("f".into(), "Claim".into(), 4_000);
        setup("mallory.testnet", 4_000_000_000, 0);
        let receipt = Receipt { public_key: String::new(), model_id: "Qwen/Qwen3.8-27B".into(), request_sha256: String::new(), response_sha256: String::new(), signature: String::new(), request_body: String::new(), response_body: String::new() };
        let _ = c.resolve("f".into(), Side::Yes, receipt);
    }
}
