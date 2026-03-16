export async function POST(req: Request) {
  const body = await req.json()

  await fetch("http://127.0.0.1:4000/neural/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })

  return Response.json({ ok: true })
}
