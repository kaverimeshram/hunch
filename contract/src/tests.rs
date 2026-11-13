use super::*;
use near_sdk::{test_utils::VMContextBuilder, testing_env};

const MODEL: &str = "Qwen/Qwen3.8-27B";
const CONTRACT: &str = "hunch.testnet";
const CREATOR_SOURCE: &str = "https://example.com/source";

fn account(s: &str) -> AccountId { s.parse().unwrap() }

/// Set the caller, block time in milliseconds, and attached deposit for the next call.
fn at(who: &str, ms: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account(CONTRACT))
        .predecessor_account_id(account(who))
        .block_timestamp(ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

/// Contract with fact "f" (closes at t=2000 ms), one creator source, alice YES 10, bob NO 30.
fn market() -> Hunch {
    at("alice.testnet", 1_000, FACT_BOND);
    let mut c = Hunch::new(account("arbiter.testnet"), account("sworn.testnet"), MODEL.into());
    c.create_fact("f".into(), "Claim".into(), 2_000);
    c.add_source("f".into(), CREATOR_SOURCE.into());
    at("alice.testnet", 1_100, 10);
    c.stake("f".into(), Side::Yes);
    at("bob.testnet", 1_200, 30);
    c.stake("f".into(), Side::No);
    c
}

/// A receipt whose request is the contract's current prompt and whose answer is `answer`.
fn receipt(c: &Hunch, answer: &str) -> Receipt {
    at("arbiter.testnet", 3_000, 0);
    let prompt = c.get_arbiter_prompt("f".into());
    let request_body = serde_json::json!({"model": MODEL, "messages": [{"role": "user", "content": prompt}]}).to_string();
    let response_body = serde_json::json!({"choices": [{"message": {"content": answer}}]}).to_string();
    Receipt {
        public_key: "ed25519:pk".into(), model_id: MODEL.into(),
        request_sha256: sha256_hex(request_body.as_bytes()), response_sha256: sha256_hex(response_body.as_bytes()),
        signature: "sig".into(), request_body, response_body,
    }
}

fn answer(outcome: &str) -> String { format!(r#"{{"outcome":"{outcome}","reasoning":"Per {CREATOR_SOURCE}."}}"#) }

/// Arbiter submits the answer, then the Sworn callback reports `verified`.
fn settle(c: &mut Hunch, outcome: Outcome, answer: &str, verified: bool) -> bool {
    let r = receipt(c, answer);
    at("arbiter.testnet", 3_000, 0);
    let _ = c.resolve("f".into(), outcome, r);
    assert_eq!(c.get_fact("f".into()).unwrap().status, Status::Pending);
    at(CONTRACT, 3_001, 0);
    c.finish_resolution("f".into(), Ok(Verdict { ok: verified, reason: String::new() }))
}

fn submit(c: &mut Hunch, who: &str, url: &str, stance: Stance) -> u32 {
    at(who, 1_500, EVIDENCE_DEPOSIT);
    c.submit_evidence("f".into(), url.into(), stance, None)
}

// ---------- market basics and prompt ----------

#[test]
fn stakes_update_pools_and_prompt_never_shows_the_market() {
    let c = market();
    let fact = c.get_fact("f".into()).unwrap();
    assert_eq!((fact.yes_pool, fact.no_pool, fact.stakers), (10, 30, 2));
    at("bob.testnet", 2_000, 0);
    let prompt = c.get_arbiter_prompt("f".into());
    assert!(prompt.contains("Claim: Claim"));
    assert!(prompt.contains(CREATOR_SOURCE));
    for leak in ["pool", "yocto", "stake", "odds", "YES pool", "NO pool"] {
        assert!(!prompt.to_lowercase().contains(&leak.to_lowercase()), "prompt leaks market data: {leak}");
    }
}

#[test]
#[should_panic(expected = "only arbiter can resolve")]
fn resolve_without_arbiter_is_refused() {
    let mut c = market();
    let r = receipt(&c, &answer("yes"));
    at("mallory.testnet", 3_000, 0);
    let _ = c.resolve("f".into(), Outcome::Yes, r);
}

#[test]
fn list_facts_returns_facts_in_creation_order() {
    at("alice.testnet", 1_000, FACT_BOND);
    let mut c = Hunch::new(account("arbiter.testnet"), account("sworn.testnet"), MODEL.into());
    for id in ["a", "b", "c"] { c.create_fact(id.into(), format!("Claim {id}"), 2_000); }
    let ids = |v: Vec<Fact>| v.into_iter().map(|f| f.id).collect::<Vec<_>>();
    assert_eq!(ids(c.list_facts(0, 10)), ["a", "b", "c"]);
    assert_eq!(ids(c.list_facts(1, 1)), ["b"]);
    assert!(c.list_facts(5, 10).is_empty());
    assert_eq!(c.get_config().fact_count, 3);
}

// ---------- resolution outcomes ----------

#[test]
fn attested_yes_resolves_pays_winners_and_records_history() {
    let mut c = market();
    assert!(settle(&mut c, Outcome::Yes, &answer("yes"), true));
    let fact = c.get_fact("f".into()).unwrap();
    assert_eq!((fact.status.clone(), fact.outcome.clone()), (Status::Resolved, Some(Side::Yes)));
    assert_eq!(payout_for(&fact, 10, 0), 40, "alice gets the whole 40 yocto pot");
    assert_eq!(payout_for(&fact, 0, 30), 0, "bob staked the losing side");
    let history = c.get_resolution_history("f".into());
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].outcome, Some(Outcome::Yes));
    assert_eq!(history[0].settlement, Status::Resolved);
    let attestation = history[0].attestation.as_ref().unwrap();
    assert_eq!((attestation.public_key.as_str(), attestation.model_id.as_str()), ("ed25519:pk", MODEL));
    assert_eq!(attestation.registry, account("sworn.testnet"));
}

#[test]
fn insufficient_evidence_voids_the_market_and_refunds_everyone() {
    let mut c = market();
    assert!(settle(&mut c, Outcome::Insufficient, &answer("insufficient"), true));
    let fact = c.get_fact("f".into()).unwrap();
    assert_eq!((fact.status.clone(), fact.outcome.clone()), (Status::Void, None));
    assert_eq!(payout_for(&fact, 10, 0), 10);
    assert_eq!(payout_for(&fact, 0, 30), 30);
    assert_eq!(payout_for(&fact, 5, 7), 12, "an account on both sides gets both back");
    at("alice.testnet", 4_000, 0);
    let _ = c.claim("f".into());
    assert!(c.get_claimed("f".into(), account("alice.testnet")));
    assert!(!c.get_claimed("f".into(), account("bob.testnet")));
    assert_eq!(c.get_resolution_history("f".into())[0].outcome, Some(Outcome::Insufficient));
}

#[test]
#[should_panic(expected = "winnings already claimed")]
fn refunds_cannot_be_claimed_twice() {
    let mut c = market();
    settle(&mut c, Outcome::Insufficient, &answer("insufficient"), true);
    at("alice.testnet", 4_000, 0);
    let _ = c.claim("f".into());
    let _ = c.claim("f".into());
}

#[test]
fn answer_for_a_side_nobody_staked_voids_instead_of_locking_funds() {
    at("alice.testnet", 1_000, FACT_BOND);
    let mut c = Hunch::new(account("arbiter.testnet"), account("sworn.testnet"), MODEL.into());
    c.create_fact("f".into(), "Claim".into(), 2_000);
    at("alice.testnet", 1_100, 10);
    c.stake("f".into(), Side::Yes);
    assert!(settle(&mut c, Outcome::No, &answer("no"), true));
    let fact = c.get_fact("f".into()).unwrap();
    assert_eq!(fact.status, Status::Void);
    assert_eq!(payout_for(&fact, 10, 0), 10);
    assert!(c.get_resolution_history("f".into())[0].reason.contains("nobody staked NO"));
}

#[test]
fn failed_sworn_check_reopens_the_market_and_records_nothing() {
    let mut c = market();
    assert!(!settle(&mut c, Outcome::Yes, &answer("yes"), false));
    assert_eq!(c.get_fact("f".into()).unwrap().status, Status::Open);
    assert!(c.get_resolution_history("f".into()).is_empty());
    assert!(settle(&mut c, Outcome::No, &answer("no"), true), "the arbiter can retry");
    assert_eq!(c.get_fact("f".into()).unwrap().outcome, Some(Side::No));
}

#[test]
fn answer_wrapped_in_a_code_fence_is_accepted() {
    let mut c = market();
    let fenced = format!("```json\n{}\n```", answer("yes"));
    assert!(settle(&mut c, Outcome::Yes, &fenced, true));
    assert_eq!(c.get_fact("f".into()).unwrap().status, Status::Resolved);
}

#[test]
#[should_panic(expected = "signed answer outcome mismatch")]
fn outcome_must_match_the_signed_answer() {
    let mut c = market();
    let r = receipt(&c, &answer("no"));
    at("arbiter.testnet", 3_000, 0);
    let _ = c.resolve("f".into(), Outcome::Yes, r);
}

#[test]
#[should_panic(expected = "request does not match the current claim and evidence")]
fn evidence_added_after_the_prompt_was_fetched_invalidates_the_request() {
    let mut c = market();
    let r = receipt(&c, &answer("yes"));
    // Rewind time to before the deadline to add evidence, then resolve with the stale prompt.
    submit(&mut c, "carol.testnet", "https://news.example.org/new", Stance::Contradicting);
    at("arbiter.testnet", 3_000, 0);
    let _ = c.resolve("f".into(), Outcome::Yes, r);
}

#[test]
#[should_panic(expected = "fact is not settled")]
fn claim_before_settlement_is_refused() {
    let mut c = market();
    at("alice.testnet", 1_500, 0);
    let _ = c.claim("f".into());
}

#[test]
#[should_panic(expected = "no winning stake")]
fn losing_side_cannot_claim() {
    let mut c = market();
    settle(&mut c, Outcome::Yes, &answer("yes"), true);
    at("bob.testnet", 4_000, 0);
    let _ = c.claim("f".into());
}

// ---------- expiry ----------

#[test]
#[should_panic(expected = "the resolution grace period has not ended")]
fn void_expired_waits_for_the_grace_period() {
    let mut c = market();
    at("anyone.testnet", 2_000 + RESOLUTION_GRACE_MS - 1, 0);
    c.void_expired("f".into());
}

#[test]
fn void_expired_refunds_an_abandoned_market() {
    let mut c = market();
    at("anyone.testnet", 2_000 + RESOLUTION_GRACE_MS, 0);
    c.void_expired("f".into());
    let fact = c.get_fact("f".into()).unwrap();
    assert_eq!(fact.status, Status::Void);
    assert_eq!(payout_for(&fact, 0, 30), 30);
    let history = c.get_resolution_history("f".into());
    assert_eq!((history[0].outcome.clone(), history[0].attestation.clone()), (None, None));
    assert_eq!(history[0].recorded_by, account("anyone.testnet"));
}

// ---------- evidence ----------

#[test]
fn evidence_is_recorded_with_contributor_time_and_normalised_url() {
    let mut c = market();
    at("carol.testnet", 1_500, EVIDENCE_DEPOSIT);
    let id = c.submit_evidence("f".into(), "  HTTPS://News.Example.org/story?x=1#comments ".into(), Stance::Supporting, Some("  Primary report. ".into()));
    assert_eq!(id, 0);
    let items = c.get_evidence("f".into());
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.url, "https://news.example.org/story?x=1");
    assert_eq!((item.stance.clone(), item.review_status.clone()), (Stance::Supporting, ReviewStatus::Pending));
    assert_eq!((item.submitted_by.as_str(), item.submitted_at), ("carol.testnet", 1_500));
    assert_eq!(item.note.as_deref(), Some("Primary report."));
    assert_eq!(submit(&mut c, "dave.testnet", "https://other.example.org", Stance::Context), 1);
}

