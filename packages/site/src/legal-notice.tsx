import { LEGAL, fact, missingFacts, type LegalFacts } from './legal';

/**
 * The header of the Terms and the Privacy Policy: the effective date once the
 * owner has supplied every required fact, or a draft notice until then.
 */
export function LegalNotice({ facts = LEGAL }: { facts?: LegalFacts }) {
  if (missingFacts(facts).length > 0) {
    return (
      <p role="note" className="legal-draft">
        <strong>Draft, not yet in effect.</strong> The bracketed details are placeholders the owner
        will supply, and the text is pending owner and counsel review.
      </p>
    );
  }
  return <p>Effective {fact('effectiveDate', facts)}.</p>;
}
