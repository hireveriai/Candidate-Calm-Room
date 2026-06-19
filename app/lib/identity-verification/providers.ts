import OpenAI from "openai";
import type { VerificationProvider } from "./types";

export type AadhaarOcrResult = {
  full_name: string;
  dob: string;
  gender: string;
  aadhaar_last4: string;
  address: string;
};

export interface IdentityProvider {
  id: VerificationProvider;
  connect(): Promise<{ connected: boolean; message?: string }>;
}

class DigiLockerProvider implements IdentityProvider {
  id = "digilocker" as const;

  async connect() {
    const configured = Boolean(
      process.env.DIGILOCKER_CLIENT_ID &&
        process.env.DIGILOCKER_CLIENT_SECRET &&
        process.env.DIGILOCKER_REDIRECT_URI
    );

    return configured
      ? { connected: false, message: "DigiLocker authorization is ready to be initiated." }
      : {
          connected: false,
          message: "DigiLocker credentials are not configured. You can continue unverified.",
        };
  }
}

class ManualUploadProvider implements IdentityProvider {
  id = "manual_upload" as const;
  async connect() {
    return { connected: true };
  }
}

const providers: Record<VerificationProvider, IdentityProvider> = {
  digilocker: new DigiLockerProvider(),
  aadhaar_otp: new DigiLockerProvider(),
  manual_upload: new ManualUploadProvider(),
  passport_scan: new ManualUploadProvider(),
};

export function getIdentityProvider(provider: VerificationProvider) {
  return providers[provider];
}

let openai: OpenAI | null = null;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export async function extractAadhaarFields(
  bytes: Buffer,
  mimeType: string
): Promise<AadhaarOcrResult | null> {
  const client = getOpenAI();
  if (!client || !mimeType.startsWith("image/")) return null;

  const response = await client.responses.create({
    model: process.env.OPENAI_OCR_MODEL || "gpt-5.5",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Extract the visible fields from this Indian Aadhaar front image. " +
              "Return only the requested fields. Never return the full Aadhaar number; " +
              "aadhaar_last4 must contain only its final four digits.",
          },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${bytes.toString("base64")}`,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "aadhaar_ocr",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            full_name: { type: "string" },
            dob: { type: "string" },
            gender: { type: "string" },
            aadhaar_last4: { type: "string" },
            address: { type: "string" },
          },
          required: ["full_name", "dob", "gender", "aadhaar_last4", "address"],
        },
      },
    },
  });

  try {
    const parsed = JSON.parse(response.output_text) as AadhaarOcrResult;
    return {
      ...parsed,
      aadhaar_last4: parsed.aadhaar_last4.replace(/\D/g, "").slice(-4),
    };
  } catch {
    return null;
  }
}