#[test]
#[should_panic(expected = "this source is already listed for this fact")]
fn duplicate_evidence_is_refused_after_normalisation() {
    let mut c = market();
    submit(&mut c, "carol.testnet", "https://news.example.org/story", Stance::Supporting);
    submit(&mut c, "dave.testnet", "https://NEWS.example.org/story#top", Stance::Contradicting);
}

#[test]
#[should_panic(expected = "this source is already listed for this fact")]
fn evidence_duplicating_a_creator_source_is_refused() {
    let mut c = market();
    submit(&mut c, "carol.testnet", "https://Example.com/source", Stance::Supporting);
}

#[test]
#[should_panic(expected = "attach exactly 0.01 NEAR evidence storage deposit")]
fn evidence_requires_the_storage_deposit() {
    let mut c = market();
    at("carol.testnet", 1_500, 0);
    c.submit_evidence("f".into(), "https://news.example.org/a".into(), Stance::Supporting, None);
}

#[test]
#[should_panic(expected = "evidence must be a valid https URL")]
fn evidence_must_be_https() {
    let mut c = market();
    submit(&mut c, "carol.testnet", "http://news.example.org/a", Stance::Supporting);
}

#[test]
#[should_panic(expected = "evidence is closed for this fact")]
fn evidence_closes_at_the_deadline() {
    let mut c = market();
    at("carol.testnet", 2_000, EVIDENCE_DEPOSIT);
    c.submit_evidence("f".into(), "https://news.example.org/late".into(), Stance::Supporting, None);
}

