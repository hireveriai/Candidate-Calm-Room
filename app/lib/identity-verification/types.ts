export const VERIFICATION_METHODS = [
  "digilocker",
  "aadhaar_scan",
  "manual_upload",
  "none",
] as const;

export const VERIFICATION_PROVIDERS = [
  "digilocker",
  "aadhaar_otp",
  "manual_upload",
  "passport_scan",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export type VerificationProvider = (typeof VERIFICATION_PROVIDERS)[number];
export type VerificationStatus =
  | "pending"
  | "verified"
  | "partial"
  | "skipped"
  | "failed";

export type VerificationDocumentType =
  | "aadhaar"
  | "pan"
  | "passport"
  | "degree"
  | "experience";

export type StoredVerificationDocument = {
  type: VerificationDocumentType;
  path: string;
  name: string;
  mimeType: string;
  uploadedAt: string;
};

export type IdentityVerificationSummary = {
  id: string;
  status: VerificationStatus;
  method: VerificationMethod;
  provider: VerificationProvider;
  trustScore: number;
  digilockerConnected: boolean;
  aadhaarLast4: string | null;
  fullName: string | null;
  dob: string | null;
  gender: string | null;
  documents: StoredVerificationDocument[];
  ocrData: Record<string, unknown>;
  nameMatch: boolean | null;
  dobMatch: boolean | null;
};

