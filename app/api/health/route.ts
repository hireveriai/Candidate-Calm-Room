import { getProductionReadinessReport } from "@/app/lib/productionReadiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const report = await getProductionReadinessReport();
  return Response.json(report, {
    status: report.ok ? 200 : 503,
  });
}
