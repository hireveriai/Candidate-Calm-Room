import { prisma } from "@/app/lib/prisma";
import {
  auditVerification,
  documentTypeFromValue,
  ensureVerification,
  getLatestVerification,
  getRequestIp,
  resolveInviteContext,
} from "@/app/lib/identity-verification/server";
import { extractAadhaarFields } from "@/app/lib/identity-verification/providers";
import type { StoredVerificationDocument } from "@/app/lib/identity-verification/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "candidate-verification";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function safeFileName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(-120);
}

async function uploadPrivateObject(path: string, file: File) {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    throw new Error("Supabase verification storage is not configured");
  }

  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${baseUrl}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": file.type,
        "x-upsert": "false",
      },
      body: Buffer.from(await file.arrayBuffer()),
    }
  );

  if (!response.ok) {
    throw new Error((await response.text()) || "Document upload failed");
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const country = String(form.get("country") ?? "India").trim();
    const documentType = documentTypeFromValue(String(form.get("documentType") ?? ""));
    const files = form.getAll("files").filter((value): value is File => value instanceof File);

    if (!token || !documentType || files.length === 0) {
      return Response.json(
        { error: "Token, document type, and at least one file are required" },
        { status: 400 }
      );
    }

    if (files.length > 5) {
      return Response.json({ error: "Upload at most five files per request" }, { status: 400 });
    }

    for (const file of files) {
      if (!ALLOWED_MIME_TYPES.has(file.type) || file.size > MAX_FILE_BYTES) {
        return Response.json(
          { error: `${file.name} must be a PNG, JPEG, WEBP, or PDF under 10 MB` },
          { status: 400 }
        );
      }
    }

    const context = await resolveInviteContext(token);
    if (!context) {
      return Response.json({ error: "Interview invite is invalid or expired" }, { status: 404 });
    }

    let verification =
      (await getLatestVerification(context.interview_id)) ??
      (await ensureVerification({
        candidateId: context.candidate_id,
        interviewId: context.interview_id,
        country,
        method: documentType === "aadhaar" ? "aadhaar_scan" : "manual_upload",
        provider: documentType === "passport" ? "passport_scan" : "manual_upload",
      }));

    const uploaded: StoredVerificationDocument[] = [];
    for (const file of files) {
      const objectPath = [
        context.candidate_id,
        verification.id,
        `${documentType}-${crypto.randomUUID()}-${safeFileName(file.name)}`,
      ].join("/");

      await uploadPrivateObject(objectPath, file);
      uploaded.push({
        type: documentType,
        path: objectPath,
        name: file.name,
        mimeType: file.type,
        uploadedAt: new Date().toISOString(),
      });
    }

    await prisma.$executeRaw`
      update public.candidate_identity_verifications
      set document_urls = coalesce(document_urls, '[]'::jsonb) ||
            ${JSON.stringify(uploaded)}::jsonb,
          verification_method = ${
            documentType === "aadhaar" ? "aadhaar_scan" : "manual_upload"
          },
          verification_provider = ${
            documentType === "passport" ? "passport_scan" : "manual_upload"
          }
      where id = ${verification.id}::uuid
        and candidate_id = ${context.candidate_id}::uuid
    `;

    let ocrProcessed = false;
    const aadhaarImage = documentType === "aadhaar"
      ? files.find((file) => file.type.startsWith("image/"))
      : undefined;

    if (aadhaarImage) {
      const bytes = Buffer.from(await aadhaarImage.arrayBuffer());
      const ocr = await extractAadhaarFields(bytes, aadhaarImage.type);
      if (ocr) {
        const safeDob = /^\d{4}-\d{2}-\d{2}$/.test(ocr.dob) ? ocr.dob : null;
        const redactedOcr = {
          address: ocr.address,
          fieldsExtracted: ["full_name", "dob", "gender", "aadhaar_last4", "address"],
          processedAt: new Date().toISOString(),
        };
        const encryptionKey = process.env.IDENTITY_OCR_ENCRYPTION_KEY;

        await prisma.$transaction(async (tx: typeof prisma) => {
          if (encryptionKey && encryptionKey.length >= 32) {
            await tx.$queryRaw`select set_config('app.identity_ocr_key', ${encryptionKey}, true)`;
            await tx.$queryRaw`
              select public.set_identity_verification_ocr(
                ${verification.id}::uuid,
                ${context.candidate_id}::uuid,
                ${JSON.stringify(redactedOcr)}::jsonb,
                ${JSON.stringify(ocr)}::jsonb,
                ${ocr.full_name},
                ${safeDob}::date,
                ${ocr.gender},
                ${ocr.aadhaar_last4}
              )
            `;
          } else {
            await tx.$executeRaw`
              update public.candidate_identity_verifications
              set ocr_data = ${JSON.stringify(redactedOcr)}::jsonb,
                  full_name = ${ocr.full_name},
                  dob = ${safeDob}::date,
                  gender = ${ocr.gender},
                  aadhaar_last4 = ${ocr.aadhaar_last4}
              where id = ${verification.id}::uuid
                and candidate_id = ${context.candidate_id}::uuid
            `;
          }

          await tx.$executeRaw`
            update public.candidate_identity_verifications v
            set name_match = regexp_replace(lower(coalesce(v.full_name, '')), '[^a-z0-9]', '', 'g')
                = regexp_replace(lower(${context.candidate_name}), '[^a-z0-9]', '', 'g'),
                dob_match = case
                  when ${context.profile_dob}::date is null or v.dob is null then null
                  else v.dob = ${context.profile_dob}::date
                end
            where v.id = ${verification.id}::uuid
          `;
        });
        ocrProcessed = true;
      }
    }

    await auditVerification({
      verificationId: verification.id,
      candidateId: context.candidate_id,
      interviewId: context.interview_id,
      action: ocrProcessed ? "document.uploaded_and_processed" : "document.uploaded",
      ip: getRequestIp(request.headers),
      metadata: {
        documentType,
        fileCount: uploaded.length,
        objectPaths: uploaded.map((document) => document.path),
      },
    });

    verification = (await getLatestVerification(context.interview_id))!;
    return Response.json({ verification, ocrProcessed });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Verification upload failed" },
      { status: 500 }
    );
  }
}
