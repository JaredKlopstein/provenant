/**
 * Exhibit A: three real receipts and the DigiCert RFC 3161 anchor over their
 * head, recorded with the lacre CLI and anchored at DigiCert's production
 * timestamp authority (rename 8/9). Copied byte for byte from the DATA constant
 * in docs/index.html, the Pages landing page; test/exhibit.test.ts checks that
 * the two stay identical and recomputes the chain. Never edit a value by hand:
 * regenerate both together.
 */
export interface ExhibitReceipt {
  readonly seq: number;
  /** The receipt's RFC 8785 canonical JSON, exactly the bytes that were hashed and signed. */
  readonly canonical: string;
  readonly self_hash: string;
}

export interface ExhibitAnchor {
  readonly seq: number;
  readonly head: string;
  readonly time: string;
  readonly authority: string;
}

export interface ExhibitData {
  readonly anchor: ExhibitAnchor;
  readonly receipts: readonly ExhibitReceipt[];
}

export const EXHIBIT_DATA: ExhibitData = {"anchor":{"seq":2,"head":"55f1f1fdb63a0c682932087567b8f23c3276212852cd1a9caca037163fdaeb3b","time":"2026-10-27T23:06:52.000Z","authority":"C=US, O=DigiCert\\, Inc., CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1"},"receipts":[{"seq":0,"canonical":"{\"action_detail\":{\"amount_usd\":42.5,\"customer_id\":\"c_8812\"},\"action_type\":\"tool_call\",\"agent_id\":\"urn:lacre:agent:-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"agent_version\":\"0.0.0\",\"lacre\":{\"action\":\"refund.issue\",\"idempotency_key\":\"refund-8812\",\"key_id\":\"-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"seq\":0,\"side_effect_class\":\"irreversible\",\"signature_alg\":\"ed25519\",\"v\":\"1\"},\"outcome\":\"success\",\"parent_record_id\":null,\"prev_hash\":null,\"record_id\":\"a3904040-edcf-434a-b0d7-a03504c5b7da\",\"session_id\":\"312fc583-4110-4474-a159-154b11a1aaea\",\"signature\":\"JxAxrr47qtRRp4tHu9IkUweCRd-ZQRgtX2kOGrVhYRH2oKLCROqswhmmm296COGV17ioQVptHQNIOqE9z56-CQ\",\"timestamp\":\"2026-10-27T23:06:51.223Z\",\"trust_level\":\"L1\"}","self_hash":"d504ed9897848c3bdd3dac886491868e2e001a2f4b0424cb2ed04eff8ec6cf3f"},{"seq":1,"canonical":"{\"action_detail\":{\"template\":\"refund_confirmation\",\"to\":\"c_8812\"},\"action_type\":\"tool_call\",\"agent_id\":\"urn:lacre:agent:-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"agent_version\":\"0.0.0\",\"lacre\":{\"action\":\"email.send\",\"key_id\":\"-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"seq\":1,\"side_effect_class\":\"write\",\"signature_alg\":\"ed25519\",\"v\":\"1\"},\"outcome\":\"success\",\"parent_record_id\":null,\"prev_hash\":\"d504ed9897848c3bdd3dac886491868e2e001a2f4b0424cb2ed04eff8ec6cf3f\",\"record_id\":\"a322696a-0faf-4b6f-a33d-39b4787036a4\",\"session_id\":\"0636db0a-fb86-4b3c-a174-258931091366\",\"signature\":\"Y6kDhdHt6EYhgsEpETQ_6J08L8DgRnf8R597SRVbhnEtDwSggc5Zmcg71pG7hcoJucqmVH_ffYpJ4hTrpGsuBQ\",\"timestamp\":\"2026-10-27T23:06:51.579Z\",\"trust_level\":\"L1\"}","self_hash":"98536b38d4644e1c600a0d22fd215681250578a5e4402f3b0a7714e076e00bf1"},{"seq":2,"canonical":"{\"action_detail\":{\"amount_usd\":180,\"customer_id\":\"c_9001\"},\"action_type\":\"tool_call\",\"agent_id\":\"urn:lacre:agent:-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"agent_version\":\"0.0.0\",\"lacre\":{\"action\":\"refund.issue\",\"key_id\":\"-voYUSQoXORSb8ZzzgSzjal_ZU5ea2cVPzuPZ-SS_W8\",\"seq\":2,\"side_effect_class\":\"irreversible\",\"signature_alg\":\"ed25519\",\"v\":\"1\"},\"outcome\":\"success\",\"parent_record_id\":null,\"prev_hash\":\"98536b38d4644e1c600a0d22fd215681250578a5e4402f3b0a7714e076e00bf1\",\"record_id\":\"306cbac4-8b3b-44ed-baa4-a938548504d6\",\"session_id\":\"018bf4b2-4096-416f-9e02-bc0bcebc851c\",\"signature\":\"5gjvtkyDeXwbV6zRut0yhXaykklQwBxG5b3aoMToxi6PFPPP5MxhLmh1I8IdRNOugGEpo_972LLKyCKRz7niBg\",\"timestamp\":\"2026-10-27T23:06:51.936Z\",\"trust_level\":\"L1\"}","self_hash":"55f1f1fdb63a0c682932087567b8f23c3276212852cd1a9caca037163fdaeb3b"}]};