#[test]
#[should_panic(expected = "note must be at most 280 bytes")]
fn evidence_note_is_length_limited() {
    let mut c = market();
    at("carol.testnet", 1_500, EVIDENCE_DEPOSIT);
    c.submit_evidence("f".into(), "https://news.example.org/a".into(), Stance::Supporting, Some("x".repeat(281)));
}

#[test]
#[should_panic(expected = "evidence limit reached for this fact")]
fn evidence_per_fact_is_capped() {
    let mut c = market();
    for i in 0..=MAX_EVIDENCE_PER_FACT { submit(&mut c, "carol.testnet", &format!("https://news.example.org/{i}"), Stance::Context); }
}

#[test]
fn curator_reviews_and_rejected_evidence_leaves_the_prompt() {
    let mut c = market();
    submit(&mut c, "carol.testnet", "https://kept.example.org/a", Stance::Supporting);
    submit(&mut c, "dave.testnet", "https://spam.example.org/b", Stance::Contradicting);
    at(CONTRACT, 1_600, 0);
    c.set_curator(account("curator.testnet"));
    assert_eq!(c.get_config().curator, Some(account("curator.testnet")));
    at("curator.testnet", 1_700, 0);
    c.review_evidence("f".into(), 0, ReviewStatus::Reviewed);
    c.review_evidence("f".into(), 1, ReviewStatus::Rejected);
    let items = c.get_evidence("f".into());
    assert_eq!(items[0].reviewed_by, Some(account("curator.testnet")));
    assert_eq!(items[1].review_status, ReviewStatus::Rejected);
    at("arbiter.testnet", 2_000, 0);
    let prompt = c.get_arbiter_prompt("f".into());
    assert!(prompt.contains("- [Supporting, review Reviewed] https://kept.example.org/a"));
    assert!(!prompt.contains("spam.example.org"));
}

