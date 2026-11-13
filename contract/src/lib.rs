use near_sdk::{
    borsh::{BorshDeserialize, BorshSerialize},
    env, ext_contract, json_types::U128, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
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
/// Raised from 16 KiB so a prompt carrying the full evidence list still fits.
const MAX_RECEIPT_BYTES: usize = 32_768;
const MAX_REASONING_BYTES: usize = 4096;

/// Storage deposit for one evidence submission (covers ~1 KB of contract storage).
const EVIDENCE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
const MAX_EVIDENCE_PER_FACT: usize = 16;
const MAX_EVIDENCE_URL_BYTES: usize = 512;
const MAX_NOTE_BYTES: usize = 280;
/// After resolve_after + this grace period, anyone may void an unresolved market so stakes can be refunded.
const RESOLUTION_GRACE_MS: u64 = 14 * 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT: u32 = 50;

// Storage prefixes for data added after the first deployment. They are written with raw
// env::storage_* calls instead of new fields on `Hunch`, so the root state layout of
// already-deployed contracts does not change. Existing prefixes: f, s, c, e and STATE.
const EVIDENCE_PREFIX: &[u8] = b"v";
const HISTORY_PREFIX: &[u8] = b"h";
const INDEX_PREFIX: &[u8] = b"i";
const CURATOR_KEY: &[u8] = b"k:curator";

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Side { Yes, No }

/// `Void` is appended last so existing Borsh-encoded statuses keep their meaning.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Status { Open, Pending, Resolved, Void }

/// What the attested arbiter answered. `Yes` and `No` are accepted in JSON exactly as before.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Outcome { Yes, No, Insufficient }

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum Stance { Supporting, Contradicting, Context, Unclassified }

/// Review checks that a source is relevant and genuine. It never means the source is accurate.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum ReviewStatus { Pending, Reviewed, Rejected }

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

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct EvidenceItem {
    pub evidence_id: u32,
    pub url: String,
    pub stance: Stance,
    pub note: Option<String>,
    #[schemars(with = "String")]
    pub submitted_by: AccountId,
    pub submitted_at: u64,
    pub review_status: ReviewStatus,
    #[schemars(with = "Option<String>")]
    pub reviewed_by: Option<AccountId>,
    pub reviewed_at: Option<u64>,
}

/// Hashes and signature the Sworn registry verified. Bodies stay in the resolve transaction.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Attestation {
    #[schemars(with = "String")]
    pub registry: AccountId,
    pub model_id: String,
    pub public_key: String,
    pub request_sha256: String,
    pub response_sha256: String,
    pub signature: String,
}

