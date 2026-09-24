import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HealthStatus } from "./HealthStatus";

const API_URL = "http://api.test";

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthStatus apiUrl={API_URL} />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HealthStatus", () => {
  it("shows ok when the server answers /healthz", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ok" }));
    renderWithClient();

    expect(await screen.findByText("Server: ok")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/healthz`, expect.anything());
  });

  it("shows an error and lets the user retry when the server is unreachable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    renderWithClient();

    expect(
      await screen.findByText(/Server: unreachable \(Could not reach the server\)/),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Server: ok")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a malformed response as an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "maybe" }));
    renderWithClient();

    expect(
      await screen.findByText("Server: unreachable (Unexpected response from the server)"),
    ).toBeVisible();
  });
});
