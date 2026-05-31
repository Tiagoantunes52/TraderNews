import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WatchlistRow } from "@/app/(dashboard)/dashboard/watchlist/watchlist-row";

const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  mockRefresh.mockClear();
  vi.restoreAllMocks();
});

describe("WatchlistRow", () => {
  it("renders children and remove button", () => {
    render(
      <WatchlistRow stockId="s1" ticker="AAPL">
        <span>AAPL</span>
      </WatchlistRow>
    );
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove AAPL from watchlist")).toBeInTheDocument();
  });

  it("disappears immediately on remove (optimistic)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const { container } = render(
      <WatchlistRow stockId="s1" ticker="AAPL">
        <span>AAPL</span>
      </WatchlistRow>
    );

    fireEvent.click(screen.getByLabelText("Remove AAPL from watchlist"));

    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("reappears if the DELETE request fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    render(
      <WatchlistRow stockId="s1" ticker="AAPL">
        <span>AAPL</span>
      </WatchlistRow>
    );

    fireEvent.click(screen.getByLabelText("Remove AAPL from watchlist"));

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());
  });

  it("calls router.refresh() after a successful remove", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(
      <WatchlistRow stockId="s1" ticker="AAPL">
        <span>AAPL</span>
      </WatchlistRow>
    );

    fireEvent.click(screen.getByLabelText("Remove AAPL from watchlist"));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
  });
});