/// One settlement event for a fact. Appended, never edited.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct ResolutionRecord {
    /// The arbiter's attested answer, or None when the market was voided without one.
    pub outcome: Option<Outcome>,
    /// Resulting market status: Resolved (winners paid) or Void (all stakes refunded).
    pub settlement: Status,
    pub reason: String,
    pub reasoning: Option<String>,
    pub attestation: Option<Attestation>,
    #[schemars(with = "String")]
    pub recorded_by: AccountId,
    pub recorded_at: u64,
    pub block_height: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    #[schemars(with = "String")]
    pub arbiter: AccountId,
    #[schemars(with = "String")]
    pub registry: AccountId,
    pub model_id: String,
    #[schemars(with = "Option<String>")]
    pub curator: Option<AccountId>,
    pub fact_count: u32,
    #[schemars(with = "String")]
    pub evidence_deposit: U128,
    pub max_evidence_per_fact: u32,
    pub resolution_grace_ms: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct Verdict { ok: bool, reason: String }

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
    /// Pending arbiter receipts awaiting the Sworn check (not community evidence).
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
        save(&index_key(self.fact_count), &id);
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

    // ---------- Community evidence ----------

    /// Submit a source for an open fact. Attach exactly 0.01 NEAR to cover storage.
    /// Returns the new evidence id. URLs are normalised and duplicates are refused.
    #[payable]
    pub fn submit_evidence(&mut self, fact_id: String, url: String, stance: Stance, note: Option<String>) -> u32 {
        require!(env::attached_deposit().as_yoctonear() == EVIDENCE_DEPOSIT, "attach exactly 0.01 NEAR evidence storage deposit");
        let fact = self.facts.get(&fact_id).expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() < fact.resolve_after, "evidence is closed for this fact");
        let url = normalize_url(&url).unwrap_or_else(|| env::panic_str("evidence must be a valid https URL of at most 512 bytes"));
        let note = match note.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(text) => {
                require!(text.len() <= MAX_NOTE_BYTES, "note must be at most 280 bytes");
                require!(!text.chars().any(char::is_control), "note must not contain control characters");
                Some(text.to_owned())
            }
        };
        let mut items: Vec<EvidenceItem> = load(&evidence_key(&fact_id)).unwrap_or_default();
        require!(items.len() < MAX_EVIDENCE_PER_FACT, "evidence limit reached for this fact");
        let duplicate = items.iter().any(|item| item.url == url)
            || fact.sources.iter().any(|source| normalize_url(source).as_deref() == Some(url.as_str()));
        require!(!duplicate, "this source is already listed for this fact");
        let evidence_id = items.len() as u32;
        items.push(EvidenceItem {
            evidence_id, url, stance, note,
            submitted_by: env::predecessor_account_id(),
            submitted_at: env::block_timestamp_ms(),
            review_status: ReviewStatus::Pending, reviewed_by: None, reviewed_at: None,
        });
        save(&evidence_key(&fact_id), &items);
        evidence_id
    }

    /// Curator-only. Marks a submitted source as reviewed (relevant and genuine) or rejected.
    /// Rejected evidence stays visible but is left out of the arbiter prompt.
    pub fn review_evidence(&mut self, fact_id: String, evidence_id: u32, status: ReviewStatus) {
        let curator: Option<AccountId> = load(CURATOR_KEY);
        require!(curator.as_ref() == Some(&env::predecessor_account_id()), "only the curator can review evidence");
        let fact = self.facts.get(&fact_id).expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() < fact.resolve_after, "evidence is closed for this fact");
        let mut items: Vec<EvidenceItem> = load(&evidence_key(&fact_id)).unwrap_or_default();
        let item = items.get_mut(evidence_id as usize).unwrap_or_else(|| env::panic_str("unknown evidence"));
        item.review_status = status;
        item.reviewed_by = Some(env::predecessor_account_id());
        item.reviewed_at = Some(env::block_timestamp_ms());
        save(&evidence_key(&fact_id), &items);
    }

    /// Only the contract account can appoint the evidence curator. Checked explicitly
    /// (rather than with #[private]) so the rule is also exercised by unit tests.
    pub fn set_curator(&mut self, curator: AccountId) {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract account can appoint the curator");
        save(CURATOR_KEY, &curator);
    }

    // ---------- Resolution ----------

    pub fn get_arbiter_prompt(&self, id: String) -> String {
        let fact = self.facts.get(&id).expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() >= fact.resolve_after, "fact is not ready to resolve");
        prompt(fact, &load::<Vec<EvidenceItem>>(&evidence_key(&id)).unwrap_or_default())
    }

    pub fn resolve(&mut self, id: String, outcome: Outcome, evidence: Receipt) -> PromiseOrValue<bool> {
        require!(env::predecessor_account_id() == self.arbiter, "only arbiter can resolve");
        let mut fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(fact.status == Status::Open && env::block_timestamp_ms() >= fact.resolve_after, "fact is not ready to resolve");
        require!(evidence.model_id == self.model_id, "model is not configured");
        require!(evidence.request_body.len() <= MAX_RECEIPT_BYTES && evidence.response_body.len() <= MAX_RECEIPT_BYTES, "receipt too large");
        require!(sha256_hex(evidence.request_body.as_bytes()) == evidence.request_sha256, "request hash mismatch");
        require!(sha256_hex(evidence.response_body.as_bytes()) == evidence.response_sha256, "response hash mismatch");
        let request: serde_json::Value = serde_json::from_str(&evidence.request_body).expect("invalid request JSON");
        require!(request.get("model").and_then(|v| v.as_str()) == Some(self.model_id.as_str()), "request model mismatch");
        let content = request.get("messages").and_then(|v| v.as_array()).and_then(|m| m.first())
            .and_then(|m| m.get("content")).and_then(|v| v.as_str()).expect("request has no user prompt");
        let items: Vec<EvidenceItem> = load(&evidence_key(&id)).unwrap_or_default();
        require!(content == prompt(&fact, &items), "request does not match the current claim and evidence");
        let (signed_outcome, _) = signed_answer(&evidence.response_body);
        require!(signed_outcome == outcome, "signed answer outcome mismatch");
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
        let verified = matches!(result, Ok(Verdict { ok: true, .. }));
        let receipt = match self.evidence.remove(&id) { Some(r) => r, None => env::panic_str("pending receipt missing") };
        if !verified {
            fact.status = Status::Open;
            self.facts.insert(id, fact);
            return false;
        }
        let (outcome, reasoning) = signed_answer(&receipt.response_body);
        let (settlement, reason) = match outcome {
            Outcome::Insufficient => (Status::Void, "The attested arbiter found the evidence insufficient. All stakes are refundable."),
            Outcome::Yes if fact.yes_pool == 0 => (Status::Void, "The attested answer was YES but nobody staked YES. All stakes are refundable."),
            Outcome::No if fact.no_pool == 0 => (Status::Void, "The attested answer was NO but nobody staked NO. All stakes are refundable."),
            Outcome::Yes | Outcome::No => (Status::Resolved, "Resolved by an attested arbiter answer verified through the Sworn registry."),
        };
        fact.outcome = match (&settlement, &outcome) {
            (Status::Resolved, Outcome::Yes) => Some(Side::Yes),
            (Status::Resolved, Outcome::No) => Some(Side::No),
            _ => None,
        };
        fact.reasoning = Some(reasoning.clone());
        fact.status = settlement.clone();
        self.facts.insert(id.clone(), fact);
        push_history(&id, ResolutionRecord {
            outcome: Some(outcome), settlement, reason: reason.to_owned(), reasoning: Some(reasoning),
            attestation: Some(Attestation {
                registry: self.registry.clone(), model_id: receipt.model_id, public_key: receipt.public_key,
                request_sha256: receipt.request_sha256, response_sha256: receipt.response_sha256, signature: receipt.signature,
            }),
            recorded_by: self.arbiter.clone(), recorded_at: env::block_timestamp_ms(), block_height: env::block_height(),
        });
        true
    }

    /// Anyone may void a market the arbiter has not settled within the grace period,
    /// so stakes can never be locked forever.
    pub fn void_expired(&mut self, id: String) {
        let mut fact = self.facts.get(&id).cloned().expect("unknown fact");
        require!(fact.status == Status::Open || fact.status == Status::Pending, "fact is already settled");
        require!(env::block_timestamp_ms() >= fact.resolve_after.saturating_add(RESOLUTION_GRACE_MS), "the resolution grace period has not ended");
        self.evidence.remove(&id);
        fact.status = Status::Void;
        fact.outcome = None;
        self.facts.insert(id.clone(), fact);
        push_history(&id, ResolutionRecord {
            outcome: None, settlement: Status::Void,
            reason: "No attested resolution within 14 days of the deadline. All stakes are refundable.".to_owned(),
            reasoning: None, attestation: None,
            recorded_by: env::predecessor_account_id(), recorded_at: env::block_timestamp_ms(), block_height: env::block_height(),
        });
    }

    // ---------- Payouts ----------

    #[private]
    pub fn finish_claim(&mut self, id: String, account: AccountId, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let key = account_key(&id, &account);
        if result.is_err() { self.claimed.remove(&key); return false; }
        true
    }

    /// Resolved: winners receive a pro rata share of both pools.
    /// Void: every staker receives their own YES and NO stakes back.
    pub fn claim(&mut self, id: String) -> PromiseOrValue<bool> {
        let fact = self.facts.get(&id).cloned().expect("unknown fact");
        let account = env::predecessor_account_id();
        let key = account_key(&id, &account);
        require!(!self.claimed.get(&key).copied().unwrap_or(false), "winnings already claimed");
        let yes = self.stakes.get(&stake_key(&id, &account, &Side::Yes)).copied().unwrap_or(0);
        let no = self.stakes.get(&stake_key(&id, &account, &Side::No)).copied().unwrap_or(0);
        let payout = payout_for(&fact, yes, no);
        require!(payout > 0, match fact.status { Status::Void => "no stake to refund", _ => "no winning stake" });
        self.claimed.insert(key, true);
        Promise::new(account.clone())
            .transfer(NearToken::from_yoctonear(payout))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).finish_claim(id, account))
            .into()
    }

    // ---------- Views ----------

    pub fn get_fact(&self, id: String) -> Option<Fact> { self.facts.get(&id).cloned() }

    pub fn get_stake(&self, id: String, account: AccountId, side: Side) -> U128 {
        require!(self.facts.get(&id).is_some(), "unknown fact");
        U128(self.stakes.get(&stake_key(&id, &account, &side)).copied().unwrap_or(0))
    }

    pub fn get_claimed(&self, id: String, account: AccountId) -> bool {
        self.claimed.get(&account_key(&id, &account)).copied().unwrap_or(false)
    }

    /// Facts in creation order. Facts created before this index existed are skipped.
    pub fn list_facts(&self, from_index: u32, limit: u32) -> Vec<Fact> {
        let end = from_index.saturating_add(limit.min(MAX_LIST_LIMIT)).min(self.fact_count);
        (from_index..end)
            .filter_map(|i| load::<String>(&index_key(i)))
            .filter_map(|id| self.facts.get(&id).cloned())
            .collect()
    }

    pub fn get_evidence(&self, fact_id: String) -> Vec<EvidenceItem> {
        load(&evidence_key(&fact_id)).unwrap_or_default()
    }

    pub fn get_resolution_history(&self, id: String) -> Vec<ResolutionRecord> {
        load(&history_key(&id)).unwrap_or_default()
    }

    pub fn get_config(&self) -> Config {
        Config {
            arbiter: self.arbiter.clone(), registry: self.registry.clone(), model_id: self.model_id.clone(),
            curator: load(CURATOR_KEY), fact_count: self.fact_count,
            evidence_deposit: U128(EVIDENCE_DEPOSIT), max_evidence_per_fact: MAX_EVIDENCE_PER_FACT as u32,
            resolution_grace_ms: RESOLUTION_GRACE_MS,
        }
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

/// The arbiter prompt. It deliberately contains no stake or odds information: the market
/// shows what participants believe, and must not influence the evidence-based judgment.
fn prompt(fact: &Fact, evidence: &[EvidenceItem]) -> String {
    let creator_sources = if fact.sources.is_empty() { "- none".to_owned() } else {
        fact.sources.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")
    };
    let submitted: Vec<String> = evidence.iter()
        .filter(|item| item.review_status != ReviewStatus::Rejected)
        .map(|item| format!("- [{:?}, review {:?}] {}", item.stance, item.review_status, item.url))
        .collect();
    let submitted = if submitted.is_empty() { "- none".to_owned() } else { submitted.join("\n") };
    format!(
        "Resolve this factual claim. Judge it only on the sources listed below and what they report. \
Ignore popularity, betting and how many sources take each side. Labels on submitted sources are the \
submitter's own classification and are unverified. Cite source URLs in the reasoning. Use \"insufficient\" \
when the sources do not establish the answer either way. Reply with JSON only: \
{{\"outcome\": \"yes\" | \"no\" | \"insufficient\", \"reasoning\": \"...\"}}\n\
Claim: {}\nSources from the claim creator:\n{}\nSubmitted evidence:\n{}",
        fact.claim, creator_sources, submitted,
    )
}

/// Parse the signed completion body into (outcome, reasoning). Panics on anything malformed.
/// Tolerates a ```json code fence around the answer, which some models add.
fn signed_answer(response_body: &str) -> (Outcome, String) {
    let response: serde_json::Value = serde_json::from_str(response_body).expect("invalid response JSON");
    let content = response.get("choices").and_then(|v| v.as_array()).and_then(|m| m.first())
        .and_then(|m| m.get("message")).and_then(|m| m.get("content")).and_then(|v| v.as_str())
        .expect("response has no signed answer");
    let mut text = content.trim();
    if let Some(inner) = text.strip_prefix("```") {
        text = inner.trim_start_matches("json").trim().strip_suffix("```").unwrap_or(inner).trim();
    }
    let answer: serde_json::Value = serde_json::from_str(text).expect("signed answer is not JSON");
    let outcome = match answer.get("outcome").and_then(|v| v.as_str()) {
        Some("yes") => Outcome::Yes,
        Some("no") => Outcome::No,
        Some("insufficient") => Outcome::Insufficient,
        _ => env::panic_str("signed answer outcome must be yes, no or insufficient"),
    };
    let reasoning = answer.get("reasoning").and_then(|v| v.as_str()).expect("signed answer has no reasoning");
    require!(!reasoning.trim().is_empty() && reasoning.len() <= MAX_REASONING_BYTES, "invalid reasoning");
    (outcome, reasoning.to_owned())
}

/// Amount owed to an account with the given YES and NO stakes.
fn payout_for(fact: &Fact, yes: u128, no: u128) -> u128 {
    match (&fact.status, &fact.outcome) {
        (Status::Resolved, Some(side)) => {
            let (stake, winning) = match side { Side::Yes => (yes, fact.yes_pool), Side::No => (no, fact.no_pool) };
            if stake == 0 || winning == 0 { return 0; }
            (U256::from(stake) * U256::from(fact.yes_pool + fact.no_pool) / U256::from(winning)).as_u128()
        }
        (Status::Void, _) => yes + no,
        (Status::Open | Status::Pending, _) => env::panic_str("fact is not settled"),
        (Status::Resolved, None) => env::panic_str("resolved outcome missing"),
    }
}

/// Canonical form of an evidence URL: https only, lowercase host, no credentials, no
/// fragment, at least "/" as path. Returns None for anything else.
fn normalize_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    // ASCII check first: it also makes the byte slicing below safe.
    if !raw.bytes().all(|b| b.is_ascii_graphic()) { return None; }
    if raw.len() > MAX_EVIDENCE_URL_BYTES || raw.len() <= 8 || !raw[..8].eq_ignore_ascii_case("https://") { return None; }
    let rest = &raw[8..];
    let rest = rest.split('#').next().unwrap_or("");
    let split = rest.find(['/', '?']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(split);
    let valid_host = !host.is_empty() && host.contains('.') && !host.starts_with(['.', '-', ':'])
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':');
    if !valid_host { return None; }
    let tail = if tail.starts_with('/') { tail.to_owned() } else { format!("/{tail}") };
    Some(format!("https://{}{}", host.to_ascii_lowercase(), tail))
}

fn push_history(id: &str, record: ResolutionRecord) {
    let mut history: Vec<ResolutionRecord> = load(&history_key(id)).unwrap_or_default();
    history.push(record);
    save(&history_key(id), &history);
}

fn prefixed(prefix: &[u8], id: &str) -> Vec<u8> { [prefix, id.as_bytes()].concat() }
fn evidence_key(id: &str) -> Vec<u8> { prefixed(EVIDENCE_PREFIX, id) }
fn history_key(id: &str) -> Vec<u8> { prefixed(HISTORY_PREFIX, id) }
fn index_key(index: u32) -> Vec<u8> { [INDEX_PREFIX, &index.to_le_bytes()].concat() }

fn load<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|bytes| T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("corrupt storage value")))
}

fn save<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(key, &near_sdk::borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("storage encoding failed")));
}

fn stake_key(id: &str, account: &AccountId, side: &Side) -> String { format!("{id}:{account}:{side:?}") }
fn account_key(id: &str, account: &AccountId) -> String { format!("{id}:{account}") }

fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests;
