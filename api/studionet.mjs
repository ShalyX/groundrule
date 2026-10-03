const STUDIONET_RPC = "https://studio.genlayer.com/api";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(STUDIONET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const body = await upstream.text();
    response.status(upstream.status);
    response.setHeader(
      "content-type",
      upstream.headers.get("content-type") || "application/json",
    );
    return response.send(body);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return response.status(timedOut ? 504 : 502).json({
      error: timedOut ? "StudioNet request timed out" : "StudioNet is unavailable",
    });
  } finally {
    clearTimeout(timeout);
  }
}
