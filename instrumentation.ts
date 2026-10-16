export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { runStartupDiagnostics } = await import("@/app/lib/productionReadiness");
  await runStartupDiagnostics();
}

export async function onRequestError(
  error: unknown,
  request: { method?: string },
  context: { routePath?: string; routeType?: string },
) {
  const { reportServerError } = await import("@/app/lib/errorReporting");
  await reportServerError("calm-room", error, request, context);
}
