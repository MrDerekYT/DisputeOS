export interface ClientRow {
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface CsvImportResult {
  rows: ClientRow[];
  duplicates: number;
  errors: { line: number; message: string }[];
}

const HEADERS: Record<keyof ClientRow, string[]> = {
  name: ["name", "full name", "client name", "fullname"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "phone number", "mobile", "cell"],
  address: ["address", "street address", "street"],
};

/** RFC 4180-style parser: quoted fields, escaped quotes, embedded commas/newlines. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim())) out.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) out.push(row);
  return out;
}

// Neutralise spreadsheet formula injection if values are ever exported again.
const safe = (v: string) => v.trim().replace(/^[=+\-@]+/, "");

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

export function importClientsCsv(text: string): CsvImportResult {
  const table = parseCsv(text.slice(0, 2_000_000));
  const result: CsvImportResult = { rows: [], duplicates: 0, errors: [] };
  if (table.length < 2) {
    result.errors.push({ line: 1, message: "File needs a header row and at least one client" });
    return result;
  }
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const idx = {} as Record<keyof ClientRow, number>;
  for (const key of Object.keys(HEADERS) as (keyof ClientRow)[]) {
    idx[key] = header.findIndex((h) => HEADERS[key].includes(h));
  }
  if (idx.name < 0) {
    result.errors.push({ line: 1, message: "Missing a name column" });
    return result;
  }
  const seen = new Set<string>();
  table.slice(1).forEach((cells, n) => {
    const line = n + 2;
    const get = (k: keyof ClientRow) => (idx[k] >= 0 ? safe(cells[idx[k]] ?? "") : "");
    const row: ClientRow = { name: get("name"), email: get("email").toLowerCase(), phone: normPhone(get("phone")), address: get("address") };
    if (!row.name) return void result.errors.push({ line, message: "Name is required" });
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) return void result.errors.push({ line, message: "Invalid email" });
    if (row.phone && row.phone.length !== 10) return void result.errors.push({ line, message: "Phone must be 10 digits" });
    const key = row.email || row.phone || row.name.toLowerCase();
    if (seen.has(key)) { result.duplicates++; return; }
    seen.add(key);
    result.rows.push(row);
  });
  return result;
}
