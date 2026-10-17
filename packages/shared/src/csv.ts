export type ParsedStatementRow = {
  bankTxnId: string;
  valueDate: string; // YYYY-MM-DD
  amount: number; // whole MNT
  currency: string;
  payerName: string;
  description: string;
};

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/** Parse DD.MM.YYYY bank statement dates. */
export function parseValueDate(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (!match) {
    throw new CsvParseError(`Invalid value_date "${raw}"; expected DD.MM.YYYY`);
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CsvParseError(`Invalid value_date "${raw}"`);
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new CsvParseError(`Invalid calendar date "${raw}"`);
  }
  return iso;
}

/**
 * Parse amounts like "450,000.00" or 450000.00 into whole MNT (bigint-safe number).
 * Fractional parts other than .00 are rejected — seed money is whole tögrög.
 */
export function parseAmount(raw: string): number {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Remove thousand separators (commas)
  s = s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new CsvParseError(`Invalid amount "${raw}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.replace(/0/g, "").length > 0) {
    throw new CsvParseError(`Amount "${raw}" is not a whole number of MNT`);
  }
  const n = Number(whole);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CsvParseError(`Amount "${raw}" must be a positive whole number of MNT`);
  }
  return n;
}

/** Minimal CSV line splitter that respects double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

const EXPECTED_HEADER = [
  "bank_txn_id",
  "value_date",
  "amount",
  "currency",
  "payer_name",
  "description",
];

export function parseStatementCsv(content: string): ParsedStatementRow[] {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new CsvParseError("CSV must include a header and at least one row");
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, i) => header[i] === h)) {
    throw new CsvParseError(
      `Unexpected CSV header; expected ${EXPECTED_HEADER.join(",")}`
    );
  }

  const rows: ParsedStatementRow[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.length !== EXPECTED_HEADER.length) {
      throw new CsvParseError(
        `Row ${i + 1}: expected ${EXPECTED_HEADER.length} columns, got ${fields.length}`
      );
    }
    const [bankTxnId, valueDateRaw, amountRaw, currency, payerName, description] =
      fields.map((f) => f.trim());

    if (!bankTxnId) {
      throw new CsvParseError(`Row ${i + 1}: bank_txn_id is required`);
    }
    if (seen.has(bankTxnId)) {
      throw new CsvParseError(`Row ${i + 1}: duplicate bank_txn_id ${bankTxnId} in file`);
    }
    seen.add(bankTxnId);

    rows.push({
      bankTxnId,
      valueDate: parseValueDate(valueDateRaw),
      amount: parseAmount(amountRaw),
      currency: currency || "MNT",
      payerName,
      description,
    });
  }

  return rows;
}
