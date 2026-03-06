import OpenAI from "openai";
import { z } from "zod";
import { truncateNullableString, truncateString } from "./strings.js";

const warrantyStatusSchema = z.enum(["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"]);

const claimExtractionSchema = z
  .object({
    customerName: z.string().trim().min(1).max(200).nullable(),
    productName: z.string().trim().min(1).max(200).nullable(),
    serialNumber: z.string().trim().min(1).max(200).nullable(),
    purchaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    issueSummary: z.string().trim().min(1).max(4000).nullable(),
    retailer: z.string().trim().min(1).max(200).nullable(),
    warrantyStatus: warrantyStatusSchema,
    missingInfo: z.array(z.string().trim().min(1).max(100)).max(20),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().trim().min(1).max(1000),
  })
  .strict();

type ClaimExtractionPayload = z.infer<typeof claimExtractionSchema>;

type ClaimExtractionInput = {
  providerMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  textBody: string | null;
  strippedTextReply: string | null;
  claimIssueSummary: string | null;
  supplementalText: string | null;
};

type ClaimExtractionConfig = {
  openAiApiKey: string | null;
  model: string;
  maxInputChars: number;
};

export type ClaimExtractionResult = {
  provider: "OPENAI" | "FALLBACK";
  model: string;
  schemaVersion: number;
  extraction: ClaimExtractionPayload;
  rawOutput: Record<string, unknown>;
};

type RetryableErrorLike = Error & { retryable: boolean };

let openAiClient: OpenAI | undefined;

const CLAIM_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    customerName: { type: ["string", "null"] },
    productName: { type: ["string", "null"] },
    serialNumber: { type: ["string", "null"] },
    purchaseDate: {
      type: ["string", "null"],
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    },
    issueSummary: { type: ["string", "null"] },
    retailer: { type: ["string", "null"] },
    warrantyStatus: {
      type: "string",
      enum: ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"],
    },
    missingInfo: {
      type: "array",
      items: { type: "string" },
      maxItems: 20,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    reasoning: { type: "string" },
  },
  required: [
    "customerName",
    "productName",
    "serialNumber",
    "purchaseDate",
    "issueSummary",
    "retailer",
    "warrantyStatus",
    "missingInfo",
    "confidence",
    "reasoning",
  ],
} as const;

export async function extractClaimData(
  input: ClaimExtractionInput,
  config: ClaimExtractionConfig,
): Promise<ClaimExtractionResult> {
  if (!config.openAiApiKey) {
    const fallbackExtraction = fallbackExtractionFromInbound(input);
    return {
      provider: "FALLBACK",
      model: "fallback-local-heuristic-v1",
      schemaVersion: 1,
      extraction: fallbackExtraction,
      rawOutput: {
        fallback: true,
        reason: "OPENAI_API_KEY is not configured.",
      },
    };
  }

  const promptInput = JSON.stringify(
    {
      providerMessageId: input.providerMessageId,
      fromEmail: input.fromEmail,
      subject: input.subject,
      strippedTextReply: input.strippedTextReply,
      textBody: truncateNullableString(input.textBody, config.maxInputChars),
      claimIssueSummary: input.claimIssueSummary,
      supplementalText: truncateNullableString(input.supplementalText, config.maxInputChars),
    },
    null,
    2,
  );

  const response = await getOpenAiClient(config.openAiApiKey).chat.completions.create({
    model: config.model,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "claim_extraction",
        strict: true,
        schema: CLAIM_EXTRACTION_JSON_SCHEMA,
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Extract structured warranty claim fields from the inbound message. " +
          "Return only data grounded in the input. Use null when unknown.",
      },
      {
        role: "user",
        content:
          "Extract claim data from this inbound message payload. " +
          "If data is missing, include it in missingInfo.\n\n" +
          promptInput,
      },
    ],
  });

  const choice = response.choices[0];
  const rawContent = choice?.message?.content;
  if (!rawContent || !rawContent.trim()) {
    throw claimExtractionError("OpenAI returned an empty structured output payload.", true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw claimExtractionError("OpenAI output is not valid JSON.", true);
  }

  const validated = claimExtractionSchema.safeParse(parsed);
  if (!validated.success) {
    throw claimExtractionError(
      `OpenAI output failed validation: ${validated.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      true,
    );
  }

  return {
    provider: "OPENAI",
    model: response.model ?? config.model,
    schemaVersion: 1,
    extraction: normalizeExtraction(validated.data),
    rawOutput: {
      id: response.id,
      model: response.model,
      finishReason: choice?.finish_reason ?? null,
      content: rawContent,
      usage: response.usage ?? null,
    },
  };
}

function getOpenAiClient(apiKey: string): OpenAI {
  if (openAiClient) {
    return openAiClient;
  }

  openAiClient = new OpenAI({ apiKey });
  return openAiClient;
}

function fallbackExtractionFromInbound(input: ClaimExtractionInput): ClaimExtractionPayload {
  const issueSummary = firstNonEmpty(
    input.supplementalText,
    input.claimIssueSummary,
    input.strippedTextReply,
    input.textBody,
  );
  return {
    customerName: null,
    productName: null,
    serialNumber: null,
    purchaseDate: null,
    issueSummary,
    retailer: null,
    warrantyStatus: "UNCLEAR",
    missingInfo: ["customer_name", "product_name", "serial_number", "purchase_date", "retailer"],
    confidence: issueSummary ? 0.35 : 0.2,
    reasoning: "Used local fallback extraction because OPENAI_API_KEY is not configured.",
  };
}

function normalizeExtraction(value: ClaimExtractionPayload): ClaimExtractionPayload {
  return {
    ...value,
    customerName: cleanNullable(value.customerName),
    productName: cleanNullable(value.productName),
    serialNumber: cleanNullable(value.serialNumber),
    purchaseDate: cleanNullable(value.purchaseDate),
    issueSummary: cleanNullable(value.issueSummary),
    retailer: cleanNullable(value.retailer),
    missingInfo: Array.from(
      new Set(
        value.missingInfo
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .map((item) => item.slice(0, 100)),
      ),
    ),
  };
}

function cleanNullable(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return truncateString(trimmed, 4000);
    }
  }
  return null;
}

function claimExtractionError(message: string, retryable: boolean): RetryableErrorLike {
  const error = new Error(message) as RetryableErrorLike;
  error.retryable = retryable;
  return error;
}
