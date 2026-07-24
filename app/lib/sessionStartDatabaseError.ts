type DatabaseErrorRecord = {
  code?: unknown;
  message?: unknown;
  meta?: unknown;
};

function databaseErrorText(error: unknown) {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  if (typeof error === "object" && error !== null) {
    const record = error as DatabaseErrorRecord;
    return typeof record.message === "string"
      ? record.message.toLowerCase()
      : "";
  }

  return String(error ?? "").toLowerCase();
}

export function isAmbiguousDatabaseColumnError(error: unknown) {
  const record =
    typeof error === "object" && error !== null
      ? (error as DatabaseErrorRecord)
      : undefined;
  const meta =
    typeof record?.meta === "object" && record.meta !== null
      ? (record.meta as DatabaseErrorRecord)
      : undefined;
  const databaseCode = String(meta?.code ?? record?.code ?? "");
  const message = databaseErrorText(error);

  return (
    databaseCode === "42702" ||
    (message.includes("42702") &&
      message.includes("column") &&
      message.includes("ambiguous"))
  );
}
