export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { runStartupDiagnostics } = await import("@/app/lib/productionReadiness");
  await runStartupDiagnostics();
}
