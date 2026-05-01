/**
 * Payload generation — recursively walks a JSON Schema and produces
 * realistic sample data using a lookup table of known field values.
 */

import { v4 as uuidv4 } from "uuid";
import { mergeAllOf } from "./asyncapi.js";

// ---------------------------------------------------------------------------
// Known field value lookup table
// ---------------------------------------------------------------------------

export const KNOWN_FIELD_VALUES: Record<string, string[]> = {
  sku: ["SKU-001-XL-BLK", "SKU-002-M-WHT", "SKU-003-L-GRY"],
  barcode: ["0123456789012", "9876543210987", "1234567890123"],
  name: ["Classic Hoodie - Black - XL", "Performance Tee - White - M", "Joggers - Grey - L"],
  description: ["Classic Hoodie - Black - XL", "Performance Tee - White - M", "Joggers - Grey - L"],
  code: ["UKLUT1 : OK", "BERIE1 : OK", "USLAX1 : OK"],
  provider: ["PROVIDER_A", "PROVIDER_B"],
  currency: ["GBP", "USD", "EUR"],
  currencyCode: ["GBP", "USD", "EUR"],
  countryCode: ["GB", "US", "DE", "NL"],
  country: ["United Kingdom", "United States", "Germany", "Netherlands"],
  city: ["London", "New York", "Los Angeles", "Berlin"],
  postcode: ["SW1A 1AA", "10001", "90001", "10115"],
  state: ["", "California", ""],
  stateCode: ["", "CA", ""],
  line1: ["1 Example Street", "3 Central Blvd", "Unit 7 Magna Park"],
  line2: ["Suite 100", "Floor 2", ""],
  email: ["test@example.com", "warehouse@example.com"],
  phone: ["0000000000", "+441234567890"],
  addressee: ["Jane Smith", "Example Warehouse", "Returns Dept"],
  attention: ["Acme Corp", "Acme Ltd"],
  reference: ["#TR005309", "SO041746995", "POIC3323445634"],
  transactionId: ["439808578", "356546875", "354414408"],
  id: ["5091754528", "683394", "1234"],
  firstName: ["Jim", "Jane", "Alex"],
  lastName: ["Shark", "Smith", "Jones"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// String generation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateString(schema: any, fieldName?: string): string {
  if (schema.format === "date-time")
    return new Date(Date.now() - Math.floor(Math.random() * 7 * 86400000)).toISOString();
  if (schema.format === "uuid") return uuidv4();
  if (schema.format === "email") return pick(KNOWN_FIELD_VALUES.email);

  if (schema.pattern) {
    if (schema.pattern.includes("[A-Z]{2}[A-Z0-9]{3}")) return pick(["GBLTT", "USLAX", "NLRTM"]);
    if (schema.pattern.includes("\\d{10}")) return "6109100010";
    if (schema.pattern.includes("[A-Z]{3}$")) return pick(["GBP", "USD", "EUR", "VNM"]);
    if (schema.pattern.includes("[A-Z]{2}$")) return pick(["GB", "US", "DE", "NL"]);
  }

  if (fieldName && KNOWN_FIELD_VALUES[fieldName]) return pick(KNOWN_FIELD_VALUES[fieldName]);

  if (schema.description) {
    const desc = schema.description.toLowerCase();
    if (desc.includes("sku")) return pick(KNOWN_FIELD_VALUES.sku);
    if (desc.includes("location")) return pick(KNOWN_FIELD_VALUES.code);
    if (desc.includes("currency")) return pick(KNOWN_FIELD_VALUES.currency);
    if (desc.includes("country")) return pick(KNOWN_FIELD_VALUES.country);
    if (desc.includes("email")) return pick(KNOWN_FIELD_VALUES.email);
    if (desc.includes("address")) return pick(KNOWN_FIELD_VALUES.line1);
    if (desc.includes("name")) return pick(KNOWN_FIELD_VALUES.name);
  }

  return `sample-${fieldName ?? "value"}`;
}

// ---------------------------------------------------------------------------
// Value generation
// ---------------------------------------------------------------------------

/**
 * Recursively generate a sample value from a JSON Schema.
 * Uses field names and descriptions to produce realistic values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateValue(schema: any, fieldName?: string): any {
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return pick(schema.enum);
  if (schema.allOf) return generateValue(mergeAllOf(schema), fieldName);

  switch (schema.type) {
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        obj[key] = generateValue(propSchema, key);
      }
      return obj;
    }
    case "array": {
      const count = (schema.minItems ?? 1) + Math.floor(Math.random() * 3);
      return Array.from({ length: count }, () => generateValue(schema.items));
    }
    case "string":
      return generateString(schema, fieldName);
    case "integer":
      return (schema.minimum ?? 1) + Math.floor(Math.random() * 50);
    case "number":
      return Math.round((1 + Math.random() * 100) * 100) / 100;
    case "boolean":
      return schema.default ?? false;
    default:
      return null;
  }
}
