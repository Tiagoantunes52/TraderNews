import { describe, it, expect } from "vitest";
import { parseForm4 } from "@/lib/edgar";

// A trimmed but structurally faithful Form 4 ownership document: issuer, a
// reporting owner who is an officer (CEO) and director, the 10b5-1 flag set, and
// two non-derivative lines — an open-market buy (acquired) and a sale (disposed).
const FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Example Corp</issuerName>
    <issuerTradingSymbol>EXMPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerName>DOE JANE</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <officerTitle>Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <aff10b5One>true</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-20</value></transactionDate>
      <transactionCoding>
        <transactionCode>P</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1500</value></transactionShares>
        <transactionPricePerShare><value>190.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>51500</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-21</value></transactionDate>
      <transactionCoding>
        <transactionCode>S</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>192.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>51000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

describe("parseForm4", () => {
  const parsed = parseForm4(FORM4_XML, { filingDate: "2026-05-22" });

  it("extracts the issuer symbol", () => {
    expect(parsed.issuerSymbol).toBe("EXMPL");
  });

  it("extracts the reporting owner with role/title", () => {
    expect(parsed.owner?.name).toBe("DOE JANE");
    expect(parsed.owner?.isOfficer).toBe(true);
    expect(parsed.owner?.isDirector).toBe(true);
    expect(parsed.owner?.isTenPctOwner).toBe(false);
    expect(parsed.owner?.officerTitle).toBe("Chief Executive Officer");
  });

  it("reads the 10b5-1 planned flag", () => {
    expect(parsed.isPlanned).toBe(true);
  });

  it("parses each non-derivative line with acquired/disposed direction", () => {
    expect(parsed.transactions).toHaveLength(2);

    const [buy, sell] = parsed.transactions;
    expect(buy.code).toBe("P");
    expect(buy.shares).toBe(1500);
    expect(buy.price).toBe(190.5);
    expect(buy.acquired).toBe(true);
    expect(buy.sharesAfter).toBe(51500);

    expect(sell.code).toBe("S");
    expect(sell.acquired).toBe(false); // D → disposed
    expect(sell.sharesAfter).toBe(51000);
  });
});
