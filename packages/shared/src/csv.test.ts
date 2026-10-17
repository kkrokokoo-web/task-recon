import { describe, expect, it } from "vitest";
import {
  CsvParseError,
  parseAmount,
  parseStatementCsv,
  parseValueDate,
} from "./csv.js";

describe("parseValueDate", () => {
  it("parses DD.MM.YYYY", () => {
    expect(parseValueDate("15.10.2026")).toBe("2026-10-15");
    expect(parseValueDate("13.10.2026")).toBe("2026-10-13");
  });

  it("rejects invalid dates", () => {
    expect(() => parseValueDate("2026-10-15")).toThrow(CsvParseError);
    expect(() => parseValueDate("32.10.2026")).toThrow(CsvParseError);
  });
});

describe("parseAmount", () => {
  it("parses quoted European thousands", () => {
    expect(parseAmount('"450,000.00"')).toBe(450000);
    expect(parseAmount("1,250,000.00")).toBe(1250000);
    expect(parseAmount("300000")).toBe(300000);
  });

  it("rejects fractional MNT", () => {
    expect(() => parseAmount("100.50")).toThrow(CsvParseError);
  });

  it("rejects non-positive", () => {
    expect(() => parseAmount("0")).toThrow(CsvParseError);
    expect(() => parseAmount("-1")).toThrow(CsvParseError);
  });
});

describe("parseStatementCsv", () => {
  const sample = `bank_txn_id,value_date,amount,currency,payer_name,description
TX-88101,15.10.2026,"450,000.00",MNT,BAT-ERDENE D,LN-1042 зээл төлөлт
TX-88102,15.10.2026,"1,250,000.00",MNT,SARANGEREL B,зээл
`;

  it("parses sample statement rows", () => {
    const rows = parseStatementCsv(sample);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      bankTxnId: "TX-88101",
      valueDate: "2026-10-15",
      amount: 450000,
      currency: "MNT",
      payerName: "BAT-ERDENE D",
      description: "LN-1042 зээл төлөлт",
    });
    expect(rows[1].amount).toBe(1250000);
  });

  it("rejects duplicate bank_txn_id in file", () => {
    const dup = `bank_txn_id,value_date,amount,currency,payer_name,description
TX-1,15.10.2026,"100.00",MNT,A,x
TX-1,15.10.2026,"100.00",MNT,A,x
`;
    expect(() => parseStatementCsv(dup)).toThrow(/duplicate/);
  });
});
