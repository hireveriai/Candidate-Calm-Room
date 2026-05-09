import { runStartupDiagnostics } from "@/app/lib/productionReadiness";

export async function register() {
  await runStartupDiagnostics();
}
