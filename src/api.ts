export async function api<T = unknown>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error:
        "Roster couldn’t reach the local service. Your saved work is safe.",
    }));
    throw new Error(error.error || "The request could not be completed.");
  }
  return response.json();
}
