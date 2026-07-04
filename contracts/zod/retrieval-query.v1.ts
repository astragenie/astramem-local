/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/retrieval-query.v1.schema.json
 * Regenerate: node contracts/generate-zod.mjs
 */
import { z } from "zod"

export const RetrievalQueryV1Schema = z.object({ "text": z.string().describe("Free-form query text. May be empty for filter-only browsing."), "mode": z.enum(["keyword","semantic","hybrid"]), "filters": z.object({ "type": z.array(z.enum(["decision","fact","lesson","command","todo","note","event"])).optional(), "scope": z.array(z.enum(["personal","team","org"])).optional(), "repo": z.string().optional(), "project": z.string().optional(), "since": z.string().datetime({ offset: true }).describe("Lower bound on created_at.").optional(), "as_of": z.string().datetime({ offset: true }).describe("Bitemporal time-travel: return the atom state as it was valid at this instant (ADR-001/ADR-005).").optional() }).strict().optional(), "limit": z.number().int().gte(1).lte(500).optional(), "explain": z.boolean().describe("Explanations are not optional per ADR-005 result contract, but the caller can still choose whether to request the extra payload weight.").optional() }).strict().describe("Query envelope for the shared retrieval contract (ADR-005). Both engines accept this envelope; they may differ internally in how they satisfy it.")
export type RetrievalQueryV1 = z.infer<typeof RetrievalQueryV1Schema>