#[test]
#[should_panic(expected = "only the curator can review evidence")]
fn only_the_curator_reviews() {
    let mut c = market();
    submit(&mut c, "carol.testnet", "https://kept.example.org/a", Stance::Supporting);
    at("carol.testnet", 1_700, 0);
    c.review_evidence("f".into(), 0, ReviewStatus::Reviewed);
}

#[test]
#[should_panic(expected = "only the contract account can appoint the curator")]
fn only_the_contract_account_appoints_the_curator() {
    let mut c = market();
    at("mallory.testnet", 1_600, 0);
    c.set_curator(account("mallory.testnet"));
}

#[test]
fn url_normalisation() {
    let cases = [
        ("https://Example.COM", Some("https://example.com/")),
        ("https://example.com?q=1", Some("https://example.com/?q=1")),
        ("https://example.com/Path#frag", Some("https://example.com/Path")),
        ("https://example.com:8443/a", Some("https://example.com:8443/a")),
        ("http://example.com", None),
        ("https://", None),
        ("https://localhost/a", None),
        ("https://user@example.com/", None),
        ("https://exa mple.com/", None),
        ("https://exämple.com/", None),
        ("https://.example.com/", None),
    ];
    for (raw, expected) in cases { assert_eq!(normalize_url(raw).as_deref(), expected, "{raw}"); }
    assert_eq!(normalize_url(&format!("https://example.com/{}", "a".repeat(600))), None);
}

#[test]
#[should_panic(expected = "response hash mismatch")]
fn tampered_signed_answer_is_refused() {
    let mut c = market();
    let mut r = receipt(&c, &answer("no"));
    // The answer is a JSON string inside the response JSON, so its quotes are escaped.
    let tampered = r.response_body.replace(r#"\"no\""#, r#"\"yes\""#);
    assert_ne!(tampered, r.response_body, "the tamper must change the body");
    r.response_body = tampered;
    at("arbiter.testnet", 3_000, 0);
    let _ = c.resolve("f".into(), Outcome::Yes, r);
}

#[test]
fn json_views_use_exact_string_amounts() {
    let c = market();
    let fact = serde_json::to_value(c.get_fact("f".into()).unwrap()).unwrap();
    assert_eq!((fact["yes_pool"].as_str(), fact["no_pool"].as_str()), (Some("10"), Some("30")));
    at("alice.testnet", 1_500, 0);
    assert_eq!(serde_json::to_value(c.get_stake("f".into(), account("alice.testnet"), Side::Yes)).unwrap(), "10");
    assert_eq!(serde_json::to_value(c.get_config()).unwrap()["evidence_deposit"], "10000000000000000000000");
}
